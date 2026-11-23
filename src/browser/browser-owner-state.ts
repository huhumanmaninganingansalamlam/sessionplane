import path from 'node:path';
import type { Browser, BrowserContext, CDPSession, Page } from 'playwright-core';
import type { ChildProcess } from 'node:child_process';
import type {
  BrowserPreference, BrowserRuntimeState, ChromeInstallation,
} from './browser-health.ts';
import type { PageRegistry } from './page-registry.ts';
import type { BrowserOwnerOptions } from './browser-owner-types.ts';
import type { TeamTabGroupStatus } from './team-group-synchronizer.ts';

/** The state of a feature stays with its owner. No global mutable container
 * or independently competing Core/browser process is introduced here.
 */
export interface BrowserGroupState {
  readonly resolveTeam: BrowserOwnerOptions['resolveTeam'];
  groupSync: Promise<void> | null;
  groupsDirty: boolean;
  groupsFingerprint: string;
  groupsStatus: TeamTabGroupStatus;
}
export interface ProfileLeaseState {
  readonly profileRoot: string;
  readonly scopeProfileByBrowser: boolean;
  profileDir: string;
  readonly browserPreference: BrowserPreference;
  readonly browserExecutable: string | null;
  lockPath: string;
  lockToken: string | null;
}
export interface BrowserProcessState {
  readonly headless: boolean;
  readonly persistentMetrics: boolean;
  readonly launchTimeoutMs: number;
  readonly now: () => Date;
  readonly pid: number;
  context: BrowserContext | null;
  browser: Browser | null;
  browserProcess: ChildProcess | null;
  browserPid: number | null;
  debuggingPort: number | null;
  ownership: 'spawned' | 'adopted' | 'manual' | null;
  browserStderrTail: string;
  state: BrowserRuntimeState;
  chrome: ChromeInstallation | null;
  lastError: string | null;
  closing: boolean;
}
export interface OwnedPageRecoveryState {
  readonly pageRegistry: PageRegistry;
  readonly recoveryControllers: Map<string, Browser>;
  readonly interactionReady: WeakMap<Page, Promise<void>>;
}
export interface DownloadCaptureState {
  downloadControl: Promise<CDPSession> | null;
}
export interface ManualLoginState {
  manualLoginUrl: string | null;
}

export class BrowserOwnerState {
  readonly groups: BrowserGroupState;
  readonly profile: ProfileLeaseState;
  readonly process: BrowserProcessState;
  readonly pages: OwnedPageRecoveryState;
  readonly downloads: DownloadCaptureState;
  readonly login: ManualLoginState;

  constructor(options: BrowserOwnerOptions) {
    const profileRoot = path.resolve(options.profileDir);
    this.groups = {
      resolveTeam: options.resolveTeam, groupSync: null, groupsDirty: false,
      groupsFingerprint: '', groupsStatus: { state: 'not-started' },
    };
    this.profile = {
      profileRoot, scopeProfileByBrowser: options.scopeProfileByBrowser ?? false,
      profileDir: profileRoot,
      browserPreference: options.browserPreference ?? 'chrome',
      browserExecutable: options.browserExecutable ?? null,
      lockPath: path.join(profileRoot, '.sessionplane-profile.lock'), lockToken: null,
    };
    this.process = {
      headless: options.headless ?? false,
      persistentMetrics: options.persistentMetrics ?? false,
      launchTimeoutMs: options.launchTimeoutMs ?? 30_000,
      now: options.now ?? (() => new Date()),
      pid: options.pid ?? process.pid, context: null, browser: null,
      browserProcess: null, browserPid: null, debuggingPort: null,
      ownership: null, browserStderrTail: '', state: 'not_started',
      chrome: null, lastError: null, closing: false,
    };
    this.pages = {
      pageRegistry: options.pageRegistry,
      recoveryControllers: new Map<string, Browser>(),
      interactionReady: new WeakMap<Page, Promise<void>>(),
    };
    this.downloads = { downloadControl: null };
    this.login = { manualLoginUrl: null };
  }
}
