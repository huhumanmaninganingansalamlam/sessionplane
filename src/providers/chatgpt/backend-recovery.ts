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
  /** Stable identity of the authenticated request context. Rotate on account changes;
   * wrappers for the same context may share this opaque identity. */
  readonly authScope?: object;
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
  /** Persist the GET cooldown before the next network request. */
  readonly onConversationRetryAtMs?: (nextAllowedAtMs: number) => void;
  readonly now?: () => Date;
  readonly onRateLimit?: (request: ProviderRecoveryRequest, evidence: BackendRateLimitEvidence) => void;
  /** Safe endpoint/Retry-After metadata for semantic and legacy reads alike. */
  readonly onRateLimitEvidence?: (evidence: BackendRateLimitEvidence) => void;
}

interface CachedToken {
  readonly origin: string;
  readonly authScope: object;
  readonly value: string;
  readonly expiresAtMs: number;
}

const MAX_CONVERSATION_429_BACKOFF_MS = 15 * 60_000;
const RESERVED_BACKGROUND_READ_SAFETY_MS = MAX_CONVERSATION_429_BACKOFF_MS + 60_000;

export class ChatGptBackendRecovery {
  readonly #requestTimeoutMs: number;
  readonly #tokenCacheTtlMs: number;
  readonly #now: () => Date;
  readonly #onRateLimit: ChatGptBackendRecoveryOptions['onRateLimit'];
  readonly #onRateLimitEvidence: ChatGptBackendRecoveryOptions['onRateLimitEvidence'];
  readonly #onConversationRetryAtMs: ChatGptBackendRecoveryOptions['onConversationRetryAtMs'];
  #token: CachedToken | null = null;
  #conversationRetryAt = 0;
  #consecutiveConversation429s = 0;
  readonly #conversationWaiting = new Map<string, {
    expiresAt: number; selected: boolean; priorityAt: number;
    backgroundReadAvailable: boolean;
  }>();
  #conversationInFlight = false;

  constructor(options: ChatGptBackendRecoveryOptions) {
    this.#requestTimeoutMs = options.requestTimeoutMs;
    this.#tokenCacheTtlMs = options.tokenCacheTtlMs;
    this.#now = options.now ?? (() => new Date());
    this.#onRateLimit = options.onRateLimit;
    this.#onRateLimitEvidence = options.onRateLimitEvidence;
    this.#onConversationRetryAtMs = options.onConversationRetryAtMs;
    this.#conversationRetryAt = options.acknowledgementRetryAtMs ?? 0;
  }

  #extendConversationRetryAt(nextAllowedAtMs: number): void {
    if (nextAllowedAtMs <= this.#conversationRetryAt) return;
    // Reserve locally first. A failed SQLite write still preserves the
    // Retry-After barrier in this Core and never grants an early second GET.
    this.#conversationRetryAt = nextAllowedAtMs;
    // Persist before any network read; no tokens, bodies or task content.
    this.#onConversationRetryAtMs?.(nextAllowedAtMs);
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

  /**
   * New semantic adapter entry point. Uses the same rate-limited, authenticated
   * read-only backend transport as legacy recovery without fabricating a
   * SessionSnapshot. No UI focus or submission is permitted here.
   */
  reserveExactTurn(conversationId: string, notBefore: string): void {
    if (!/^[A-Za-z0-9_-]{1,160}$/.test(conversationId)) {
      throw new Error('Invalid canonical conversation reservation');
    }
    const dueMs = Date.parse(notBefore);
    if (!Number.isFinite(dueMs)) throw new Error('Invalid canonical read time');
    const graceMs = 2 * Math.max(5_000, this.#requestTimeoutMs);
    const existing = this.#conversationWaiting.get(conversationId);
    // One immediate completion check is safe only while even the maximum local
    // 429 backoff still clears before the fixed due. Re-registering the same
    // reservation never restores an already consumed background read.
    const earlyReadIsSafe = dueMs - this.#now().getTime() >=
      RESERVED_BACKGROUND_READ_SAFETY_MS;
    this.#conversationWaiting.set(conversationId, {
      expiresAt: Math.max(existing?.expiresAt ?? 0, dueMs + graceMs),
      selected: true,
      priorityAt: Math.min(existing?.priorityAt ?? dueMs, dueMs),
      backgroundReadAvailable: existing?.selected === true
        ? existing.backgroundReadAvailable : earlyReadIsSafe,
    });
  }

  async recoverExactTurn(
    identity: {
      readonly conversationId: string | null;
      readonly submittedUserMessageId: string | null;
      readonly submittedUserTurnId: string | null;
    },
    client: BackendJsonClient,
    origin: string,
    selected = false,
  ): Promise<ProviderRecoveryResult> {
    if (identity.conversationId === null ||
      (identity.submittedUserMessageId === null && identity.submittedUserTurnId === null)) {
      return unavailable('backend-identity-incomplete');
    }
    const result = await this.#conversation(
      identity.conversationId, client, origin, undefined, false, selected);
    if ('recovery' in result) return result.recovery;
    return recoverExactServerFinal(result.body, {
      conversationId: identity.conversationId,
      submittedUserMessageId: identity.submittedUserMessageId,
      submittedUserTurnId: identity.submittedUserTurnId,
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

  async recoverRenderedDispatchEvidence(
    conversationId: string, prompt: string, selectedMessageId: string,
    client: BackendJsonClient, origin: string,
  ): Promise<ProviderSubmissionAttempt | null> {
    if (!/^[A-Za-z0-9_-]{1,160}$/.test(conversationId) ||
        !/^[A-Za-z0-9_-]{1,200}$/.test(selectedMessageId)) return null;
    const result = await this.#conversation(conversationId, client, origin,
      undefined, true, true);
    if ('recovery' in result) return null;
    const ack = recoverExactServerAcknowledgement(
      result.body, conversationId, prompt, undefined, selectedMessageId);
    if (ack === null || ack.submittedUserMessageId !== selectedMessageId ||
        !isRecord(result.body) || !isRecord(result.body.mapping)) return null;
    const mapping = result.body.mapping as Record<string, unknown>;
    const matches = Object.entries(mapping).filter(([, node]) => {
      const message = messageForNode(node);
      return message !== null && messageRole(message) === 'user' &&
        readStringField(message, 'id') === selectedMessageId &&
        messageText(message).replaceAll('\r\n', '\n') === prompt.replaceAll('\r\n', '\n');
    });
    if (matches.length !== 1) return null;
    const parent = readStringField(matches[0]![1], 'parent');
    if (parent === null || parent.length === 0) return null;
    return { conversationId, messageId: selectedMessageId,
      parentMessageId: parent,
      textHash: createHash('sha256').update(prompt.replaceAll('\r\n', '\n')).digest('hex'),
      observedAt: this.#now().toISOString() };
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
    const reservedBackgroundRead = !selected && waiting?.selected === true &&
      waiting.backgroundReadAvailable;
    // Consume before checking the shared fence. If the exact ACK just used a
    // canonical slot, this bounded observation is paced and cannot reappear on
    // the next tick; if no backend read was needed for ACK, it may collect an
    // already-finished FINAL without weakening the fixed due reservation.
    if (reservedBackgroundRead) waiting.backgroundReadAvailable = false;
    if (selected || !waiting?.selected) {
      this.#conversationWaiting.set(conversationId, {
        expiresAt: Math.max(waiting?.expiresAt ?? 0,
          Math.max(now, this.#conversationRetryAt) + graceMs),
        selected,
        priorityAt: selected ? Math.min(waiting?.priorityAt ?? now, now)
          : waiting?.priorityAt ?? Number.MAX_SAFE_INTEGER,
        backgroundReadAvailable: waiting?.backgroundReadAvailable ?? false,
      });
    }
    // A user-selected ACK or an approved due FINAL gets the next legal slot
    // ahead of repeated background reads. Both still obey Retry-After. An
    // approved due permits at most the one safe early completion check above.
    const nextSelected = [...this.#conversationWaiting]
      .filter(([, entry]) => entry.selected)
      .sort((left, right) => left[1].priorityAt - right[1].priorityAt)[0]?.[0];
    const queued = (nextSelected ?? this.#conversationWaiting.keys().next().value) !== conversationId ||
      (!selected && waiting?.selected === true && !reservedBackgroundRead);
    if (now < this.#conversationRetryAt || queued || this.#conversationInFlight) {
      const next = Math.max(now + 5_000, this.#conversationRetryAt);
      return { pacing: true, recovery: { ...unavailable(acknowledgement
        ? queued && now >= this.#conversationRetryAt ? 'backend-acknowledgement-probe-queued' : 'backend-acknowledgement-probe-paced'
        : 'backend-conversation-probe-paced'), kind: 'deferred', retryAfterMs: next - now,
        nextCheckAt: new Date(next).toISOString() } };
    }
    if (!reservedBackgroundRead) this.#conversationWaiting.delete(conversationId);
    this.#conversationInFlight = true;
    try {
      this.#extendConversationRetryAt(now + 5_000);
      let result = await this.#readConversation(conversationId, client, origin, observe);
      if ('recovery' in result && result.recovery.kind === 'deferred') {
        // A persistent server 429 may keep returning a short Retry-After.
        // Increase our own cooldown as well; never shorten a server-specified delay.
        const repeated429 = result.recovery.reason === 'backend-http-429';
        if (repeated429) {
          this.#consecutiveConversation429s = Math.min(5, this.#consecutiveConversation429s + 1);
        }
        const exponential429Ms = repeated429
          ? Math.min(MAX_CONVERSATION_429_BACKOFF_MS,
            60_000 * 2 ** (this.#consecutiveConversation429s - 1))
          : 0;
        const extendedAt = this.#now().getTime() +
          Math.max(5_000, result.recovery.retryAfterMs ?? 0, exponential429Ms);
        this.#extendConversationRetryAt(extendedAt);
        // Keep retryAfterMs as parsed server evidence. Local exponential pacing
        // is represented by nextCheckAt and must not fabricate a server delay.
        // This preserves safe provenance for absent or malformed headers.
        result = { ...result, recovery: { ...result.recovery,
          nextCheckAt: new Date(this.#conversationRetryAt).toISOString(),
        } };
        if (selected) this.#conversationWaiting.set(conversationId, {
          expiresAt: this.#conversationRetryAt + graceMs, selected: true,
          priorityAt: waiting?.priorityAt ?? now,
          backgroundReadAvailable: false,
        });
      } else if (!('recovery' in result)) {
        this.#consecutiveConversation429s = 0;
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
      return { recovery: rateLimited(response.headers, this.#now(), 'conversation-detail',
        evidence => { observe?.(evidence); this.#onRateLimitEvidence?.(evidence); }),
        httpStatus: response.status, endpointCategory: 'conversation-detail' };
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
    const authScope = client.authScope ?? client;
    if (this.#token !== null && this.#token.origin === origin &&
      this.#token.authScope === authScope && this.#token.expiresAtMs > nowMs) {
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
      return { recovery: rateLimited(response.headers, this.#now(), 'auth-session',
        evidence => { observe?.(evidence); this.#onRateLimitEvidence?.(evidence); }),
        httpStatus: response.status, endpointCategory: 'auth-session' };
    }
    if (response.status < 200 || response.status >= 300) {
      return { recovery: unavailable(`backend-auth-http-${response.status}`), httpStatus: response.status, endpointCategory: 'auth-session' };
    }
    const token = readStringField(response.body, 'accessToken');
    if (token === null || token.length < 8) {
      return { recovery: unavailable('backend-access-token-missing'), httpStatus: response.status, endpointCategory: 'auth-session' };
    }
    this.#token = {
      origin,
      authScope,
      value: token,
      expiresAtMs: nowMs + this.#tokenCacheTtlMs,
    };
    return { token };
  }
}

function trustedOrigin(value: string): string | null {
  try {
    const url = new URL(value);
    // Exact HTTPS origins only: a trusted hostname on another TLS port
    // is not an authorized endpoint for fetching an account bearer token.
    return url.origin === 'https://chatgpt.com' || url.origin === 'https://chat.openai.com'
      ? url.origin : null;
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
  if (exactAttempt !== undefined &&
    createHash('sha256').update(prompt.replaceAll('\r\n', '\n')).digest('hex') !== exactAttempt.textHash) return null;
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
  let boundUserIndex = -1;
  for (let index = 0; index < branchIds.length; index += 1) {
    const nodeId = branchIds[index];
    if (nodeId === undefined) {
      continue;
    }
    const message = messageForNode(mapping[nodeId]);
    if (message === null) continue;
    // A duplicate of either bound identity component makes the entire
    // current-branch ancestry ambiguous, even when the other component differs.
    const matchesBoundId = isExactSubmittedUser(nodeId, message, {
      submittedUserMessageId: identity.submittedUserMessageId, submittedUserTurnId: null,
    }) || isExactSubmittedUser(nodeId, message, {
      submittedUserMessageId: null, submittedUserTurnId: identity.submittedUserTurnId,
    });
    if (matchesBoundId) {
      if (boundUserIndex >= 0) return unverified('backend-user-anchor-ambiguous-on-current-branch');
      boundUserIndex = index;
    }
    if (isExactSubmittedUser(nodeId, message, identity)) submittedIndex = index;
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
  const text = messageText(message);
  if (text.trim().length === 0) {
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
  if (identity.submittedUserMessageId === null && identity.submittedUserTurnId === null) return false;
  if (identity.submittedUserMessageId !== null) {
    const canonicalMessageId = messageId ?? nodeId;
    if (canonicalMessageId !== identity.submittedUserMessageId) return false;
  }
  if (identity.submittedUserTurnId !== null) {
    const canonicalTurnId = turnId ?? nodeId;
    if (canonicalTurnId !== identity.submittedUserTurnId) return false;
  }
  return true;
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
    const durationMs = Math.round(seconds * 1_000);
    return Number.isFinite(durationMs) && now.getTime() + durationMs <= 8.64e15
      ? durationMs : null;
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
