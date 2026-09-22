#!/usr/bin/env node

import { ensureSessionPlaneStateDir } from './runtime-state.mjs';

const cliUrl = new URL('../dist/cli/main.js', import.meta.url);

try {
  ensureSessionPlaneStateDir();
  const { main } = await import(cliUrl.href);
  await main();
} catch (error) {
  if (error && typeof error === 'object' && error.code === 'ERR_MODULE_NOT_FOUND') {
    console.error('SessionPlane is not built. Run `npm run build` first.');
  } else {
    console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  }
  process.exitCode = 1;
}

