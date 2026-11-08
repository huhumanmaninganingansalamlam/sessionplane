import assert from 'node:assert/strict';
import test from 'node:test';

import type { Page } from 'playwright-core';

import type { OwnedPageIdentity } from '../../src/browser/owned-page-lifecycle.ts';
import {
  observeExactNativeTab,
  protectExactOwnedTabFromAutoDiscard,
} from '../../src/browser/owned-tab-policy.ts';
import type { NativeTabApi } from '../../src/browser/owned-tab-policy.ts';
import { nativeTabApiFromController } from '../../src/browser/native-tab-extension-bridge.ts';
import { TEAM_GROUPS_EXTENSION_ID } from '../../src/browser/team-tab-groups.ts';

const url = 'https://chatgpt.com/c/owner-conversation';
const lease: OwnedPageIdentity = {
  projectId: 'project-one', slotId: 'main', slotRevision: 1,
  taskId: 'task-one', pageKey: 'page-one', targetId: 'target-one', bindingEpoch: 1,
};

function fixture() {
  let owned = true;
  let focused = false;
  let targetId = 'target-one';
  let nativeTabId = 7;
  let autoDiscardable: boolean | undefined = true;
  let discarded = false;
  let frozen = false;
  let incognito = false;
  const updates: Array<{ id: number; props: { autoDiscardable: boolean } }> = [];
  const api: NativeTabApi = {
    debugger: {
      async getTargets() {
        return [{ id: targetId, tabId: nativeTabId },
          { id: 'unmanaged-target', tabId: 9 }];
      },
    },
    tabs: {
      async get(tabId) {
        if (tabId === 7) {
          return {
            id: 7, windowId: 3, url, incognito,
            active: true, discarded, frozen, autoDiscardable,
          };
        }
        return {
          id: 9, windowId: 3, url, incognito: false,
          active: false, discarded: false, frozen: false, autoDiscardable: true,
        };
      },
      async update(tabId, props) {
        updates.push({ id: tabId, props });
        if (tabId === 7) autoDiscardable = props.autoDiscardable;
        return undefined;
      },
    },
    windows: {
      async get(id) { return { id, focused }; },
    },
  };
  return {
    api,
    updates,
    isOwned: (expected: OwnedPageIdentity) => owned && expected === lease,
    setOwned(value: boolean) { owned = value; },
    setFocused(value: boolean) { focused = value; },
    setTargetId(value: string) { targetId = value; },
    setTabId(value: number) { nativeTabId = value; },
    setFrozen(value: boolean) { frozen = value; },
    setIncognito(value: boolean) { incognito = value; },
    setDiscarded(value: boolean) { discarded = value; },
    setAutoDiscardable(value: boolean | undefined) { autoDiscardable = value; },
  };
}

test('native window+tab evidence is separate from provider visibility and emulation', async () => {
  const f = fixture();
  const background = await observeExactNativeTab(f.api, lease, url, f.isOwned);
  assert.equal(background.tabActive, true);
  assert.equal(background.windowFocused, false);
  assert.equal(background.humanForeground, false);
  assert.equal(background.discarded, false);
  assert.equal(background.frozen, false);
  f.setFocused(true);
  const foreground = await observeExactNativeTab(f.api, lease, url, f.isOwned);
  assert.equal(foreground.humanForeground, true);
  assert.deepEqual(f.updates, [], 'observation must never activate/move a tab');
});

test('optional autoDiscardable policy updates only the exact owned target', async () => {
  const f = fixture();
  f.setFrozen(true);
  f.setDiscarded(true);
  const receipt = await protectExactOwnedTabFromAutoDiscard(
    f.api, lease, url, 7, f.isOwned,
  );
  assert.equal(receipt.tabId, 7);
  assert.equal(receipt.autoDiscardable, false);
  assert.equal(receipt.frozen, true, 'policy does not unfreeze a tab');
  assert.equal(receipt.discarded, true, 'policy does not resurrect a discarded document');
  assert.equal(receipt.humanForeground, false, 'policy cannot activate a window');
  assert.deepEqual(f.updates, [{ id: 7, props: { autoDiscardable: false } }]);
  await protectExactOwnedTabFromAutoDiscard(f.api, lease, url, 7, f.isOwned);
  assert.equal(f.updates.length, 1, 'identical policy is idempotent');
});

test('unowned, stale, incognito, wrong URL or target mismatches fail closed', async () => {
  const f = fixture();
  f.setOwned(false);
  await assert.rejects(
    protectExactOwnedTabFromAutoDiscard(f.api, lease, url, 7, f.isOwned),
    /Unowned or stale/,
  );
  f.setOwned(true);
  f.setTargetId('different-target');
  await assert.rejects(
    protectExactOwnedTabFromAutoDiscard(f.api, lease, url, 7, f.isOwned),
    /mapping unavailable/,
  );
  f.setTargetId('target-one');
  f.setTabId(9);
  await assert.rejects(
    protectExactOwnedTabFromAutoDiscard(f.api, lease, url, 7, f.isOwned),
    /identity changed/,
  );
  f.setTabId(7);
  f.setIncognito(true);
  await assert.rejects(
    protectExactOwnedTabFromAutoDiscard(f.api, lease, url, 7, f.isOwned),
    /identity changed/,
  );
  f.setIncognito(false);
  await assert.rejects(
    protectExactOwnedTabFromAutoDiscard(f.api, lease, 'https://other.invalid/', 7, f.isOwned),
    /identity changed/,
  );
  assert.equal(f.updates.length, 0);
});

test('policy cannot report success if the owned lease disappears before update', async () => {
  const f = fixture();
  const original = f.api.windows.get;
  const api: NativeTabApi = {
    ...f.api,
    windows: {
      async get(id) {
        f.setOwned(false);
        return original(id);
      },
    },
  };
  await assert.rejects(
    protectExactOwnedTabFromAutoDiscard(api, lease, url, 7, f.isOwned),
    /identity changed|lease changed/,
  );
  assert.deepEqual(f.updates, []);
});

test('unsupported auto-discard capability stays unknown until observed', async () => {
  const f = fixture();
  f.setAutoDiscardable(undefined);
  const observed = await observeExactNativeTab(f.api, lease, url, f.isOwned);
  assert.equal(observed.autoDiscardable, null);
  assert.equal(f.updates.length, 0);
});

test('native extension bridge rejects foreign controller before any tabs API call', async () => {
  let pageUrl = 'about:blank';
  let calls = 0;
  const page = {
    isClosed: () => false,
    url: () => pageUrl,
    evaluate: async () => { calls++; return []; },
  } as unknown as Page;
  const api = nativeTabApiFromController(page);
  await assert.rejects(api.debugger.getTargets(), /extension controller is unavailable/);
  await assert.rejects(api.tabs.update(7, { autoDiscardable: false }),
    /extension controller is unavailable/);
  assert.equal(calls, 0);
  pageUrl = 'chrome-extension://' + TEAM_GROUPS_EXTENSION_ID + '/groups.html';
  assert.deepEqual(await api.debugger.getTargets(), []);
  assert.equal(calls, 1);
});

test('extension page replacement after tab API execution is not a verified receipt', async () => {
  let pageUrl = 'chrome-extension://' + TEAM_GROUPS_EXTENSION_ID + '/groups.html';
  const page = {
    isClosed: () => false,
    url: () => pageUrl,
    evaluate: async () => {
      pageUrl = 'about:blank';
      return { id: 7, autoDiscardable: false };
    },
  } as unknown as Page;
  const api = nativeTabApiFromController(page);
  await assert.rejects(api.tabs.update(7, { autoDiscardable: false }),
    /extension controller is unavailable/);
});
