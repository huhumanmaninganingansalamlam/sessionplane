import type { ProviderSubmissionAttempt, ProviderServerObservation, ProviderSubmissionAcknowledgement, ProviderRecoveryResult } from '../provider-adapter.ts';
import { createHash } from 'node:crypto';
import { limitationHeaders } from './rate-limit-evidence.ts';
import type { BackendRateLimitEvidence } from './backend-recovery.ts';
export function trustedOrigin(value: string): string | null {
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

export function matchesLiteralEditorText(text: string, prompt: string): boolean {
  const decoded = decodeLiteralMarkdown(text);
  return decoded === prompt || (decoded !== text && prompt.endsWith('\n') &&
    !prompt.endsWith('\n\n') && decoded === prompt.slice(0, -1));
}

export function decodeLiteralMarkdown(text: string): string {
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

export function exactServerFinal(
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

export function isExactSubmittedUser(
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

export function messageForNode(value: unknown): Readonly<Record<string, unknown>> | null {
  if (!isRecord(value) || !isRecord(value.message)) {
    return null;
  }
  return value.message;
}

export function messageRole(message: Readonly<Record<string, unknown>>): string | null {
  return isRecord(message.author) ? readStringField(message.author, 'role') : null;
}

export function messageText(message: Readonly<Record<string, unknown>>): string {
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

export function rateLimited(
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
  const deferred: ProviderRecoveryResult = {
    kind: 'deferred',
    observationTransport: 'deferred',
    responseMessageId: null,
    answerText: null,
    reason: 'backend-http-429',
    retryAfterMs,
    nextCheckAt: null,
  };
  try {
    observe?.({ status: 429, method: 'GET', endpointCategory, receivedAt: now.toISOString(),
      source: 'sessionplane-backend-recovery', headers: safeHeaders,
      retryAfterSource: retryAfterMs !== null ? 'valid-header' : header === undefined ? 'header-absent-fallback' : 'header-invalid-fallback',
      retryAfterDurationMs: retryAfterMs });
  } catch { return deferred; /* 429 still takes precedence over unavailable telemetry. */ }
  return deferred;
}

export function unavailable(reason: string): ProviderRecoveryResult {
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

export function unverified(reason: string): ProviderRecoveryResult {
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

export function readStringField(value: unknown, key: string): string | null {
  if (!isRecord(value)) {
    return null;
  }
  const field = value[key];
  return typeof field === 'string' ? field : null;
}

export function readNullableStringField(
  value: Readonly<Record<string, unknown>>,
  key: string,
): string | null {
  const field = value[key];
  return field === null || typeof field === 'string' ? field : null;
}

export function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
