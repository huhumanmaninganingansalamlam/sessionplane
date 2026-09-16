import assert from 'node:assert/strict';
import test from 'node:test';

import { reduceWaitState } from '../../src/core/wait-reducer.ts';
import type { SessionSnapshot } from '../../src/domain/session.ts';

const BASE_SNAPSHOT: SessionSnapshot = {
  requestOk: true,
  teamId: 'team-1',
  roleId: 'role-1',
  roleKey: 'main',
  sessionId: 'session-1',
  predecessorSessionId: null,
  provider: 'chatgpt',
  generation: 3,
  sessionState: 'observing',
  providerState: 'generating',
  observationTransport: 'fresh',
  terminal: false,
  waitExpired: false,
  nextCheckAt: null,
  conversationId: 'conversation-1',
  pageKey: 'page-1',
  submittedUserMessageId: 'user-message-1',
  submittedUserTurnId: 'user-turn-1',
  responseMessageId: null,
  answerText: null,
  reason: null,
  errorCode: null,
  promptSubmitted: true,
};

test('client wait expiry decorates a snapshot without terminalizing provider work', () => {
  const reduced = reduceWaitState({ snapshot: BASE_SNAPSHOT, clientWaitExpired: true });
  assert.equal(reduced.waitExpired, true);
  assert.equal(reduced.terminal, false);
  assert.equal(reduced.sessionState, 'observing');
  assert.equal(reduced.providerState, 'generating');
});

test('session deadline without fresh exact progress becomes unknown and nonterminal', () => {
  const reduced = reduceWaitState({
    snapshot: BASE_SNAPSHOT,
    clientWaitExpired: false,
    sessionDeadlineExpired: true,
    freshExactProgress: false,
  });
  assert.equal(reduced.terminal, false);
  assert.equal(reduced.sessionState, 'observing');
  assert.equal(reduced.providerState, 'unknown');
  assert.equal(reduced.reason, 'session-deadline-unverified');
});

test('terminal completion is monotonic even when the client wait deadline also expires', () => {
  const complete: SessionSnapshot = {
    ...BASE_SNAPSHOT,
    sessionState: 'complete',
    providerState: 'complete',
    terminal: true,
    answerText: 'done',
  };
  const reduced = reduceWaitState({
    snapshot: complete,
    clientWaitExpired: true,
    sessionDeadlineExpired: true,
  });
  assert.equal(reduced.terminal, true);
  assert.equal(reduced.sessionState, 'complete');
  assert.equal(reduced.answerText, 'done');
  assert.equal(reduced.waitExpired, false);
});

