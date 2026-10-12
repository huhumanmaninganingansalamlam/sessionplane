import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';

import type { SessionSnapshot } from '../../src/domain/session.ts';
import {
  ChatGptBackendRecovery,
  parseRetryAfterMs,
  recoverExactServerFinal,
  recoverExactServerAcknowledgement,
  type BackendJsonClient,
  type BackendJsonResponse,
  type BackendRateLimitEvidence,
} from '../../src/providers/chatgpt/backend-recovery.ts';

const CONVERSATION_ID = 'conversation-backend-1';

test('late ACK uses durable dispatch identity among duplicate questions, never recency', () => {
  const old = [node('root', null, null), node('old-user', 'root', userMessage('old-user', 'old-turn')),
    node('old-final', 'old-user', finalAssistant('old-answer', 'Previous answer'))];
  const attempt = { conversationId: CONVERSATION_ID, messageId: 'new-user', parentMessageId: 'old-answer',
    textHash: createHash('sha256').update('Question').digest('hex'), observedAt: '2026-10-07T18:37:54.258Z' };
  const recover = (payload: unknown, attempts = [attempt]) =>
    recoverExactServerAcknowledgement(payload, CONVERSATION_ID, 'Question', attempts);
  assert.equal(recover(conversationPayload(old, 'old-final')), null, 'attempt alone is not ACK');
  const payload = conversationPayload([...old,
    node('new-user', 'old-final', userMessage('new-user', 'new-turn')),
    node('new-final', 'new-user', finalAssistant('new-answer', 'Original new answer'))], 'new-final');
  assert.equal(recoverExactServerAcknowledgement(payload, CONVERSATION_ID, 'Question'), null,
    'legacy duplicate prompts remain uncertain without dispatch evidence');
  const ack = recover(payload);
  assert.equal(ack?.submittedUserMessageId, 'new-user');
  assert.equal(recoverExactServerFinal(payload, ack!).responseMessageId, 'new-answer');
  assert.equal(recover(payload, [{ ...attempt, parentMessageId: 'wrong-parent' }]), null);
  assert.equal(recover(payload, [{ ...attempt, textHash: '0'.repeat(64) }]), null);
  assert.equal(recover(payload, [{ ...attempt, conversationId: 'other-conversation' }]), null);
  assert.equal(recover({ ...payload, current_node: 'old-final' }), null, 'another branch is not this ACK');
  assert.equal(recover(payload, [attempt, { ...attempt, messageId: 'old-user', parentMessageId: 'root' }]), null,
    'two dispatched identities must not be resolved by latest timestamp');
});

test('exact dispatch ACK and final never cross the next user turn', () => {
  const attempt = { conversationId: CONVERSATION_ID, messageId: 'user-message-1', parentMessageId: 'root',
    textHash: createHash('sha256').update('Question').digest('hex'), observedAt: '2026-10-07T18:37:54.258Z' };
  for (const originalFinal of [true, false]) {
    const first = { ...finalAssistant('answer-A', 'Answer A'),
      ...(originalFinal ? {} : { status: 'in_progress', end_turn: false }) };
    const payload = conversationPayload([
      node('root', null, null), node('user-A', 'root', userMessage('user-message-1', 'user-turn-1')),
      node('final-A', 'user-A', first), node('user-B', 'final-A', userMessage('user-message-B', 'user-turn-B')),
      node('final-B', 'user-B', finalAssistant('answer-B', 'Answer B')),
    ], 'final-B');
    const ack = recoverExactServerAcknowledgement(payload, CONVERSATION_ID, 'Question', [attempt]);
    assert.equal(ack?.submittedUserMessageId, 'user-message-1');
    for (const result of [recoverExactServerFinal(payload, identity()), recoverExactServerFinal(payload, ack!)]) {
      assert.equal(result.kind, originalFinal ? 'complete' : 'pending');
      assert.equal(result.responseMessageId, originalFinal ? 'answer-A' : null);
      assert.equal(result.answerText, originalFinal ? 'Answer A' : null);
      if (!originalFinal) assert.equal(result.reason, 'backend-next-user-turn-before-final');
    }
  }
});

test('backend recovery accepts only an exact final on the current branch', () => {
  const result = recoverExactServerFinal(
    conversationPayload([
      node('root', null, null),
      node('user-node', 'root', userMessage('user-message-1', 'user-turn-1')),
      node('assistant-node', 'user-node', finalAssistant('assistant-message-1', 'Exact server answer')),
    ], 'assistant-node'),
    identity(),
  );

  assert.equal(result.kind, 'complete');
  assert.equal(result.responseMessageId, 'assistant-message-1');
  assert.equal(result.answerText, 'Exact server answer');
});

test('direct final and ACK reject missing or conflicting conversation aliases even with the same message ID', () => {
  const branch = conversationPayload([
    node('root', null, null), node('user', 'root', userMessage('user-message-1', 'user-turn-1')),
    node('answer', 'user', finalAssistant('exact-answer', 'Original answer')),
  ], 'answer');
  for (const aliases of [
    { id: undefined, conversation_id: 'foreign-conversation' },
    { id: CONVERSATION_ID, conversation_id: 'foreign-conversation' },
    { id: 'foreign-conversation', conversation_id: CONVERSATION_ID },
    { id: undefined, conversation_id: undefined },
  ]) {
    const payload = { ...branch, ...aliases };
    const result = recoverExactServerFinal(payload, identity());
    assert.equal(result.kind, 'unverified');
    assert.equal(result.responseMessageId, null);
    assert.equal(result.answerText, null);
    assert.equal(recoverExactServerAcknowledgement(payload, CONVERSATION_ID, 'Question'), null);
  }
  const aliasOnly = { ...branch, id: undefined, conversation_id: CONVERSATION_ID };
  assert.equal(recoverExactServerFinal(aliasOnly, identity()).responseMessageId, 'exact-answer');
  assert.equal(recoverExactServerAcknowledgement(aliasOnly, CONVERSATION_ID, 'Question')?.submittedUserMessageId, 'user-message-1');
});

test('backend recovery rejects other branches and preserves the anchored turn before human follow-ups', () => {
  const historical = recoverExactServerFinal(
    conversationPayload([
      node('root', null, null),
      node('exact-user', 'root', userMessage('user-message-1', 'user-turn-1')),
      node('historical-final', 'exact-user', finalAssistant('historical-answer', 'Wrong branch')),
      node('other-user', 'root', userMessage('other-message', 'other-turn')),
      node('current-final', 'other-user', finalAssistant('current-answer', 'Other branch')),
    ], 'current-final'),
    identity(),
  );
  assert.equal(historical.kind, 'unverified');
  assert.equal(historical.reason, 'backend-user-anchor-not-on-current-branch');
  assert.equal(historical.answerText, null);
  const absent = recoverExactServerFinal(conversationPayload([
    node('root', null, null),
    node('other-user', 'root', userMessage('other-message', 'other-turn')),
    node('current-final', 'other-user', finalAssistant('user-message-1', 'Unrelated final')),
  ], 'current-final'), identity());
  assert.equal(absent.kind, 'unverified');
  assert.equal(absent.reason, 'backend-user-anchor-absent-from-mapping');
  assert.equal(absent.responseMessageId, null);
  assert.equal(absent.answerText, null);

  const laterUser = recoverExactServerFinal(
    conversationPayload([
      node('root', null, null),
      node('exact-user', 'root', userMessage('user-message-1', 'user-turn-1')),
      node('first-final', 'exact-user', finalAssistant('first-answer', 'First answer')),
      node('later-user', 'first-final', userMessage('later-message', 'later-turn')),
      node('later-final', 'later-user', finalAssistant('later-answer', 'Later answer')),
    ], 'later-final'),
    identity(),
  );
  assert.equal(laterUser.kind, 'complete');
  assert.equal(laterUser.responseMessageId, 'first-answer');
  assert.equal(laterUser.answerText, 'First answer');
  const pending = recoverExactServerFinal(conversationPayload([
    node('root', null, null),
    node('user', 'root', userMessage('user-message-1', 'user-turn-1')),
    node('old-final', 'user', finalAssistant('old-answer', 'Original answer')),
    node('human', 'old-final', userMessage('human-message', 'human-turn')),
  ], 'human'), identity());
  assert.equal(pending.kind, 'complete');
  assert.equal(pending.responseMessageId, 'old-answer');
  assert.equal(pending.answerText, 'Original answer');
});

test('backend recovery requires final channel, finished status, end_turn, and nonempty text', () => {
  const payload = conversationPayload([
    node('root', null, null),
    node('exact-user', 'root', userMessage('user-message-1', 'user-turn-1')),
    node('assistant', 'exact-user', {
      ...finalAssistant('assistant-message', ''),
      channel: 'analysis',
      status: 'in_progress',
      end_turn: false,
    }),
  ], 'assistant');
  const result = recoverExactServerFinal(payload, identity());
  assert.equal(result.kind, 'pending');
  assert.equal(result.reason, 'backend-assistant-not-final');
});

test('backend client caches access token in memory and classifies Retry-After 429', async () => {
  const now = new Date('2026-09-17T00:00:00.000Z');
  const responses: BackendJsonResponse[] = [
    { status: 200, headers: {}, body: { accessToken: 'memory-only-token' } },
    {
      status: 200,
      headers: {},
      body: conversationPayload([
        node('root', null, null),
        node('exact-user', 'root', userMessage('user-message-1', 'user-turn-1')),
        node('assistant', 'exact-user', finalAssistant('answer-1', 'Recovered once')),
      ], 'assistant'),
    },
    { status: 429, headers: { 'retry-after': '120' }, body: null },
  ];
  const urls: string[] = [];
  const evidence: BackendRateLimitEvidence[] = [];
  const client: BackendJsonClient = {
    async get(url): Promise<BackendJsonResponse> {
      urls.push(url);
      const response = responses.shift();
      if (response === undefined) throw new Error('Unexpected request');
      return response;
    },
  };
  const recovery = new ChatGptBackendRecovery({
    requestTimeoutMs: 1_000,
    tokenCacheTtlMs: 60_000,
    now: () => now,
    onRateLimit: (_request, value) => evidence.push(value),
  });
  const request = { session: sessionSnapshot(), generation: 1 } as const;

  assert.equal((await recovery.recover(request, client, 'https://chatgpt.com/')).kind, 'complete');
  const limited = await recovery.recover(request, client, 'https://chatgpt.com/');
  assert.equal(limited.kind, 'deferred');
  assert.equal(limited.reason, 'backend-http-429');
  assert.equal(limited.retryAfterMs, 120_000);
  assert.deepEqual(evidence, [{ status: 429, method: 'GET', endpointCategory: 'conversation-detail',
    receivedAt: now.toISOString(), source: 'sessionplane-backend-recovery', headers: { 'retry-after': '120' },
    retryAfterSource: 'valid-header', retryAfterDurationMs: 120_000 }]);
  assert.equal(urls.filter((url) => url.endsWith('/api/auth/session')).length, 1);
  assert.equal(parseRetryAfterMs({ 'Retry-After': '2' }, now), 2_000);
  assert.equal(
    parseRetryAfterMs({ 'retry-after': 'Thu, 17 Sep 2026 00:01:00 GMT' }, now),
    60_000,
  );
});

test('auth GET429 keeps its own safe provenance and cannot leak or create a conversation request', async () => {
  const evidence: BackendRateLimitEvidence[] = [], urls: string[] = [];
  const recovery = new ChatGptBackendRecovery({ requestTimeoutMs: 1000, tokenCacheTtlMs: 60000,
    now: () => new Date(0), onRateLimit: (_request, value) => evidence.push(value) });
  const client: BackendJsonClient = { async get(url) {
    urls.push(url);
    return { status: 429, headers: { 'set-cookie': 'private', authorization: 'private',
      'retry-after': 'invalid-private-value', 'x-ratelimit-scope': 'endpoint', 'x-ratelimit-remaining': '0' },
      body: { private: 'not retained' } };
  } };
  const result = await recovery.recover({ session: sessionSnapshot(), generation: 1 }, client, 'https://chatgpt.com');
  assert.equal(result.reason, 'backend-http-429');
  assert.equal(result.retryAfterMs, null);
  assert.deepEqual(urls, ['https://chatgpt.com/api/auth/session']);
  assert.deepEqual(evidence, [{ status: 429, method: 'GET', endpointCategory: 'auth-session',
    receivedAt: new Date(0).toISOString(), source: 'sessionplane-backend-recovery',
    headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-scope': 'endpoint' },
    retryAfterSource: 'header-invalid-fallback', retryAfterDurationMs: null }]);
});

test('backend acknowledgement requires one exact user prompt on the verified current branch', () => {
  const payload = conversationPayload([
    node('root', null, null),
    node('user-node', 'root', userMessage('user-message-1', 'user-turn-1')),
    node('assistant', 'user-node', finalAssistant('answer', 'Already complete')),
  ], 'assistant');
  const recover = (value: unknown, prompt = 'Question') => recoverExactServerAcknowledgement(value, CONVERSATION_ID, prompt);
  assert.equal(recover(payload)?.submittedUserMessageId, 'user-message-1');
  assert.equal(recover(payload)?.submittedUserTurnId, 'user-turn-1');
  assert.equal(recover(payload, 'Different prompt'), null);
  assert.equal(recover({ ...payload, id: 'other' }), null);
  assert.equal(recover({ ...payload, id: undefined }), null);
  assert.equal(recover({ ...payload, conversation_id: 'other' }), null);
  assert.equal(recover({ ...payload, current_node: 'missing' }), null);
  assert.equal(recover({ ...payload, current_node: 'root' }), null);
  assert.equal(recover(conversationPayload([
    ...Object.values(payload.mapping),
    node('duplicate', 'root', userMessage('other-user', 'other-turn')),
  ], 'assistant')), null);
  assert.equal(recover(conversationPayload([
    node('root', null, null),
    node('user', 'root', { ...userMessage('user', 'turn'), id: undefined }),
  ], 'user')), null);
});

test('backend acknowledgement preserves uncertainty and Retry-After without repeated probes', async () => {
  let now = 0;
  let calls = 0;
  const recovery = new ChatGptBackendRecovery({ requestTimeoutMs: 1000, tokenCacheTtlMs: 60000, now: () => new Date(now) });
  const client: BackendJsonClient = { async get(url) {
    calls++;
    return url.endsWith('/api/auth/session')
      ? { status: 200, headers: {}, body: { accessToken: 'memory-only-token' } }
      : { status: 429, headers: { 'retry-after': '120' }, body: null };
  } };
  assert.equal(await recovery.recoverAcknowledgement(CONVERSATION_ID, 'Question', client, 'https://chatgpt.com'), null);
  now = 6000;
  assert.equal(await recovery.recoverAcknowledgement(CONVERSATION_ID, 'Question', client, 'https://chatgpt.com'), null);
  assert.equal(calls, 2);
  now = 120001;
  assert.equal(await recovery.recoverAcknowledgement(CONVERSATION_ID, 'Question', client, 'https://chatgpt.com'), null);
  assert.equal(calls, 4);
});

function identity() {
  return {
    conversationId: CONVERSATION_ID,
    submittedUserMessageId: 'user-message-1',
    submittedUserTurnId: 'user-turn-1',
  } as const;
}

function conversationPayload(nodes: readonly Record<string, unknown>[], currentNode: string) {
  return {
    id: CONVERSATION_ID,
    current_node: currentNode,
    mapping: Object.fromEntries(nodes.map((entry) => [String(entry.id), entry])),
  };
}

function node(id: string, parent: string | null, message: Record<string, unknown> | null) {
  return { id, parent, children: [], message };
}

function userMessage(id: string, turnId: string) {
  return {
    id,
    turn_id: turnId,
    author: { role: 'user' },
    content: { parts: ['Question'] },
  };
}

function finalAssistant(id: string, text: string) {
  return {
    id,
    author: { role: 'assistant' },
    channel: 'final',
    status: 'finished_successfully',
    end_turn: true,
    content: { parts: [text] },
    metadata: {},
  };
}

function sessionSnapshot(): SessionSnapshot {
  return {
    requestOk: true,
    teamId: '11111111-1111-4111-8111-111111111111',
    roleId: '22222222-2222-4222-8222-222222222222',
    roleKey: 'main',
    sessionId: '33333333-3333-4333-8333-333333333333',
    predecessorSessionId: null,
    provider: 'chatgpt',
    generation: 1,
    sessionState: 'observing',
    providerState: 'unknown',
    observationTransport: 'stale',
    terminal: false,
    waitExpired: false,
    nextCheckAt: null,
    conversationId: CONVERSATION_ID,
    pageKey: 'page-backend',
    submittedUserMessageId: 'user-message-1',
    submittedUserTurnId: 'user-turn-1',
    responseMessageId: null,
    answerText: null,
    reason: null,
    errorCode: null,
    promptSubmitted: true,
  };
}
