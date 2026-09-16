import assert from 'node:assert/strict';
import test from 'node:test';

import type { SessionSnapshot } from '../../src/domain/session.ts';
import {
  ChatGptBackendRecovery,
  parseRetryAfterMs,
  recoverExactServerFinal,
  type BackendJsonClient,
  type BackendJsonResponse,
} from '../../src/providers/chatgpt/backend-recovery.ts';

const CONVERSATION_ID = 'conversation-backend-1';

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

test('backend recovery rejects historical branches and later user turns', () => {
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
  assert.equal(laterUser.kind, 'unverified');
  assert.equal(laterUser.reason, 'backend-later-user-turn');
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
  });
  const request = { session: sessionSnapshot(), generation: 1 } as const;

  assert.equal((await recovery.recover(request, client, 'https://chatgpt.com/')).kind, 'complete');
  const limited = await recovery.recover(request, client, 'https://chatgpt.com/');
  assert.equal(limited.kind, 'deferred');
  assert.equal(limited.reason, 'backend-http-429');
  assert.equal(limited.retryAfterMs, 120_000);
  assert.equal(urls.filter((url) => url.endsWith('/api/auth/session')).length, 1);
  assert.equal(parseRetryAfterMs({ 'Retry-After': '2' }, now), 2_000);
  assert.equal(
    parseRetryAfterMs({ 'retry-after': 'Thu, 17 Sep 2026 00:01:00 GMT' }, now),
    60_000,
  );
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
