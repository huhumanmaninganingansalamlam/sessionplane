import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';

import { rehearseMigration, rehearseRollback } from '../../scripts/offline-state-rehearsal.mjs';
import { SessionPlaneDatabase } from '../../src/storage/database.ts';
import { TaskKernelRepository } from '../../src/storage/task-kernel-repository.ts';
import { migrations } from '../../src/storage/migrations/index.ts';

const facts = [
  ['ack', 'acknowledged', 'exact user message'],
  ['draft', 'composer_filled', 'unsent draft'],
  ['final', 'completed', 'Answer\n  with exact whitespace'],
  ['permission', 'declined', 'permission was denied'],
  ['stop', 'uncertain', 'stop not acknowledged'],
  ['unknown', 'submission_unknown', 'unknown original POST'],
];
function fixture(root: string) {
  const path = join(root, 'source.sqlite');
  const db = new DatabaseSync(path);
  db.exec('PRAGMA journal_mode=WAL');
  db.exec('CREATE TABLE legacy_facts (id TEXT PRIMARY KEY, status TEXT NOT NULL, body TEXT NOT NULL) STRICT');
  const insert = db.prepare('INSERT INTO legacy_facts VALUES(?,?,?)');
  for (const row of facts) insert.run(...row);
  return { path, db };
}
function rows(path: string) {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    return db.prepare('SELECT id,status,body FROM legacy_facts ORDER BY id').all()
      .map(row => [row.id, row.status, row.body]);
  } finally { db.close(); }
}
function hash(path: string) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

test('WAL-consistent offline backup upgrades schema and keeps every synthetic legacy fact byte-exact', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'sp-offline-snapshot-'));
  const source = fixture(dir);
  const destinationDir = join(dir, 'migration');
  try {
    const result = await rehearseMigration({ sourcePath: source.path, destinationDir });
    assert.equal(result.schemaVersion, migrations.at(-1)!.version);
    assert.equal(result.replayed, false);
    assert.equal(result.sourceReadOnly, true);
    assert.deepEqual(rows(source.path), facts);
    assert.deepEqual(rows(join(destinationDir, 'source-snapshot.sqlite')), facts);
    assert.deepEqual(rows(join(destinationDir, 'candidate.sqlite')), facts);
    assert.equal(result.snapshotSha256,
      hash(join(destinationDir, 'source-snapshot.sqlite')));
    const replay = await rehearseMigration({ sourcePath: source.path, destinationDir });
    assert.equal(replay.replayed, true);
    assert.equal(replay.snapshotSha256, result.snapshotSha256);
    source.db.prepare('INSERT INTO legacy_facts VALUES(?,?,?)')
      .run('later', 'acknowledged', 'source changed after first snapshot');
    await assert.rejects(rehearseMigration({ sourcePath: source.path, destinationDir }),
      /Source changed since committed offline rehearsal/);
  } finally {
    source.db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('interrupted migration publishes no partial candidate; rollback preserves post-migration Task evidence', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'sp-offline-rollback-'));
  const source = fixture(dir);
  const destinationDir = join(dir, 'migration');
  const rollbackDir = join(dir, 'rollback');
  try {
    await assert.rejects(rehearseMigration({
      sourcePath: source.path, destinationDir, failAfterSnapshot: true,
    }), /Injected offline interruption/);
    assert.equal(existsSync(destinationDir), false);
    assert.deepEqual(rows(source.path), facts);
    const migrated = await rehearseMigration({ sourcePath: source.path, destinationDir });
    const candidate = join(destinationDir, 'candidate.sqlite');
    const database = SessionPlaneDatabase.open(candidate);
    try {
      const store = new TaskKernelRepository(database);
      for (const [i, phase] of ['uncertain', 'final', 'draft'].entries()) {
        const projectId = 'synthetic-project-' + i;
        const taskId = 'synthetic-task-' + i;
        const attemptId = 'synthetic-attempt-' + i;
        store.openProject({ projectId, clientId: 'isolated-owner',
          projectKey: projectId, displayName: phase });
        store.openSlot({ projectId, clientId: 'isolated-owner',
          slotId: 'main', roleKey: 'main', providerKey: 'chatgpt' });
        store.startTask({ taskId, projectId, slotId: 'main',
          clientId: 'isolated-owner', requestId: 'start-' + phase,
          expectedSlotRevision: 1, prompt: 'prompt ' + phase });
        store.planAttempt({ taskId, clientId: 'isolated-owner', attemptId,
          kind: 'initial', turnKey: 'root', content: 'prompt ' + phase });
        if (phase !== 'draft') store.beginDispatch(taskId, 'isolated-owner', attemptId);
        if (phase === 'uncertain') {
          store.markUncertain(taskId, 'isolated-owner', attemptId, 'lost-provider-ACK');
        }
        if (phase === 'final') {
          store.acknowledgeAttempt({ taskId, clientId: 'isolated-owner',
            attemptId, externalTurnId: 'turn-exact' });
          store.recordFinal({ taskId, clientId: 'isolated-owner',
            attemptId, externalTurnId: 'turn-exact',
            resultId: 'result-exact', answerText: 'Exact final\n  retained',
            completeTask: true });
        }
      }
    } finally { database.close(); }
    const afterWrites = hash(candidate);
    assert.notEqual(afterWrites, migrated.candidateSha256);

    await assert.rejects(rehearseRollback({
      migrationDir: destinationDir, candidatePath: candidate,
      destinationDir: rollbackDir, failAfterEvidence: true,
    }), /Injected rollback interruption/);
    assert.equal(existsSync(rollbackDir), false);
    assert.equal(hash(candidate), afterWrites);

    const result = await rehearseRollback({
      migrationDir: destinationDir, candidatePath: candidate,
      destinationDir: rollbackDir,
    });
    assert.equal(result.candidateWasNeverOverwritten, true);
    assert.equal(result.postMigrationEvidencePreserved, true);
    assert.equal(hash(candidate), afterWrites);
    assert.deepEqual(rows(join(rollbackDir, 'restored-original.sqlite')), facts);
    const retained = new DatabaseSync(join(rollbackDir, 'post-migration-evidence.sqlite'),
      { readOnly: true });
    try {
      assert.deepEqual(retained.prepare(
        'SELECT task_id AS taskId,state FROM kernel_attempts ORDER BY task_id',
      ).all().map(row => [row.taskId, row.state]), [
        ['synthetic-task-0', 'uncertain'],
        ['synthetic-task-1', 'acknowledged'],
        ['synthetic-task-2', 'planned'],
      ]);
      assert.equal(retained.prepare('SELECT answer_text AS answer FROM kernel_results')
        .get()!.answer, 'Exact final\n  retained');
    } finally { retained.close(); }
    await assert.rejects(rehearseRollback({
      migrationDir: destinationDir, candidatePath: candidate,
      destinationDir: rollbackDir,
    }), /Rollback output already exists/);
  } finally {
    source.db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('offline rehearsal CLI requires explicit paths and emits a verifiable manifest', async () => {
  const root = mkdtempSync(join(tmpdir(), 'sp-offline-cli-'));
  const source = fixture(root);
  try {
    const destinationDir = join(root, 'cli-migration');
    const operation = spawnSync(process.execPath, [
      'scripts/offline-state-rehearsal.mjs', 'migrate',
      '--source', source.path, '--destination', destinationDir,
    ], { cwd: process.cwd(), encoding: 'utf8' });
    assert.equal(operation.status, 0, operation.stderr);
    const manifest = JSON.parse(operation.stdout);
    assert.equal(manifest.schemaVersion, migrations.at(-1)!.version);
    assert.equal(manifest.snapshotSha256, hash(join(destinationDir, 'source-snapshot.sqlite')));
    assert.deepEqual(rows(source.path), facts);
    assert.deepEqual(rows(join(destinationDir, 'candidate.sqlite')), facts);
    const invalid = spawnSync(process.execPath, [
      'scripts/offline-state-rehearsal.mjs', 'migrate', '--source', source.path,
    ], { cwd: process.cwd(), encoding: 'utf8' });
    assert.notEqual(invalid.status, 0);
    assert.match(invalid.stderr, /destination path is required/);
  } finally {
    source.db.close();
    rmSync(root, { recursive: true, force: true });
  }
});
