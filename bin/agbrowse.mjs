#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const sourcePath = fileURLToPath(new URL('../src/compat/agbrowse-cli.ts', import.meta.url));
const distUrl = new URL('../dist/compat/agbrowse-cli.js', import.meta.url);

try {
  if (existsSync(sourcePath)) {
    const result = spawnSync(
      process.execPath,
      ['--experimental-strip-types', sourcePath, ...process.argv.slice(2)],
      { stdio: 'inherit', env: process.env },
    );
    if (result.error !== undefined) {
      throw result.error;
    }
    process.exitCode = result.status ?? 1;
  } else {
    const { main } = await import(distUrl.href);
    await main(process.argv.slice(2));
  }
} catch (error) {
  if (error && typeof error === 'object' && error.code === 'ERR_MODULE_NOT_FOUND') {
    console.error('SessionPlane source and built CLI are both unavailable.');
  } else {
    console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  }
  process.exitCode = 1;
}
