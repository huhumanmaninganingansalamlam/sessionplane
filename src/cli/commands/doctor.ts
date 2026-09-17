import { existsSync, statSync } from 'node:fs';

import { findPlaywrightChromium } from '../../browser/browser-health.ts';
import { prepareRuntimeDirectories, SESSIONPLANE_VERSION, type SessionPlaneConfig } from '../../config.ts';
import { SessionPlaneDatabase } from '../../storage/database.ts';
import { callRpc } from '../client.ts';

export interface DoctorReport {
  readonly requestOk: boolean;
  readonly service: string;
  readonly version: string;
  readonly checks: readonly Readonly<Record<string, unknown>>[];
  readonly pageBindings: readonly unknown[];
}

export async function runDoctor(config: SessionPlaneConfig): Promise<DoctorReport> {
  const checks: Array<Readonly<Record<string, unknown>>> = [];

  const [major = 0, minor = 0] = process.versions.node.split('.').map(Number);
  checks.push({
    name: 'node',
    required: true,
    ok: major === 24 && minor >= 15,
    version: process.version,
    expected: '>=24.15 <25',
  });

  const chrome = findPlaywrightChromium();
  checks.push({
    name: 'playwright-chromium',
    required: true,
    ok: chrome !== null,
    ...(chrome === null
      ? { reason: 'Playwright Chromium is not installed; run `npm run browser:install`' }
      : chrome),
  });

  try {
    prepareRuntimeDirectories(config);
    const mode = statSync(config.stateDir).mode & 0o777;
    checks.push({
      name: 'state-directory',
      required: true,
      ok: mode === 0o700,
      path: config.stateDir,
      mode: mode.toString(8).padStart(3, '0'),
    });
  } catch (error) {
    checks.push({
      name: 'state-directory',
      required: true,
      ok: false,
      path: config.stateDir,
      reason: error instanceof Error ? error.message : String(error),
    });
  }

  try {
    const database = SessionPlaneDatabase.open(config.databasePath);
    const health = database.health();
    database.close();
    checks.push({
      name: 'database',
      required: true,
      ok: health.integrity === 'ok' && health.foreignKeys && health.journalMode === 'wal',
      ...health,
    });
  } catch (error) {
    checks.push({
      name: 'database',
      required: true,
      ok: false,
      path: config.databasePath,
      reason: error instanceof Error ? error.message : String(error),
    });
  }

  let pageBindings: readonly unknown[] = [];
  if (!existsSync(config.socketPath)) {
    checks.push({ name: 'core', required: false, ok: true, running: false });
  } else {
    try {
      const pages = await callRpc<{ readonly requestOk: boolean; readonly pages: readonly unknown[] }>({
        socketPath: config.socketPath,
        method: 'browser.pages',
        timeoutMs: config.rpcRequestTimeoutMs,
        maxLineBytes: config.rpcMaxLineBytes,
      });
      pageBindings = pages.pages;
      checks.push({ name: 'core', required: false, ok: true, running: true });
    } catch (error) {
      checks.push({
        name: 'core',
        required: false,
        ok: false,
        running: false,
        reason: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return {
    requestOk: checks
      .filter((check) => check.required === true)
      .every((check) => check.ok === true),
    service: 'sessionplane',
    version: SESSIONPLANE_VERSION,
    checks,
    pageBindings,
  };
}

