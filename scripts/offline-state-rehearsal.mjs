import { createHash } from 'node:crypto';
import {
  chmodSync, closeSync, copyFileSync, existsSync, mkdirSync, mkdtempSync,
  openSync, readFileSync, readSync, realpathSync, renameSync, rmSync, writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { backup, DatabaseSync } from 'node:sqlite';
import { pathToFileURL } from 'node:url';

// Source checkout and installed tarball use the same current schema engine.
 // The archived v8 state is never opened by an old workflow runtime.
const databaseModule = existsSync(new URL('../src/storage/database.ts', import.meta.url))
  ? '../src/storage/database.ts' : '../dist/storage/database.js';
const { SessionPlaneDatabase } = await import(databaseModule);

const KIND = 'sessionplane-offline-state-rehearsal-v1';
const ROLLBACK_KIND = 'sessionplane-offline-rollback-v1';

function assertPath(value, label) {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(label + ' path is required');
  }
  return path.resolve(value);
}

function openReadonly(file) {
  return new DatabaseSync(file, { readOnly: true });
}

function verifyDatabase(db) {
  const integrity = db.prepare('PRAGMA integrity_check').all();
  if (integrity.length !== 1 || Object.values(integrity[0] ?? {})[0] !== 'ok') {
    throw new Error('SQLite full integrity verification failed');
  }
  const foreignKeys = db.prepare('PRAGMA foreign_key_check').all();
  if (foreignKeys.length !== 0) {
    throw new Error('SQLite foreign-key verification failed');
  }
}

function schemaVersion(db) {
  const table = db.prepare(
    "SELECT name FROM sqlite_master WHERE type='table' AND name='schema_migrations'",
  ).get();
  return table ? Number(db.prepare(
    'SELECT COALESCE(MAX(version),0) AS version FROM schema_migrations',
  ).get().version) : 0;
}

function quote(identifier) {
  return '"' + identifier.replaceAll('"', '""') + '"';
}

function canonicalRow(row) {
  return JSON.stringify(row, (_key, value) => {
    if (typeof value === 'bigint') return { sqliteInteger: value.toString() };
    if (value instanceof Uint8Array) {
      return { sqliteBlob: Buffer.from(value).toString('base64') };
    }
    return value;
  });
}

function tableFacts(db, sourceColumnProjection = null) {
  const tables = db.prepare(
    "SELECT name,sql FROM sqlite_master WHERE type='table'" +
    " AND name NOT IN ('schema_migrations','sqlite_sequence')" +
    " AND name NOT LIKE 'sqlite_%' ORDER BY name",
  ).all();
  const facts = [];
  for (const table of tables) {
    const name = String(table.name);
    const primaryKey = db.prepare('PRAGMA table_info(' + quote(name) + ')').all()
      .filter(column => Number(column.pk) > 0)
      .sort((a, b) => Number(a.pk) - Number(b.pk));
    const order = primaryKey.length > 0
      ? primaryKey.map(column => quote(String(column.name))).join(',')
      : 'rowid';
    // During an additive migration, compare only columns from the sealed source
    // schema. New migration-owned columns must not rewrite the original
    // Decision/Task fact hash, and every original value remains byte-exact.
    const columns = sourceColumnProjection?.get(name);
    const selection = columns ? columns.map(quote).join(',') : '*';
    const statement = db.prepare('SELECT ' + selection + ' FROM ' +
      quote(name) + ' ORDER BY ' + order);
    const sha = createHash('sha256');
    let count = 0;
    for (const row of statement.iterate()) {
      sha.update(canonicalRow(row));
      sha.update('\n');
      count++;
    }
    facts.push({ name, count, sha256: sha.digest('hex') });
  }
  return facts;
}

function sha256File(file) {
  const hash = createHash('sha256');
  const fd = openSync(file, 'r');
  const chunk = Buffer.allocUnsafe(1024 * 1024);
  try {
    for (;;) {
      const size = readSync(fd, chunk, 0, chunk.length, null);
      if (size === 0) break;
      hash.update(chunk.subarray(0, size));
    }
  } finally { closeSync(fd); }
  return hash.digest('hex');
}

function readVerifiedManifest(directory, expectedKind = KIND) {
  const manifest = JSON.parse(readFileSync(path.join(directory, 'manifest.json'), 'utf8'));
  if (manifest.kind !== expectedKind || manifest.version !== 1) {
    throw new Error('Offline manifest contract mismatch');
  }
  return manifest;
}

function writeJson(file, value) {
  writeFileSync(file, JSON.stringify(value, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
}

function stageInParent(destination) {
  const parent = path.dirname(destination);
  mkdirSync(parent, { recursive: true, mode: 0o700 });
  return mkdtempSync(path.join(parent, '.sessionplane-offline-'));
}

function verifyFileHash(file, expected, label) {
  if (!/^[0-9a-f]{64}$/.test(String(expected)) || sha256File(file) !== expected) {
    throw new Error(label + ' SHA-256 mismatch');
  }
}

/** Read-only source -> consistent SQLite backup -> isolated schema upgrade.
 * No caller, browser or Core is started and no source DB receives writes.
 * A committed output directory is immutable; identical replays are read-only.
 */
export async function rehearseMigration(input) {
  const source = realpathSync(assertPath(input.sourcePath, 'source'));
  const destination = assertPath(input.destinationDir, 'destination');

  if (existsSync(destination)) {
    const old = readVerifiedManifest(destination);
    const snapshot = path.join(destination, 'source-snapshot.sqlite');
    const migrated = path.join(destination, 'candidate.sqlite');
    verifyFileHash(snapshot, old.snapshotSha256, 'Archived original');
    verifyFileHash(migrated, old.candidateSha256, 'Committed candidate');
    const original = openReadonly(source);
    try {
      verifyDatabase(original);
      if (schemaVersion(original) !== old.sourceSchemaVersion ||
          JSON.stringify(tableFacts(original)) !== JSON.stringify(old.originalFacts)) {
        throw new Error('Source changed since committed offline rehearsal');
      }
    } finally { original.close(); }
    return { ...old, replayed: true };
  }

  const stage = stageInParent(destination);
  try {
    const snapshot = path.join(stage, 'source-snapshot.sqlite');
    const candidate = path.join(stage, 'candidate.sqlite');
    // The SQLite backup is the first durable operation. Facts are derived from
    // that one WAL-consistent image, never from a racing pre-backup read.
    const readSource = openReadonly(source);
    try { await backup(readSource, snapshot); }
    finally { readSource.close(); }

    const snapshotDb = openReadonly(snapshot);
    let sourceFacts;
    let sourceColumns;
    let sourceSchemaVersion;
    try {
      verifyDatabase(snapshotDb);
      sourceFacts = tableFacts(snapshotDb);
      sourceColumns = new Map(sourceFacts.map(fact => [fact.name,
        snapshotDb.prepare('PRAGMA table_info(' + quote(fact.name) + ')').all()
          .map(column => String(column.name))]));
      sourceSchemaVersion = schemaVersion(snapshotDb);
    } finally { snapshotDb.close(); }
    if (input.failAfterSnapshot === true) throw new Error('Injected offline interruption');

    // Copying a *closed, consistent SQLite backup* is safe; it is not a copy
    // of the original live WAL/DB files. The migrated candidate is separate.
    copyFileSync(snapshot, candidate);
    chmodSync(snapshot, 0o600);
    chmodSync(candidate, 0o600);

    const upgraded = SessionPlaneDatabase.open(candidate);
    let candidateSchemaVersion;
    let createdKernelTables;
    try {
      verifyDatabase(upgraded.raw);
      candidateSchemaVersion = upgraded.schemaVersion;
      const retainedFacts = tableFacts(upgraded.raw, sourceColumns);
      for (const fact of sourceFacts) {
        const after = retainedFacts.find(value => value.name === fact.name);
        if (!after || after.count !== fact.count || after.sha256 !== fact.sha256) {
          throw new Error('Migration changed an archived original fact: ' + fact.name);
        }
      }
      const originalNames = new Set(sourceFacts.map(fact => fact.name));
      createdKernelTables = retainedFacts.filter(fact =>
        fact.name.startsWith('kernel_') && !originalNames.has(fact.name));
      if (createdKernelTables.some(fact => fact.count !== 0)) {
        throw new Error('Migration introduced conflicting Task/slot rows');
      }
    } finally { upgraded.close(); }

    const manifest = {
      kind: KIND, version: 1,
      createdAt: new Date().toISOString(),
      sourceBasename: path.basename(source),
      sourceSchemaVersion,
      originalFacts: sourceFacts,
      snapshotSha256: sha256File(snapshot),
      candidateSha256: sha256File(candidate),
      schemaVersion: candidateSchemaVersion,
      createdKernelTables,
      integrityCheck: 'ok',
      foreignKeyViolations: 0,
      sourceReadOnly: true,
      publishedAtomically: true,
      rollback: 'new-evidence-first; no in-place restoration or deletion',
    };
    writeJson(path.join(stage, 'manifest.json'), manifest);
    renameSync(stage, destination);
    return { ...manifest, replayed: false };
  } catch (error) {
    rmSync(stage, { recursive: true, force: true });
    throw error;
  }
}

/** An archived v8 (or older) state remains independently inspectable even
 * after the old RPC/workflow implementation is removed from the package.
 * This performs read-only SQLite/manifest verification; it does not run
 * migrations, deserialize workflow objects, or export conversation bodies.
 */
export function inspectArchivedState(input) {
  const rehearsal = realpathSync(assertPath(input.migrationDir, 'migration'));
  const manifest = readVerifiedManifest(rehearsal);
  const source = path.join(rehearsal, 'source-snapshot.sqlite');
  verifyFileHash(source, manifest.snapshotSha256, 'Archived original');
  const db = openReadonly(source);
  try {
    verifyDatabase(db);
    const current = tableFacts(db);
    if (JSON.stringify(current) !== JSON.stringify(manifest.originalFacts)) {
      throw new Error('Archived source table facts differ from sealed manifest');
    }
    const hasTable = (name) => current.some(fact => fact.name === name) ||
      Boolean(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(name));
    const byState = (table) => hasTable(table)
      ? db.prepare('SELECT submission_state AS state,COUNT(*) AS count FROM ' +
          quote(table) + ' GROUP BY submission_state ORDER BY submission_state').all()
        .map(row => ({ state: String(row.state), count: Number(row.count) }))
      : [];
    const archivedSchemaVersion = schemaVersion(db);
    return {
      kind: 'sessionplane-archived-state-inspection-v1',
      sourceSchemaVersion: archivedSchemaVersion,
      candidateSchemaVersion: manifest.schemaVersion,
      snapshotSha256: manifest.snapshotSha256,
      tables: current,
      retainedSubmissionStates: {
        generations: byState('generations'),
        outbox: byState('outbox'),
      },
      completeOriginalFactsVerified: true,
      legacyRuntimeRequired: false,
      sourceOpenedReadOnly: true,
      conversationBodiesReturned: false,
    };
  } finally {
    db.close();
  }
}

function assertOriginalFacts(db, expected, label) {
  const facts = tableFacts(db);
  for (const original of expected) {
    const retained = facts.find(value => value.name === original.name);
    if (!retained || retained.count !== original.count ||
        retained.sha256 !== original.sha256) {
      throw new Error(label + ' does not match source manifest: ' + original.name);
    }
  }
}

function assertOriginalRowsRetained(
  sourceDb, candidateDb, tableName, label, allowSchedulerPositionChanges = false,
) {
  const sourceColumns = sourceDb.prepare('PRAGMA table_info(' + quote(tableName) + ')').all();
  const candidateColumns = new Set(candidateDb.prepare(
    'PRAGMA table_info(' + quote(tableName) + ')').all().map(column => String(column.name)));
  const primaryKey = sourceColumns.filter(column => Number(column.pk) > 0)
    .sort((a, b) => Number(a.pk) - Number(b.pk));
  if (sourceColumns.length === 0 ||
      sourceColumns.some(column => !candidateColumns.has(String(column.name)))) {
    throw new Error(label + ' cannot prove retained source rows: ' + tableName);
  }
  const sourceCount = Number(sourceDb.prepare(
    'SELECT COUNT(*) AS count FROM ' + quote(tableName)).get().count);
  if (sourceCount === 0) return;
  if (primaryKey.length === 0) {
    throw new Error(label + ' cannot prove retained source rows: ' + tableName);
  }
  const columns = sourceColumns.map(column => String(column.name));
  const projection = columns.map(quote).join(',');
  const order = primaryKey.map(column => quote(String(column.name))).join(',');
  const where = primaryKey.map(column => quote(String(column.name)) + ' IS ?').join(' AND ');
  const sourceRows = sourceDb.prepare(
    'SELECT ' + projection + ' FROM ' + quote(tableName) + ' ORDER BY ' + order);
  const lookup = candidateDb.prepare(
    'SELECT ' + projection + ' FROM ' + quote(tableName) + ' WHERE ' + where);
  for (const sourceRow of sourceRows.iterate()) {
    const key = primaryKey.map(column => sourceRow[String(column.name)]);
    const candidateRow = lookup.get(...key);
    // Cursor positions and preparation phase are scheduling hints, not
    // submission evidence. Their values advance under normal Core operation,
    // but the original primary-key identities must still be present.
    if (!candidateRow || (!allowSchedulerPositionChanges &&
        canonicalRow(candidateRow) !== canonicalRow(sourceRow))) {
      throw new Error(label + ' changed or removed a source row: ' + tableName);
    }
  }
}

function assertRollbackCandidate(candidateDb, sourceDb, manifest, label) {
  if (schemaVersion(candidateDb) !== manifest.schemaVersion) {
    throw new Error(label + ' schema differs from migration manifest');
  }
  const facts = tableFacts(candidateDb);
  for (const original of manifest.originalFacts) {
    const retained = facts.find(value => value.name === original.name);
    if (retained && retained.count === original.count && retained.sha256 === original.sha256) {
      continue;
    }
    // Both an equal-schema refresh and an additive schema transition can
    // accumulate exact Task/attempt/result evidence after migration. For an
    // existing durable kernel table, permit only additional rows while
    // verifying every original primary-keyed row remains byte-exact. The
    // original legacy/session/outbox tables still require full table hashes.
    // A table without provable source primary keys fails closed.
    if (original.name.startsWith('kernel_')) {
      // Only these two bounded scheduler metadata tables can update their
      // position fields. All Task, attempt, result, and submission evidence
      // remains byte-exact by original primary key.
      const mutableSchedulerPosition = original.name === 'kernel_public_scan_cursors' ||
        original.name === 'kernel_public_preparation_phase';
      assertOriginalRowsRetained(sourceDb, candidateDb, original.name, label,
        mutableSchedulerPosition);
      continue;
    }
    throw new Error(label + ' does not match source manifest: ' + original.name);
  }
}

/** A rollback rehearsal NEVER replaces the candidate database. It snapshots
 * post-migration evidence first, then restores the original into another
 * destination. New ACKs, UNKNOWNs and drafts remain in the evidence file.
 */
export async function rehearseRollback(input) {
  const rehearsal = realpathSync(assertPath(input.migrationDir, 'migration'));
  const candidate = realpathSync(assertPath(input.candidatePath, 'candidate'));
  const destination = assertPath(input.destinationDir, 'rollback destination');
  const manifest = readVerifiedManifest(rehearsal);
  const original = path.join(rehearsal, 'source-snapshot.sqlite');
  verifyFileHash(original, manifest.snapshotSha256, 'Original rollback source');
  if (candidate === original || candidate === destination) {
    throw new Error('Rollback candidate, original and output must be distinct');
  }
  if (existsSync(destination)) throw new Error('Rollback output already exists; preserve its evidence');

  const stage = stageInParent(destination);
  const sourceDb = openReadonly(original);
  try {
    verifyDatabase(sourceDb);
    const evidence = path.join(stage, 'post-migration-evidence.sqlite');
    const restored = path.join(stage, 'restored-original.sqlite');
    const readCandidate = openReadonly(candidate);
    try {
      verifyDatabase(readCandidate);
      // This must not accept a different account/backup merely because its
      // SQLite schema is compatible. Equal-schema refreshes may append only
      // durable kernel evidence while retaining every original row byte-exact.
      assertRollbackCandidate(readCandidate, sourceDb, manifest, 'Rollback candidate');
      await backup(readCandidate, evidence);
    } finally { readCandidate.close(); }
    if (input.failAfterEvidence === true) {
      throw new Error('Injected rollback interruption after retaining new evidence');
    }
    copyFileSync(original, restored);
    chmodSync(evidence, 0o600);
    chmodSync(restored, 0o600);
    const restoredDb = openReadonly(restored);
    const retainedDb = openReadonly(evidence);
    try {
      verifyDatabase(restoredDb);
      verifyDatabase(retainedDb);
      if (JSON.stringify(tableFacts(restoredDb)) !== JSON.stringify(manifest.originalFacts)) {
        throw new Error('Rollback original facts differ');
      }
      // Detect a candidate that changed while the consistent snapshot was
      // being taken. Never publish a mixed-account rollback result.
      assertRollbackCandidate(retainedDb, sourceDb, manifest,
        'Retained rollback evidence');
    } finally { restoredDb.close(); retainedDb.close(); }

    const result = {
      kind: ROLLBACK_KIND, version: 1, createdAt: new Date().toISOString(),
      sourceMigrationSha256: manifest.snapshotSha256,
      restoredOriginalSha256: sha256File(restored),
      retainedNewEvidenceSha256: sha256File(evidence),
      candidateWasNeverOverwritten: true,
      postMigrationEvidencePreserved: true,
    };
    writeJson(path.join(stage, 'manifest.json'), result);
    renameSync(stage, destination);
    return result;
  } catch (error) {
    rmSync(stage, { recursive: true, force: true });
    throw error;
  } finally {
    sourceDb.close();
  }
}

function parseArguments(argv) {
  const parsed = {};
  for (let i = 0; i < argv.length; i += 2) {
    const flag = argv[i];
    const value = argv[i + 1];
    if (!flag?.startsWith('--') || !value || value.startsWith('--')) {
      throw new Error('Every offline argument must have an explicit value');
    }
    const name = flag.slice(2);
    if (!['source', 'migration', 'candidate', 'destination'].includes(name) ||
        Object.hasOwn(parsed, name)) throw new Error('Unsupported offline argument: ' + name);
    parsed[name] = value;
  }
  return parsed;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const argv = process.argv.slice(2);
  const mode = argv.shift();
  const args = parseArguments(argv);
  const operation = mode === 'migrate'
    ? rehearseMigration({ sourcePath: args.source, destinationDir: args.destination })
    : mode === 'rollback'
      ? rehearseRollback({
          migrationDir: args.migration, candidatePath: args.candidate,
          destinationDir: args.destination,
        })
      : mode === 'inspect'
        ? Promise.resolve(inspectArchivedState({ migrationDir: args.migration }))
        : Promise.reject(new Error('Usage: offline-state-rehearsal.mjs migrate|rollback|inspect --...'));
  operation.then(result => process.stdout.write(JSON.stringify(result) + '\n'),
    error => { process.stderr.write(error.message + '\n'); process.exitCode = 1; });
}
