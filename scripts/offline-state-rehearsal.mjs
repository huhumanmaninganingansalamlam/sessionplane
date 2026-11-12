import { createHash } from 'node:crypto';
import {
  chmodSync, closeSync, copyFileSync, existsSync, mkdirSync, mkdtempSync,
  openSync, readFileSync, readSync, realpathSync, renameSync, rmSync, writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { backup, DatabaseSync } from 'node:sqlite';
import { pathToFileURL } from 'node:url';

import { SessionPlaneDatabase } from '../src/storage/database.ts';

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

function quickCheck(db) {
  const result = db.prepare('PRAGMA quick_check').get();
  if (Object.values(result ?? {})[0] !== 'ok') throw new Error('SQLite integrity verification failed');
}

function quote(identifier) {
  return '"' + identifier.replaceAll('"', '""') + '"';
}

function tableFacts(db) {
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
    const statement = db.prepare('SELECT * FROM ' + quote(name) + ' ORDER BY ' + order);
    const sha = createHash('sha256');
    let count = 0;
    for (const row of statement.iterate()) {
      sha.update(JSON.stringify(row, (_key, value) => {
        if (typeof value === 'bigint') return { sqliteInteger: value.toString() };
        if (value instanceof Uint8Array) return { sqliteBlob: Buffer.from(value).toString('base64') };
        return value;
      }));
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
  const original = openReadonly(source);
  let sourceFacts;
  try { quickCheck(original); sourceFacts = tableFacts(original); }
  finally { original.close(); }

  if (existsSync(destination)) {
    const old = readVerifiedManifest(destination);
    const snapshot = path.join(destination, 'source-snapshot.sqlite');
    const migrated = path.join(destination, 'candidate.sqlite');
    verifyFileHash(snapshot, old.snapshotSha256, 'Archived original');
    verifyFileHash(migrated, old.candidateSha256, 'Committed candidate');
    if (JSON.stringify(old.originalFacts) !== JSON.stringify(sourceFacts)) {
      throw new Error('Source changed since committed offline rehearsal');
    }
    return { ...old, replayed: true };
  }

  const stage = stageInParent(destination);
  try {
    const snapshot = path.join(stage, 'source-snapshot.sqlite');
    const candidate = path.join(stage, 'candidate.sqlite');
    const readSource = openReadonly(source);
    try { await backup(readSource, snapshot); }
    finally { readSource.close(); }

    const snapshotDb = openReadonly(snapshot);
    try {
      quickCheck(snapshotDb);
      if (JSON.stringify(tableFacts(snapshotDb)) !== JSON.stringify(sourceFacts)) {
        throw new Error('Online backup differs from source fact snapshot; retry offline');
      }
    } finally { snapshotDb.close(); }
    if (input.failAfterSnapshot === true) throw new Error('Injected offline interruption');

    // Copying a *closed, consistent SQLite backup* is safe; it is not a copy
    // of the original live WAL/DB files. The migrated candidate is separate.
    copyFileSync(snapshot, candidate);
    chmodSync(snapshot, 0o600);
    chmodSync(candidate, 0o600);

    const upgraded = SessionPlaneDatabase.open(candidate);
    let schemaVersion;
    try {
      quickCheck(upgraded.raw);
      schemaVersion = upgraded.schemaVersion;
      const retainedFacts = tableFacts(upgraded.raw);
      for (const fact of sourceFacts) {
        const after = retainedFacts.find(value => value.name === fact.name);
        if (!after || after.count !== fact.count || after.sha256 !== fact.sha256) {
          throw new Error('Migration changed an archived original fact: ' + fact.name);
        }
      }
    } finally { upgraded.close(); }

    const manifest = {
      kind: KIND, version: 1,
      createdAt: new Date().toISOString(),
      sourceBasename: path.basename(source),
      originalFacts: sourceFacts,
      snapshotSha256: sha256File(snapshot),
      candidateSha256: sha256File(candidate),
      schemaVersion,
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
  try {
    const evidence = path.join(stage, 'post-migration-evidence.sqlite');
    const restored = path.join(stage, 'restored-original.sqlite');
    const readCandidate = openReadonly(candidate);
    try {
      quickCheck(readCandidate);
      // This must not accept a different account/backup merely because its
      // SQLite schema is compatible. Original legacy facts are immutable.
      assertOriginalFacts(readCandidate, manifest.originalFacts, 'Rollback candidate');
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
      quickCheck(restoredDb);
      quickCheck(retainedDb);
      if (JSON.stringify(tableFacts(restoredDb)) !== JSON.stringify(manifest.originalFacts)) {
        throw new Error('Rollback original facts differ');
      }
      // Detect a candidate that changed while the consistent snapshot was
      // being taken. Never publish a mixed-account rollback result.
      assertOriginalFacts(retainedDb, manifest.originalFacts, 'Retained rollback evidence');
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
      : Promise.reject(new Error('Usage: offline-state-rehearsal.mjs migrate|rollback --...'));
  operation.then(result => process.stdout.write(JSON.stringify(result) + '\n'),
    error => { process.stderr.write(error.message + '\n'); process.exitCode = 1; });
}
