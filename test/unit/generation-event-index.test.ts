import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { EventRepository } from '../../src/storage/event-repository.ts';
import { migrations, runMigrations } from '../../src/storage/migrations/index.ts';

test('generation history upgrade bounds original evidence lookups without changing records or latest-result selection', t => {
  const db = new DatabaseSync(':memory:');
  try {
    db.exec('CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL) STRICT');
    for (const migration of migrations.filter(migration => migration.version < 8)) {
      migration.up(db);
      db.prepare('INSERT INTO schema_migrations VALUES(?,?,?)').run(migration.version, migration.name, '2026-10-28T00:00:00Z');
    }
    const events = new EventRepository(db);
    const append = (sessionId: string, generation: number, eventType: string, payload: Record<string, unknown>) =>
      events.append({ teamId: 'retained-team', sessionId, generation, eventType, payload, createdAt: '2026-10-28T00:00:00Z' });
    append('same-session', 1, 'generation.backend-unavailable', { recoveryReason: 'backend-user-anchor-absent-from-mapping' });
    append('same-session', 2, 'generation.backend-progress', { serverObservation: { marker: 'older' } });
    append('same-session', 2, 'generation.backend-progress', { serverObservation: { marker: 'original-result' } });
    append('same-session', 2, 'generation.backend-unavailable', { serverObservation: null });
    append('same-session', 2, 'generation.dom-progress', { serverObservation: { marker: 'wrong-source' } });
    append('other-session', 2, 'generation.backend-progress', { serverObservation: { marker: 'wrong-session' } });
    append('same-session', 1, 'generation.backend-progress', { serverObservation: { marker: 'late-old-generation' },
      recoveryReason: 'backend-exact-final' });
    const read = () => ({ server: events.latestServerObservation('same-session', 2),
      anchor: events.latestAnchorRecovery('same-session', 2),
      old: events.latestServerObservation('same-session', 1), absent: events.latestServerObservation('same-session', 3) });
    const before = read();
    assert.equal((before.server!.serverObservation as { marker: string }).marker, 'original-result');
    assert.equal(before.anchor, null);
    assert.equal(before.absent, null);
    const records = db.prepare('SELECT * FROM events ORDER BY sequence').all();
    assert.equal(runMigrations(db), 8);
    assert.deepEqual(read(), before);
    assert.deepEqual(db.prepare('SELECT * FROM events ORDER BY sequence').all(), records);
    assert.equal(runMigrations(db), 8, 'ordinary reopen must not repeat the migration');

    const queries: string[] = [];
    const prepare = db.prepare.bind(db);
    t.mock.method(db, 'prepare', (sql: string) => { queries.push(sql); return prepare(sql); });
    events.latestServerObservation('same-session', 2);
    events.latestAnchorRecovery('same-session', 2);
    t.mock.restoreAll();
    assert.equal(queries.length, 2);
    for (const query of queries) {
      const plan = prepare(`EXPLAIN QUERY PLAN ${query}`).all('same-session', 2);
      assert.match(JSON.stringify(plan), /idx_events_session_generation_sequence \(session_id=\? AND generation=\?\)/);
    }
    append('same-session', 2, 'generation.backend-complete', { serverObservation: { marker: 'new-result' }, recoveryReason: 'backend-exact-final' });
    assert.equal((events.latestServerObservation('same-session', 2)!.serverObservation as { marker: string }).marker, 'new-result');
    assert.equal(events.latestAnchorRecovery('same-session', 2)!.recoveryReason, 'backend-exact-final');
  } finally { t.mock.restoreAll(); db.close(); }
});
