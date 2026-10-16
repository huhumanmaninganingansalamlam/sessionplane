import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';

import type { SessionSnapshot } from '../../src/domain/session.ts';
import type { ProviderAcknowledgementRecoveryEvidence } from '../../src/providers/provider-adapter.ts';
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

test('explicit retained message ACK compares the full literal editor text, preserving whitespace and POST evidence', () => {
  const prompt = 'Required response:\n1) Keep **all** code: `a_b` and \\path\nURL https://example.test/a\\b vs literal <https://example.test/>\n[Brave 검색](https://search.brave.com/search?q=Android+tablet)과 [GitHub](https://api.github.com/search?q=receiver&sort=updated)\n\nFinal.';
  const serialized = 'Required response:\n1\\) Keep \\*\\*all\\*\\* code: \\`a\\_b\\` and \\\\path\nURL <https://example.test/a\\b> vs literal \\<https://example.test/\\>\n\\[Brave 검색\\]\\([https://search.brave.com/search?q=Android+tablet)과](https://search.brave.com/search?q=Android+tablet\\)과) \\[GitHub\\]\\([https://api.github.com/search?q=receiver&sort=updated](https://api.github.com/search?q=receiver\\&sort=updated))\n\nFinal\\.';
  const payload = conversationPayload([node('root', null, null),
    node('user-node', 'root', { ...userMessage('selected-user', 'selected-turn'), content: { content_type: 'text', parts: [serialized] } }),
    node('answer', 'user-node', finalAssistant('answer', 'Original PLAN'))], 'answer');
  const recover = (text: string, id?: string) => recoverExactServerAcknowledgement(payload, CONVERSATION_ID, text, undefined, id);
  assert.equal(recover(prompt), null, 'Automatic UNKNOWN recovery cannot assume a text encoding');
  assert.equal(recover(prompt, 'another-user'), null);
  const terminalBreak = recover(prompt + '\n', 'selected-user');
  assert.equal(terminalBreak?.submittedUserMessageId, 'selected-user');
  assert.equal(terminalBreak?.promptEncoding?.terminalLineBreakOmitted, true);
  assert.equal(recover(prompt + '\n\n', 'selected-user'), null, 'Multiple trailing blank lines are not discarded');
  assert.equal(recover(prompt + ' ', 'selected-user'), null, 'Trailing spaces remain significant');
  assert.equal(recover(prompt + '\n'), null, 'Automatic recovery cannot assume the editor omitted a final paragraph break');
  const ack = recover(prompt, 'selected-user');
  assert.equal(ack?.submittedUserMessageId, 'selected-user');
  assert.equal(ack?.evidence, 'backend-exact-editor-text');
  assert.equal(ack?.promptEncoding?.decodedTextSha256, createHash('sha256').update(prompt).digest('hex'));
  assert.equal(recoverExactServerFinal(payload, ack!).answerText, 'Original PLAN');
  assert.equal(recover(prompt.replace('Keep', 'Delete'), 'selected-user'), null);
  assert.equal(recover(prompt.replace('\n\n', '\n'), 'selected-user'), null, 'Blank lines are not collapsed');
  const wrongTarget = JSON.parse(JSON.stringify(payload));
  wrongTarget.mapping['user-node'].message.content.parts[0] = serialized.replace('tablet\\)과)', 'tablet\\)evil)');
  assert.equal(recoverExactServerAcknowledgement(wrongTarget, CONVERSATION_ID, prompt, undefined, 'selected-user'), null,
    'A link with a different destination is not the literal editor representation');
  assert.equal(recoverExactServerAcknowledgement(payload, CONVERSATION_ID, prompt, [{ conversationId: CONVERSATION_ID,
    messageId: 'selected-user', parentMessageId: 'root', textHash: '0'.repeat(64), observedAt: new Date(0).toISOString() }], 'selected-user'), null,
    'An incompatible captured POST hash remains authoritative');
});

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
  let clock = now.getTime();
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
    now: () => new Date(clock),
    onRateLimit: (_request, value) => evidence.push(value),
  });
  const request = { session: sessionSnapshot(), generation: 1 } as const;

  assert.equal((await recovery.recover(request, client, 'https://chatgpt.com/')).kind, 'complete');
  clock += 6000;
  const limited = await recovery.recover(request, client, 'https://chatgpt.com/');
  assert.equal(limited.kind, 'deferred');
  assert.equal(limited.reason, 'backend-http-429');
  assert.equal(limited.retryAfterMs, 120_000);
  assert.deepEqual(evidence, [{ status: 429, method: 'GET', endpointCategory: 'conversation-detail',
    receivedAt: new Date(clock).toISOString(), source: 'sessionplane-backend-recovery', headers: { 'retry-after': '120' },
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
  const evidence: ProviderAcknowledgementRecoveryEvidence[] = [];
  const inspect = () => recovery.recoverAcknowledgement(CONVERSATION_ID, 'Question', client, 'https://chatgpt.com',
    undefined, value => evidence.push(value));
  assert.equal(await inspect(), null);
  assert.equal(evidence.at(-1)?.source, 'backend');
  assert.equal(evidence.at(-1)?.httpStatus, 429);
  assert.equal(evidence.at(-1)?.endpointCategory, 'conversation-detail');
  assert.equal(evidence.at(-1)?.retryAfterMs, 120000);
  assert.equal(evidence.at(-1)?.retryAfterSource, 'valid-header');
  assert.equal(evidence.at(-1)?.candidateConversationId, CONVERSATION_ID);
  assert.equal(evidence.at(-1)?.nextCheckAt, new Date(120000).toISOString());
  now = 6000;
  assert.equal(await inspect(), null);
  assert.equal(evidence.at(-1)?.source, 'pacing');
  assert.equal(evidence.at(-1)?.httpStatus, null, 'a cached deferral is not another HTTP response');
  assert.equal(calls, 2);
  now = 120001;
  assert.equal(await inspect(), null);
  assert.equal(evidence.at(-1)?.source, 'backend');
  assert.equal(evidence.at(-1)?.httpStatus, 429);
  assert.equal(calls, 4);
});

test('ACK reads give the waiting conversation its turn without retaining a stopped caller', async () => {
  let now = 0;
  const reads: string[] = [];
  const recovery = new ChatGptBackendRecovery({ requestTimeoutMs: 1000, tokenCacheTtlMs: 60000, now: () => new Date(now) });
  const client: BackendJsonClient = { async get(url) {
    if (url.endsWith('/api/auth/session')) return { status: 200, headers: {}, body: { accessToken: 'memory-only-token' } };
    reads.push(url.split('/').at(-1)!);
    return { status: 200, headers: {}, body: { id: reads.at(-1), mapping: {} } };
  } };
  const evidence: ProviderAcknowledgementRecoveryEvidence[] = [];
  const inspect = (id: string) => recovery.recoverAcknowledgement(id, 'Question', client, 'https://chatgpt.com',
    undefined, value => evidence.push(value));
  await inspect('no-match');
  now = 1000; await inspect('waiting');
  now = 6000; await inspect('no-match');
  assert.equal(evidence.at(-1)?.reason, 'backend-acknowledgement-probe-queued');
  assert.deepEqual(reads, ['no-match'], 'the repeat reader cannot consume the waiting request slot');
  await inspect('waiting');
  assert.deepEqual(reads, ['no-match', 'waiting']);
  now = 7000; await inspect('stopped');
  now = 13000; await inspect('stopped');
  assert.equal(reads.length, 2, 'the stopped caller still has its allowed turn plus grace');
  now = 29001; await inspect('no-match');
  assert.deepEqual(reads, ['no-match', 'waiting', 'no-match'], 'a caller that stopped renewing cannot block recovery');
  const restarted = new ChatGptBackendRecovery({ requestTimeoutMs: 1000, tokenCacheTtlMs: 60000,
    now: () => new Date(now), acknowledgementRetryAtMs: 31000 });
  await restarted.recoverAcknowledgement('waiting', 'Question', client, 'https://chatgpt.com');
  assert.equal(reads.length, 3, 'restarting a controller must not bypass recorded Retry-After');
  now = 31001;
  await restarted.recoverAcknowledgement('waiting', 'Question', client, 'https://chatgpt.com');
  assert.equal(reads.at(-1), 'waiting');
  assert.equal(reads.length, 4);
});

test('ordinary collection cannot consume a waiting ACK slot or ignore its shared Retry-After', async () => {
  let now = 0;
  const reads: string[] = [];
  const recovery = new ChatGptBackendRecovery({ requestTimeoutMs: 1000, tokenCacheTtlMs: 60000, now: () => new Date(now) });
  const client: BackendJsonClient = { async get(url) {
    if (url.endsWith('/api/auth/session')) return { status: 200, headers: {}, body: { accessToken: 'memory-only-token' } };
    const id = url.split('/').at(-1)!;
    reads.push(id);
    if (id === 'ongoing-generation' && now >= 12000) return { status: 429, headers: { 'retry-after': '50' }, body: null };
    return { status: 200, headers: {}, body: { ...conversationPayload([node('root', null, null),
      node('user', 'root', userMessage('user-message-1', 'user-turn-1')),
      node('answer', 'user', finalAssistant('answer', 'Original result'))], 'answer'), id } };
  } };
  const request = { session: { ...sessionSnapshot(), conversationId: 'ongoing-generation' }, generation: 1 } as const;
  const collect = () => recovery.recover(request, client, 'https://chatgpt.com');
  const ack = () => recovery.recoverAcknowledgement(CONVERSATION_ID, 'Question', client, 'https://chatgpt.com');
  assert.equal((await collect()).kind, 'complete');
  now = 1000;
  assert.equal(await ack(), null);
  now = 6000;
  assert.equal((await collect()).kind, 'deferred', 'An ordinary read cannot race ahead of an ACK already waiting');
  assert.deepEqual(reads, ['ongoing-generation']);
  assert.equal((await ack())?.submittedUserMessageId, 'user-message-1');
  now = 12000;
  assert.equal((await collect()).reason, 'backend-http-429');
  now = 13000;
  assert.equal(await ack(), null);
  assert.deepEqual(reads, ['ongoing-generation', CONVERSATION_ID, 'ongoing-generation']);
  now = 62001;
  assert.equal((await collect()).kind, 'deferred', 'A client honoring a long server delay retains its queue slot');
  assert.equal((await ack())?.submittedUserMessageId, 'user-message-1');
  assert.deepEqual(reads, ['ongoing-generation', CONVERSATION_ID, 'ongoing-generation', CONVERSATION_ID]);
});

test('explicit selected ACK gets the next permitted read ahead of background UNKNOWN polling', async () => {
  let now = 0;
  const reads: string[] = [];
  const recovery = new ChatGptBackendRecovery({ requestTimeoutMs: 1000, tokenCacheTtlMs: 60000, now: () => new Date(now) });
  const client: BackendJsonClient = { async get(url) {
    if (url.endsWith('/api/auth/session')) return { status: 200, headers: {}, body: { accessToken: 'memory-only-token' } };
    reads.push(url.split('/').at(-1)!);
    return { status: 429, headers: { 'retry-after': '50' }, body: null };
  } };
  const ack = (id: string, selected?: string) => recovery.recoverAcknowledgement(id, 'Question', client, 'https://chatgpt.com', undefined, undefined, selected);
  await ack('background');
  now = 1000; await ack('background');
  now = 2000; await ack('selected', 'original-user');
  assert.deepEqual(reads, ['background'], 'An explicit selection never bypasses Retry-After');
  now = 50001;
  await ack('background');
  assert.deepEqual(reads, ['background'], 'Repeated background no-match recovery must leave the interactive read available');
  await ack('selected', 'original-user');
  assert.deepEqual(reads, ['background', 'selected']);
});

test('canonical ACK evidence separates no match and access rejection from a recovered original answer', async () => {
  let now = 0;
  let status = 200;
  let payload = conversationPayload([node('root', null, null)], 'root');
  const evidence: ProviderAcknowledgementRecoveryEvidence[] = [];
  const recovery = new ChatGptBackendRecovery({ requestTimeoutMs: 1000, tokenCacheTtlMs: 60000, now: () => new Date(now) });
  const client: BackendJsonClient = { async get(url) {
    return url.endsWith('/api/auth/session') ? { status: 200, headers: {}, body: { accessToken: 'memory-only-token' } }
      : { status, headers: {}, body: payload };
  } };
  const inspect = () => recovery.recoverAcknowledgement(CONVERSATION_ID, 'Question', client, 'https://chatgpt.com',
    undefined, value => evidence.push(value));
  assert.equal(await inspect(), null);
  assert.equal(evidence.at(-1)?.reason, 'backend-exact-prompt-absent');
  assert.equal(evidence.at(-1)?.httpStatus, 200);
  assert.equal(evidence.at(-1)?.promptMatchCount, 0);
  now += 6000; status = 403;
  assert.equal(await inspect(), null);
  assert.equal(evidence.at(-1)?.kind, 'unavailable');
  assert.equal(evidence.at(-1)?.httpStatus, 403);
  assert.equal(evidence.at(-1)?.reason, 'backend-auth-rejected');
  now += 6000; status = 200;
  payload = conversationPayload([node('root', null, null),
    node('user-node', 'root', { ...userMessage('original-user', 'original-turn'), content: { content_type: 'text', parts: ['Question\n'] } })], 'user-node');
  assert.equal(await recovery.recoverAcknowledgement(CONVERSATION_ID, 'Question', client, 'https://chatgpt.com',
    undefined, value => evidence.push(value), 'original-user'), null);
  assert.equal(evidence.at(-1)?.selectedMessageComparison?.whitespaceOnlyDifference, true);
  assert.equal(evidence.at(-1)?.selectedMessageComparison?.firstDifference, 8);
  assert.equal(evidence.at(-1)?.selectedMessageComparison?.textLength, 9);
  now += 6000; status = 200;
  payload = conversationPayload([node('root', null, null),
    node('user-node', 'root', userMessage('original-user', 'original-turn')),
    node('answer-node', 'user-node', finalAssistant('original-answer', 'Original result'))], 'answer-node');
  const acknowledgement = await inspect();
  assert.equal(acknowledgement?.submittedUserMessageId, 'original-user');
  assert.equal(recoverExactServerFinal(payload, acknowledgement!).answerText, 'Original result');
  assert.equal(evidence.length, 3, 'successful recovery does not retain a new failure');
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
