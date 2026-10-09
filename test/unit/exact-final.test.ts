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

test('Stop or thinking cannot quiet-finalize an announcement; idle stability starts after activity ends', () => {
  const tracker = new ExactFinalTracker(1_000);
  const candidate = { responseMessageId: 'announcement', answerText: 'I will inspect the evidence.',
    terminalMarker: false, streamingMarker: false };
  for (const now of [0, 999, 10_000]) {
    const result = tracker.evaluate(evidence({ candidate, activity: 'weak' }), now);
    assert.equal(result.kind, 'progress');
    assert.equal(result.answerText, null);
  }
  assert.equal(tracker.evaluate(evidence({ candidate }), 10_001).kind, 'progress');
  assert.equal(tracker.evaluate(evidence({ candidate }), 11_001).kind, 'complete');
  assert.equal(new ExactFinalTracker(1_000).evaluate(evidence({ candidate: {
    ...candidate, terminalMarker: true }, activity: 'weak' }), 0).kind, 'complete');
});

test('next user turn requires an original terminal candidate; network activity alone is not final', () => {
  const tracker = new ExactFinalTracker(10);
  const waiting = tracker.evaluate(evidence({ laterUserFound: true, candidate: null }), 0);
  assert.equal(waiting.kind, 'unverified');
  assert.equal(waiting.reason, 'dom-next-user-turn-before-final');
  const continued = tracker.evaluate(evidence({ laterUserFound: true, candidate: {
    responseMessageId: 'original-answer', answerText: 'Original answer before human follow-up',
    terminalMarker: true, streamingMarker: false,
  } }), 100);
  assert.equal(continued.kind, 'complete');
  assert.equal(continued.responseMessageId, 'original-answer');
  for (const now of [0, 100]) {
    const partial = tracker.evaluate(evidence({ laterUserFound: true, candidate: {
      responseMessageId: 'partial-answer', answerText: 'Incomplete original answer',
      terminalMarker: false, streamingMarker: false,
    } }), now);
    assert.equal(partial.kind, 'unverified');
    assert.equal(partial.answerText, null, 'quiet time cannot finalize a partial before another user');
  }

  const networkOnly = new ExactFinalTracker(10).evaluate(
    evidence({ candidate: null, networkActivity: true }),
    100,
  );
  assert.equal(networkOnly.kind, 'progress');
  assert.equal(networkOnly.responseMessageId, null);
  assert.equal(networkOnly.answerText, null);
  assert.equal(networkOnly.freshExactProgress, false);
  assert.equal(
    new ExactFinalTracker(10).evaluate(evidence({ candidate: null, activity: 'strong' }), 100)
      .freshExactProgress,
    false,
  );
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
  assert.equal(tracker.evaluate(active, 10_000).freshExactProgress, false);
});

test('request placeholder messages can never become final answers', () => {
  const tracker = new ExactFinalTracker(10);
  const placeholder = evidence({
    candidate: {
      responseMessageId: 'request-placeholder-request-conversation-0',
      answerText: '생각 중...',
      terminalMarker: true,
      streamingMarker: false,
    },
  });

  const first = tracker.evaluate(placeholder, 0);
  const later = tracker.evaluate(placeholder, 10_000);
  assert.equal(first.kind, 'progress');
  assert.equal(first.reason, 'assistant-placeholder-active');
  assert.equal(first.answerText, null);
  assert.equal(later.kind, 'progress');
  assert.equal(later.answerText, null);
});

test('connection-loss placeholder stays unverified until a real answer arrives', () => {
  const tracker = new ExactFinalTracker(10);
  const interrupted = evidence({
    candidate: {
      responseMessageId: 'assistant-interrupted',
      answerText: '연결이 끊어졌습니다. 전체 답변을 기다리는 중입니다',
      terminalMarker: true,
      streamingMarker: false,
    },
  });
  assert.equal(tracker.evaluate(interrupted, 0).reason, 'provider-connection-lost-placeholder');
  assert.equal(tracker.evaluate(interrupted, 1_000).kind, 'unverified');

  const recovered = evidence({
    candidate: {
      responseMessageId: 'assistant-recovered',
      answerText: 'VERDICT: APPROVE',
      terminalMarker: true,
      streamingMarker: false,
    },
  });
  assert.equal(tracker.evaluate(recovered, 1_001).kind, 'complete');
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
