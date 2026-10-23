import assert from 'node:assert/strict';
import test from 'node:test';
import { syncNativeTeamGroups, resolveNativeTeamTabs } from '../../src/browser/team-tab-groups.ts';

test('native team groups follow create/replace/close/delete without changing unmanaged tabs or focus', async () => {
  const tabs = [
    { id: 1, windowId: 10, groupId: -1, active: true, incognito: false },
    { id: 2, windowId: 10, groupId: -1, active: false, incognito: false },
    { id: 3, windowId: 10, groupId: -1, active: false, incognito: false },
    { id: 4, windowId: 10, groupId: -1, active: false, incognito: false },
    { id: 5, windowId: 20, groupId: -1, active: false, incognito: true },
  ];
  const groups: { id: number; windowId: number; title: string }[] = [];
  const saved: any = {};
  const original = (globalThis as any).chrome;
  let sequence = 100;
  (globalThis as any).chrome = {
    debugger: { getTargets: async () => tabs.map(tab => ({ id: `target-${tab.id}`, tabId: tab.id })) },
    windows: { getAll: async () => [{ id: 10, focused: true }, { id: 20, focused: false }] },
    tabs: {
      query: async () => tabs.map(tab => ({ ...tab })),
      move: async () => { assert.fail('No existing tab should move between windows'); },
      group: async ({ tabIds, groupId, createProperties }: any) => {
        const id = groupId ?? ++sequence;
        if (!groupId) groups.push({ id, windowId: createProperties.windowId, title: '' });
        for (const tab of tabs) if (tabIds.includes(tab.id)) tab.groupId = id;
        return id;
      },
    },
    tabGroups: { query: async () => groups.map(group => ({ ...group })),
      update: async (id: number, data: any) => Object.assign(groups.find(group => group.id === id)!, data) },
    storage: { local: { get: async () => structuredClone(saved), set: async (data: any) => Object.assign(saved, data) } },
  };
  try {
    const first = await syncNativeTeamGroups([
      { teamId: 'stable-a', title: 'Maetda', targetIds: ['target-1', 'target-2'] },
      { teamId: 'stable-b', title: 'Webturn', targetIds: ['target-3', 'target-5'] },
    ]);
    assert.equal(first.groups.length, 2);
    assert.equal(tabs[0]!.groupId, tabs[1]!.groupId);
    assert.notEqual(tabs[0]!.groupId, tabs[2]!.groupId);
    assert.equal(tabs[4]!.groupId, -1, 'Incognito remains outside this owner');
    assert.equal(tabs[3]!.groupId, -1, 'User unmanaged tab stays untouched');
    const a = tabs[0]!.groupId;
    const restored = resolveNativeTeamTabs([
      { targetId: 'target-1', sessionId: 'current', state: 'owned', url: 'https://chatgpt.com/c/original' },
    ], tabs.map(tab => ({ targetId: `target-${tab.id}`, type: 'page', url: `https://chatgpt.com/c/${tab.id === 2 ? 'retained' : 'unmanaged'}` })), [],
    (sessionId, conversationId) => sessionId === 'current' || conversationId === 'retained' ? { teamId: 'stable-a', title: 'Maetda' } : null);
    await syncNativeTeamGroups(restored);
    assert.equal(tabs[0]!.groupId, a, 'Restored native membership must not recreate the existing group');
    assert.equal(tabs[1]!.groupId, a, 'The unregistered retained tab stays with its durable team');
    await syncNativeTeamGroups([{ teamId: 'stable-a', title: 'Maetda renamed', targetIds: ['target-1', 'target-2', 'target-4'] }]);
    assert.equal(tabs[3]!.groupId, a, 'New owned conversation joins its existing team group');
    assert.equal(groups.find(group => group.id === a)!.title, 'Maetda renamed');
    tabs.splice(1, 1); // Existing guarded session cleanup closes only the old tab.
    await syncNativeTeamGroups([{ teamId: 'stable-a', title: 'Maetda', targetIds: ['target-1', 'target-4'] }]);
    assert.equal(tabs.find(tab => tab.id === 4)!.groupId, a, 'Replacement retains the team group');
    await syncNativeTeamGroups([]);
    assert.deepEqual(saved.teams, {}, 'Team deletion retires native group tracking; normal tab closure removes empty groups');
    assert.equal(tabs[0]!.active, true, 'Current tab remains active throughout');
    assert.equal(tabs.find(tab => tab.id === 3)!.groupId, first.groups[1]!.groupId);
    assert.equal(first.tabs.find(tab => tab.tabId === 4)?.groupId, -1, 'Inventory retains ungrouped tabs for ownership review');
  } finally { (globalThis as any).chrome = original; }
});

test('restored native targets retain their exact durable team group without adopting unknown or private tabs', () => {
  const conversation = 'https://chatgpt.com/c/known-conversation';
  const resolve = (sessionId: string | null, conversationId: string | null) =>
    sessionId === 'current-session' || conversationId === 'known-conversation' ? { teamId: 'stable-a', title: 'Maetda' } : null;
  const groups = resolveNativeTeamTabs([
    { targetId: 'live', sessionId: 'current-session', state: 'owned', url: conversation },
  ], [
    { targetId: 'live', type: 'page', url: conversation },
    { targetId: 'pre-adoption-crashed', type: 'page', url: conversation },
    { targetId: 'unknown-user', type: 'page', url: 'https://chatgpt.com/c/unknown' },
    { targetId: 'private', type: 'page', url: conversation, browserContextId: 'other-context' },
    { targetId: 'other-site', type: 'page', url: 'https://example.com/c/known-conversation' },
    { targetId: 'worker', type: 'service_worker', url: conversation },
  ], ['other-context'], resolve);
  assert.deepEqual(groups, [{ teamId: 'stable-a', title: 'Maetda', targetIds: ['live', 'pre-adoption-crashed'] }],
    'The tab retained by Chrome must not invalidate its saved group simply because Playwright omitted it');
});
