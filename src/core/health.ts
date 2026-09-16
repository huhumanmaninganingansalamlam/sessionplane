import type { SessionPlaneConfig } from '../config.ts';
import { SESSIONPLANE_VERSION } from '../config.ts';
import type { SessionPlaneDatabase } from '../storage/database.ts';

export interface HealthContext {
  readonly config: SessionPlaneConfig;
  readonly database: SessionPlaneDatabase;
  readonly startedAt: Date;
}

export function getSystemHealth(context: HealthContext): Readonly<Record<string, unknown>> {
  const database = context.database.health();
  return {
    requestOk: true,
    service: 'sessionplane',
    version: SESSIONPLANE_VERSION,
    process: {
      pid: process.pid,
      nodeVersion: process.version,
      startedAt: context.startedAt.toISOString(),
      uptimeSec: Math.max(0, Math.floor((Date.now() - context.startedAt.getTime()) / 1000)),
    },
    socket: {
      path: context.config.socketPath,
    },
    database,
    browser: {
      state: 'not_started',
      profileDir: context.config.profileDir,
    },
  };
}

