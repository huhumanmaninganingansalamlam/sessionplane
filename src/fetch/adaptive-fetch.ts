import { createHash } from 'node:crypto';
import { request as httpRequest, type IncomingHttpHeaders, type IncomingMessage } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { isIP } from 'node:net';

import { extractHtmlDocument, type ExtractedDocument } from './html-extractor.ts';
import {
  UrlSafetyError,
  validateFetchTarget,
  type ResolvedAddress,
  type UrlSafetyOptions,
  type ValidatedFetchTarget,
} from './url-safety.ts';

export type AdaptiveFetchKind = 'html' | 'json' | 'text' | 'feed' | 'binary';

export interface AdaptiveFetchTraceEntry {
  readonly phase: 'validate' | 'request' | 'redirect' | 'extract';
  readonly url: string;
  readonly address: string | null;
  readonly status: number | null;
  readonly durationMs: number;
  readonly detail: string;
}

export interface AdaptiveFetchResult {
  readonly requestOk: true;
  readonly schemaVersion: 'sessionplane-adaptive-fetch-v1';
  readonly inputUrl: string;
  readonly finalUrl: string;
  readonly ok: boolean;
  readonly status: number;
  readonly kind: AdaptiveFetchKind;
  readonly contentType: string | null;
  readonly charset: string | null;
  readonly sizeBytes: number;
  readonly contentHash: string;
  readonly fetchedAt: string;
  readonly redirectCount: number;
  readonly responseHeaders: Readonly<Record<string, string>>;
  readonly document: ExtractedDocument | null;
  readonly json: unknown;
  readonly text: string | null;
  readonly binaryBase64: string | null;
  readonly challenge: boolean;
  readonly truncated: boolean;
  readonly trace: readonly AdaptiveFetchTraceEntry[];
}

export interface AdaptiveFetchOptions extends UrlSafetyOptions {
  readonly timeoutMs?: number;
  readonly maxBytes?: number;
  readonly maxRedirects?: number;
  readonly maxExtractChars?: number;
  readonly includeHtml?: boolean;
  readonly includeBinary?: boolean;
  readonly userAgent?: string;
  readonly acceptLanguage?: string;
  readonly headers?: Readonly<Record<string, string>>;
  readonly now?: () => Date;
}

export class AdaptiveFetchError extends Error {
  readonly errorCode: string;
  readonly details: unknown;

  constructor(errorCode: string, message: string, details?: unknown, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = 'AdaptiveFetchError';
    this.errorCode = errorCode;
    this.details = details;
  }
}

interface RawResponse {
  readonly status: number;
  readonly headers: IncomingHttpHeaders;
  readonly body: Uint8Array;
  readonly durationMs: number;
}

interface NormalizedOptions {
  readonly timeoutMs: number;
  readonly maxBytes: number;
  readonly maxRedirects: number;
  readonly maxExtractChars: number;
  readonly includeHtml: boolean;
  readonly includeBinary: boolean;
  readonly userAgent: string;
  readonly acceptLanguage: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly now: () => Date;
  readonly allowPrivateNetworks: boolean;
  readonly resolver?: UrlSafetyOptions['resolver'];
}

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

export async function adaptiveFetch(
  input: string | URL,
  options: AdaptiveFetchOptions = {},
): Promise<AdaptiveFetchResult> {
  const normalized = normalizeOptions(options);
  const inputUrl = input instanceof URL ? input.href : input;
  let currentUrl = input instanceof URL ? new URL(input.href) : parseInputUrl(input);
  let redirectCount = 0;
  let previousProtocol: string | null = null;
  const trace: AdaptiveFetchTraceEntry[] = [];

  for (;;) {
    const validationStarted = performance.now();
    const target = await validateTarget(currentUrl, normalized);
    trace.push({
      phase: 'validate',
      url: target.url.href,
      address: target.selectedAddress.address,
      status: null,
      durationMs: elapsed(validationStarted),
      detail: `validated ${target.addresses.length} address(es)`,
    });
    if (previousProtocol === 'https:' && target.url.protocol === 'http:') {
      throw new AdaptiveFetchError(
        'fetch.redirect-downgrade-blocked',
        `Refusing HTTPS to HTTP redirect: ${target.url.href}`,
      );
    }

    const response = await fetchPinned(target, normalized);
    trace.push({
      phase: 'request',
      url: target.url.href,
      address: target.selectedAddress.address,
      status: response.status,
      durationMs: response.durationMs,
      detail: `received ${response.body.byteLength} byte(s)`,
    });

    const location = headerValue(response.headers, 'location');
    if (REDIRECT_STATUSES.has(response.status) && location !== null) {
      if (redirectCount >= normalized.maxRedirects) {
        throw new AdaptiveFetchError(
          'fetch.too-many-redirects',
          `Fetch exceeded ${normalized.maxRedirects} redirects`,
        );
      }
      const redirectUrl = resolveRedirect(location, target.url);
      redirectCount += 1;
      trace.push({
        phase: 'redirect',
        url: target.url.href,
        address: target.selectedAddress.address,
        status: response.status,
        durationMs: 0,
        detail: `redirect ${redirectCount} -> ${redirectUrl.href}`,
      });
      previousProtocol = target.url.protocol;
      currentUrl = redirectUrl;
      continue;
    }

    const extractionStarted = performance.now();
    const decoded = decodeBody(response.body, response.headers);
    const contentType = parseContentType(headerValue(response.headers, 'content-type'));
    const kind = classifyKind(contentType.mediaType, decoded);
    const document = kind === 'html'
      ? extractHtmlDocument(decoded, target.url.href, {
          maxChars: normalized.maxExtractChars,
          includeHtml: normalized.includeHtml,
        })
      : null;
    const json = kind === 'json' ? parseJson(decoded) : null;
    const text = kind === 'html'
      ? document?.text ?? null
      : kind === 'json' || kind === 'text' || kind === 'feed'
        ? truncateText(decoded, normalized.maxExtractChars)
        : null;
    const contentHash = createHash('sha256').update(response.body).digest('hex');
    const challenge = detectChallenge(response.status, decoded, response.headers);
    trace.push({
      phase: 'extract',
      url: target.url.href,
      address: target.selectedAddress.address,
      status: response.status,
      durationMs: elapsed(extractionStarted),
      detail: `${kind}${challenge ? ' challenge-detected' : ''}`,
    });

    return Object.freeze({
      requestOk: true,
      schemaVersion: 'sessionplane-adaptive-fetch-v1',
      inputUrl,
      finalUrl: target.url.href,
      ok: response.status >= 200 && response.status < 300,
      status: response.status,
      kind,
      contentType: contentType.mediaType,
      charset: contentType.charset,
      sizeBytes: response.body.byteLength,
      contentHash,
      fetchedAt: normalized.now().toISOString(),
      redirectCount,
      responseHeaders: Object.freeze(safeHeaders(response.headers)),
      document,
      json,
      text,
      binaryBase64:
        kind === 'binary' && normalized.includeBinary
          ? Buffer.from(response.body).toString('base64')
          : null,
      challenge,
      truncated:
        (document?.truncated ?? false) || (text !== null && text.length < decoded.length),
      trace: Object.freeze(trace),
    });
  }
}

async function validateTarget(
  url: URL,
  options: NormalizedOptions,
): Promise<ValidatedFetchTarget> {
  try {
    return await validateFetchTarget(url, {
      allowPrivateNetworks: options.allowPrivateNetworks,
      ...(options.resolver === undefined ? {} : { resolver: options.resolver }),
    });
  } catch (error) {
    if (error instanceof UrlSafetyError) {
      throw new AdaptiveFetchError(error.errorCode, error.message, error.details, error);
    }
    throw error;
  }
}

async function fetchPinned(
  target: ValidatedFetchTarget,
  options: NormalizedOptions,
): Promise<RawResponse> {
  const started = performance.now();
  const url = target.url;
  const selected = target.selectedAddress;
  const request = url.protocol === 'https:' ? httpsRequest : httpRequest;
  return await new Promise<RawResponse>((resolve, reject) => {
    let settled = false;
    let timer: NodeJS.Timeout;
    const finish = (operation: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      operation();
    };
    const req = request(
      {
        protocol: url.protocol,
        hostname: selected.address,
        ...(url.port === '' ? {} : { port: Number(url.port) }),
        method: 'GET',
        path: `${url.pathname}${url.search}`,
        headers: requestHeaders(target, options),
        ...(url.protocol === 'https:' && isIP(target.hostname) === 0
          ? { servername: target.hostname }
          : {}),
      },
      (response) => {
        readBoundedBody(response, options.maxBytes)
          .then((body) => finish(() => resolve({
            status: response.statusCode ?? 0,
            headers: response.headers,
            body,
            durationMs: elapsed(started),
          })))
          .catch((error: unknown) =>
            finish(() => reject(classifyRequestError(error, url, selected))),
          );
      },
    );
    req.once('error', (error) =>
      finish(() => reject(classifyRequestError(error, url, selected))),
    );
    timer = setTimeout(() => {
      req.destroy();
      finish(() => reject(new AdaptiveFetchError(
        'fetch.timeout',
        `Fetch timed out after ${options.timeoutMs}ms`,
        { url: url.href, address: selected.address },
      )));
    }, options.timeoutMs);
    timer.unref?.();
    req.end();
  });
}

async function readBoundedBody(response: IncomingMessage, maxBytes: number): Promise<Uint8Array> {
  const contentLength = Number(headerValue(response.headers, 'content-length') ?? '0');
  if (Number.isFinite(contentLength) && contentLength > maxBytes) {
    response.destroy();
    throw new AdaptiveFetchError(
      'fetch.body-too-large',
      `Response Content-Length ${contentLength} exceeds ${maxBytes} bytes`,
      { contentLength, maxBytes },
    );
  }
  const encoding = (headerValue(response.headers, 'content-encoding') ?? 'identity').toLowerCase();
  if (encoding !== '' && encoding !== 'identity') {
    response.destroy();
    throw new AdaptiveFetchError(
      'fetch.unsupported-content-encoding',
      `Unexpected response content encoding: ${encoding}`,
    );
  }
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const raw of response) {
    const chunk = Buffer.isBuffer(raw) ? raw : Buffer.from(raw as Uint8Array);
    total += chunk.length;
    if (total > maxBytes) {
      response.destroy();
      throw new AdaptiveFetchError(
        'fetch.body-too-large',
        `Response exceeded ${maxBytes} bytes`,
        { maxBytes },
      );
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

function requestHeaders(
  target: ValidatedFetchTarget,
  options: NormalizedOptions,
): Record<string, string> {
  const headers: Record<string, string> = {
    Accept: 'text/html,application/xhtml+xml,application/json,application/xml;q=0.9,text/plain;q=0.8,*/*;q=0.5',
    'Accept-Encoding': 'identity',
    'Accept-Language': options.acceptLanguage,
    Connection: 'close',
    Host: target.url.host,
    'User-Agent': options.userAgent,
  };
  for (const [key, value] of Object.entries(options.headers)) {
    const normalized = key.toLowerCase();
    if (normalized === 'host' || normalized === 'connection') continue;
    headers[key] = value;
  }
  return headers;
}

function decodeBody(body: Uint8Array, headers: IncomingHttpHeaders): string {
  const contentType = parseContentType(headerValue(headers, 'content-type'));
  const charset = (contentType.charset ?? 'utf-8').toLowerCase().replaceAll('_', '-');
  const decoderName =
    charset === 'latin1' || charset === 'iso-8859-1' || charset === 'windows-1252'
      ? 'windows-1252'
      : 'utf-8';
  try {
    return new TextDecoder(decoderName, { fatal: false }).decode(body);
  } catch {
    return Buffer.from(body).toString('utf8');
  }
}

function classifyKind(mediaType: string | null, text: string): AdaptiveFetchKind {
  const normalized = mediaType?.toLowerCase() ?? '';
  if (
    normalized.includes('text/html') ||
    normalized.includes('application/xhtml') ||
    /^\s*<!doctype html|^\s*<html\b/i.test(text)
  ) {
    return 'html';
  }
  if (normalized.includes('json') || /^\s*[\[{]/.test(text)) return 'json';
  if (
    normalized.includes('rss') ||
    normalized.includes('atom') ||
    (normalized.includes('xml') && /^\s*<(rss|feed)\b/i.test(text))
  ) {
    return 'feed';
  }
  if (
    normalized.startsWith('text/') ||
    normalized.includes('xml') ||
    normalized.includes('javascript') ||
    normalized.includes('csv')
  ) {
    return 'text';
  }
  return printableRatio(text) >= 0.85 ? 'text' : 'binary';
}

function detectChallenge(
  status: number,
  text: string,
  headers: IncomingHttpHeaders,
): boolean {
  if (![401, 403, 429, 503].includes(status)) return false;
  const sample = text.slice(0, 30_000).toLowerCase();
  const server = headerValue(headers, 'server')?.toLowerCase() ?? '';
  return (
    server.includes('cloudflare') ||
    /captcha|verify you are human|checking your browser|access denied|security check|challenge-platform|cf-chl/.test(
      sample,
    )
  );
}

function parseContentType(value: string | null): {
  readonly mediaType: string | null;
  readonly charset: string | null;
} {
  if (value === null) return { mediaType: null, charset: null };
  const [rawMediaType = '', ...parameters] = value.split(';');
  const mediaType = rawMediaType.trim().toLowerCase() || null;
  let charset: string | null = null;
  for (const parameter of parameters) {
    const match = /^\s*charset\s*=\s*["']?([^"';\s]+)["']?/i.exec(parameter);
    if (match?.[1] !== undefined) charset = match[1];
  }
  return { mediaType, charset };
}

function parseJson(value: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch (error) {
    throw new AdaptiveFetchError(
      'fetch.invalid-json',
      'Response declared JSON but was not valid JSON',
      undefined,
      error,
    );
  }
}

function safeHeaders(headers: IncomingHttpHeaders): Record<string, string> {
  const allowed = new Set([
    'cache-control',
    'content-language',
    'content-length',
    'content-type',
    'date',
    'etag',
    'last-modified',
    'location',
    'retry-after',
    'vary',
  ]);
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    if (!allowed.has(key.toLowerCase()) || value === undefined) continue;
    result[key.toLowerCase()] = Array.isArray(value) ? value.join(', ') : value;
  }
  return result;
}

function headerValue(headers: IncomingHttpHeaders, name: string): string | null {
  const value = headers[name.toLowerCase()];
  if (value === undefined) return null;
  return Array.isArray(value) ? value[0] ?? null : value;
}

function normalizeOptions(options: AdaptiveFetchOptions): NormalizedOptions {
  return {
    timeoutMs: positiveInteger(options.timeoutMs, 15_000, 'timeoutMs'),
    maxBytes: positiveInteger(options.maxBytes, 5 * 1024 * 1024, 'maxBytes'),
    maxRedirects: nonnegativeInteger(options.maxRedirects, 5, 'maxRedirects'),
    maxExtractChars: positiveInteger(options.maxExtractChars, 500_000, 'maxExtractChars'),
    includeHtml: options.includeHtml ?? false,
    includeBinary: options.includeBinary ?? false,
    userAgent: nonempty(
      options.userAgent ??
        'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/153 Safari/537.36 SessionPlane/0.1',
      'userAgent',
    ),
    acceptLanguage: nonempty(options.acceptLanguage ?? 'en-US,en;q=0.9', 'acceptLanguage'),
    headers: options.headers ?? {},
    now: options.now ?? (() => new Date()),
    allowPrivateNetworks: options.allowPrivateNetworks ?? false,
    ...(options.resolver === undefined ? {} : { resolver: options.resolver }),
  };
}

function classifyRequestError(
  error: unknown,
  url: URL,
  address: ResolvedAddress,
): AdaptiveFetchError {
  if (error instanceof AdaptiveFetchError) return error;
  const causeCode =
    error instanceof Error && 'code' in error
      ? String((error as NodeJS.ErrnoException).code ?? '')
      : '';
  return new AdaptiveFetchError(
    causeCode === 'ECONNREFUSED' ? 'fetch.connection-refused' : 'fetch.request-failed',
    `Fetch request failed for ${url.href}`,
    { url: url.href, address: address.address, causeCode: causeCode || null },
    error,
  );
}

function resolveRedirect(value: string, base: URL): URL {
  try {
    const url = new URL(value, base);
    url.hash = '';
    return url;
  } catch (error) {
    throw new AdaptiveFetchError(
      'fetch.invalid-redirect',
      `Invalid redirect location: ${value}`,
      { from: base.href, location: value },
      error,
    );
  }
}

function parseInputUrl(value: string): URL {
  try {
    return new URL(value);
  } catch (error) {
    throw new AdaptiveFetchError('fetch.invalid-url', `Invalid URL: ${value}`, undefined, error);
  }
}

function truncateText(value: string, limit: number): string {
  if (value.length <= limit) return value;
  return `${value.slice(0, limit).trimEnd()}\n…`;
}

function printableRatio(value: string): number {
  if (value.length === 0) return 1;
  const sample = value.slice(0, 20_000);
  let printable = 0;
  for (const character of sample) {
    const codePoint = character.codePointAt(0) ?? 0;
    if (codePoint === 9 || codePoint === 10 || codePoint === 13 || codePoint >= 32) {
      printable += 1;
    }
  }
  return printable / sample.length;
}

function elapsed(started: number): number {
  return Math.max(0, Math.round((performance.now() - started) * 1_000) / 1_000);
}

function positiveInteger(value: number | undefined, fallback: number, name: string): number {
  const result = value ?? fallback;
  if (!Number.isSafeInteger(result) || result <= 0) {
    throw new AdaptiveFetchError('input.invalid', `${name} must be a positive integer`);
  }
  return result;
}

function nonnegativeInteger(value: number | undefined, fallback: number, name: string): number {
  const result = value ?? fallback;
  if (!Number.isSafeInteger(result) || result < 0) {
    throw new AdaptiveFetchError('input.invalid', `${name} must be a nonnegative integer`);
  }
  return result;
}

function nonempty(value: string, name: string): string {
  const normalized = value.trim();
  if (normalized === '') {
    throw new AdaptiveFetchError('input.invalid', `${name} must not be empty`);
  }
  return normalized;
}
