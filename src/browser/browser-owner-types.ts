

import { type BrowserPreference, type BrowserStatusSource } from './browser-health.ts';

import { PageRegistry } from './page-registry.ts';

export type BrowserLockMode = 'cdp' | 'manual';

export interface ProfileLockPayload {
  readonly pid: number;
  readonly token: string;
  readonly createdAt: string;
  readonly mode?: BrowserLockMode;
  readonly browserPid?: number;
  readonly debuggingPort?: number;
}

export type AdoptedBrowser =
  | {
      readonly mode: 'cdp';
      readonly browserPid: number;
      readonly debuggingPort: number;
    }
  | {
      readonly mode: 'manual';
      readonly browserPid: number;
    };

export interface ManualLoginSnapshot {
  readonly requestOk: true;
  readonly mode: 'manual';
  readonly url: string;
  readonly browser: BrowserStatusSource;
  readonly instruction: string;
}

export interface ManualLoginResumeSnapshot {
  readonly requestOk: true;
  readonly mode: 'automated';
  readonly browser: BrowserStatusSource;
}

export interface BrowserOwnerOptions {
  readonly resolveTeam?: (sessionId: string | null, conversationId: string | null, targetId: string) => { teamId: string; title: string } | null;
  readonly profileDir: string;
  readonly scopeProfileByBrowser?: boolean;
  readonly pageRegistry: PageRegistry;
  readonly headless?: boolean;
  readonly persistentMetrics?: boolean;
  readonly browserPreference?: BrowserPreference;
  readonly browserExecutable?: string | null;
  readonly launchTimeoutMs?: number;
  readonly now?: () => Date;
  readonly pid?: number;
}

export class BrowserOwnerError extends Error {
  readonly errorCode: string;

  constructor(errorCode: string, message: string, options: { readonly cause?: unknown } = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'BrowserOwnerError';
    this.errorCode = errorCode;
  }
}
