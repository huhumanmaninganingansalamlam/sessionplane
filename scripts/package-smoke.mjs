#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';

const sourceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const temporaryRoot = mkdtempSync(path.join(tmpdir(), 'sessionplane-package-smoke-'));
const prefix = path.join(temporaryRoot, 'global');

try {
  const packed = run('npm', ['pack', '--silent', '--pack-destination', temporaryRoot], {
    cwd: sourceRoot,
    capture: true,
  });
  const filename = packed.trim().split(/\r?\n/).at(-1);
  if (!filename) throw new Error('npm pack did not return a package filename');
  const tarball = path.join(temporaryRoot, filename);
  const repeatDir = path.join(temporaryRoot, 'repeat');
  mkdirSync(repeatDir, { recursive: true });
  const repeatName = run('npm', ['pack', '--silent', '--pack-destination', repeatDir], {
    cwd: sourceRoot,
    capture: true,
  }).trim().split(/\r?\n/).at(-1);
  const bytes = readFileSync(tarball);
  if (repeatName !== filename ||
      !bytes.equals(readFileSync(path.join(repeatDir, repeatName)))) {
    throw new Error('release package is not byte-for-byte reproducible');
  }
  const packageSha256 = createHash('sha256').update(bytes).digest('hex');

  run('npm', ['install', '-g', '--prefix', prefix, tarball], { cwd: sourceRoot });

  const sessplane = path.join(prefix, 'bin', 'sessplane');
  const installedRoot = path.join(prefix, 'lib', 'node_modules', 'sessionplane');
  if (!existsSync(sessplane)) throw new Error('installed sessplane executable is missing');
  if (existsSync(path.join(installedRoot, 'src'))) {
    throw new Error('TypeScript source must not be shipped in the runtime package');
  }
  if (!existsSync(path.join(installedRoot, 'dist', 'cli', 'main.js'))) {
    throw new Error('built SessionPlane runtime is missing');
  }

  const installedPackage = JSON.parse(
    readFileSync(path.join(installedRoot, 'package.json'), 'utf8'),
  );
  if (JSON.stringify(installedPackage.bin) !== JSON.stringify({ sessplane: 'bin/sessplane.mjs' })) {
    throw new Error('installed package must expose only the sessplane executable');
  }

  const identityPath = path.join(installedRoot, 'dist', 'build-identity.json');
  if (!existsSync(identityPath)) throw new Error('installed package is missing build identity');
  const identity = JSON.parse(readFileSync(identityPath, 'utf8'));
  if (identity.schemaVersion !== 1 || identity.version !== installedPackage.version) {
    throw new Error('build identity schema/version differs from the installed package');
  }
  if (!['clean', 'dirty', 'unavailable'].includes(identity.sourceState) ||
      (identity.sourceCommit !== null && !/^[0-9a-f]{40}$/.test(identity.sourceCommit)) ||
      (identity.sourceTree !== null && !/^[0-9a-f]{40}$/.test(identity.sourceTree)) ||
      (identity.sourceState === 'clean' && (identity.sourceCommit === null || identity.sourceTree === null))) {
    throw new Error('installed package has an invalid or unverified source identity');
  }

  const runtimeEnv = { ...process.env, HOME: temporaryRoot };
  delete runtimeEnv.SESSIONPLANE_STATE_DIR;
  delete runtimeEnv.XDG_STATE_HOME;

  const help = run(sessplane, ['--help'], {
    cwd: temporaryRoot, env: runtimeEnv, capture: true,
  });
  if (/sessplane (?:team|role|request|session|send|stop|wait|artifact)\\b/.test(help)) {
    throw new Error('installed help still advertises a retired public CLI workflow');
  }
  const catalogRequest = {
    jsonrpc: '2.0', id: 1, method: 'tools/list',
    params: { _meta: {
      'io.modelcontextprotocol/protocolVersion': '2026-07-28',
      'io.modelcontextprotocol/clientCapabilities': {},
    } },
  };
  const catalog = JSON.parse(run(sessplane, ['mcp'], {
    cwd: temporaryRoot, env: runtimeEnv, capture: true,
    input: JSON.stringify(catalogRequest) + '\n',
  }).trim());
  const names = catalog.result?.tools?.map((tool) => tool.name).sort();
  const expected = [
    'sessionplane_project_open', 'sessionplane_task_start',
    'sessionplane_task_get', 'sessionplane_task_wait',
    'sessionplane_task_decide', 'sessionplane_task_cancel',
  ].sort();
  if (JSON.stringify(names) !== JSON.stringify(expected)) {
    throw new Error('installed MCP catalogue does not match six-tool contract: ' + JSON.stringify({names, expected, error:catalog.error}));
  }
  const forbiddenCall = JSON.parse(run(sessplane, ['mcp'], {
    cwd: temporaryRoot, env: runtimeEnv, capture: true,
    input: JSON.stringify({ ...catalogRequest, method: 'tools/call',
      params: { ...catalogRequest.params, name: 'sessionplane_team_get',
        arguments: { teamId: 'retired' } } }) + '\n',
  }).trim());
  if (forbiddenCall.error?.code !== -32602) {
    throw new Error('installed MCP still executes a retired workflow tool');
  }
  for (const retired of [
    'dist/core/observation-service.js',
    'dist/core/submission-service.js',
    'dist/core/recovery-service.js',
    'dist/core/thinking-failure-recovery.js',
    'dist/core/conversation-load-recovery.js',
    'dist/core/session-ui-service.js',
    'dist/core/stop-service.js',
    'dist/core/artifact-service.js',
    'dist/core/browser-control-service.js',
    'dist/providers/chatgpt/adapter.js',
    'dist/providers/gemini/adapter.js',
    'dist/providers/grok/adapter.js',
    'dist/core/team-workflow.js',
    'dist/rpc/methods/workflow.js',
    'dist/rpc/methods/team.js',
    'dist/rpc/methods/session.js',
    'dist/rpc/methods/session-ui.js',
    'dist/rpc/methods/send.js',
    'dist/rpc/methods/stop.js',
    'dist/rpc/methods/wait.js',
    'dist/rpc/methods/artifact.js',
    'dist/rpc/methods/browser-control.js',
    'dist/cli/remote-artifacts.js',
  ]) {
    if (existsSync(path.join(installedRoot, retired))) {
      throw new Error('retired public implementation was packaged: ' + retired);
    }
  }
  for (const [file, forbidden] of [
    ['dist/main.js', /registerWorkflowMethods|registerTeamMethods|registerSessionMethods|registerSendMethods|registerWaitMethods|registerStopMethods/],
    ['dist/cli/main.js', /runRequestCommand|runTeamCommand|runSessionCommand|runRoleCommand/],
    ['dist/mcp/tools.js', /workflowSchemas|sessionplane_team_get|sessionplane_send/],
  ]) {
    if (forbidden.test(readFileSync(path.join(installedRoot, file), 'utf8'))) {
      throw new Error('retired public surface remains in installed ' + file);
    }
  }
  // The removed legacy runtime must not be necessary to inspect a sealed
  // archive or migrate a synthetic old database from the installed tarball.
  const archiveHelper = path.join(installedRoot, 'scripts', 'offline-state-rehearsal.mjs');
  if (!existsSync(archiveHelper)) {
    throw new Error('Installed package omits the current read-only archive inspector');
  }
  const archiveSource = path.join(temporaryRoot, 'archive-source.sqlite');
  const archiveCandidate = path.join(temporaryRoot, 'archive-candidate');
  const archiveDb = new DatabaseSync(archiveSource);
  try {
    archiveDb.exec('CREATE TABLE archived_fact (id TEXT PRIMARY KEY, status TEXT, text TEXT) STRICT');
    archiveDb.prepare('INSERT INTO archived_fact VALUES(?,?,?)')
      .run('one', 'submission_unknown', 'A test-only stored, unacknowledged POST');
  } finally { archiveDb.close(); }
  const upgradedArchive = JSON.parse(run(process.execPath, [
    archiveHelper, 'migrate', '--source', archiveSource,
    '--destination', archiveCandidate,
  ], { cwd: temporaryRoot, env: runtimeEnv, capture: true }).trim());
  const inspectedArchive = JSON.parse(run(process.execPath, [
    archiveHelper, 'inspect', '--migration', archiveCandidate,
  ], { cwd: temporaryRoot, env: runtimeEnv, capture: true }).trim());
  if (inspectedArchive.completeOriginalFactsVerified !== true ||
      inspectedArchive.sourceOpenedReadOnly !== true ||
      inspectedArchive.legacyRuntimeRequired !== false ||
      inspectedArchive.conversationBodiesReturned !== false ||
      inspectedArchive.snapshotSha256 !== upgradedArchive.snapshotSha256 ||
      inspectedArchive.tables.find(row => row.name === 'archived_fact')?.count !== 1) {
    throw new Error('Installed archive provenance/inspection failed without old workflow');
  }

  const doctor = JSON.parse(run(sessplane, ['doctor', '--json'], {
    cwd: temporaryRoot,
    env: runtimeEnv,
    capture: true,
  }));
  if (doctor.requestOk !== true) throw new Error('installed sessplane doctor failed');
  const installedCore = JSON.parse(run(process.execPath, [
    path.join(sourceRoot, 'scripts', 'installed-core-smoke.mjs'),
    installedRoot, temporaryRoot,
  ], {
    cwd: sourceRoot, env: runtimeEnv, capture: true,
  }).trim());
  if (installedCore.requestOk !== true ||
      installedCore.gate !== 'installed-core-public-task-smoke' ||
      installedCore.toolCount !== 6 || installedCore.originalProviderPosts !== 0 ||
      installedCore.isolatedBrowserStarted !== false ||
      installedCore.installedCoreRestarted !== true ||
      installedCore.requestIdentitySurvivedRestart !== true ||
      installedCore.originalAttemptCountAfterRestart !== 1 ||
      installedCore.secondSlotRevisionIndependentAfterRestart !== true ||
      installedCore.historicalSlotRecoveredAfterRestart !== true ||
      installedCore.crossProjectRequestCollisionRejected !== true ||
      installedCore.staleBindingReplacementRejectedAfterRestart !== true ||
      installedCore.noIdleLegacyActorsOnRestart !== true ||
      installedCore.installedNoFinal20MinuteContinue !== true ||
      installedCore.installedExactFinalStopsContinuation !== true ||
      installedCore.installed429NeverLicensesContinue !== true ||
      installedCore.installedPersistent429FifthSlotAgentReview !== true ||
      installedCore.installedPersistent429ReviewResumesOnce !== true ||
      installedCore.installedPersistent429ExtraPosts !== 0 ||
      installedCore.installedPublicFinalFairRotation !== true ||
      installedCore.installedPublicPreparationFairRotation !== true) {
    throw new Error('Installed Core idempotency/restart/rebinding smoke failed');
  }

  process.stdout.write(
    `${JSON.stringify({ requestOk: true, gate: 'package-smoke', filename, packageSha256 })}\n`,
  );
} finally {
  rmSync(temporaryRoot, { recursive: true, force: true });
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    env: options.env ?? process.env,
    encoding: 'utf8',
    stdio: options.capture ? 'pipe' : 'inherit',
    ...(options.input === undefined ? {} : { input: options.input }),
  });
  if (result.error !== undefined) throw result.error;
  if (result.status !== 0) {
    throw new Error(
      `${command} ${args.join(' ')} failed with exit code ${String(result.status)}\n${result.stderr ?? ''}`,
    );
  }
  return result.stdout ?? '';
}
