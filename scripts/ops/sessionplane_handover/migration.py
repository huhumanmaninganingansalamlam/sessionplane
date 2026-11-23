"""Bounded verified handover migration phase."""
import hashlib, json, pathlib, shutil, sqlite3, subprocess, uuid
from contextlib import closing
from . import bundle, model


def sqlite_schema(path):
    with closing(sqlite3.connect(pathlib.Path(path).resolve().as_uri() + '?mode=ro', uri=True)) as db:
        row = db.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name='schema_migrations'").fetchone()
        return int(db.execute('SELECT COALESCE(MAX(version),0) FROM schema_migrations').fetchone()[0]) if row else 0

def verify_sqlite(path, expected_schema=None):
    with closing(sqlite3.connect(pathlib.Path(path).resolve().as_uri() + '?mode=ro', uri=True)) as db:
        integrity = db.execute('PRAGMA integrity_check').fetchall()
        assert integrity == [('ok',)], 'SQLite full integrity check failed'
        foreign = db.execute('PRAGMA foreign_key_check').fetchall()
        assert not foreign, 'SQLite foreign-key check failed'
        schema = sqlite_schema(path)
        if expected_schema is not None:
            assert schema == expected_schema, f'Expected schema {expected_schema}, got {schema}'
        return {'schemaVersion': schema, 'integrity': 'ok', 'foreignKeyViolations': 0}

def run_offline(candidate, mode, options, log_path, timeout=1800):
    helper = candidate/'scripts/offline-state-rehearsal.mjs'
    command = ['node', str(helper), mode]
    for key, value in options.items():
        command += ['--' + key, str(value)]
    result = subprocess.run(command, text=True, capture_output=True, timeout=timeout)
    pathlib.Path(log_path).write_text(json.dumps({
        'command': command, 'exitCode': result.returncode,
        'stdout': result.stdout, 'stderr': result.stderr,
    }, indent=2))
    pathlib.Path(log_path).chmod(0o600)
    if result.returncode != 0:
        raise RuntimeError(f'Offline state {mode} failed; inspect {log_path}')
    lines = [line for line in result.stdout.splitlines() if line.strip()]
    assert lines, 'Offline state helper returned no receipt'
    return json.loads(lines[-1])

def seed_transition_evidence(candidate, database_path, receipt):
    marker = 'handover-' + uuid.uuid4().hex
    script = r"""
import { pathToFileURL } from 'node:url';
const [root, file, marker] = process.argv.slice(1);
const { SessionPlaneDatabase } = await import(pathToFileURL(root + '/dist/storage/database.js').href);
const { createKernelStores } = await import(pathToFileURL(root + '/dist/storage/kernel/create-kernel-stores.js').href);
const database = SessionPlaneDatabase.open(file);
try {
  const store = createKernelStores(database);
  for (const [index, phase] of ['uncertain', 'final', 'draft'].entries()) {
    const projectId = marker + '-project-' + index;
    const taskId = marker + '-task-' + index;
    const attemptId = marker + '-attempt-' + index;
    store.projects.openProject({ projectId, clientId: marker, projectKey: projectId, displayName: phase });
    store.projects.openConversationSlot({ projectId, clientId: marker, slotId: 'main', roleKey: 'main', providerKey: 'chatgpt' });
    store.tasks.createTask({ taskId, projectId, slotId: 'main', clientId: marker,
      requestId: marker + '-start-' + phase, expectedSlotRevision: 1, prompt: 'handover ' + phase });
    store.attempts.planAttempt({ taskId, clientId: marker, attemptId,
      kind: 'initial', turnKey: 'root', content: 'handover ' + phase });
    if (phase !== 'draft') store.attempts.reserveAttemptDispatch(taskId, marker, attemptId);
    if (phase === 'uncertain') store.attempts.markAttemptUncertain(taskId, marker, attemptId, 'handover-lost-ack');
    if (phase === 'final') {
      store.attempts.acknowledgeAttempt({ taskId, clientId: marker, attemptId, externalTurnId: marker + '-turn' });
      store.tasks.recordTaskFinal({ taskId, clientId: marker, attemptId,
        externalTurnId: marker + '-turn', resultId: marker + '-result',
        answerText: 'handover exact final\n  retained', completeTask: true });
    }
  }
} finally { database.close(); }
console.log(JSON.stringify({ marker }));
"""
    result = subprocess.run(['node', '--input-type=module', '-e', script,
        str(candidate), str(database_path), marker], text=True, capture_output=True, timeout=60)
    model.save(receipt/'rehearsal-task-write.json', {'exitCode': result.returncode,
        'stdout': result.stdout, 'stderr': result.stderr, 'marker': marker})
    if result.returncode != 0:
        raise RuntimeError('Unable to write isolated rollback rehearsal evidence')
    return marker

def verify_transition_evidence(path, marker):
    verify_sqlite(path)
    with closing(sqlite3.connect(pathlib.Path(path))) as db:
        rows = db.execute('SELECT task_id,state FROM kernel_attempts WHERE task_id LIKE ? ORDER BY task_id',
                          (marker + '-task-%',)).fetchall()
        answer = db.execute('SELECT answer_text FROM kernel_results WHERE task_id LIKE ?',
                            (marker + '-task-%',)).fetchone()
    assert [row[1] for row in rows] == ['uncertain', 'acknowledged', 'planned'], 'Rollback evidence states changed'
    assert answer == ('handover exact final\n  retained',), 'Rollback FINAL bytes changed'
    return {'marker': marker, 'attemptStates': [row[1] for row in rows],
            'finalSha256': hashlib.sha256(answer[0].encode()).hexdigest()}

def rehearse_schema_transition(candidate, source_path, transition, receipt):
    source_schema, target_schema = transition
    migration = receipt/'preflight-migration'
    rollback = receipt/'preflight-rollback'
    migrated = run_offline(candidate, 'migrate', {
        'source': source_path, 'destination': migration,
    }, receipt/'preflight-migration.log')
    assert migrated['sourceSchemaVersion'] == source_schema, 'Rehearsal source schema differs'
    assert migrated['schemaVersion'] == target_schema, 'Rehearsal target schema differs'
    assert migrated['integrityCheck'] == 'ok' and migrated['foreignKeyViolations'] == 0
    assert all(row['count'] == 0 for row in migrated.get('createdKernelTables', [])), 'Task/slot collision in migrated copy'
    candidate_db = migration/'candidate.sqlite'
    marker = seed_transition_evidence(candidate, candidate_db, receipt)
    candidate_hash = bundle.sha256_file(candidate_db)
    rolled = run_offline(candidate, 'rollback', {
        'migration': migration, 'candidate': candidate_db, 'destination': rollback,
    }, receipt/'preflight-rollback.log')
    assert rolled['candidateWasNeverOverwritten'] and rolled['postMigrationEvidencePreserved']
    assert bundle.sha256_file(candidate_db) == candidate_hash, 'Rollback rehearsal overwrote candidate'
    evidence = verify_transition_evidence(rollback/'post-migration-evidence.sqlite', marker)
    verify_sqlite(rollback/'restored-original.sqlite', source_schema)
    report = {'migration': migrated, 'rollback': rolled, 'evidence': evidence,
              'candidateSha256AfterTaskWrites': candidate_hash}
    model.save(receipt/'schema-transition-rehearsal.json', report)
    return report

def promote_database(database_path, migration_dir, receipt, transition):
    source_schema, target_schema = transition
    database_path = pathlib.Path(database_path)
    candidate = pathlib.Path(migration_dir)/'candidate.sqlite'
    verify_sqlite(candidate, target_schema)
    verify_sqlite(pathlib.Path(migration_dir)/'source-snapshot.sqlite', source_schema)
    assert candidate.stat().st_dev == database_path.parent.stat().st_dev, 'Database promotion must be same-filesystem'
    # Keep the sealed migrated candidate beside its manifest. A private copy is
    # the only file renamed into the live path, so the migration receipt remains
    # independently verifiable after success or rollback.
    staged = database_path.parent/('.sessionplane-promote-' + uuid.uuid4().hex + '.sqlite')
    shutil.copy2(candidate, staged); staged.chmod(0o600)
    verify_sqlite(staged, target_schema)
    archive = receipt/'database-archive'
    archive.mkdir(mode=0o700)
    moved = []
    try:
        for suffix in ['', '-wal', '-shm']:
            current = pathlib.Path(str(database_path) + suffix)
            if current.exists():
                target = archive/(database_path.name + suffix)
                current.rename(target)
                moved.append((target, current))
        staged.rename(database_path)
        verify_sqlite(database_path, target_schema)
    except BaseException:
        if database_path.exists() and sqlite_schema(database_path) == target_schema:
            failed = archive/'uncommitted-candidate.sqlite'
            if not failed.exists(): database_path.rename(failed)
        if staged.exists(): staged.unlink()
        for archived, original in reversed(moved):
            if archived.exists() and not original.exists(): archived.rename(original)
        raise
    report = {'phase': 'promoted', 'sourceSchemaVersion': source_schema,
              'targetSchemaVersion': target_schema, 'livePath': str(database_path),
              'archive': str(archive), 'archivedFiles': [str(pair[0]) for pair in moved],
              'sealedCandidate': str(candidate), 'sealedCandidateSha256': bundle.sha256_file(candidate),
              'liveSha256': bundle.sha256_file(database_path)}
    model.save(receipt/'database-promotion.json', report)
    return report
