import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';

import { inspectArchivedState, rehearseMigration, rehearseRollback } from '../../scripts/offline-state-rehearsal.mjs';
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
    assert.equal(result.sourceSchemaVersion, 0);
    assert.equal(result.integrityCheck, 'ok');
    assert.equal(result.foreignKeyViolations, 0);
    assert.equal(result.createdKernelTables.every(table => table.count === 0), true);
    assert.deepEqual(rows(source.path), facts);
    assert.deepEqual(rows(join(destinationDir, 'source-snapshot.sqlite')), facts);
    assert.deepEqual(rows(join(destinationDir, 'candidate.sqlite')), facts);
    assert.equal(result.snapshotSha256,
      hash(join(destinationDir, 'source-snapshot.sqlite')));
    const archived = inspectArchivedState({ migrationDir: destinationDir });
    assert.equal(archived.sourceSchemaVersion, 0);
    assert.equal(archived.completeOriginalFactsVerified, true);
    assert.equal(archived.sourceOpenedReadOnly, true);
    assert.equal(archived.legacyRuntimeRequired, false);
    assert.equal(archived.conversationBodiesReturned, false);
    assert.equal(archived.tables.find(table => table.name === 'legacy_facts')?.count, facts.length);
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

test('offline migration refuses a source snapshot with foreign-key violations', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'sp-offline-foreign-key-'));
  const source = join(dir, 'source.sqlite');
  const db = new DatabaseSync(source);
  try {
    db.exec('PRAGMA foreign_keys=OFF');
    db.exec('CREATE TABLE parent(id TEXT PRIMARY KEY) STRICT');
    db.exec('CREATE TABLE child(id TEXT PRIMARY KEY,parent_id TEXT NOT NULL REFERENCES parent(id)) STRICT');
    db.exec("INSERT INTO child VALUES('orphan','missing')");
  } finally { db.close(); }
  try {
    await assert.rejects(rehearseMigration({
      sourcePath: source, destinationDir: join(dir, 'migration'),
    }), /foreign-key verification failed/);
    assert.equal(existsSync(join(dir, 'migration')), false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
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

test('equal-schema rollback retains additive Task evidence and rejects mutation of an original Task row', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'sp-offline-equal-schema-'));
  const source = join(dir, 'source-current.sqlite');
  const sourceDb = SessionPlaneDatabase.open(source);
  try {
    const store = new TaskKernelRepository(sourceDb);
    store.openProject({ projectId: 'original-project', clientId: 'original-owner',
      projectKey: 'original-project', displayName: 'original' });
    store.openSlot({ projectId: 'original-project', clientId: 'original-owner',
      slotId: 'main', roleKey: 'main', providerKey: 'chatgpt' });
    store.startTask({ taskId: 'original-task', projectId: 'original-project',
      slotId: 'main', clientId: 'original-owner', requestId: 'original-request',
      expectedSlotRevision: 1, prompt: 'original prompt must remain byte exact' });
  } finally { sourceDb.close(); }

  const migrationDir = join(dir, 'migration');
  const rollbackDir = join(dir, 'rollback');
  try {
    const migrated = await rehearseMigration({ sourcePath: source, destinationDir: migrationDir });
    assert.equal(migrated.sourceSchemaVersion, 16);
    assert.equal(migrated.schemaVersion, 16);
    const candidatePath = join(migrationDir, 'candidate.sqlite');
    const candidate = SessionPlaneDatabase.open(candidatePath);
    try {
      const store = new TaskKernelRepository(candidate);
      store.openProject({ projectId: 'new-project', clientId: 'new-owner',
        projectKey: 'new-project', displayName: 'new evidence' });
      store.openSlot({ projectId: 'new-project', clientId: 'new-owner',
        slotId: 'main', roleKey: 'main', providerKey: 'chatgpt' });
      store.startTask({ taskId: 'new-task', projectId: 'new-project', slotId: 'main',
        clientId: 'new-owner', requestId: 'new-request', expectedSlotRevision: 1,
        prompt: 'new evidence retained before rollback' });
      store.planAttempt({ taskId: 'new-task', clientId: 'new-owner',
        attemptId: 'new-attempt', kind: 'initial', turnKey: 'root',
        content: 'new evidence retained before rollback' });
      store.beginDispatch('new-task', 'new-owner', 'new-attempt');
      store.markUncertain('new-task', 'new-owner', 'new-attempt', 'lost-ack');
    } finally { candidate.close(); }

    const result = await rehearseRollback({
      migrationDir, candidatePath, destinationDir: rollbackDir,
    });
    assert.equal(result.postMigrationEvidencePreserved, true);
    const restored = new DatabaseSync(join(rollbackDir, 'restored-original.sqlite'),
      { readOnly: true });
    const evidence = new DatabaseSync(join(rollbackDir, 'post-migration-evidence.sqlite'),
      { readOnly: true });
    try {
      assert.deepEqual(restored.prepare(
        'SELECT task_id AS id,original_prompt AS prompt FROM kernel_tasks ORDER BY task_id',
      ).all().map(row => ({ id: row.id, prompt: row.prompt })),
      [{ id: 'original-task', prompt: 'original prompt must remain byte exact' }]);
      assert.deepEqual(evidence.prepare(
        'SELECT task_id AS id,state FROM kernel_tasks ORDER BY task_id',
      ).all().map(row => ({ id: row.id, state: row.state })),
      [{ id: 'new-task', state: 'uncertain' }, { id: 'original-task', state: 'working' }]);
      assert.equal(evidence.prepare(
        "SELECT state FROM kernel_attempts WHERE task_id='new-task'",
      ).get()!.state, 'uncertain');
    } finally { restored.close(); evidence.close(); }

    const tampered = new DatabaseSync(candidatePath);
    try {
      tampered.prepare("UPDATE kernel_tasks SET original_prompt='forged' WHERE task_id='original-task'").run();
    } finally { tampered.close(); }
    await assert.rejects(rehearseRollback({
      migrationDir, candidatePath, destinationDir: join(dir, 'must-not-exist'),
    }), /changed or removed a source row: kernel_tasks/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
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
    const inspected = spawnSync(process.execPath, [
      'scripts/offline-state-rehearsal.mjs', 'inspect',
      '--migration', destinationDir,
    ], { cwd: process.cwd(), encoding: 'utf8' });
    assert.equal(inspected.status, 0, inspected.stderr);
    assert.equal(JSON.parse(inspected.stdout).snapshotSha256, manifest.snapshotSha256);
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

test('v15-to-v16 isolated upgrade retains original exact ACK/FINAL and event chain', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'sp-scan-cursors-schema15-'));
  const source = join(dir, 'original-v15.sqlite');
  const target = join(dir, 'migration');
  try {
    // Create a genuine Task/evidence chain through public repository methods,
    // then reconstruct the exact pre-0016 schema in this disposable fixture.
    // The new table is empty before downgrading; no operational DB is touched.
    const current = SessionPlaneDatabase.open(source);
    try {
      const store = new TaskKernelRepository(current);
      store.openProject({ projectId: 'upgraded', clientId: 'owner',
        projectKey: 'upgrade.fixture', displayName: 'Preserve exact final' });
      store.openSlot({ projectId: 'upgraded', clientId: 'owner', slotId: 'main',
        roleKey: 'Main', providerKey: 'fixture' });
      store.startTask({ taskId: 'retained-task', projectId: 'upgraded',
        slotId: 'main', expectedSlotRevision: 1, clientId: 'owner',
        requestId: 'start-once', prompt: 'exact original prompt' });
      store.observeConversation({ projectId: 'upgraded', clientId: 'owner',
        slotId: 'main', expectedRevision: 1, taskId: 'retained-task',
        providerConversationId: 'exact-conversation' });
      store.planAttempt({ taskId: 'retained-task', clientId: 'owner',
        attemptId: 'original-attempt', kind: 'initial', turnKey: 'root',
        content: 'exact original prompt' });
      store.beginDispatch('retained-task', 'owner', 'original-attempt');
      store.acknowledgeAttempt({ taskId: 'retained-task', clientId: 'owner',
        attemptId: 'original-attempt', externalTurnId: 'exact-turn' });
      store.recordFinal({ taskId: 'retained-task', clientId: 'owner',
        attemptId: 'original-attempt', externalTurnId: 'exact-turn',
        resultId: 'original-final', answerText: 'Original FINAL\n  exact spacing',
        completeTask: true });
      assert.equal(store.getTask('retained-task', 'owner').state, 'completed');
    } finally { current.close(); }

    const original = new DatabaseSync(source);
    try {
      original.exec('BEGIN IMMEDIATE');
      try {
        original.exec('DROP TABLE kernel_public_preparation_phase');
        original.exec('DROP TABLE kernel_public_scan_cursors');
        original.prepare('DELETE FROM schema_migrations WHERE version=16').run();
        original.exec('COMMIT');
      } catch (error) { original.exec('ROLLBACK'); throw error; }
      assert.equal(original.prepare('SELECT MAX(version) AS version FROM schema_migrations')
        .get()!.version, 15);
    } finally { original.close(); }
    const snapshot = (file: string) => {
      const db = new DatabaseSync(file, { readOnly: true });
      try {
        return {
          task: db.prepare('SELECT task_id,state,original_prompt,revision FROM kernel_tasks')
            .all(),
          attempts: db.prepare('SELECT attempt_id,state,external_turn_id FROM kernel_attempts')
            .all(),
          final: db.prepare('SELECT answer_text,external_turn_id FROM kernel_results')
            .all(),
          events: db.prepare('SELECT task_revision,event_type,payload_json FROM kernel_events' +
            ' ORDER BY task_revision').all(),
        };
      } finally { db.close(); }
    };
    const before = snapshot(source);
    const result = await rehearseMigration({ sourcePath: source, destinationDir: target });
    assert.equal(result.sourceSchemaVersion, 15);
    assert.equal(result.schemaVersion, 16);
    assert.equal(result.sourceReadOnly, true);
    assert.deepEqual(snapshot(source), before, 'source archive is read-only');
    assert.deepEqual(snapshot(join(target, 'candidate.sqlite')), before,
      'exact Task, ACK, FINAL and event chain must survive the additive upgrade');
    const candidate = SessionPlaneDatabase.open(join(target, 'candidate.sqlite'));
    try {
      assert.equal(candidate.schemaVersion, 16);
      assert.equal(candidate.raw.prepare(
        'SELECT COUNT(*) AS count FROM kernel_public_scan_cursors').get()!.count, 0);
      assert.equal(new TaskKernelRepository(candidate)
        .getTask('retained-task', 'owner').state, 'completed');
    } finally { candidate.close(); }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('actual v8 legacy schema with WAL ACK/FINAL/UNKNOWN/draft is retained while upgrading only an isolated candidate to v16', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'sp-real-schema8-upgrade-'));
  const source = join(dir, 'original-v8.sqlite');
  const db = new DatabaseSync(source);
  try {
    db.exec('PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON');
    db.exec('CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY,name TEXT NOT NULL,applied_at TEXT NOT NULL) STRICT');
    const at = '2026-11-12T00:00:00.000Z';
    for (const migration of migrations.filter(m => m.version <= 8)) {
      db.exec('BEGIN IMMEDIATE');
      try {
        migration.up(db);
        db.prepare('INSERT INTO schema_migrations VALUES(?,?,?)')
          .run(migration.version, migration.name, at);
        db.exec('COMMIT');
      } catch (error) { db.exec('ROLLBACK'); throw error; }
    }
    assert.equal(db.prepare('SELECT MAX(version) AS n FROM schema_migrations').get()!.n, 8);
    db.prepare('INSERT INTO teams(team_id,owner_client_id,name,team_state,primary_role_id,created_at,updated_at) VALUES(?,?,?,?,?,?,?)')
      .run('v8-team', 'fixture-owner', 'Preserved synthetic team', 'available', 'v8-role', at, at);
    db.prepare('INSERT INTO team_roles(role_id,team_id,role_key,role_type,role_state,created_at) VALUES(?,?,?,?,?,?)')
      .run('v8-role', 'v8-team', 'main', 'primary', 'active', at);
    db.prepare('INSERT INTO sessions(session_id,team_id,role_id,provider,session_state,provider_state,observation_transport,current_generation,conversation_id,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)')
      .run('v8-session', 'v8-team', 'v8-role', 'chatgpt', 'working', 'generating', 'dom', 3,
        'old-conversation-must-stay', at, at);
    const generations = [
      [1, 'submitted', 'old-user-1', 'turn-1', 'answer-1', 'Exact FINAL \n  with whitespace', at, 1],
      [2, 'submission_unknown', null, null, null, null, null, 1],
      [3, 'composer_filled', null, null, null, null, null, 0],
    ];
    const addGeneration = db.prepare('INSERT INTO generations(session_id,generation,team_brief_version,prompt_hash,submission_state,submitted_user_message_id,submitted_user_turn_id,response_message_id,answer_text,completed_at,prompt_submitted) VALUES(?,?,?,?,?,?,?,?,?,?,?)');
    for (const row of generations) {
      addGeneration.run('v8-session', row[0], 0, 'hash-' + row[0], ...row.slice(1));
    }
    const addOutbox = db.prepare('INSERT INTO outbox(outbox_id,client_id,request_id,team_id,role_id,session_id,generation,payload_json,submission_state,created_at,updated_at,prompt_submitted) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)');
    for (const [i, state] of ['submitted', 'submission_unknown', 'composer_filled'].entries()) {
      addOutbox.run('v8-outbox-' + i, 'fixture-owner', 'v8-request-' + i,
        'v8-team', 'v8-role', 'v8-session', i + 1,
        JSON.stringify({ original: 'preserve original ' + i, draft: i === 2 }),
        state, at, at, i < 2 ? 1 : 0);
    }
    db.prepare('INSERT INTO request_receipts(client_id,request_id,method,result_json,created_at) VALUES(?,?,?,?,?)')
      .run('fixture-owner', 'receipt-old-ack', 'workflow.send',
        JSON.stringify({ messageId: 'old-user-1', status: 'acknowledged' }), at);
    const addEvent = db.prepare('INSERT INTO events(team_id,role_id,session_id,generation,event_type,payload_json,created_at) VALUES(?,?,?,?,?,?,?)');
    for (const [eventType, payload] of [
      ['provider.acknowledged', { messageId: 'old-user-1' }],
      ['provider.final', { answerSha256: createHash('sha256').update('Exact FINAL \n  with whitespace').digest('hex') }],
      ['provider.permission-declined', { approved: false }],
      ['provider.stop-uncertain', { confirmed: false }],
    ] as const) {
      addEvent.run('v8-team', 'v8-role', 'v8-session', 1, eventType, JSON.stringify(payload), at);
    }

    const target = join(dir, 'migrated');
    const report = await rehearseMigration({ sourcePath: source, destinationDir: target });
    assert.equal(report.schemaVersion, 16);
    const archive = inspectArchivedState({ migrationDir: target });
    assert.equal(archive.sourceSchemaVersion, 8);
    assert.equal(archive.candidateSchemaVersion, 16);
    assert.deepEqual(archive.retainedSubmissionStates.generations, [
      { state: 'composer_filled', count: 1 },
      { state: 'submission_unknown', count: 1 },
      { state: 'submitted', count: 1 },
    ]);
    assert.equal(archive.legacyRuntimeRequired, false);
    for (const [table, count] of [
      ['teams', 1], ['team_roles', 1], ['sessions', 1], ['generations', 3],
      ['outbox', 3], ['request_receipts', 1], ['events', 4],
    ] as const) {
      assert.equal(report.originalFacts.find((item: { name: string }) => item.name === table)?.count,
        count, 'Missing archived v8 table: ' + table);
    }
    const candidate = SessionPlaneDatabase.open(join(target, 'candidate.sqlite'));
    try {
      assert.equal(candidate.schemaVersion, 16);
      assert.equal(candidate.raw.prepare('SELECT answer_text AS text FROM generations WHERE generation=1')
        .get()!.text, 'Exact FINAL \n  with whitespace');
      assert.equal(candidate.raw.prepare('SELECT submission_state AS state FROM generations WHERE generation=2')
        .get()!.state, 'submission_unknown');
      assert.equal(candidate.raw.prepare('SELECT submission_state AS state FROM generations WHERE generation=3')
        .get()!.state, 'composer_filled');
      assert.equal(candidate.raw.prepare('SELECT COUNT(*) AS n FROM events').get()!.n, 4);
      assert.equal(candidate.raw.prepare('SELECT COUNT(*) AS n FROM kernel_tasks').get()!.n, 0,
        'Archive data is not silently promoted into an unrelated new Task');
    } finally { candidate.close(); }

    assert.equal(db.prepare('SELECT MAX(version) AS n FROM schema_migrations').get()!.n, 8,
      'The opened source writer must remain on its original version');
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM generations').get()!.n, 3);
    assert.deepEqual(
      JSON.parse(readFileSync(join(target, 'manifest.json'), 'utf8')).originalFacts,
      report.originalFacts);
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('rollback refuses a different source/account candidate even when both use the same schema', async () => {
  const root = mkdtempSync(join(tmpdir(), 'sp-offline-foreign-rollback-'));
  const leftDir = join(root, 'left');
  const rightDir = join(root, 'right');
  mkdirSync(leftDir); mkdirSync(rightDir);
  const left = fixture(leftDir);
  const right = fixture(rightDir);
  try {
    right.db.prepare('UPDATE legacy_facts SET body=? WHERE id=?')
      .run('Different source account cannot be imported', 'ack');
    const leftMigration = join(root, 'left-migration');
    const rightMigration = join(root, 'right-migration');
    await rehearseMigration({ sourcePath: left.path, destinationDir: leftMigration });
    await rehearseMigration({ sourcePath: right.path, destinationDir: rightMigration });
    const foreign = join(rightMigration, 'candidate.sqlite');
    const before = hash(foreign);
    const destinationDir = join(root, 'must-not-exist');
    await assert.rejects(rehearseRollback({
      migrationDir: leftMigration, candidatePath: foreign, destinationDir,
    }), /Rollback candidate does not match source manifest: legacy_facts/);
    assert.equal(hash(foreign), before);
    assert.equal(existsSync(destinationDir), false);
  } finally {
    left.db.close(); right.db.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('archived source tampering is rejected before inspecting any legacy data', async () => {
  const root = mkdtempSync(join(tmpdir(), 'sp-offline-archive-tamper-'));
  const source = fixture(root);
  try {
    const destinationDir = join(root, 'migration');
    await rehearseMigration({ sourcePath: source.path, destinationDir });
    const archivePath = join(destinationDir, 'source-snapshot.sqlite');
    assert.equal(inspectArchivedState({ migrationDir: destinationDir })
      .completeOriginalFactsVerified, true);
    const tampered = new DatabaseSync(archivePath);
    try {
      tampered.prepare('UPDATE legacy_facts SET body=? WHERE id=?')
        .run('forged ACK outcome', 'ack');
    } finally { tampered.close(); }
    assert.throws(() => inspectArchivedState({ migrationDir: destinationDir }),
      /Archived original SHA-256 mismatch|Archived source table facts differ/);
    assert.deepEqual(rows(source.path), facts,
      'An archive cannot modify its original, externally supplied source');
  } finally {
    source.db.close();
    rmSync(root, { recursive: true, force: true });
  }
});
