import type { SessionPlaneConfig } from '../config.ts';
import {
  adaptiveFetch,
  type AdaptiveFetchOptions,
  type AdaptiveFetchResult,
} from '../fetch/adaptive-fetch.ts';

export interface SearchCandidate {
  readonly url: string;
  readonly title: string;
  readonly snippet: string;
  readonly backend: string;
  readonly rank: number;
}

export interface SearchEvidence {
  readonly candidate: SearchCandidate;
  readonly finalUrl: string;
  readonly status: number;
  readonly kind: string;
  readonly title: string;
  readonly description: string;
  readonly excerpt: string;
  readonly wordCount: number;
  readonly contentHash: string;
  readonly score: number;
  readonly verdict: 'verified' | 'weak' | 'blocked' | 'failed';
  readonly reason: string;
}

export interface SearchQueryInput {
  readonly query: string;
  readonly results?: unknown;
  readonly backend?: string;
  readonly verifyUrl?: string;
  readonly maxResults?: number;
  readonly deep?: boolean;
}

export interface SearchQueryResult {
  readonly requestOk: true;
  readonly schemaVersion: 'sessionplane-search-v1';
  readonly query: string;
  readonly backend: string;
  readonly candidates: readonly SearchCandidate[];
  readonly evidence: readonly SearchEvidence[];
  readonly sufficient: boolean;
  readonly nextStep: 'answer-from-evidence' | 'browse-candidates' | 'provider-synthesis';
  readonly verifiedCount: number;
  readonly weakCount: number;
  readonly failedCount: number;
}

export interface SearchServiceOptions {
  readonly fetch?: typeof adaptiveFetch;
  readonly fetchOptions?: AdaptiveFetchOptions;
  readonly candidateProvider?: (
    query: string,
    maxResults: number,
  ) => Promise<readonly SearchCandidate[]>;
  readonly maxCandidates?: number;
}

export class SearchService {
  readonly #fetch: typeof adaptiveFetch;
  readonly #fetchOptions: AdaptiveFetchOptions;
  readonly #candidateProvider: (
    query: string,
    maxResults: number,
  ) => Promise<readonly SearchCandidate[]>;
  readonly #maxCandidates: number;

  constructor(options: SearchServiceOptions = {}) {
    this.#fetch = options.fetch ?? adaptiveFetch;
    this.#fetchOptions = options.fetchOptions ?? {};
    this.#maxCandidates = positiveInteger(options.maxCandidates, 10, 'maxCandidates');
    this.#candidateProvider =
      options.candidateProvider ??
      (async (query, maxResults) =>
        await discoverDuckDuckGoCandidates(query, maxResults, this.#fetch, this.#fetchOptions));
  }

  static fromConfig(config: SessionPlaneConfig): SearchService {
    return new SearchService({
      maxCandidates: config.searchMaxCandidates,
      fetchOptions: {
        timeoutMs: config.fetchTimeoutMs,
        maxBytes: config.fetchMaxBytes,
        maxRedirects: config.fetchMaxRedirects,
        allowPrivateNetworks: config.fetchAllowPrivateNetworks,
      },
    });
  }

  async query(input: SearchQueryInput): Promise<SearchQueryResult> {
    const query = nonempty(input.query, 'query');
    const maxResults = Math.min(
      positiveInteger(input.maxResults, this.#maxCandidates, 'maxResults'),
      50,
    );
    const backend = input.verifyUrl !== undefined
      ? 'verify'
      : nonempty(input.backend ?? 'duckduckgo-html', 'backend');
    const candidates = input.verifyUrl !== undefined
      ? normalizeSearchResults([{ url: input.verifyUrl, title: input.verifyUrl }], backend, query)
      : input.results !== undefined
        ? normalizeSearchResults(input.results, backend, query)
        : [...await this.#candidateProvider(query, maxResults)];
    const selected = candidates.slice(0, maxResults);
    const evidence = await mapConcurrent(selected, 4, async (candidate) =>
      await this.#verifyCandidate(query, candidate),
    );
    evidence.sort((left, right) => right.score - left.score || left.candidate.rank - right.candidate.rank);
    const verifiedCount = evidence.filter((entry) => entry.verdict === 'verified').length;
    const weakCount = evidence.filter((entry) => entry.verdict === 'weak').length;
    const failedCount = evidence.length - verifiedCount - weakCount;
    const sufficient = verifiedCount >= Math.min(2, selected.length) && evidence.some((entry) => entry.score >= 60);
    return Object.freeze({
      requestOk: true,
      schemaVersion: 'sessionplane-search-v1',
      query,
      backend,
      candidates: Object.freeze(selected),
      evidence: Object.freeze(evidence),
      sufficient,
      nextStep: sufficient
        ? 'answer-from-evidence'
        : input.deep === true
          ? 'provider-synthesis'
          : 'browse-candidates',
      verifiedCount,
      weakCount,
      failedCount,
    });
  }

  async #verifyCandidate(query: string, candidate: SearchCandidate): Promise<SearchEvidence> {
    try {
      const fetched = await this.#fetch(candidate.url, this.#fetchOptions);
      return scoreEvidence(query, candidate, fetched);
    } catch (error) {
      return {
        candidate,
        finalUrl: candidate.url,
        status: 0,
        kind: 'unavailable',
        title: '',
        description: '',
        excerpt: '',
        wordCount: 0,
        contentHash: '',
        score: 0,
        verdict: 'failed',
        reason: error instanceof Error ? error.message : 'candidate-fetch-failed',
      };
    }
  }
}

export function normalizeSearchResults(
  input: unknown,
  backend = 'external',
  query = '',
): SearchCandidate[] {
  const rows = findResultRows(input);
  const candidates: SearchCandidate[] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    const urlValue = firstString(row.url, row.href, row.link, row.sourceUrl, row.canonicalUrl);
    if (urlValue === '') continue;
    const url = normalizeCandidateUrl(urlValue);
    if (url === null || seen.has(url)) continue;
    seen.add(url);
    candidates.push({
      url,
      title: firstString(row.title, row.name, row.headline, url),
      snippet: firstString(row.snippet, row.description, row.content, row.text),
      backend,
      rank: candidates.length + 1,
    });
    if (candidates.length >= 200) break;
  }
  if (query.trim() !== '') {
    const terms = queryTerms(query);
    candidates.sort((left, right) =>
      candidateTermScore(right, terms) - candidateTermScore(left, terms) || left.rank - right.rank,
    );
    return candidates.map((candidate, index) => ({ ...candidate, rank: index + 1 }));
  }
  return candidates;
}

async function discoverDuckDuckGoCandidates(
  query: string,
  maxResults: number,
  fetcher: typeof adaptiveFetch,
  fetchOptions: AdaptiveFetchOptions,
): Promise<readonly SearchCandidate[]> {
  const url = new URL('https://html.duckduckgo.com/html/');
  url.searchParams.set('q', query);
  const fetched = await fetcher(url, {
    ...fetchOptions,
    maxExtractChars: 1_000_000,
    includeHtml: true,
  });
  const html = fetched.document?.html ?? '';
  if (html === '') return [];
  const candidates: SearchCandidate[] = [];
  const pattern = /<a\b([^>]*class\s*=\s*["'][^"']*result__a[^"']*["'][^>]*)>([\s\S]*?)<\/a>/gi;
  for (const match of html.matchAll(pattern)) {
    if (candidates.length >= maxResults) break;
    const href = attributeValue(match[1] ?? '', 'href');
    const candidateUrl = decodeSearchRedirect(href);
    if (candidateUrl === null) continue;
    const title = cleanHtmlText(match[2] ?? '');
    const tail = html.slice((match.index ?? 0) + match[0].length, (match.index ?? 0) + match[0].length + 4_000);
    const snippetMatch = /<(?:a|div)\b[^>]*class\s*=\s*["'][^"']*result__snippet[^"']*["'][^>]*>([\s\S]*?)<\/(?:a|div)>/i.exec(tail);
    candidates.push({
      url: candidateUrl,
      title,
      snippet: cleanHtmlText(snippetMatch?.[1] ?? ''),
      backend: 'duckduckgo-html',
      rank: candidates.length + 1,
    });
  }
  return candidates;
}

function scoreEvidence(
  query: string,
  candidate: SearchCandidate,
  fetched: AdaptiveFetchResult,
): SearchEvidence {
  const title = fetched.document?.title ?? '';
  const description = fetched.document?.description ?? '';
  const body = fetched.document?.text ?? fetched.text ?? '';
  const wordCount = fetched.document?.wordCount ?? countWords(body);
  const terms = queryTerms(query);
  const searchable = `${title}\n${description}\n${body.slice(0, 100_000)}`.toLowerCase();
  const termHits = terms.filter((term) => searchable.includes(term)).length;
  const termCoverage = terms.length === 0 ? 1 : termHits / terms.length;
  let score = 0;
  if (fetched.ok) score += 30;
  if (!fetched.challenge) score += 15;
  if (title !== '') score += 10;
  if (wordCount >= 100) score += 15;
  if (wordCount >= 500) score += 10;
  score += Math.round(termCoverage * 20);
  score = Math.min(100, score);
  const verdict: SearchEvidence['verdict'] = fetched.challenge
    ? 'blocked'
    : fetched.ok && wordCount >= 80 && termCoverage >= 0.25
      ? 'verified'
      : fetched.status > 0
        ? 'weak'
        : 'failed';
  return {
    candidate,
    finalUrl: fetched.finalUrl,
    status: fetched.status,
    kind: fetched.kind,
    title,
    description,
    excerpt: excerpt(body, 800),
    wordCount,
    contentHash: fetched.contentHash,
    score,
    verdict,
    reason: fetched.challenge
      ? 'challenge-detected'
      : !fetched.ok
        ? `http-${fetched.status}`
        : wordCount < 80
          ? 'thin-content'
          : termCoverage < 0.25
            ? 'weak-query-match'
            : 'original-page-verified',
  };
}

function findResultRows(input: unknown): Array<Record<string, unknown>> {
  const rows: Array<Record<string, unknown>> = [];
  const visit = (value: unknown, depth: number): void => {
    if (depth > 8 || rows.length >= 1_000) return;
    if (Array.isArray(value)) {
      for (const entry of value) visit(entry, depth + 1);
      return;
    }
    if (!isRecord(value)) return;
    if (['url', 'href', 'link', 'sourceUrl', 'canonicalUrl'].some((key) => typeof value[key] === 'string')) {
      rows.push(value);
      return;
    }
    for (const key of ['results', 'items', 'data', 'organic', 'web', 'documents', 'hits']) {
      if (value[key] !== undefined) visit(value[key], depth + 1);
    }
  };
  visit(input, 0);
  return rows;
}

async function mapConcurrent<Input, Output>(
  inputs: readonly Input[],
  concurrency: number,
  mapper: (input: Input, index: number) => Promise<Output>,
): Promise<Output[]> {
  const outputs = new Array<Output>(inputs.length);
  let nextIndex = 0;
  const workers = Array.from({ length: Math.min(concurrency, inputs.length) }, async () => {
    for (;;) {
      const index = nextIndex;
      nextIndex += 1;
      if (index >= inputs.length) return;
      const input = inputs[index];
      if (input !== undefined) outputs[index] = await mapper(input, index);
    }
  });
  await Promise.all(workers);
  return outputs;
}

function decodeSearchRedirect(value: string | null): string | null {
  if (value === null) return null;
  try {
    const url = new URL(value, 'https://html.duckduckgo.com/');
    const redirected = url.searchParams.get('uddg');
    return normalizeCandidateUrl(redirected ?? url.href);
  } catch {
    return null;
  }
}

function normalizeCandidateUrl(value: string): string | null {
  try {
    const url = new URL(value);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    url.hash = '';
    for (const key of [...url.searchParams.keys()]) {
      if (/^(utm_|fbclid$|gclid$|mc_)/i.test(key)) url.searchParams.delete(key);
    }
    return url.href;
  } catch {
    return null;
  }
}

function attributeValue(attributes: string, name: string): string | null {
  const pattern = new RegExp(
    `(?:^|\\s)${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`,
    'i',
  );
  const match = pattern.exec(attributes);
  return match === null ? null : decodeHtml(match[1] ?? match[2] ?? match[3] ?? '');
}

function cleanHtmlText(value: string): string {
  return decodeHtml(value.replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
}

function decodeHtml(value: string): string {
  return value
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&nbsp;/gi, ' ')
    .replace(/&#x([0-9a-f]+);/gi, (_full, hex: string) =>
      String.fromCodePoint(Number.parseInt(hex, 16)),
    )
    .replace(/&#(\d+);/g, (_full, decimal: string) =>
      String.fromCodePoint(Number.parseInt(decimal, 10)),
    );
}

function firstString(...values: unknown[]): string {
  for (const value of values) {
    if (typeof value === 'string' && value.trim() !== '') return value.trim();
  }
  return '';
}

function queryTerms(query: string): string[] {
  return [...new Set(
    (query.toLowerCase().match(/[\p{L}\p{N}]{2,}/gu) ?? [])
      .filter((term) => !['the', 'and', 'for', 'with', 'from', 'that', 'this', 'what', 'when'].includes(term)),
  )].slice(0, 30);
}

function candidateTermScore(candidate: SearchCandidate, terms: readonly string[]): number {
  const text = `${candidate.title}\n${candidate.snippet}\n${candidate.url}`.toLowerCase();
  return terms.reduce((score, term) => score + (text.includes(term) ? 1 : 0), 0);
}

function excerpt(value: string, limit: number): string {
  const normalized = value.replace(/\s+/g, ' ').trim();
  return normalized.length <= limit ? normalized : `${normalized.slice(0, limit).trimEnd()}…`;
}

function countWords(value: string): number {
  return value.match(/[\p{L}\p{N}]+(?:['’_-][\p{L}\p{N}]+)*/gu)?.length ?? 0;
}

function positiveInteger(value: number | undefined, fallback: number, name: string): number {
  const result = value ?? fallback;
  if (!Number.isSafeInteger(result) || result <= 0) throw new Error(`${name} must be positive`);
  return result;
}

function nonempty(value: string, name: string): string {
  const normalized = value.trim();
  if (normalized === '') throw new Error(`${name} must not be empty`);
  return normalized;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
