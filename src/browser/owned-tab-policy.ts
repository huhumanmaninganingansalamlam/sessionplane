import type { OwnedPageIdentity } from './owned-page-lifecycle.ts';

/**
 * The extension bridge only. Target IDs come from an exact owned Page lease,
 * never a URL/title lookup. Nothing here activates or moves a native tab.
 */
export interface NativeTabApi {
  readonly debugger: {
    getTargets(): Promise<readonly { id: string; tabId?: number }[]>;
  };
  readonly tabs: {
    get(tabId: number): Promise<{
      readonly id: number;
      readonly windowId: number;
      readonly url?: string;
      readonly incognito: boolean;
      readonly active: boolean;
      readonly discarded?: boolean;
      readonly frozen?: boolean;
      readonly autoDiscardable?: boolean;
    }>;
    update(tabId: number, props: { readonly autoDiscardable: boolean }): Promise<unknown>;
  };
  readonly windows: {
    get(windowId: number): Promise<{ readonly id: number; readonly focused: boolean }>;
  };
}

export interface NativeTabEvidence {
  readonly targetId: string;
  readonly tabId: number;
  readonly windowId: number;
  readonly tabActive: boolean;
  readonly windowFocused: boolean;
  readonly humanForeground: boolean;
  readonly discarded: boolean | null;
  readonly frozen: boolean | null;
  readonly autoDiscardable: boolean | null;
}

export async function observeExactNativeTab(
  api: NativeTabApi,
  lease: OwnedPageIdentity,
  expectedUrl: string,
  isOwnedLease: (lease: OwnedPageIdentity) => boolean,
  expectedTabId?: number,
): Promise<NativeTabEvidence> {
  if (!isOwnedLease(lease)) throw new Error('Unowned or stale page lease');
  const targets = await api.debugger.getTargets();
  const matches = targets.filter(target => target.id === lease.targetId);
  const tabId = matches.length === 1 ? matches[0]?.tabId : undefined;
  if (!Number.isSafeInteger(tabId) || tabId! < 0) {
    throw new Error('Exact native target-to-tab mapping unavailable');
  }
  if (expectedTabId !== undefined && tabId !== expectedTabId) {
    throw new Error('Previously observed native tab identity changed');
  }
  const tab = await api.tabs.get(tabId!);
  const window = await api.windows.get(tab.windowId);
  const refreshed = await api.debugger.getTargets();
  const rematched = refreshed.filter(target => target.id === lease.targetId);
  if (!isOwnedLease(lease) || rematched.length !== 1 ||
    rematched[0]?.tabId !== tab.id || tab.id !== tabId ||
    window.id !== tab.windowId || tab.incognito || tab.url !== expectedUrl) {
    throw new Error('Native tab identity changed; no unsafe URL/title fallback');
  }
  return {
    targetId: lease.targetId,
    tabId: tab.id,
    windowId: tab.windowId,
    tabActive: tab.active,
    windowFocused: window.focused,
    humanForeground: tab.active && window.focused,
    discarded: tab.discarded ?? null,
    frozen: tab.frozen ?? null,
    autoDiscardable: tab.autoDiscardable ?? null,
  };
}

/**
 * Optional, not enabled globally. Only a separately verified owned target
 * may have auto-discard disabled. The result makes no assertion about freeze,
 * renderer liveness or task progress, and does not change human focus.
 */
export async function protectExactOwnedTabFromAutoDiscard(
  api: NativeTabApi,
  lease: OwnedPageIdentity,
  expectedUrl: string,
  expectedTabId: number,
  isOwnedLease: (lease: OwnedPageIdentity) => boolean,
): Promise<NativeTabEvidence> {
  // The tab ID must be captured in a prior read-only, exact-target mapping.
  // Resolving a fresh URL match at mutation time could touch another tab.
  if (!Number.isSafeInteger(expectedTabId) || expectedTabId < 0) {
    throw new Error('Missing trusted native tab identity');
  }
  const before = await observeExactNativeTab(
    api, lease, expectedUrl, isOwnedLease, expectedTabId,
  );
  if (!isOwnedLease(lease)) throw new Error('Owned lease changed before tab policy');
  if (before.autoDiscardable === false) return before;
  await api.tabs.update(before.tabId, { autoDiscardable: false });
  const after = await observeExactNativeTab(
    api, lease, expectedUrl, isOwnedLease, expectedTabId,
  );
  if (after.tabId !== before.tabId || after.windowId !== before.windowId ||
    after.autoDiscardable !== false) {
    throw new Error('Owned tab policy was not verified after update');
  }
  return after;
}
