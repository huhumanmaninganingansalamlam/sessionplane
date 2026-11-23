import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { copyFileSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';

import { SessionPlaneDatabase } from '../../src/storage/database.ts';
import { migrations } from '../../src/storage/migrations/index.ts';
import { createKernelStores } from '../../src/storage/kernel/create-kernel-stores.ts';
import type { AgentDecisionPacket } from '../../src/core/semantic-decision-gateway.ts';
import {
  buildDecisionEnvelopeV2, parseDecisionEnvelope, parseDecisionEnvelopeV1,
  parseDecisionEnvelopeV2, projectHistoricalDecisionForRead, reconcilePendingDecisionV1,
} from '../../src/core/decisions/decision-envelope.ts';

const legacy = readFileSync(new URL('../fixtures/decision-envelope-v1.json', import.meta.url), 'utf8');
const blankEvidence = {
  original_request: '', current_attempt: '', provider_question: '',
  permission: '', partial_answer: '', capability_issues: '',
  provider_controls: '', decision_options: '[]',
};

function packet(taskId: string, decisionId: string): AgentDecisionPacket {
  const timestamp = '2026-11-23T00:00:00.000Z';
  return {
    taskId, taskRevision: 2, decisionId, kind: 'provider_question', reason: 'fixture-question',
    humanOnly: false, observedAt: timestamp, expiresAt: timestamp,
    snapshotId: null, questionText: null, permission: null, requestedModel: null,
    options: [], controls: [], evidenceSections: [], observedControls: [],
    resumePoint: 'same exact task', evidenceBytes: 0,
  };
}

test('historical v1 and v2 envelopes enforce separate durable action boundaries', () => {
  const first = parseDecisionEnvelopeV1(legacy);
  assert.equal(first.schemaVersion, 1);
  assert.equal(first.context.taskId, 'historical-task');
  assert.equal(first.actions[0]?.actionRef, 'old-action');
  assert.equal(reconcilePendingDecisionV1('historical-task', 'historical-decision', first),
    'read_only_refresh_required');
  const projected = projectHistoricalDecisionForRead(first, true);
  assert.equal(projected.options.length, 0);
  assert.equal(projected.reason, 'historical-decision-read-only-refresh-required');
  assert.equal(projectHistoricalDecisionForRead(first, false).kind, 'model_choice');

  const next = buildDecisionEnvelopeV2({
    taskContext: first.context, attemptId: first.attemptId,
    providerActions: [], evidence: blankEvidence,
    packet: packet(first.context.taskId, 'v2-decision'),
  });
  const raw = JSON.stringify(next);
  const parsed = parseDecisionEnvelope(raw);
  assert.equal(parsed.schemaVersion, 2);
  assert.equal(parsed.actions.length, 0);
  for (const old of ['kind', 'context', 'purpose', 'snapshotId', 'actionRef',
    'evidenceHash', 'actions', 'allOptions']) {
    assert.equal(Object.hasOwn(next, old), false, 'v2 must not double-write ' + old);
  }
  assert.throws(() => parseDecisionEnvelopeV2(JSON.stringify({ ...next, actionRef: 'old' })),
    /legacy fields are forbidden/);
  assert.throws(() => parseDecisionEnvelopeV2(JSON.stringify({
    ...next, taskContext: { ...next.taskContext, taskId: 'other' },
  })), /Task binding mismatch/);
  assert.throws(() => reconcilePendingDecisionV1('other', 'v2-decision', parsed),
    /identity mismatch/);
});

test('isolated SQLite schema 16→17 retains historical bytes and records new v2 discriminator', t => {
  const dir = mkdtempSync(join(tmpdir(), 'sessionplane-decision-v2-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const source = join(dir, 'rehearsal.sqlite');
  const originalCopy = join(dir, 'sealed-v16.sqlite');
  const raw = new DatabaseSync(source);
  raw.exec('PRAGMA foreign_keys=ON');
  raw.exec('CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL) STRICT');
  for (const migration of migrations.filter(item => item.version <= 16)) {
    raw.exec('BEGIN IMMEDIATE');
    try {
      migration.up(raw);
      raw.prepare('INSERT INTO schema_migrations(version,name,applied_at) VALUES(?,?,?)')
        .run(migration.version, migration.name, '2026-11-23T00:00:00Z');
      raw.exec('COMMIT');
    } catch (error) {
      raw.exec('ROLLBACK');
      throw error;
    }
  }
  assert.equal(raw.prepare('SELECT MAX(version) AS version FROM schema_migrations')
    .get()!.version, 16);
  const historical = JSON.parse(legacy);
  historical.context = { ...historical.context, projectId: 'p', slotId: 'main',
    slotRevision: 1, taskId: 't', providerConversationId: null };
  historical.packet = { ...historical.packet, taskId: 't', decisionId: 'd' };
  const originalContext = JSON.stringify(historical);
  raw.prepare('INSERT INTO kernel_projects(project_id,project_key,display_name,created_at) VALUES(?,?,?,?)')
    .run('p', 'p', 'Project', 'now');
  raw.prepare('INSERT INTO kernel_project_access(project_id,client_id,access_role) VALUES(?,?,?)')
    .run('p', 'owner', 'owner');
  raw.prepare('INSERT INTO kernel_slots(project_id,slot_id,role_key,provider_key,revision,active_task_id,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)')
    .run('p', 'main', 'main', 'chatgpt', 1, 't', 'now', 'now');
  raw.prepare('INSERT INTO kernel_slot_bindings(project_id,slot_id,revision,provider_key,observed_at) VALUES(?,?,?,?,?)')
    .run('p', 'main', 1, 'chatgpt', 'now');
  raw.prepare('INSERT INTO kernel_tasks(task_id,project_id,slot_id,slot_revision,client_id,request_id,original_prompt,state,cancel_requested,pending_decision_id,revision,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)')
    .run('t', 'p', 'main', 1, 'owner', 'req', 'original', 'agent_input_required', 0, 'd', 2, 'now', 'now');
  raw.prepare('INSERT INTO kernel_decisions(decision_id,task_id,audience,context_json,status,action_consumed,created_at) VALUES(?,?,?,?,?,?,?)')
    .run('d', 't', 'agent', originalContext, 'pending', 0, 'now');
  raw.close();
  copyFileSync(source, originalCopy);
  const originalSha256 = createHash('sha256').update(readFileSync(originalCopy)).digest('hex');
  const db = SessionPlaneDatabase.open(source);
  try {
    assert.equal(db.schemaVersion, 17);
    const historic = db.raw.prepare('SELECT context_json AS contextJson, envelope_version AS envelopeVersion, status FROM kernel_decisions WHERE decision_id=?')
      .get('d') as { contextJson: string; envelopeVersion: number; status: string };
    assert.equal(historic.contextJson, originalContext);
    assert.equal(historic.envelopeVersion, 1);
    assert.equal(historic.status, 'pending');
    assert.equal(parseDecisionEnvelope(historic.contextJson).schemaVersion, 1);
    const store = createKernelStores(db);
    store.projects.openProject({ projectId: 'p2', projectKey: 'p2', displayName: 'New',
      clientId: 'owner' });
    store.projects.openConversationSlot({ projectId: 'p2', slotId: 'main', roleKey: 'main',
      providerKey: 'chatgpt', clientId: 'owner' });
    store.tasks.createTask({ taskId: 't2', projectId: 'p2', slotId: 'main',
      expectedSlotRevision: 1, requestId: 'new-request', clientId: 'owner',
      prompt: 'new exact prompt' });
    const context = {
      projectId: 'p2', slotId: 'main', slotRevision: 1, taskId: 't2',
      providerConversationId: null, submittedUserMessageId: null,
      submittedUserTurnId: null, pageLease: null,
    };
    const next = buildDecisionEnvelopeV2({
      taskContext: context, attemptId: 'a2', providerActions: [],
      evidence: blankEvidence, packet: packet('t2', 'd2'),
    });
    store.decisions.createDecision({ taskId: 't2', clientId: 'owner', decisionId: 'd2',
      audience: 'agent', contextJson: JSON.stringify(next) });
    const newer = db.raw.prepare('SELECT context_json AS contextJson, envelope_version AS envelopeVersion FROM kernel_decisions WHERE decision_id=?')
      .get('d2') as { contextJson: string; envelopeVersion: number };
    assert.equal(newer.envelopeVersion, 2);
    assert.equal(parseDecisionEnvelopeV2(newer.contextJson).schemaVersion, 2);
    assert.equal(db.raw.prepare('PRAGMA quick_check').get()!.quick_check, 'ok');
  } finally {
    db.close();
  }
  assert.equal(createHash('sha256').update(readFileSync(originalCopy)).digest('hex'),
    originalSha256, 'original v16 snapshot is unchanged');
});
