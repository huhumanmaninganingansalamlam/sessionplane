import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';

import { SemanticTaskArtifactReader } from '../../src/core/semantic-task-artifact-reader.ts';
import type {
  SemanticArtifactReadRequest, SemanticArtifactReadResult,
  SemanticProviderAdapter,
} from '../../src/providers/semantic-adapter.ts';
import { SemanticProviderRegistry } from '../../src/providers/semantic-provider-registry.ts';
import { SessionPlaneDatabase } from '../../src/storage/database.ts';
import { TaskKernelRepository } from '../../src/storage/task-kernel-repository.ts';

const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const file = Buffer.from('fixture binary\n  original bytes\0', 'utf8');

function fixture(t: TestContext) {
  const dir = mkdtempSync(join(tmpdir(), 'sessionplane-artifact-seam-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const db = SessionPlaneDatabase.open(join(dir, 'fixture.sqlite'));
  t.after(() => db.close());
  const store = new TaskKernelRepository(db);
  const clientId = 'owner', taskId = 'task-exact', resultId = 'result-exact';
  store.openProject({
    projectId: 'project', projectKey: 'artifact.fixture', displayName: 'Fixture',
    clientId,
  });
  store.openSlot({ projectId: 'project', clientId, slotId: 'Main',
    roleKey: 'Main', providerKey: 'artifact-fixture' });
  store.startTask({ taskId, projectId: 'project', slotId: 'Main',
    clientId, expectedSlotRevision: 1, requestId: 'once', prompt: 'exact prompt' });
  store.observeConversation({ projectId: 'project', slotId: 'Main', clientId,
    expectedRevision: 1, taskId, providerConversationId: 'conversation-exact' });
  store.planAttempt({ taskId, clientId, attemptId: 'attempt-exact',
    kind: 'initial', turnKey: 'root', content: 'exact prompt' });
  store.beginDispatch(taskId, clientId, 'attempt-exact');
  store.acknowledgeAttempt({ taskId, clientId, attemptId: 'attempt-exact',
    externalTurnId: 'turn-exact' });
  return { store, database: db, taskId, resultId, clientId };
}

class FakeArtifactProvider implements SemanticProviderAdapter {
  readonly providerKey = 'artifact-fixture';
  readonly capabilities = {
    providerKey: this.providerKey, contractVersion: 1 as const, browserRequired: false,
    supports: ['conversation', 'artifact_read'] as const,
  };
  reads = 0;
  onRead: (() => void) | null = null;
  next: 'good' | 'wrong_turn' | 'wrong_result' | 'wrong_conversation' |
    'wrong_hash' | 'wrong_size' | 'denied' | 'missing' = 'good';

  async observe(): Promise<never> { throw new Error('No UI observation required for file read'); }
  async act(): Promise<never> { throw new Error('No provider mutation permitted for file read'); }
  async verify(): Promise<never> { throw new Error('Read must use recorded exact FINAL'); }
  async recover(): Promise<never> { throw new Error('Read must not infer unknown FINAL'); }

  async readArtifact(request: SemanticArtifactReadRequest): Promise<SemanticArtifactReadResult> {
    this.reads++;
    this.onRead?.();
    assert.equal(request.context.pageLease, null, 'artifact read does not take over Chrome');
    if (this.next === 'denied') return { kind: 'denied', reason: 'access_denied' };
    if (this.next === 'missing') return { kind: 'unavailable', reason: 'missing_file' };
    return {
      kind: 'verified',
      artifactRef: request.artifactRef,
      taskId: request.context.taskId,
      resultId: this.next === 'wrong_result' ? 'foreign-result' : request.resultId,
      conversationId: this.next === 'wrong_conversation'
        ? 'foreign-conversation' : request.context.providerConversationId!,
      submittedUserTurnId: this.next === 'wrong_turn'
        ? 'foreign-turn' : request.context.submittedUserTurnId!,
      sha256: this.next === 'wrong_hash' ? '0'.repeat(64) : hash(file),
      sizeBytes: this.next === 'wrong_size' ? file.byteLength + 10 : file.byteLength,
      mediaType: 'application/octet-stream',
      bytes: file,
    };
  }
}

test('artifact read is tied to owner, exact recorded FINAL and verified bytes', async t => {
  const env = fixture(t);
  const adapter = new FakeArtifactProvider();
  const reader = new SemanticTaskArtifactReader({
    repository: env.store, providers: new SemanticProviderRegistry([adapter]),
  });
  const read = () => reader.read({
    taskId: env.taskId, clientId: env.clientId,
    resultId: env.resultId, artifactRef: 'provider-ref',
  });
  assert.deepEqual(await read(), {
    kind: 'unavailable', reason: 'exact_final_not_found',
  }, 'without durable exact FINAL no file can be read');
  assert.equal(adapter.reads, 0);
  env.store.recordFinal({ taskId: env.taskId, clientId: env.clientId,
    attemptId: 'attempt-exact', externalTurnId: 'turn-exact',
    resultId: env.resultId, answerText: 'exact text FINAL', completeTask: true });
  const verified = await read();
  assert.equal(verified.kind, 'verified');
  if (verified.kind !== 'verified') return;
  assert.equal(verified.sha256, hash(file));
  assert.equal(verified.sizeBytes, file.length);
  assert.deepEqual(verified.bytes, file);
  assert.equal(verified.resultId, env.resultId);
  assert.equal(verified.externalTurnId, 'turn-exact');
  assert.equal(verified.artifactRef, 'provider-ref');
  assert.equal(adapter.reads, 1);
  const unknown = await reader.read({
    taskId: env.taskId, clientId: env.clientId,
    resultId: 'foreign-result', artifactRef: 'provider-ref',
  });
  assert.deepEqual(unknown, { kind: 'unavailable', reason: 'exact_final_not_found' });
  assert.equal(adapter.reads, 1);
  const crossOwner = await reader.read({
    taskId: env.taskId, clientId: 'foreign-owner',
    resultId: env.resultId, artifactRef: 'provider-ref',
  });
  assert.deepEqual(crossOwner, { kind: 'denied', reason: 'task_not_authorized' });
  assert.equal(adapter.reads, 1);
});

test('owner revoked during provider read receives no verified artifact bytes', async t => {
  const env = fixture(t);
  env.store.recordFinal({ taskId: env.taskId, clientId: env.clientId,
    attemptId: 'attempt-exact', externalTurnId: 'turn-exact',
    resultId: env.resultId, answerText: 'exact FINAL', completeTask: true });
  const adapter = new FakeArtifactProvider();
  adapter.onRead = () => {
    env.database.raw.prepare(
      'DELETE FROM kernel_project_access WHERE project_id=? AND client_id=?',
    ).run('project', env.clientId);
  };
  const reader = new SemanticTaskArtifactReader({
    repository: env.store, providers: new SemanticProviderRegistry([adapter]),
  });
  assert.deepEqual(await reader.read({
    taskId: env.taskId, clientId: env.clientId,
    resultId: env.resultId, artifactRef: 'opaque-ref',
  }), { kind: 'denied', reason: 'task_not_authorized' });
  assert.equal(adapter.reads, 1,
    'one read is allowed but its bytes cannot escape after permission revocation');
});

test('artifact capability cannot silently lie, drop access denial or trust bad provenance', async t => {
  const env = fixture(t);
  env.store.recordFinal({ taskId: env.taskId, clientId: env.clientId,
    attemptId: 'attempt-exact', externalTurnId: 'turn-exact',
    resultId: env.resultId, answerText: 'exact FINAL', completeTask: true });
  const adapter = new FakeArtifactProvider();
  const reader = new SemanticTaskArtifactReader({
    repository: env.store, providers: new SemanticProviderRegistry([adapter]),
  });
  const read = () => reader.read({
    taskId: env.taskId, clientId: env.clientId,
    resultId: env.resultId, artifactRef: 'opaque-ref',
  });
  for (const bad of ['wrong_turn', 'wrong_result', 'wrong_conversation',
    'wrong_hash', 'wrong_size'] as const) {
    adapter.next = bad;
    assert.deepEqual(await read(),
      { kind: 'unavailable', reason: 'artifact_provenance_unverified' }, bad);
  }
  adapter.next = 'denied';
  assert.deepEqual(await read(), { kind: 'denied', reason: 'access_denied' });
  adapter.next = 'missing';
  assert.deepEqual(await read(), { kind: 'unavailable', reason: 'missing_file' });

  const incomplete = Object.assign(Object.create(Object.getPrototypeOf(adapter)), adapter);
  incomplete.readArtifact = undefined;
  assert.throws(() => new SemanticProviderRegistry([incomplete]),
    /artifact_read requires a readArtifact handler/);
  const textOnly = new FakeArtifactProvider();
  (textOnly as { capabilities: { supports: readonly string[] } }).capabilities = {
    ...textOnly.capabilities, supports: ['conversation'],
  };
  const unsupported = new SemanticTaskArtifactReader({
    repository: env.store, providers: new SemanticProviderRegistry([textOnly]),
  });
  assert.deepEqual(await unsupported.read({
    taskId: env.taskId, clientId: env.clientId,
    resultId: env.resultId, artifactRef: 'opaque-ref',
  }), { kind: 'unsupported', reason: 'capability_not_supported' });
  assert.equal(textOnly.reads, 0);
});
