import assert from 'node:assert/strict';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { syncNativeTeamGroups, resolveNativeTeamTabs } from '../../src/browser/team-tab-groups.ts';
import { PageBindingRepository } from '../../src/storage/page-binding-repository.ts';

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
    delete saved.teams['stable-a'];
    await syncNativeTeamGroups([
      { teamId: 'stable-a', title: 'Maetda', targetIds: ['target-1', 'target-2'] },
      { teamId: 'stable-b', title: 'Webturn', targetIds: ['target-3', 'target-5'] },
    ]);
    assert.equal(tabs[0]!.groupId, a, 'A lost saved mapping reuses the existing exact same-team group');
    assert.equal(groups.length, 2, 'Restoring the mapping creates no extra group');
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

test('an identity-lost page keeps its exact durable conversation group without regaining page ownership', () => {
  const binding = { targetId: 'retained', sessionId: 'original', state: 'identity_lost', url: 'https://chatgpt.com/c/known-conversation' };
  const result = resolveNativeTeamTabs([binding], [], [], (sessionId, conversationId) => {
    assert.equal(sessionId, null, 'Lost mutation ownership must not be treated as a live owned session');
    return conversationId === 'known-conversation' ? { teamId: 'stable-a', title: 'Project' } : null;
  });
  assert.deepEqual(result, [{ teamId: 'stable-a', title: 'Project', targetIds: ['retained'] }]);
  assert.equal(binding.state, 'identity_lost');
  assert.deepEqual(resolveNativeTeamTabs([{ ...binding, url: 'https://chatgpt.com/c/unknown-conversation' }], [], [],
    (_sessionId, conversationId) => conversationId === 'known-conversation' ? { teamId: 'stable-a', title: 'Project' } : null), []);
});

test('restored home targets retain unique durable team membership without claiming page ownership', () => {
  const database = new DatabaseSync(':memory:');
  database.exec('CREATE TABLE page_bindings(target_id TEXT, team_id TEXT)');
  database.exec(`INSERT INTO page_bindings VALUES ('restored-home','stable-a'), ('restored-home',NULL),
    ('conflicting-home','stable-a'), ('conflicting-home','stable-b')`);
  const repository = new PageBindingRepository(database);
  const resolve = (_sessionId: string | null, conversationId: string | null, targetId: string) => {
    const teamId = conversationId === null ? repository.uniqueTeamForTarget(targetId) : null;
    return teamId ? { teamId, title: 'Project' } : null;
  };
  const binding = { targetId: 'restored-home', sessionId: null, state: 'unbound', url: 'https://chatgpt.com/' };
  try {
    const result = resolveNativeTeamTabs([binding], [
      { targetId: 'restored-home', type: 'page', url: 'https://chatgpt.com/' },
      { targetId: 'unknown-home', type: 'page', url: 'https://chatgpt.com/' },
      { targetId: 'conflicting-home', type: 'page', url: 'https://chatgpt.com/' },
      { targetId: 'restored-home', type: 'page', url: 'https://chatgpt.com/', browserContextId: 'private' },
    ], ['private'], resolve);
    assert.deepEqual(result, [{ teamId: 'stable-a', title: 'Project', targetIds: ['restored-home'] }]);
    assert.equal(binding.sessionId, null, 'Grouping never rebinds an unowned home page');
    assert.equal(repository.uniqueTeamForTarget('conflicting-home'), null);
    assert.equal(repository.uniqueTeamForTarget('unknown-home'), null);
    assert.deepEqual(resolveNativeTeamTabs([], [
      { targetId: 'restored-home', type: 'page', url: 'https://chatgpt.com/' },
    ], [], resolve), result, 'Native targets omitted by Playwright retain the same exact team');
    assert.deepEqual(resolveNativeTeamTabs([], [
      { targetId: 'restored-home', type: 'page', url: 'https://other.example/' },
      { targetId: 'restored-home', type: 'page', url: 'https://chatgpt.com/c/unknown' },
      { targetId: 'restored-home', type: 'page', url: 'https://chatgpt.com/', browserContextId: 'private' },
    ], ['private'], resolve), [], 'Unknown conversations, foreign sites and private targets remain excluded');
  } finally { database.close(); }
});
