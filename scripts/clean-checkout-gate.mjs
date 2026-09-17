#!/usr/bin/env node

import { cpSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const sourceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const temporaryRoot = mkdtempSync(path.join(tmpdir(), 'sessionplane-clean-checkout-'));
const checkoutRoot = path.join(temporaryRoot, 'sessionplane');
const excluded = new Set(['.git', '.state', 'node_modules', 'dist', 'coverage']);

try {
  cpSync(sourceRoot, checkoutRoot, {
    recursive: true,
    force: true,
    filter(source) {
      const relative = path.relative(sourceRoot, source);
      if (relative === '') {
        return true;
      }
      return !relative.split(path.sep).some((segment) => excluded.has(segment));
    },
  });

  for (const [command, args] of [
    ['npm', ['ci']],
    ['npm', ['run', 'browser:install']],
    ['npm', ['run', 'typecheck']],
    ['npm', ['test']],
    ['npm', ['run', 'build']],
    ['npm', ['run', 'doctor']],
  ]) {
    const result = spawnSync(command, args, {
      cwd: checkoutRoot,
      env: {
        ...process.env,
        SESSIONPLANE_STATE_DIR: path.join(checkoutRoot, '.state'),
      },
      stdio: 'inherit',
    });
    if (result.error !== undefined) {
      throw result.error;
    }
    if (result.status !== 0) {
      throw new Error(`${command} ${args.join(' ')} failed with exit code ${String(result.status)}`);
    }
  }

  process.stdout.write(
    `${JSON.stringify({ requestOk: true, gate: 'clean-checkout', checkoutRoot })}\n`,
  );
} finally {
  rmSync(temporaryRoot, { recursive: true, force: true });
}
