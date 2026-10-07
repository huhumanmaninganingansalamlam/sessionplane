import type {
  ProviderSubmissionAttempt,
  ProviderRecoveryRequest,
  ProviderSubmissionAcknowledgement,
  ProviderRecoveryResult,
} from '../provider-adapter.ts';
import { createHash } from 'node:crypto';
import { limitationHeaders } from './rate-limit-evidence.ts';

export interface BackendRateLimitEvidence {
  readonly status: 429;
  readonly method: 'GET';
  readonly endpointCategory: 'auth-session' | 'conversation-detail';
  readonly receivedAt: string;
  readonly source: 'sessionplane-backend-recovery';
  readonly headers: Readonly<Record<string, string>>;
  readonly retryAfterSource: 'valid-header' | 'header-absent-fallback' | 'header-invalid-fallback';
  readonly retryAfterDurationMs: number | null;
}

export interface BackendJsonResponse {
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: unknown;
}

export interface BackendJsonClient {
  get(
    url: string,
    options: {
      readonly headers?: Readonly<Record<string, string>>;
      readonly timeoutMs: number;
    },
  ): Promise<BackendJsonResponse>;
}

export interface ChatGptBackendRecoveryOptions {
  readonly requestTimeoutMs: number;
  readonly tokenCacheTtlMs: number;
  readonly now?: () => Date;
  readonly onRateLimit?: (request: ProviderRecoveryRequest, evidence: BackendRateLimitEvidence) => void;
}

interface CachedToken {
  readonly value: string;
  readonly expiresAtMs: number;
}

export class ChatGptBackendRecovery {
  readonly #requestTimeoutMs: number;
  readonly #tokenCacheTtlMs: number;
  readonly #now: () => Date;
  readonly #onRateLimit: ChatGptBackendRecoveryOptions['onRateLimit'];
  #token: CachedToken | null = null;
  #acknowledgementRetryAt = 0;

  constructor(options: ChatGptBackendRecoveryOptions) {
    this.#requestTimeoutMs = options.requestTimeoutMs;
    this.#tokenCacheTtlMs = options.tokenCacheTtlMs;
    this.#now = options.now ?? (() => new Date());
    this.#onRateLimit = options.onRateLimit;
  }

  async recover(
    request: ProviderRecoveryRequest,
    client: BackendJsonClient,
    origin: string,
  ): Promise<ProviderRecoveryResult> {
    const conversationId = request.session.conversationId;
    if (
      conversationId === null ||
      (request.session.submittedUserMessageId === null &&
        request.session.submittedUserTurnId === null)
    ) {
      return unavailable('backend-identity-incomplete');
    }

    const result = await this.#conversation(conversationId, client, origin,
      evidence => this.#onRateLimit?.(request, evidence));
    if ('recovery' in result) return result.recovery;
    return recoverExactServerFinal(result.body, {
      conversationId,
      submittedUserMessageId: request.session.submittedUserMessageId,
      submittedUserTurnId: request.session.submittedUserTurnId,
    });
  }

  async recoverAcknowledgement(
    conversationId: string, prompt: string, client: BackendJsonClient, origin: string,
    attempts?: readonly ProviderSubmissionAttempt[],
  ): Promise<ProviderSubmissionAcknowledgement | null> {
    if (this.#now().getTime() < this.#acknowledgementRetryAt) return null;
    // The shared account probe is bounded even when callers repeatedly inspect.
    this.#acknowledgementRetryAt = this.#now().getTime() + 5_000;
    const result = await this.#conversation(conversationId, client, origin);
    if ('recovery' in result) {
      if (result.recovery.kind === 'deferred') {
        this.#acknowledgementRetryAt = this.#now().getTime() + Math.max(5_000, result.recovery.retryAfterMs ?? 0);
      }
      return null;
    }
    return recoverExactServerAcknowledgement(result.body, conversationId, prompt, attempts);
  }

  async #conversation(conversationId: string, client: BackendJsonClient, origin: string,
    observe?: (evidence: BackendRateLimitEvidence) => void):
    Promise<{ body: unknown } | { recovery: ProviderRecoveryResult }> {
    const normalizedOrigin = trustedOrigin(origin);
    if (normalizedOrigin === null) {
      return { recovery: unavailable('backend-origin-untrusted') };
    }

    const tokenResult = await this.#accessToken(client, normalizedOrigin, observe);
    if ('recovery' in tokenResult) {
      return tokenResult;
    }

    let response: BackendJsonResponse;
    try {
      response = await client.get(
        `${normalizedOrigin}/backend-api/conversation/${encodeURIComponent(conversationId)}`,
        {
          headers: {
            accept: 'application/json',
            authorization: `Bearer ${tokenResult.token}`,
          },
          timeoutMs: this.#requestTimeoutMs,
        },
      );
    } catch {
      return { recovery: unavailable('backend-conversation-request-failed') };
    }

    if (response.status === 429) {
      return { recovery: rateLimited(response.headers, this.#now(), 'conversation-detail', observe) };
    }
    if (response.status === 401 || response.status === 403) {
      this.#token = null;
      return { recovery: unavailable('backend-auth-rejected') };
    }
    if (response.status === 404) {
      return { recovery: unverified('backend-conversation-not-found') };
    }
    if (response.status < 200 || response.status >= 300) {
      return { recovery: unavailable(`backend-http-${response.status}`) };
    }

    return { body: response.body };
  }

  async #accessToken(
    client: BackendJsonClient,
    origin: string,
    observe?: (evidence: BackendRateLimitEvidence) => void,
  ): Promise<{ readonly token: string } | { readonly recovery: ProviderRecoveryResult }> {
    const nowMs = this.#now().getTime();
    if (this.#token !== null && this.#token.expiresAtMs > nowMs) {
      return { token: this.#token.value };
    }

    let response: BackendJsonResponse;
    try {
      response = await client.get(`${origin}/api/auth/session`, {
        headers: { accept: 'application/json' },
        timeoutMs: this.#requestTimeoutMs,
      });
    } catch {
      return { recovery: unavailable('backend-auth-session-failed') };
    }
    if (response.status === 429) {
      return { recovery: rateLimited(response.headers, this.#now(), 'auth-session', observe) };
    }
    if (response.status < 200 || response.status >= 300) {
      return { recovery: unavailable(`backend-auth-http-${response.status}`) };
    }
    const token = readStringField(response.body, 'accessToken');
    if (token === null || token.length < 8) {
      return { recovery: unavailable('backend-access-token-missing') };
    }
    this.#token = {
      value: token,
      expiresAtMs: nowMs + this.#tokenCacheTtlMs,
    };
    return { token };
  }
}

function trustedOrigin(value: string): string | null {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' &&
      (url.hostname === 'chatgpt.com' || url.hostname === 'chat.openai.com')
      ? url.origin
      : null;
  } catch {
    return null;
  }
}

export function recoverExactServerAcknowledgement(
  payload: unknown, conversationId: string, prompt: string,
  attempts?: readonly ProviderSubmissionAttempt[],
): ProviderSubmissionAcknowledgement | null {
  if (!isRecord(payload) || !isRecord(payload.mapping)) return null;
  const ids = [readStringField(payload, 'id'), readStringField(payload, 'conversation_id')].filter(id => id !== null);
  if (ids.length === 0 || ids.some(id => id !== conversationId)) return null;
  const mapping = payload.mapping;
  const attempted = attempts?.length ? [...new Map(attempts.map(a => [JSON.stringify([
    a.conversationId, a.messageId, a.parentMessageId, a.textHash]), a])).values()] : [];
  if (attempted.length > 1 || attempted.some(a => a.conversationId !== conversationId)) return null;
  const exactAttempt = attempted[0];
  const matches = Object.entries(mapping).flatMap(([nodeId, node]) => {
    const message = messageForNode(node);
    if (message === null || messageRole(message) !== 'user') return [];
    const text = messageText(message).replaceAll('\r\n', '\n');
    const messageId = readStringField(message, 'id');
    if (messageId === null || messageId.length === 0) return [];
    if (exactAttempt !== undefined) {
      const parent = readStringField(node, 'parent');
      const parentMessage = parent === null ? null : messageForNode(mapping[parent]);
      if (messageId !== exactAttempt.messageId ||
          createHash('sha256').update(text).digest('hex') !== exactAttempt.textHash ||
          (parent !== exactAttempt.parentMessageId && readStringField(parentMessage, 'id') !== exactAttempt.parentMessageId)) return [];
    } else if (text !== prompt.replaceAll('\r\n', '\n')) return [];
    return [{ conversationId, submittedUserMessageId: messageId,
      submittedUserTurnId: readStringField(message, 'turn_id') ?? nodeId }];
  });
  if (matches.length !== 1) return null;
  const acknowledgement = matches[0]!;
  const anchored = recoverExactServerFinal(payload, acknowledgement);
  return anchored.kind === 'complete' || anchored.kind === 'pending' ? acknowledgement : null;
}

export function recoverExactServerFinal(
  payload: unknown,
  identity: {
    readonly conversationId: string;
    readonly submittedUserMessageId: string | null;
    readonly submittedUserTurnId: string | null;
  },
): ProviderRecoveryResult {
  if (!isRecord(payload)) {
    return unavailable('backend-response-malformed');
  }
  const responseConversationIds = [readStringField(payload, 'id'), readStringField(payload, 'conversation_id')]
    .filter(id => id !== null);
  if (responseConversationIds.length === 0) return unverified('backend-conversation-unverified');
  if (responseConversationIds.some(id => id !== identity.conversationId)) {
    return unverified('backend-conversation-mismatch');
  }
  const currentNode = readStringField(payload, 'current_node');
  const mapping = payload.mapping;
  if (currentNode === null || !isRecord(mapping)) {
    return unavailable('backend-branch-malformed');
  }

  const branchIds: string[] = [];
  const visited = new Set<string>();
  let cursor: string | null = currentNode;
  while (cursor !== null) {
    if (visited.has(cursor) || branchIds.length > 10_000) {
      return unavailable('backend-branch-cycle');
    }
    visited.add(cursor);
    const node = mapping[cursor];
    if (!isRecord(node)) {
      return unavailable('backend-branch-node-missing');
    }
    branchIds.push(cursor);
    cursor = readNullableStringField(node, 'parent');
  }
  branchIds.reverse();

  let submittedIndex = -1;
  for (let index = 0; index < branchIds.length; index += 1) {
    const nodeId = branchIds[index];
    if (nodeId === undefined) {
      continue;
    }
    const message = messageForNode(mapping[nodeId]);
    if (message !== null && isExactSubmittedUser(nodeId, message, identity)) {
      submittedIndex = index;
      break;
    }
  }
  if (submittedIndex < 0) {
    const onOtherBranch = Object.entries(mapping).some(([nodeId, node]) => {
      const message = messageForNode(node);
      return message !== null && isExactSubmittedUser(nodeId, message, identity);
    });
    return unverified(onOtherBranch
      ? 'backend-user-anchor-not-on-current-branch'
      : 'backend-user-anchor-absent-from-mapping');
  }

  let sawAssistant = false;
  let nextUserFound = false;
  let final: { readonly id: string; readonly text: string } | null = null;
  for (let index = submittedIndex + 1; index < branchIds.length; index += 1) {
    const nodeId = branchIds[index];
    if (nodeId === undefined) {
      continue;
    }
    const message = messageForNode(mapping[nodeId]);
    if (message === null) {
      continue;
    }
    const role = messageRole(message);
    if (role === 'user') {
      nextUserFound = true;
      break;
    }
    if (role !== 'assistant') {
      continue;
    }
    sawAssistant = true;
    const candidate = exactServerFinal(nodeId, message);
    final = candidate;
  }

  if (final !== null) {
    return {
      kind: 'complete',
      observationTransport: 'fresh',
      responseMessageId: final.id,
      answerText: final.text,
      reason: 'backend-exact-final',
      retryAfterMs: null,
      nextCheckAt: null,
    };
  }
  return {
    kind: 'pending',
    observationTransport: 'fresh',
    responseMessageId: null,
    answerText: null,
    reason: nextUserFound ? 'backend-next-user-turn-before-final' :
      sawAssistant ? 'backend-assistant-not-final' : 'backend-assistant-missing',
    retryAfterMs: null,
    nextCheckAt: null,
  };
}

function exactServerFinal(
  nodeId: string,
  message: Readonly<Record<string, unknown>>,
): { readonly id: string; readonly text: string } | null {
  const metadata = isRecord(message.metadata) ? message.metadata : {};
  const channel =
    readStringField(message, 'channel') ?? readStringField(metadata, 'channel');
  const status = readStringField(message, 'status');
  const hidden = metadata.is_visually_hidden_from_conversation === true;
  if (
    channel !== 'final' ||
    status !== 'finished_successfully' ||
    message.end_turn !== true ||
    hidden
  ) {
    return null;
  }
  const text = messageText(message).trim();
  if (text.length === 0) {
    return null;
  }
  return {
    id: readStringField(message, 'id') ?? nodeId,
    text,
  };
}

function isExactSubmittedUser(
  nodeId: string,
  message: Readonly<Record<string, unknown>>,
  identity: {
    readonly submittedUserMessageId: string | null;
    readonly submittedUserTurnId: string | null;
  },
): boolean {
  if (messageRole(message) !== 'user') {
    return false;
  }
  const metadata = isRecord(message.metadata) ? message.metadata : {};
  const messageId = readStringField(message, 'id');
  const turnId =
    readStringField(message, 'turn_id') ??
    readStringField(metadata, 'turn_id') ??
    readStringField(metadata, 'turnId');
  return (
    (identity.submittedUserMessageId !== null &&
      (messageId === identity.submittedUserMessageId ||
        nodeId === identity.submittedUserMessageId)) ||
    (identity.submittedUserTurnId !== null &&
      (turnId === identity.submittedUserTurnId || nodeId === identity.submittedUserTurnId))
  );
}

export function parseRetryAfterMs(
  headers: Readonly<Record<string, string>>,
  now: Date,
): number | null {
  const value = Object.entries(headers).find(
    ([name]) => name.toLowerCase() === 'retry-after',
  )?.[1];
  if (value === undefined) {
    return null;
  }
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return Math.round(seconds * 1_000);
  }
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? Math.max(0, timestamp - now.getTime()) : null;
}

function messageForNode(value: unknown): Readonly<Record<string, unknown>> | null {
  if (!isRecord(value) || !isRecord(value.message)) {
    return null;
  }
  return value.message;
}

function messageRole(message: Readonly<Record<string, unknown>>): string | null {
  return isRecord(message.author) ? readStringField(message.author, 'role') : null;
}

function messageText(message: Readonly<Record<string, unknown>>): string {
  const content = message.content;
  if (!isRecord(content)) {
    return '';
  }
  const direct = readStringField(content, 'text');
  if (direct !== null) {
    return direct;
  }
  if (!Array.isArray(content.parts)) {
    return '';
  }
  const parts: string[] = [];
  for (const part of content.parts) {
    if (typeof part === 'string') {
      parts.push(part);
    } else if (isRecord(part)) {
      const text = readStringField(part, 'text');
      if (text !== null) {
        parts.push(text);
      }
    }
  }
  return parts.join('\n');
}

function rateLimited(
  headers: Readonly<Record<string, string>>,
  now: Date,
  endpointCategory: BackendRateLimitEvidence['endpointCategory'],
  observe?: (evidence: BackendRateLimitEvidence) => void,
): ProviderRecoveryResult {
  const retryAfterMs = parseRetryAfterMs(headers, now);
  const header = Object.entries(headers).find(([name]) => name.toLowerCase() === 'retry-after')?.[1];
  const safeHeaders = limitationHeaders(Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v])));
  // Preserve only parsed, allowlisted evidence; never a URL, body or auth header.
  if (retryAfterMs !== null) safeHeaders['retry-after'] = String(retryAfterMs / 1000);
  try {
    observe?.({ status: 429, method: 'GET', endpointCategory, receivedAt: now.toISOString(),
      source: 'sessionplane-backend-recovery', headers: safeHeaders,
      retryAfterSource: retryAfterMs !== null ? 'valid-header' : header === undefined ? 'header-absent-fallback' : 'header-invalid-fallback',
      retryAfterDurationMs: retryAfterMs });
  } catch { /* Diagnostic persistence must not weaken or reissue a failed request. */ }
  return {
    kind: 'deferred',
    observationTransport: 'deferred',
    responseMessageId: null,
    answerText: null,
    reason: 'backend-http-429',
    retryAfterMs,
    nextCheckAt: null,
  };
}

function unavailable(reason: string): ProviderRecoveryResult {
  return {
    kind: 'unavailable',
    observationTransport: 'unavailable',
    responseMessageId: null,
    answerText: null,
    reason,
    retryAfterMs: null,
    nextCheckAt: null,
  };
}

function unverified(reason: string): ProviderRecoveryResult {
  return {
    kind: 'unverified',
    observationTransport: 'fresh',
    responseMessageId: null,
    answerText: null,
    reason,
    retryAfterMs: null,
    nextCheckAt: null,
  };
}

function readStringField(value: unknown, key: string): string | null {
  if (!isRecord(value)) {
    return null;
  }
  const field = value[key];
  return typeof field === 'string' ? field : null;
}

function readNullableStringField(
  value: Readonly<Record<string, unknown>>,
  key: string,
): string | null {
  const field = value[key];
  return field === null || typeof field === 'string' ? field : null;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
