#!/usr/bin/env node

import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const sourceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const temporaryRoot = mkdtempSync(path.join(tmpdir(), 'sessionplane-package-smoke-'));
const prefix = path.join(temporaryRoot, 'global');
const stateDir = path.join(temporaryRoot, 'state');

try {
  const packed = run('npm', ['pack', '--silent', '--pack-destination', temporaryRoot], {
    cwd: sourceRoot,
    capture: true,
  });
  const filename = packed.trim().split(/\r?\n/).at(-1);
  if (!filename) throw new Error('npm pack did not return a package filename');
  const tarball = path.join(temporaryRoot, filename);

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

  run(sessplane, ['--help'], { cwd: temporaryRoot, capture: true });
  const doctor = JSON.parse(run(sessplane, ['doctor', '--json'], {
    cwd: temporaryRoot,
    env: { ...process.env, SESSIONPLANE_STATE_DIR: stateDir },
    capture: true,
  }));
  if (doctor.requestOk !== true) throw new Error('installed sessplane doctor failed');
  process.stdout.write(
    `${JSON.stringify({ requestOk: true, gate: 'package-smoke', filename })}\n`,
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
  });
  if (result.error !== undefined) throw result.error;
  if (result.status !== 0) {
    throw new Error(
      `${command} ${args.join(' ')} failed with exit code ${String(result.status)}\n${result.stderr ?? ''}`,
    );
  }
  return result.stdout ?? '';
}
