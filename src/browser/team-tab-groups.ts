import { isChatGptUrl, parseProviderConversationId, type PageBindingSnapshot } from './page-binding.ts';

export interface TeamTabs {
  readonly teamId: string;
  readonly title: string;
  readonly targetIds: readonly string[];
}

/** Group identity never grants page mutation ownership. */
export function resolveNativeTeamTabs(
  bindings: readonly Pick<PageBindingSnapshot, 'targetId' | 'sessionId' | 'state' | 'url'>[],
  nativeTargets: readonly { targetId: string; type: string; url: string; browserContextId?: string }[],
  otherContexts: readonly string[],
  resolveTeam: (sessionId: string | null, conversationId: string | null) => { teamId: string; title: string } | null,
): TeamTabs[] {
  const teams = new Map<string, { teamId: string; title: string; targetIds: string[] }>();
  for (const binding of bindings) {
    if (!binding.targetId) continue;
    const owned = binding.sessionId && ['owned', 'reserved'].includes(binding.state);
    const conversationId = !binding.sessionId && ['unbound', 'conflict'].includes(binding.state) && isChatGptUrl(binding.url)
      ? parseProviderConversationId(binding.url) : null;
    if (!owned && !conversationId) continue;
    const owner = resolveTeam(owned ? binding.sessionId : null, conversationId);
    if (!owner) continue;
    const team = teams.get(owner.teamId) ?? { ...owner, targetIds: [] };
    team.targetIds.push(binding.targetId);
    teams.set(owner.teamId, team);
  }
  // A crashed/restored Chrome tab may never become a Playwright Page after
  // adoption. Its exact durable conversation still determines grouping only.
  for (const target of nativeTargets) {
    if (target.type !== 'page' || bindings.some(binding => binding.targetId === target.targetId) ||
        (target.browserContextId !== undefined && otherContexts.includes(target.browserContextId)) ||
        !isChatGptUrl(target.url)) continue;
    const conversationId = parseProviderConversationId(target.url);
    const owner = conversationId ? resolveTeam(null, conversationId) : null;
    if (!owner) continue;
    const team = teams.get(owner.teamId) ?? { ...owner, targetIds: [] };
    team.targetIds.push(target.targetId);
    teams.set(owner.teamId, team);
  }
  return [...teams.values()].sort((a, b) => a.teamId.localeCompare(b.teamId));
}

// Runs only in our local extension. No host permissions, page content access,
// debugger attachment, activation, navigation, closing or conversation mutation.
export async function syncNativeTeamGroups(teams: readonly TeamTabs[]) {
  const chrome = (globalThis as any).chrome;
  const targets: { id: string; tabId?: number }[] = await chrome.debugger.getTargets();
  const tabs: { id: number; windowId: number; groupId: number; active: boolean; incognito: boolean }[] = await chrome.tabs.query({});
  const groups: { id: number; windowId: number; title: string }[] = await chrome.tabGroups.query({});
  const windows: { id: number; focused: boolean }[] = await chrome.windows.getAll();
  const saved: Record<string, number> = (await chrome.storage.local.get('teams')).teams ?? {};
  const membership = new Map<number, string>();
  const requested = teams.map(team => ({ ...team, tabs: team.targetIds.map(id => {
    const target = targets.find(target => target.id === id);
    return tabs.find(tab => tab.id === target?.tabId && !tab.incognito);
  }).filter((tab): tab is typeof tabs[number] => tab !== undefined) }));
  for (const team of requested) for (const tab of team.tabs) {
    if (membership.has(tab.id)) throw new Error('Tab has conflicting team ownership');
    membership.set(tab.id, team.teamId);
  }
  const result = [];
  for (const team of requested) {
    if (!team.tabs.length) continue;
    // Never adopt a user group or modify its unmanaged members. A saved native
    // group is usable only while every member remains owned by this exact team.
    let group = groups.find(group => group.id === saved[team.teamId] &&
      tabs.filter(tab => tab.groupId === group.id).every(tab => membership.get(tab.id) === team.teamId));
    const active = team.tabs.find(tab => tab.active && windows.some(window => window.id === tab.windowId && window.focused));
    const windowId = active?.windowId ?? group?.windowId ?? team.tabs[0]!.windowId;
    if (group && group.windowId !== windowId) group = undefined;
    for (const tab of team.tabs) if (tab.windowId !== windowId)
      await chrome.tabs.move(tab.id, { windowId, index: -1 });
    const tabIds = team.tabs.map(tab => tab.id);
    const groupId: number = await chrome.tabs.group({ tabIds,
      ...(group ? { groupId: group.id } : { createProperties: { windowId } }) });
    await chrome.tabGroups.update(groupId, { title: team.title });
    saved[team.teamId] = groupId;
    result.push({ teamId: team.teamId, title: team.title, groupId, targetIds: [...team.targetIds], tabIds });
  }
  for (const teamId of Object.keys(saved)) if (!requested.some(team => team.teamId === teamId && team.tabs.length)) delete saved[teamId];
  await chrome.storage.local.set({ teams: saved });
  const verified = await chrome.tabs.query({});
  for (const team of result) if (!team.tabIds.every(id => verified.some((tab: any) => tab.id === id && tab.groupId === team.groupId)))
    throw new Error('Native group membership did not match exact owned tabs');
  return { groups: result, tabs: verified.map((tab: any) => ({ tabId: tab.id,
    targetId: targets.find(target => target.tabId === tab.id)?.id ?? null,
    windowId: tab.windowId, groupId: tab.groupId, active: tab.active, incognito: tab.incognito,
    title: tab.title ?? '', url: tab.url ?? '' })) };
}

// Public extension identity only; no signing key or website access is retained.
export const TEAM_GROUPS_EXTENSION_ID = 'kcohfbgmlmjgkljggplakklnpimfpkko';
export const teamGroupsManifest = {
  manifest_version: 3, name: 'SessionPlane Team Tabs', version: '1.0.0',
  key: 'MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAmAeUSaCaEOVy33EG+RqZZ6qYwzTIBp7uNFCnhGEMt1QSgasEMzUbXM7R80MQFq22bn1D8kfh5U0f6XpcDe6ChRErc8q/jmK/t94V6ASZX0Y3bGdRY5gDN1chR/ttdVfRRhNQP9F5jy1ARS6qnrHJifiA3qRcWY0HszeRYfsaIJ9ZcvqTIzPEn/u1Llpxn7XnCSDWuZZ2M9UjQSRmBEbXpuDIu7IfaNYYyLhS2qXk0pU7GGsjqlIZWgNiMDbZV9ASyzOffJfoPNR8+V5WQa0NgLIN3n5B8z8nlhxpNfn9VSLqEEDQcR33jVpzx1GhlDoYFfBlDJqHdWmkJ0BOa7B2+wIDAQAB',
  description: 'Group only the exact tabs owned by SessionPlane teams. No website access.',
  permissions: ['tabs', 'tabGroups', 'storage', 'debugger'],
  background: { service_worker: 'groups.js' },
};
