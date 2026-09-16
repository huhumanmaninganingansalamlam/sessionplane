import assert from 'node:assert/strict';
import test from 'node:test';

import type { ProviderObservationEvidence } from '../../src/providers/provider-adapter.ts';
import { ExactFinalTracker } from '../../src/providers/chatgpt/exact-final.ts';

test('exact final accepts a terminal assistant only after the exact submitted user', () => {
  const tracker = new ExactFinalTracker(1_000);
  const result = tracker.evaluate(
    evidence({
      candidate: {
        responseMessageId: 'assistant-1',
        answerText: 'Final answer',
        terminalMarker: true,
        streamingMarker: false,
      },
    }),
    0,
  );

  assert.equal(result.kind, 'complete');
  assert.equal(result.responseMessageId, 'assistant-1');
  assert.equal(result.answerText, 'Final answer');
});

test('quiet stability can finish despite an unverified stale stop control', () => {
  const tracker = new ExactFinalTracker(1_000);
  const candidate = {
    responseMessageId: 'assistant-stable',
    answerText: 'Stable answer',
    terminalMarker: false,
    streamingMarker: false,
  } as const;

  assert.equal(
    tracker.evaluate(evidence({ candidate, activity: 'weak' }), 0).kind,
    'progress',
  );
  assert.equal(
    tracker.evaluate(evidence({ candidate, activity: 'weak' }), 999).kind,
    'progress',
  );
  assert.equal(
    tracker.evaluate(evidence({ candidate, activity: 'weak' }), 1_000).kind,
    'complete',
  );
});

test('later user turns and network-only evidence never publish a final', () => {
  const laterUser = new ExactFinalTracker(10).evaluate(
    evidence({
      laterUserFound: true,
      candidate: {
        responseMessageId: 'historical-assistant',
        answerText: 'Historical answer',
        terminalMarker: true,
        streamingMarker: false,
      },
    }),
    100,
  );
  assert.equal(laterUser.kind, 'unverified');
  assert.equal(laterUser.reason, 'dom-later-user-turn');

  const networkOnly = new ExactFinalTracker(10).evaluate(
    evidence({ candidate: null, networkActivity: true }),
    100,
  );
  assert.equal(networkOnly.kind, 'progress');
  assert.equal(networkOnly.responseMessageId, null);
  assert.equal(networkOnly.answerText, null);
});

test('visible rate-limit dialogs are blocked but answer text is not a dialog', () => {
  const normalAnswer = new ExactFinalTracker(10).evaluate(
    evidence({
      candidate: {
        responseMessageId: 'assistant-rate-limit-text',
        answerText: 'The documentation explains how rate limits work.',
        terminalMarker: true,
        streamingMarker: false,
      },
      dialogKind: null,
    }),
    0,
  );
  assert.equal(normalAnswer.kind, 'complete');

  const visibleDialog = new ExactFinalTracker(10).evaluate(
    evidence({ dialogKind: 'rate_limit' }),
    0,
  );
  assert.equal(visibleDialog.kind, 'blocked');
});

test('strong current-turn activity prevents quiet completion', () => {
  const tracker = new ExactFinalTracker(10);
  const active = evidence({
    activity: 'strong',
    candidate: {
      responseMessageId: 'assistant-streaming',
      answerText: 'Partial answer',
      terminalMarker: false,
      streamingMarker: true,
    },
  });
  assert.equal(tracker.evaluate(active, 0).kind, 'progress');
  assert.equal(tracker.evaluate(active, 10_000).kind, 'progress');
});

function evidence(
  overrides: Partial<ProviderObservationEvidence> = {},
): ProviderObservationEvidence {
  return {
    provider: 'chatgpt',
    pageKey: 'page-1',
    bindingEpoch: 1,
    observedAt: '2026-09-17T00:00:00.000Z',
    conversationId: 'conversation-1',
    submittedUserFound: true,
    laterUserFound: false,
    candidate: null,
    activity: 'none',
    dialogKind: null,
    networkActivity: false,
    observationTransport: 'fresh',
    reason: null,
    ...overrides,
  };
}
