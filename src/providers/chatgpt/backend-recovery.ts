import { trustedOrigin, recoverExactServerAcknowledgement, decodeLiteralMarkdown, recoverExactServerFinal, parseRetryAfterMs, messageForNode, messageRole, messageText, rateLimited, unavailable, unverified, readStringField, isRecord } from './backend-recovery-decoders.ts';
import type { ProviderSubmissionAttempt, ProviderRecoveryRequest, ProviderSubmissionAcknowledgement, ProviderRecoveryResult, ProviderAcknowledgementRecoveryEvidence } from '../provider-adapter.ts';
import { createHash } from 'node:crypto';


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
  /** Safe endpoint/Retry-After metadata for every canonical read path. */
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
   * read-only backend transport as exact-turn recovery without fabricating a
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

// The retained original canonical message omits the editor's final paragraph
// break. Permit exactly that one LF only with observed Markdown serialization;
// internal whitespace, blank lines and captured POST bytes remain authoritative.


// The ChatGPT editor serializes literal punctuation as CommonMark escapes,
// indentation as numeric character references, and URLs as autolinks or same-URL
// links. Parse together so escaped references are not decoded a second time.
// Decode only that representation: never collapse internal whitespace, strip markup or
// relax a recorded POST identity/hash. Callers must explicitly select the user.

export { parseRetryAfterMs, recoverExactServerFinal, recoverExactServerAcknowledgement } from './backend-recovery-decoders.ts';
