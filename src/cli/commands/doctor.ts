import { accessSync, constants, existsSync, statSync } from 'node:fs';
import path from 'node:path';

import { findHostBrowser, listHostBrowsers } from '../../browser/browser-health.ts';
import {
  assertDedicatedBrowserProfile,
  resolveBrowserProfileDir,
} from '../../browser/browser-profile.ts';
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

  const retiredAgbrowse = findRetiredAgbrowseExecutable();
  checks.push({
    name: 'retired-agbrowse',
    required: true,
    ok: retiredAgbrowse === null,
    executable: retiredAgbrowse,
    ...(retiredAgbrowse === null
      ? {}
      : {
          reason:
            'The retired standalone agbrowse executable is still on PATH; run `npm uninstall -g agbrowse`, refresh the shell command cache, and remove any stale agbrowse shim before using SessionPlane.',
        }),
  });

  const availableBrowsers = listHostBrowsers();
  const chrome = findHostBrowser({
    preference: config.browserPreference,
    ...(config.browserExecutable === null
      ? {}
      : { executablePath: config.browserExecutable }),
  });
  const selectedProfileDir =
    chrome === null
      ? config.profileDir
      : resolveBrowserProfileDir({
          profileRoot: config.profileDir,
          browser: chrome,
          scopeByBrowser: config.browserScopedProfile,
        });
  checks.push({
    name: 'host-browser',
    required: true,
    ok: chrome !== null,
    requested: config.browserPreference,
    executableOverride: config.browserExecutable,
    available: availableBrowsers,
    ...(chrome === null
      ? {
          reason:
            'No supported user-installed browser was found; install Chrome, Chromium, Edge, or Brave, or set SESSIONPLANE_BROWSER_EXECUTABLE',
        }
      : { selected: chrome, profileDir: selectedProfileDir }),
  });

  try {
    assertDedicatedBrowserProfile(selectedProfileDir);
    checks.push({
      name: 'browser-profile-isolation',
      required: true,
      ok: true,
      browserScoped: config.browserScopedProfile,
      profileRoot: config.profileDir,
      profileDir: selectedProfileDir,
      personalProfileAttached: false,
    });
  } catch (error) {
    checks.push({
      name: 'browser-profile-isolation',
      required: true,
      ok: false,
      browserScoped: config.browserScopedProfile,
      profileRoot: config.profileDir,
      profileDir: selectedProfileDir,
      reason: error instanceof Error ? error.message : String(error),
    });
  }

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

export function findRetiredAgbrowseExecutable(
  pathValue: string = process.env.PATH ?? '',
): string | null {
  for (const entry of pathValue.split(path.delimiter)) {
    if (entry.trim() === '') continue;
    const candidate = path.join(entry, 'agbrowse');
    try {
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {
      // Keep searching the remaining PATH entries.
    }
  }
  return null;
}

