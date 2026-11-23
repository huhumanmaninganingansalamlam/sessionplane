import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { SessionPlaneDatabase } from '../../src/storage/database.ts';
import { createKernelStores } from '../../src/storage/kernel/create-kernel-stores.ts';
import { DurableTaskKernel } from '../../src/core/durable-task-kernel.ts';
import { SemanticDecisionGateway } from '../../src/core/semantic-decision-gateway.ts';
import type { SemanticContextResolver } from '../../src/core/semantic-exact-task-port.ts';
import { assembleTaskRuntime } from '../../src/core/runtime/assemble-task-runtime.ts';
import { TaskResumeBinding } from '../../src/core/runtime/wire-task-resume.ts';
import { SemanticProviderRegistry } from '../../src/providers/semantic-provider-registry.ts';
import type {
  SemanticProviderAdapter, SemanticActRequest, SemanticActResult,
  SemanticTaskContext, SemanticObservation, SemanticExactQuery, SemanticVerification,
} from '../../src/providers/semantic-adapter.ts';

class FakeBrowserlessProvider implements SemanticProviderAdapter {
  readonly providerKey = 'browserless-fixture';
  readonly capabilities = {
    providerKey: this.providerKey, browserRequired: false,
    contractVersion: 1 as const,
    supports: ['conversation'] as const,
  };
  invoked = 0;

  async observe(context: SemanticTaskContext): Promise<SemanticObservation> {
    this.invoked++;
    assert.equal(context.pageLease, null, 'non-browser provider receives no Chrome lease');
    return {
      providerKey: this.providerKey, surface: 'unknown',
      snapshotId: 'browserless-observation', observedAt: new Date(0).toISOString(),
      capabilityManifest: this.capabilities, progress: 'idle',
      blocker: 'none', reason: null, questionText: null,
      turn: { submittedUserFound: false, laterUserFound: false,
        submittedUserMessageId: context.submittedUserMessageId,
        answerMessageId: null, partialAnswer: null },
      actions: [], evidenceBytes: 0,
    };
  }
  async act(_request: SemanticActRequest): Promise<SemanticActResult> {
    throw new Error('No provider submission is authorized by assembly alone');
  }
  async verify(_query: SemanticExactQuery): Promise<SemanticVerification> {
    return { kind: 'unavailable', reason: 'no-durable-exact-ack' };
  }
  async recover(query: SemanticExactQuery): Promise<SemanticVerification> {
    return this.verify(query);
  }
}

test('provider-neutral task assembly accepts a fake browserless port and one existing kernel store', t => {
  const dir = mkdtempSync(join(tmpdir(), 'sessionplane-assembly-'));
  const db = SessionPlaneDatabase.open(join(dir, 'runtime.sqlite'));
  t.after(() => { db.close(); rmSync(dir, { recursive: true, force: true }); });
  const repository = createKernelStores(db);
  const adapter = new FakeBrowserlessProvider();
  const providers = new SemanticProviderRegistry([adapter]);
  const resolveContext: SemanticContextResolver = intent => ({
    projectId: intent.projectId, slotId: intent.slotId,
    slotRevision: intent.slotRevision, taskId: intent.taskId,
    providerConversationId: intent.providerConversationId,
    submittedUserMessageId: null, submittedUserTurnId: null,
    pageLease: null,
  });
  const decisionGateway = new SemanticDecisionGateway({
    repository, providers, resolveContext,
  });
  const available = assembleTaskRuntime(repository,
    providers.resolve('browserless-fixture', 'conversation'),
    resolveContext, () => null, decisionGateway);
  const unsupported = assembleTaskRuntime(repository,
    providers.resolve('unregistered-provider', 'conversation'),
    resolveContext, () => null, decisionGateway);
  assert.ok(available.durableTaskKernel instanceof DurableTaskKernel);
  assert.ok(unsupported.durableTaskKernel instanceof DurableTaskKernel);
  assert.equal(adapter.invoked, 0);
  assert.equal(db.schemaVersion, 17);
});

test('Task resume command must be bound exactly once and cannot silently succeed uninstalled', async () => {
  const resume = new TaskResumeBinding();
  const exact = { taskId: 't', clientId: 'owner', attemptId: 'a',
    mode: 'provider_effect' as const };
  await assert.rejects(resume.run(exact), /not installed/);
  const seen: Array<typeof exact> = [];
  resume.bind(async input => {
    assert.equal(input.taskId, exact.taskId);
    assert.equal(input.clientId, exact.clientId);
    assert.equal(input.attemptId, exact.attemptId);
    assert.equal(input.mode, exact.mode);
    seen.push(exact);
  });
  assert.throws(() => resume.bind(async () => undefined), /already installed/);
  await resume.run(exact);
  assert.deepEqual(seen, [exact]);
});
