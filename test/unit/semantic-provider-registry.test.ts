import assert from 'node:assert/strict';
import test from 'node:test';

import { ChatGptSemanticAdapter } from '../../src/providers/chatgpt/semantic-adapter.ts';
import { SemanticProviderRegistry } from '../../src/providers/semantic-provider-registry.ts';
import type {
  SemanticActRequest, SemanticActResult, SemanticExactQuery, SemanticObservation,
  SemanticProviderAdapter, SemanticTaskContext, SemanticVerification,
} from '../../src/providers/semantic-adapter.ts';

class FakeNonBrowserAdapter implements SemanticProviderAdapter {
  readonly providerKey = 'remote-fixture';
  readonly capabilities = {
    providerKey: this.providerKey, browserRequired: false, contractVersion: 1 as const,
    supports: ['conversation', 'artifact_read'] as const,
  };
  async observe(context: SemanticTaskContext): Promise<SemanticObservation> {
    assert.equal(context.pageLease, null, 'API/non-browser providers never fabricate Chrome leases');
    const result: SemanticObservation = {
      providerKey: this.providerKey, surface: 'unknown',
      snapshotId: 'remote-read', observedAt: new Date(0).toISOString(),
      capabilityManifest: this.capabilities, progress: 'idle', blocker: 'none',
      reason: null, questionText: null,
      turn: { submittedUserFound: true, laterUserFound: false,
        submittedUserMessageId: context.submittedUserMessageId,
        answerMessageId: null, partialAnswer: null },
      actions: [], evidenceBytes: 0,
    };
    return result;
  }
  async act(_request: SemanticActRequest): Promise<SemanticActResult> {
    return { kind: 'unsupported', reason: 'read-only-test-adapter' };
  }
  async verify(query: SemanticExactQuery): Promise<SemanticVerification> {
    return this.recover(query);
  }
  async recover(query: SemanticExactQuery): Promise<SemanticVerification> {
    assert.equal(query.context.pageLease, null);
    return { kind: 'exact_final', externalTurnId: query.context.submittedUserTurnId!,
      answerText: 'Other provider exact answer' };
  }
}

test('ChatGPT B-first and future browserless providers share a capability-negotiated port', async () => {
  const chatgpt = new ChatGptSemanticAdapter({
    isExactLease: () => false,
    resolvePage: () => { throw new Error('fixture must not open a Chrome page'); },
  });
  const remote = new FakeNonBrowserAdapter();
  const registry = new SemanticProviderRegistry([chatgpt, remote]);
  const b = registry.resolve('chatgpt', 'conversation');
  assert.equal(b.kind, 'available');
  if (b.kind === 'available') {
    assert.equal(b.adapter.capabilities.browserRequired, true);
    assert.equal(b.adapter.capabilities.contractVersion, 1);
  }
  assert.deepEqual(registry.resolve('remote-fixture', 'permission'), {
    kind: 'unsupported', reason: 'capability_not_supported',
  });
  assert.deepEqual(registry.resolve('missing-provider', 'conversation'), {
    kind: 'unsupported', reason: 'provider_not_registered',
  });
  const r = registry.resolve('remote-fixture', 'conversation');
  assert.equal(r.kind, 'available');
  if (r.kind !== 'available') throw new Error('missing provider');
  const context: SemanticTaskContext = {
    projectId: 'p', slotId: 'review', slotRevision: 2, taskId: 't',
    providerConversationId: 'other-convo', submittedUserMessageId: 'other-user',
    submittedUserTurnId: 'other-turn', pageLease: null,
  };
  assert.equal((await r.adapter.observe(context)).providerKey, 'remote-fixture');
  assert.deepEqual(await r.adapter.recover({ context, kind: 'final' }), {
    kind: 'exact_final', externalTurnId: 'other-turn',
    answerText: 'Other provider exact answer',
  });
  assert.throws(() => new SemanticProviderRegistry([chatgpt, chatgpt]),
    /Duplicate semantic provider/);
});
