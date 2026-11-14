import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { BrowserOwner } from '../../src/browser/browser-owner.ts';
import { PageRegistry } from '../../src/browser/page-registry.ts';
import type { OwnedPageIdentity } from '../../src/browser/owned-page-lifecycle.ts';
import {
  observeExactNativeTab,
  protectExactOwnedTabFromAutoDiscard,
} from '../../src/browser/owned-tab-policy.ts';
import { nativeTabApiFromController } from '../../src/browser/native-tab-extension-bridge.ts';
import { TEAM_GROUPS_EXTENSION_ID } from '../../src/browser/team-tab-groups.ts';

/**
 * Opt-in real headed Chrome L2. Run inside a *separate* headless Mutter
 * compositor, not the user's display. Extension, grouping, policy and discard
 * affect only BrowserOwner's disposable profile. No recovery activation.
 */
test('scoped native tab identity, focus, auto-discard policy and exact discard', {
  skip: process.env.SESSIONPLANE_RUN_NATIVE_HEADED_BROWSER_L2 !== '1',
  timeout: 90_000,
}, async () => {
  assert.equal(process.env.DISPLAY, undefined, 'Human DISPLAY must be unavailable');
  assert.match(process.env.WAYLAND_DISPLAY ?? '', /^sessionplane-l2-/,
    'Require separate headless Mutter Wayland display');

  const root = mkdtempSync(path.join(tmpdir(), 'sessionplane-native-owned-l2-'));
  const registry = new PageRegistry();
  const owner = new BrowserOwner({
    profileDir: path.join(root, 'disposable-profile'),
    pageRegistry: registry,
    headless: false,
    resolveTeam: () => ({ teamId: 'fixture-team', title: 'Disposable Fixture Team' }),
  });
  let foregroundCalls = 0;
  try {
    await owner.start();
    const pages = [];
    for (let index = 0; index < 4; index++) {
      const created = await owner.createPage();
      const { page, binding } = created;
      Object.defineProperty(page, 'bringToFront', {
        configurable: true,
        value: async () => { foregroundCalls++; throw new Error('Foreground activation forbidden'); },
      });
      registry.reservePage(binding.pageKey, {
        sessionId: 'native-fixture-' + index, generation: 1, conversationId: null,
      });
      await owner.preparePageInteraction(binding.pageKey, {
        sessionId: 'native-fixture-' + index, generation: 1, conversationId: null,
      });
      await page.setContent('<main>Owned background tab ' + index + '</main>');
      await page.evaluate(() => {
        (globalThis as any).__timerTick = 0;
        setInterval(() => (globalThis as any).__timerTick++, 20);
      });
      pages.push(created);
    }
    await owner.syncTeamGroups();

    const extensionUrl = 'chrome-extension://' + TEAM_GROUPS_EXTENSION_ID + '/groups.html';
    const controller = pages[0]!.page.context().pages().find(page => page.url() === extensionUrl);
    assert.ok(controller, 'Isolated native extension must be available');
    const groupStatus = owner.status.teamTabGroups as {
      state?: string; groups?: { teamId: string; targetIds: string[] }[];
    };
    assert.equal(groupStatus.state, 'ready');
    const grouped = groupStatus.groups?.find(group => group.teamId === 'fixture-team');
    assert.ok(grouped, 'Owned fixture team must be grouped');
    assert.deepEqual(new Set(grouped.targetIds), new Set(pages.map(p => p.binding.targetId)),
      'Never include unmanaged foreground or extension control tab');

    const api = nativeTabApiFromController(controller);

    const leases: OwnedPageIdentity[] = pages.map((p, index) => ({
      projectId: 'fixture-project', slotId: 'fixture-slot-' + index,
      slotRevision: 1, taskId: 'fixture-task-' + index,
      pageKey: p.binding.pageKey, targetId: p.binding.targetId!, bindingEpoch: p.binding.bindingEpoch,
    }));
    const isOwned = (candidate: OwnedPageIdentity) => leases.includes(candidate) &&
      registry.getBinding(candidate.pageKey).targetId === candidate.targetId &&
      registry.getBinding(candidate.pageKey).bindingEpoch === candidate.bindingEpoch;
    const observed = await Promise.all(pages.map((p, index) =>
      observeExactNativeTab(api, leases[index]!, p.page.url(), isOwned)));
    assert.equal(new Set(observed.map(item => item.tabId)).size, 4);
    assert.ok(observed.every(item => item.tabActive === false && item.humanForeground === false),
      'Created targets must remain background even if their window is focused');
    assert.ok(observed.every(item => item.windowFocused), 'Only the isolated Chrome window is focused');

    const foregroundTab = async () => await controller.evaluate(async windowId => {
      const tabs = await (globalThis as any).chrome.tabs.query({ windowId, active: true });
      return tabs.map((tab: any) => tab.id as number);
    }, observed[0]!.windowId);
    const activeBefore = await foregroundTab();
    assert.equal(activeBefore.length, 1);
    assert.ok(!observed.some(item => item.tabId === activeBefore[0]));

    const policy = await protectExactOwnedTabFromAutoDiscard(
      api, leases[0]!, pages[0]!.page.url(), observed[0]!.tabId, isOwned,
    );
    assert.equal(policy.autoDiscardable, false);
    assert.equal(policy.humanForeground, false);

    // Explicit discard only after revalidating targetId -> tabId in the
    // disposable extension. Never attempt URL/title-based native fallback.
    const exactDiscard = observed[1]!;
    await observeExactNativeTab(api, leases[1]!, pages[1]!.page.url(), isOwned, exactDiscard.tabId);
    const discarded = await controller.evaluate(async input => {
      const chrome = (globalThis as any).chrome;
      const matches = (await chrome.debugger.getTargets())
        .filter((target: any) => target.id === input.targetId);
      const tab = await chrome.tabs.get(input.tabId);
      if (matches.length !== 1 || matches[0].tabId !== input.tabId ||
        tab.url !== input.url || tab.active || tab.incognito) {
        throw new Error('Stale native target: discard refused');
      }
      const tabStatesBefore = (await chrome.tabs.query({}))
        .map((tab: any) => ({
          id: tab.id, active: tab.active, discarded: tab.discarded,
          windowId: tab.windowId, index: tab.index, groupId: tab.groupId, url: tab.url,
        }));
      const result = await chrome.tabs.discard(input.tabId);
      const tabStatesAfter = (await chrome.tabs.query({}))
        .map((tab: any) => ({
          id: tab.id, active: tab.active, discarded: tab.discarded,
          windowId: tab.windowId, index: tab.index, groupId: tab.groupId, url: tab.url,
        }));
      return {
        id: result?.id as number | undefined, discarded: result?.discarded as boolean | undefined,
        requestedId: input.tabId, tabStatesBefore, tabStatesAfter,
      };
    }, { targetId: exactDiscard.targetId, tabId: exactDiscard.tabId, url: pages[1]!.page.url() });
    const originalTab = discarded.tabStatesBefore.find(tab => tab.id === exactDiscard.tabId);
    const discardedTab = discarded.tabStatesAfter.find(tab => tab.id === discarded.id);
    assert.ok(originalTab, 'Exact original tab must exist immediately before discard');
    assert.ok(discardedTab, 'Chrome must report the discarded tab after the operation');
    assert.equal(discardedTab.discarded, true, 'Native discard must unload the selected logical tab');
    assert.equal(discardedTab.active, false);
    assert.equal(discardedTab.windowId, originalTab.windowId);
    assert.equal(discardedTab.index, originalTab.index);
    // Chrome can rotate the native tab ID and lose group/URL metadata on
    // discard. Those values are diagnostics, never authority to auto-adopt a
    // replacement target or silently reload the document.
    assert.deepEqual(
      discarded.tabStatesAfter.filter(tab => tab.id !== discarded.id)
        .map(tab => tab.id).sort((a, b) => a - b),
      discarded.tabStatesBefore.filter(tab => tab.id !== exactDiscard.tabId)
        .map(tab => tab.id).sort((a, b) => a - b),
      'No other native tab identity may be discarded or replaced',
    );
    assert.equal(discarded.discarded, true);
    if (discarded.id !== exactDiscard.tabId) {
      // Chrome 156 may replace the native tab ID during discard. A retained
      // Task/page lease must fail closed rather than adopting the successor.
      await assert.rejects(
        observeExactNativeTab(api, leases[1]!, pages[1]!.page.url(), isOwned, exactDiscard.tabId),
        /mapping unavailable|identity changed|Unowned or stale/,
      );
    }
    console.log('ISOLATED_NATIVE_DISCARD_DIAGNOSTIC ' + JSON.stringify({
      requestedTabId: exactDiscard.tabId, resultingTabId: discarded.id,
      nativeIdRotated: discarded.id !== exactDiscard.tabId,
      groupPreserved: originalTab.groupId === discardedTab.groupId,
      urlPreserved: originalTab.url === discardedTab.url,
      priorIndex: originalTab.index, currentIndex: discardedTab.index,
    }));

    const siblings = [pages[0]!.page, pages[2]!.page, pages[3]!.page];
    const before = await Promise.all(siblings.map(page =>
      page.evaluate(() => (globalThis as any).__timerTick as number)));
    await new Promise(resolve => setTimeout(resolve, 250));
    const after = await Promise.all(siblings.map(page =>
      page.evaluate(() => (globalThis as any).__timerTick as number)));
    assert.ok(after.every((value, i) => value > before[i]!),
      'Discarding one exact tab must not halt its siblings');
    assert.deepEqual(await foregroundTab(), activeBefore,
      'No routine policy/discard may activate a different tab');
    assert.equal(foregroundCalls, 0);

    console.log('ISOLATED_NATIVE_TABS_L2 ' + JSON.stringify({
      browser: 'dedicated headed Chromium', compositor: 'isolated Mutter Wayland',
      ownedTabs: observed.length, groupedExactTargets: grouped.targetIds.length,
      nativeForegroundUnchanged: true, explicitForegroundCalls: foregroundCalls,
      autoDiscardDisabledTabId: policy.tabId, discardedExactTabId: exactDiscard.tabId,
      siblingTimerDeltas: after.map((n, i) => n - before[i]!),
    }));
  } finally {
    await owner.close().catch(() => undefined);
    rmSync(root, { recursive: true, force: true });
  }
});
