#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const packageJson = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
const version = String(packageJson.version ?? '');
if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) {
  throw new Error(`package version is not release-safe semver: ${version}`);
}
const tag = `v${version}`;

const status = capture('git', ['status', '--porcelain'], 'git status --porcelain');
if (status.trim() !== '') {
  throw new Error('release preflight requires a clean working tree');
}

const branch = capture('git', ['branch', '--show-current'], 'git branch --show-current').trim();
if (branch !== 'main') {
  throw new Error(`release preflight requires main, found ${branch || '(detached)'}`);
}

run('git', ['fetch', 'origin', 'main', '--quiet'], 'git fetch origin main --quiet');
const head = capture('git', ['rev-parse', 'HEAD'], 'git rev-parse HEAD').trim();
const originMain = capture(
  'git',
  ['rev-parse', 'origin/main'],
  'git rev-parse origin/main',
).trim();
if (head !== originMain) {
  throw new Error(`HEAD ${head} does not match origin/main ${originMain}`);
}

const existingTag = capture(
  'git',
  ['ls-remote', '--tags', 'origin', `refs/tags/${tag}`],
  `git ls-remote --tags origin refs/tags/${tag}`,
);
if (existingTag.trim() !== '') {
  throw new Error(`release tag already exists on origin: ${tag}`);
}

run('npm', ['run', 'verify:clean'], 'npm run verify:clean');

const temporaryRoot = mkdtempSync(path.join(tmpdir(), 'sessionplane-release-preflight-'));
try {
  const firstDir = path.join(temporaryRoot, 'first');
  const secondDir = path.join(temporaryRoot, 'second');
  run('mkdir', ['-p', firstDir, secondDir], 'mkdir release pack directories');
  const firstName = capture(
    'npm',
    ['pack', '--silent', '--pack-destination', firstDir],
    'npm pack --silent',
  ).trim().split(/\r?\n/).at(-1);
  const secondName = capture(
    'npm',
    ['pack', '--silent', '--pack-destination', secondDir],
    'npm pack --silent',
  ).trim().split(/\r?\n/).at(-1);
  if (!firstName || !secondName || firstName !== secondName) {
    throw new Error('release pack filenames are not deterministic');
  }
  const firstBytes = readFileSync(path.join(firstDir, firstName));
  const secondBytes = readFileSync(path.join(secondDir, secondName));
  if (!firstBytes.equals(secondBytes)) {
    throw new Error('release package is not byte-for-byte reproducible');
  }
  const sha256 = createHash('sha256').update(firstBytes).digest('hex');
  process.stdout.write(
    `${JSON.stringify({
      requestOk: true,
      gate: 'release-preflight',
      tag,
      commit: head,
      package: firstName,
      sha256,
    })}\n`,
  );
} finally {
  rmSync(temporaryRoot, { recursive: true, force: true });
}

function capture(command, args, label) {
  return execute(command, args, label, true);
}

function run(command, args, label) {
  execute(command, args, label, false);
}

function execute(command, args, label, captureOutput) {
  const result = spawnSync(command, args, {
    cwd: root,
    env: process.env,
    encoding: 'utf8',
    stdio: captureOutput ? 'pipe' : 'inherit',
  });
  if (result.error !== undefined) throw result.error;
  if (result.status !== 0) {
    throw new Error(
      `${label} failed with exit code ${String(result.status)}${result.stderr ? `\n${result.stderr}` : ''}`,
    );
  }
  return result.stdout ?? '';
}
