import { createHash } from 'node:crypto';
import path from 'node:path';

import type { Page } from 'playwright-core';

import { SessionPlaneDomainError } from '../../domain/errors.ts';
import type {
  ProviderCodeArtifactCandidate,
  ProviderCodeArtifactDownload,
} from '../provider-adapter.ts';

const ZIP_PATH_PATTERN = /\/mnt\/data\/[A-Za-z0-9_.\-/]+\.zip/g;

interface ConversationMessage {
  readonly id?: unknown;
  readonly author?: { readonly role?: unknown };
  readonly create_time?: unknown;
  readonly update_time?: unknown;
  readonly content?: { readonly content_type?: unknown; readonly [key: string]: unknown };
}

interface ConversationNode {
  readonly message?: ConversationMessage | null;
}

interface ConversationDocument {
  readonly mapping?: Readonly<Record<string, ConversationNode>>;
}

export function scanChatGptConversationForCodeArtifacts(
  conversationId: string,
  value: unknown,
): readonly ProviderCodeArtifactCandidate[] {
  const conversation = asConversation(value);
  const paths: string[] = [];
  const pathSet = new Set<string>();
  const candidateMessageIds: string[] = [];
  const messageIdSet = new Set<string>();
  for (const message of orderedMessages(conversation)) {
    const role = typeof message.author?.role === 'string' ? message.author.role : '';
    const contentType =
      typeof message.content?.content_type === 'string'
        ? message.content.content_type
        : '';
    if (role !== 'user' && contentType !== 'code') {
      const serialized = JSON.stringify(message.content ?? {});
      for (const match of serialized.match(ZIP_PATH_PATTERN) ?? []) {
        if (isSafeSandboxZipPath(match) && !pathSet.has(match)) {
          pathSet.add(match);
          paths.push(match);
        }
      }
    }
    if (
      (contentType === 'code' || contentType === 'execution_output') &&
      typeof message.id === 'string' &&
      message.id.length > 0 &&
      !messageIdSet.has(message.id)
    ) {
      messageIdSet.add(message.id);
      candidateMessageIds.push(message.id);
    }
  }
  return Object.freeze(
    paths.map((sandboxPath) => {
      const digest = createHash('sha256')
        .update(`${conversationId}\u0000${sandboxPath}`)
        .digest('hex')
        .slice(0, 32);
      return Object.freeze({
        providerArtifactId: `chatgpt-code-${digest}`,
        name: path.posix.basename(sandboxPath),
        sandboxPath,
        candidateMessageIds: Object.freeze([...candidateMessageIds]),
        mediaType: 'application/zip' as const,
      });
    }),
  );
}

function isSafeSandboxZipPath(value: string): boolean {
  if (!value.startsWith('/mnt/data/') || value.includes('\\') || value.includes('\u0000')) {
    return false;
  }
  const relative = value.slice('/mnt/data/'.length);
  const components = relative.split('/');
  if (
    relative.length === 0 ||
    components.some((component) => component === '' || component === '.' || component === '..')
  ) {
    return false;
  }
  return path.posix.normalize(value) === value && value.toLowerCase().endsWith('.zip');
}

export async function discoverChatGptCodeArtifacts(
  page: Page,
  conversationId: string,
): Promise<readonly ProviderCodeArtifactCandidate[]> {
  const conversation = await fetchConversation(page, conversationId);
  return scanChatGptConversationForCodeArtifacts(conversationId, conversation);
}

export async function downloadChatGptCodeArtifact(
  page: Page,
  conversationId: string,
  candidate: ProviderCodeArtifactCandidate,
  maxBytes: number,
): Promise<ProviderCodeArtifactDownload> {
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) {
    throw new SessionPlaneDomainError('input.invalid', 'maxBytes must be a positive integer');
  }
  for (const messageId of [...candidate.candidateMessageIds].reverse()) {
    const result = await page.evaluate(
      async ({ conversationId: id, messageId: mid, sandboxPath, limit }) => {
        const auth = await fetch('/api/auth/session').catch(() => null);
        if (auth === null || !auth.ok) {
          return { kind: 'auth' as const, status: auth?.status ?? 0 };
        }
        const session = (await auth.json().catch(() => null)) as
          | { accessToken?: string }
          | null;
        if (session?.accessToken === undefined) {
          return { kind: 'auth' as const, status: 401 };
        }
        const mintUrl =
          `/backend-api/conversation/${encodeURIComponent(id)}/interpreter/download` +
          `?message_id=${encodeURIComponent(mid)}` +
          `&sandbox_path=${encodeURIComponent(sandboxPath)}`;
        const mint = await fetch(mintUrl, {
          headers: { Authorization: `Bearer ${session.accessToken}` },
        }).catch(() => null);
        if (mint === null || !mint.ok) {
          return { kind: 'mint' as const, status: mint?.status ?? 0 };
        }
        const body = (await mint.json().catch(() => null)) as
          | { download_url?: string }
          | null;
        if (body?.download_url === undefined) {
          return { kind: 'mint' as const, status: mint.status };
        }
        const response = await fetch(body.download_url, { credentials: 'include' }).catch(
          () => null,
        );
        if (response === null || !response.ok) {
          return { kind: 'download' as const, status: response?.status ?? 0 };
        }
        const declared = Number(response.headers.get('content-length') ?? '0');
        if (Number.isFinite(declared) && declared > limit) {
          return { kind: 'too-large' as const, sizeBytes: declared };
        }
        const bytes = new Uint8Array(await response.arrayBuffer());
        if (bytes.byteLength > limit) {
          return { kind: 'too-large' as const, sizeBytes: bytes.byteLength };
        }
        let binary = '';
        const chunkSize = 0x8000;
        for (let offset = 0; offset < bytes.length; offset += chunkSize) {
          binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
        }
        return { kind: 'ok' as const, base64: btoa(binary), sizeBytes: bytes.byteLength };
      },
      {
        conversationId,
        messageId,
        sandboxPath: candidate.sandboxPath,
        limit: maxBytes,
      },
    );
    if (result.kind === 'too-large') {
      throw new SessionPlaneDomainError(
        'provider.artifact-too-large',
        `ChatGPT code artifact exceeds ${maxBytes} bytes`,
        { sizeBytes: result.sizeBytes, limitBytes: maxBytes },
      );
    }
    if (result.kind === 'auth') {
      throw new SessionPlaneDomainError(
        'provider.authentication-required',
        'ChatGPT authentication is required to retrieve code artifacts',
      );
    }
    if (result.kind === 'ok') {
      return {
        candidate,
        bytes: Uint8Array.from(Buffer.from(result.base64, 'base64')),
        mintedMessageId: messageId,
      };
    }
  }
  throw new SessionPlaneDomainError(
    'provider.artifact-download-failed',
    `ChatGPT did not mint a downloadable URL for ${candidate.sandboxPath}`,
  );
}

async function fetchConversation(page: Page, conversationId: string): Promise<unknown> {
  const result = await page.evaluate(async (id) => {
    const auth = await fetch('/api/auth/session').catch(() => null);
    if (auth === null || !auth.ok) {
      return {
        kind: 'auth' as const,
        status: auth?.status ?? 0,
        retryAfter: auth?.headers.get('retry-after') ?? null,
      };
    }
    const session = (await auth.json().catch(() => null)) as
      | { accessToken?: string }
      | null;
    if (session?.accessToken === undefined) {
      return { kind: 'auth' as const, status: 401, retryAfter: null };
    }
    const response = await fetch(`/backend-api/conversation/${encodeURIComponent(id)}`, {
      headers: { Authorization: `Bearer ${session.accessToken}` },
    }).catch(() => null);
    if (response === null) {
      return { kind: 'transport' as const, status: 0, retryAfter: null };
    }
    if (!response.ok) {
      return {
        kind: 'transport' as const,
        status: response.status,
        retryAfter: response.headers.get('retry-after'),
      };
    }
    return {
      kind: 'ok' as const,
      status: response.status,
      retryAfter: null,
      body: await response.json().catch(() => null),
    };
  }, conversationId);
  if (result.kind === 'ok' && result.body !== null) return result.body;
  if (result.status === 429) {
    throw new SessionPlaneDomainError(
      'provider.backend-deferred',
      'ChatGPT conversation retrieval was deferred by HTTP 429',
      { retryAfter: result.retryAfter },
    );
  }
  if (result.kind === 'auth') {
    throw new SessionPlaneDomainError(
      'provider.authentication-required',
      'ChatGPT authentication is required to inspect code artifacts',
    );
  }
  throw new SessionPlaneDomainError(
    'provider.artifacts-unavailable',
    `ChatGPT conversation retrieval failed with status ${result.status}`,
  );
}

function asConversation(value: unknown): ConversationDocument {
  if (value === null || typeof value !== 'object') return {};
  const mapping = (value as { mapping?: unknown }).mapping;
  if (mapping === null || typeof mapping !== 'object' || Array.isArray(mapping)) return {};
  return { mapping: mapping as Readonly<Record<string, ConversationNode>> };
}

function orderedMessages(conversation: ConversationDocument): readonly ConversationMessage[] {
  return Object.values(conversation.mapping ?? {})
    .map((node, index) => ({ message: node.message ?? null, index }))
    .filter(
      (entry): entry is { readonly message: ConversationMessage; readonly index: number } =>
        entry.message !== null && typeof entry.message === 'object',
    )
    .sort((left, right) => {
      const leftTime = messageTime(left.message);
      const rightTime = messageTime(right.message);
      if (leftTime !== null && rightTime !== null && leftTime !== rightTime) {
        return leftTime - rightTime;
      }
      if (leftTime !== null && rightTime === null) return -1;
      if (leftTime === null && rightTime !== null) return 1;
      return left.index - right.index;
    })
    .map((entry) => entry.message);
}

function messageTime(message: ConversationMessage): number | null {
  const value = message.create_time ?? message.update_time;
  const number = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(number) ? number : null;
}
