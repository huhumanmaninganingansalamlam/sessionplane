import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveConfig } from '../../src/config.ts';
import { startCore } from '../../src/main.ts';

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
test('Core composes the semantic ChatGPT provider without launching a separate browser', async () => {
  const root = mkdtempSync(join(tmpdir(), 'sessionplane-semantic-composition-'));
  const config = resolveConfig({ cwd: root, env: {}, stateDir: '.state' });
  let core: Awaited<ReturnType<typeof startCore>> | null = null;
  try {
    core = await startCore({
      config, startBrowser: false,
      logger: { debug() {}, info() {}, warn() {}, error() {} },
    });
    assert.equal(core.browserOwner, null);
    assert.equal(core.pageRegistry.listBindings().length, 0);
    const provider = core.semanticProviders.resolve('chatgpt', 'conversation');
    assert.equal(provider.kind, 'available',
      'normal Core composition must actually register the new semantic adapter');
    if (provider.kind !== 'available') throw new Error('semantic provider unregistered');
    assert.equal(provider.adapter.capabilities.contractVersion, 1);
    assert.deepEqual(await provider.adapter.recover({
      kind: 'final',
      context: {
        projectId: 'project', slotId: 'main', slotRevision: 1, taskId: 'task',
        providerConversationId: 'conversation', submittedUserMessageId: 'user',
        submittedUserTurnId: 'turn', pageLease: null,
      },
    }), { kind: 'unavailable', reason: 'backend-transport-unavailable' },
    'without an owned browser, recovery must not invent a profile or backend identity');
    assert.equal(core.pageRegistry.listBindings().length, 0);
  } finally {
    await core?.close();
    rmSync(root, { recursive: true, force: true });
  }
});
