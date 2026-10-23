import type {
  ProviderSubmissionAttempt,
  ProviderRecoveryRequest,
  ProviderServerObservation,
  ProviderSubmissionAcknowledgement,
  ProviderRecoveryResult,
  ProviderAcknowledgementRecoveryEvidence,
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
  readonly acknowledgementRetryAtMs?: number;
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
  #conversationRetryAt = 0;
  readonly #conversationWaiting = new Map<string, { expiresAt: number; selected: boolean }>();
  #conversationInFlight = false;

  constructor(options: ChatGptBackendRecoveryOptions) {
    this.#requestTimeoutMs = options.requestTimeoutMs;
    this.#tokenCacheTtlMs = options.tokenCacheTtlMs;
    this.#now = options.now ?? (() => new Date());
    this.#onRateLimit = options.onRateLimit;
    this.#conversationRetryAt = options.acknowledgementRetryAtMs ?? 0;
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
    observe?: (evidence: ProviderAcknowledgementRecoveryEvidence) => void,
    selectedMessageId?: string,
  ): Promise<ProviderSubmissionAcknowledgement | null> {
    let rateLimit: BackendRateLimitEvidence | undefined;
    const result = await this.#conversation(conversationId, client, origin, evidence => { rateLimit = evidence; }, true, selectedMessageId !== undefined);
    if ('recovery' in result) {
      observe?.({ kind: result.recovery.kind === 'deferred' ? 'deferred'
          : result.recovery.kind === 'unverified' ? 'unverified' : 'unavailable',
        source: result.pacing ? 'pacing' : 'backend', reason: result.recovery.reason, observedAt: this.#now().toISOString(),
        nextCheckAt: result.recovery.nextCheckAt ?? new Date(this.#conversationRetryAt).toISOString(),
        httpStatus: result.httpStatus ?? null, endpointCategory: result.endpointCategory ?? null,
        candidateConversationId: conversationId,
        ...(rateLimit ? { retryAfterMs: rateLimit.retryAfterDurationMs, retryAfterSource: rateLimit.retryAfterSource } : {}) });
      return null;
    }
    const acknowledgement = recoverExactServerAcknowledgement(result.body, conversationId, prompt, attempts, selectedMessageId);
    if (acknowledgement === null) {
      const payload = result.body;
      const ids = isRecord(payload) ? [readStringField(payload, 'id'), readStringField(payload, 'conversation_id')]
        .filter(id => id !== null) : [];
      const validMapping = isRecord(payload) && isRecord(payload.mapping) && ids.length > 0 && ids.every(id => id === conversationId);
      const promptMatchCount = validMapping ? Object.values(payload.mapping as Record<string, unknown>).filter(node => {
        const message = messageForNode(node);
        return message !== null && messageRole(message) === 'user' &&
          messageText(message).replaceAll('\r\n', '\n') === prompt.replaceAll('\r\n', '\n');
      }).length : undefined;
      let exactIdentityReason: string | undefined;
      const attempt = attempts?.length === 1 ? attempts[0] : undefined;
      if (validMapping && attempt !== undefined) {
        const mapping = payload.mapping as Record<string, unknown>;
        const entry = Object.entries(mapping).find(([, node]) =>
          readStringField(messageForNode(node), 'id') === attempt.messageId);
        if (entry !== undefined) {
          const message = messageForNode(entry[1])!;
          const textHash = createHash('sha256').update(messageText(message).replaceAll('\r\n', '\n')).digest('hex');
          if (textHash === attempt.textHash) {
            exactIdentityReason = recoverExactServerFinal(payload, { conversationId,
              submittedUserMessageId: attempt.messageId, submittedUserTurnId: null }).reason;
          }
        }
      }
      const selected = validMapping && selectedMessageId !== undefined
        ? Object.values(payload.mapping as Record<string, unknown>).map(messageForNode)
          .filter(message => message !== null && messageRole(message) === 'user' && readStringField(message, 'id') === selectedMessageId)
        : [];
      const text = selected.length === 1 ? messageText(selected[0]!).replaceAll('\r\n', '\n') : null;
      const expected = prompt.replaceAll('\r\n', '\n');
      let firstDifference = 0;
      if (text !== null) while (firstDifference < Math.min(text.length, expected.length) && text[firstDifference] === expected[firstDifference]) firstDifference++;
      const decoded = text === null ? null : decodeLiteralMarkdown(text);
      let decodedFirstDifference = 0;
      if (decoded !== null) while (decodedFirstDifference < Math.min(decoded.length, expected.length) && decoded[decodedFirstDifference] === expected[decodedFirstDifference]) decodedFirstDifference++;
      observe?.({ kind: 'unverified', source: 'backend', observedAt: this.#now().toISOString(),
        nextCheckAt: new Date(this.#conversationRetryAt).toISOString(), httpStatus: result.httpStatus,
        endpointCategory: 'conversation-detail',
        reason: !validMapping ? 'backend-conversation-mapping-unverified'
          : promptMatchCount === 0 ? 'backend-exact-prompt-absent'
          : promptMatchCount! > 1 ? 'backend-exact-prompt-ambiguous' : exactIdentityReason ?? 'backend-exact-acknowledgement-unverified',
        ...(promptMatchCount === undefined ? {} : { promptMatchCount }),
        ...(validMapping ? { canonicalUserMessageCount: Object.values(payload.mapping as Record<string, unknown>)
          .map(messageForNode).filter(message => message !== null && messageRole(message) === 'user').length,
          ...(selectedMessageId === undefined ? {} : { selectedMessagePresent: selected.length === 1 }) } : {}),
        ...(text === null ? {} : { selectedMessageComparison: { messageId: selectedMessageId!, textLength: text.length,
          textSha256: createHash('sha256').update(text).digest('hex'),
          whitespaceOnlyDifference: text.replace(/\s+/g, ' ').trim() === expected.replace(/\s+/g, ' ').trim(),
          firstDifference, expectedCodePoint: expected.codePointAt(firstDifference) ?? null,
          actualCodePoint: text.codePointAt(firstDifference) ?? null,
          decodedTextLength: decoded!.length, decodedFirstDifference,
          decodedActualCodePoint: decoded!.codePointAt(decodedFirstDifference) ?? null,
          decodedActualCodePoints: Array.from(decoded!.slice(decodedFirstDifference, decodedFirstDifference + 8), c => c.codePointAt(0)!) } }) });
    }
    return acknowledgement;
  }

  async #conversation(conversationId: string, client: BackendJsonClient, origin: string,
    observe?: (evidence: BackendRateLimitEvidence) => void, acknowledgement = false, selected = false):
    Promise<{ body: unknown; httpStatus: number } | { recovery: ProviderRecoveryResult; httpStatus?: number; endpointCategory?: 'auth-session' | 'conversation-detail'; pacing?: boolean }> {
    const now = this.#now().getTime();
    const graceMs = 2 * Math.max(5_000, this.#requestTimeoutMs);
    for (const [id, entry] of this.#conversationWaiting) {
      if (now > entry.expiresAt) this.#conversationWaiting.delete(id);
    }
    const waiting = this.#conversationWaiting.get(conversationId);
    if (selected || !waiting?.selected) {
      this.#conversationWaiting.set(conversationId, { expiresAt: Math.max(now, this.#conversationRetryAt) + graceMs, selected });
    }
    // A user-selected ACK gets the next legal slot ahead of repeated background
    // UNKNOWN polling. It still obeys the same Retry-After and in-flight guard.
    const nextSelected = [...this.#conversationWaiting].find(([, entry]) => entry.selected)?.[0];
    const queued = (nextSelected ?? this.#conversationWaiting.keys().next().value) !== conversationId ||
      (!selected && waiting?.selected === true);
    if (now < this.#conversationRetryAt || queued || this.#conversationInFlight) {
      const next = Math.max(now + 5_000, this.#conversationRetryAt);
      return { pacing: true, recovery: { ...unavailable(acknowledgement
        ? queued && now >= this.#conversationRetryAt ? 'backend-acknowledgement-probe-queued' : 'backend-acknowledgement-probe-paced'
        : 'backend-conversation-probe-paced'), kind: 'deferred', retryAfterMs: next - now,
        nextCheckAt: new Date(next).toISOString() } };
    }
    this.#conversationWaiting.delete(conversationId);
    this.#conversationInFlight = true;
    this.#conversationRetryAt = now + 5_000;
    try {
      const result = await this.#readConversation(conversationId, client, origin, observe);
      if ('recovery' in result && result.recovery.kind === 'deferred') {
        this.#conversationRetryAt = this.#now().getTime() + Math.max(5_000, result.recovery.retryAfterMs ?? 0);
        if (selected) this.#conversationWaiting.set(conversationId, {
          expiresAt: this.#conversationRetryAt + graceMs, selected: true,
        });
      }
      // A caller honoring Retry-After must not expire before its allowed turn.
      for (const entry of this.#conversationWaiting.values()) {
        entry.expiresAt = Math.max(entry.expiresAt, this.#conversationRetryAt + graceMs);
      }
      return result;
    } finally {
      this.#conversationInFlight = false;
    }
  }

  async #readConversation(conversationId: string, client: BackendJsonClient, origin: string,
    observe?: (evidence: BackendRateLimitEvidence) => void):
    Promise<{ body: unknown; httpStatus: number } | { recovery: ProviderRecoveryResult; httpStatus?: number; endpointCategory?: 'auth-session' | 'conversation-detail' }> {
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
      return { recovery: rateLimited(response.headers, this.#now(), 'conversation-detail', observe), httpStatus: response.status, endpointCategory: 'conversation-detail' };
    }
    if (response.status === 401 || response.status === 403) {
      this.#token = null;
      return { recovery: unavailable('backend-auth-rejected'), httpStatus: response.status, endpointCategory: 'conversation-detail' };
    }
    if (response.status === 404) {
      return { recovery: unverified('backend-conversation-not-found'), httpStatus: response.status, endpointCategory: 'conversation-detail' };
    }
    if (response.status < 200 || response.status >= 300) {
      return { recovery: unavailable(`backend-http-${response.status}`), httpStatus: response.status, endpointCategory: 'conversation-detail' };
    }

    return { body: response.body, httpStatus: response.status };
  }

  async #accessToken(
    client: BackendJsonClient,
    origin: string,
    observe?: (evidence: BackendRateLimitEvidence) => void,
  ): Promise<{ readonly token: string } | { readonly recovery: ProviderRecoveryResult; readonly httpStatus?: number; readonly endpointCategory?: 'auth-session' }> {
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
      return { recovery: rateLimited(response.headers, this.#now(), 'auth-session', observe), httpStatus: response.status, endpointCategory: 'auth-session' };
    }
    if (response.status < 200 || response.status >= 300) {
      return { recovery: unavailable(`backend-auth-http-${response.status}`), httpStatus: response.status, endpointCategory: 'auth-session' };
    }
    const token = readStringField(response.body, 'accessToken');
    if (token === null || token.length < 8) {
      return { recovery: unavailable('backend-access-token-missing'), httpStatus: response.status, endpointCategory: 'auth-session' };
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
  selectedMessageId?: string,
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
      // The server may reparent an accepted dispatch. Exact UUID and captured
      // bytes prove its identity; the current-branch check below still applies.
      if (messageId !== exactAttempt.messageId ||
          createHash('sha256').update(text).digest('hex') !== exactAttempt.textHash) return [];
    } else if (text !== prompt.replaceAll('\r\n', '\n') &&
      !(messageId === selectedMessageId && matchesLiteralEditorText(text, prompt.replaceAll('\r\n', '\n')))) return [];
    const parent = readStringField(node, 'parent');
    const parentMessageId = readStringField(parent === null ? null : messageForNode(mapping[parent]), 'id');
    return [{ conversationId, submittedUserMessageId: messageId,
      ...(exactAttempt === undefined ? {} : { dispatchParent: { capturedParentMessageId: exactAttempt.parentMessageId,
        canonicalParentNodeId: parent, canonicalParentMessageId: parentMessageId,
        matches: parent === exactAttempt.parentMessageId || parentMessageId === exactAttempt.parentMessageId } }),
      submittedUserTurnId: readStringField(message, 'turn_id') ?? nodeId,
      ...(text === prompt.replaceAll('\r\n', '\n') || exactAttempt !== undefined ? {} : {
        evidence: 'backend-exact-editor-text' as const,
        promptEncoding: { kind: 'commonmark-literal' as const,
          canonicalTextSha256: createHash('sha256').update(text).digest('hex'),
          decodedTextSha256: createHash('sha256').update(decodeLiteralMarkdown(text)).digest('hex'),
          ...(decodeLiteralMarkdown(text) === prompt.replaceAll('\r\n', '\n') ? {} : { terminalLineBreakOmitted: true as const }) } }) }];
  });
  if (matches.length !== 1) return null;
  const acknowledgement = matches[0]!;
  const anchored = recoverExactServerFinal(payload, acknowledgement);
  return anchored.kind === 'complete' || anchored.kind === 'pending' ? acknowledgement : null;
}

// The retained original canonical message omits the editor's final paragraph
// break. Permit exactly that one LF only with observed Markdown serialization;
// internal whitespace, blank lines and captured POST bytes remain authoritative.
function matchesLiteralEditorText(text: string, prompt: string): boolean {
  const decoded = decodeLiteralMarkdown(text);
  return decoded === prompt || (decoded !== text && prompt.endsWith('\n') &&
    !prompt.endsWith('\n\n') && decoded === prompt.slice(0, -1));
}

// The ChatGPT editor serializes literal punctuation as CommonMark escapes,
// indentation as numeric character references, and URLs as autolinks or same-URL
// links. Parse together so escaped references are not decoded a second time.
// Decode only that representation: never collapse internal whitespace, strip markup or
// relax a recorded POST identity/hash. Callers must explicitly select the user.
function decodeLiteralMarkdown(text: string): string {
  return text.replace(/\\([\x21-\x2f\x3a-\x40\x5b-\x60\x7b-\x7e])|<(https?:\/\/[^\s<>]+)>|\[(https?:\/\/[^\s[\]<>]+)\]\(((?:\\[\x21-\x2f\x3a-\x40\x5b-\x60\x7b-\x7e]|[^\\()\s])+)\)|&#([xX][0-9a-fA-F]{1,6}|[0-9]{1,7});/g,
    (match, punctuation: string | undefined, url: string | undefined, label: string | undefined, target: string | undefined, numeric: string | undefined) => {
      if (numeric !== undefined) {
        const value = /^[xX]/.test(numeric) ? Number.parseInt(numeric.slice(1), 16) : Number(numeric);
        return value > 0 && value <= 0x10ffff && !(value >= 0xd800 && value <= 0xdfff) ? String.fromCodePoint(value) : match;
      }
      if (label !== undefined) return target!.replace(/\\([\x21-\x2f\x3a-\x40\x5b-\x60\x7b-\x7e])/g, '$1') === label ? label : match;
      return punctuation ?? url!;
    });
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

  const messages: Array<ProviderServerObservation['messages'][number]> = [];
  const safeId = (value: string | null) => value !== null && /^[A-Za-z0-9_-]{1,200}$/.test(value) ? value : null;
  let assistantCount = 0;
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
    if (role === 'assistant' || role === 'tool') {
      const metadata = isRecord(message.metadata) ? message.metadata : {};
      const channel = readStringField(message, 'channel') ?? readStringField(metadata, 'channel');
      const status = readStringField(message, 'status');
      messages.push({ messageId: safeId(readStringField(message, 'id') ?? nodeId), role,
        channel: ['analysis', 'final', 'commentary', 'summary'].includes(channel ?? '') ? channel! : 'unknown',
        status: ['in_progress', 'finished_successfully', 'finished_partial', 'failed', 'cancelled', 'error'].includes(status ?? '') ? status! : 'unknown',
        endTurn: typeof message.end_turn === 'boolean' ? message.end_turn : null,
        hidden: metadata.is_visually_hidden_from_conversation === true, textLength: messageText(message).length });
      if (messages.length > 12) messages.shift();
    }
    if (role !== 'assistant') continue;
    assistantCount++;
    sawAssistant = true;
    // Completed hidden provider output is not a replacement for the public answer.
    // An unfinished assistant still invalidates a preceding final below.
    const metadata = isRecord(message.metadata) ? message.metadata : {};
    if (metadata.is_visually_hidden_from_conversation === true &&
        (readStringField(message, 'channel') ?? readStringField(metadata, 'channel')) === 'final' &&
        message.status === 'finished_successfully' && message.end_turn === true) continue;
    const candidate = exactServerFinal(nodeId, message);
    final = candidate;
  }

  const serverObservation: ProviderServerObservation = { anchorNodeId: safeId(branchIds[submittedIndex]!),
    currentNodeId: safeId(currentNode), nextUserFound, assistantCount, messages };
  if (final !== null) {
    return {
      serverObservation,
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
    serverObservation,
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
