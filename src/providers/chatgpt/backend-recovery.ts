import type {
  ProviderRecoveryRequest,
  ProviderRecoveryResult,
} from '../provider-adapter.ts';

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
}

interface CachedToken {
  readonly value: string;
  readonly expiresAtMs: number;
}

export class ChatGptBackendRecovery {
  readonly #requestTimeoutMs: number;
  readonly #tokenCacheTtlMs: number;
  readonly #now: () => Date;
  #token: CachedToken | null = null;

  constructor(options: ChatGptBackendRecoveryOptions) {
    this.#requestTimeoutMs = options.requestTimeoutMs;
    this.#tokenCacheTtlMs = options.tokenCacheTtlMs;
    this.#now = options.now ?? (() => new Date());
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

    const normalizedOrigin = trustedOrigin(origin);
    if (normalizedOrigin === null) {
      return unavailable('backend-origin-untrusted');
    }

    const tokenResult = await this.#accessToken(client, normalizedOrigin);
    if ('recovery' in tokenResult) {
      return tokenResult.recovery;
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
      return unavailable('backend-conversation-request-failed');
    }

    if (response.status === 429) {
      return rateLimited(response.headers, this.#now());
    }
    if (response.status === 401 || response.status === 403) {
      this.#token = null;
      return unavailable('backend-auth-rejected');
    }
    if (response.status === 404) {
      return unverified('backend-conversation-not-found');
    }
    if (response.status < 200 || response.status >= 300) {
      return unavailable(`backend-http-${response.status}`);
    }

    return recoverExactServerFinal(response.body, {
      conversationId,
      submittedUserMessageId: request.session.submittedUserMessageId,
      submittedUserTurnId: request.session.submittedUserTurnId,
    });
  }

  async #accessToken(
    client: BackendJsonClient,
    origin: string,
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
      return { recovery: rateLimited(response.headers, this.#now()) };
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
  const responseConversationId = readStringField(payload, 'id');
  if (
    responseConversationId !== null &&
    responseConversationId !== identity.conversationId
  ) {
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
    return unverified('backend-user-anchor-not-on-current-branch');
  }

  let sawAssistant = false;
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
      return unverified('backend-later-user-turn');
    }
    if (role !== 'assistant') {
      continue;
    }
    sawAssistant = true;
    const candidate = exactServerFinal(nodeId, message);
    if (candidate !== null) {
      final = candidate;
    }
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
    reason: sawAssistant ? 'backend-assistant-not-final' : 'backend-assistant-missing',
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
): ProviderRecoveryResult {
  return {
    kind: 'deferred',
    observationTransport: 'deferred',
    responseMessageId: null,
    answerText: null,
    reason: 'backend-http-429',
    retryAfterMs: parseRetryAfterMs(headers, now),
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
