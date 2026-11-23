
/** Native groups are diagnostic organization. They are never a Task lease or
 * a channel for provider submission; each variant states what is verified. */
export type TeamTabGroupStatus =
  | { readonly state: 'not-started' }
  | { readonly state: 'unavailable'; readonly message: string }
  | { readonly state: 'extension-required'; readonly directory: string;
      readonly extensionId: string; readonly message: string }
  | { readonly state: 'ready'; readonly groups: Awaited<ReturnType<typeof syncNativeTeamGroups>>['groups'];
      readonly extensionId?: string;
      readonly tabs?: Awaited<ReturnType<typeof syncNativeTeamGroups>>['tabs'];
      readonly bindings?: readonly PageBindingSnapshot[] };

import { mkdirSync, writeFileSync } from 'node:fs';

import path from 'node:path';


import { type PageBindingSnapshot } from './page-binding.ts';

import { syncNativeTeamGroups, teamGroupsManifest, TEAM_GROUPS_EXTENSION_ID, resolveNativeTeamTabs, type TeamTabs } from './team-tab-groups.ts';

import type { BrowserOwnerState } from "./browser-owner-state.ts";


import { requireOwnedBrowserContext } from "./browser-process-owner.ts";
import { createOwnedPage } from "./owned-page-recovery.ts";

export async function syncTeamGroups(state: BrowserOwnerState): Promise<void> {
    scheduleTeamGroups(state);
    await state.groups.groupSync;
  }

export function scheduleTeamGroups(state: BrowserOwnerState): void {
    if (!state.groups.resolveTeam || state.process.state !== 'ready') return;
    state.groups.groupsDirty = true;
    if (state.groups.groupSync) return;
    state.groups.groupSync = (async () => {
      while (state.groups.groupsDirty && state.process.state === 'ready') {
        state.groups.groupsDirty = false;
        try {
          const bindings = state.pages.pageRegistry.listBindings({ includeClosed: false });
          const control = await state.process.browser!.newBrowserCDPSession();
          let desired: TeamTabs[];
          try {
            const { targetInfos } = await control.send('Target.getTargets');
            const { browserContextIds } = await control.send('Target.getBrowserContexts');
            desired = resolveNativeTeamTabs(bindings, targetInfos, browserContextIds, state.groups.resolveTeam!);
          } finally { await control.detach(); }
          for (const team of desired) (team.targetIds as string[]).sort();
          const fingerprint = JSON.stringify([desired, bindings.map(binding => [binding.targetId, binding.sessionId, binding.state, binding.url])]);
          if (fingerprint === state.groups.groupsFingerprint) continue;
          state.groups.groupsFingerprint = fingerprint;
          await synchronizeTeamGroups(state, desired);
        } catch (error) { state.groups.groupsStatus = { state: 'unavailable', message: error instanceof Error ? error.message : String(error) }; }
      }
    })().finally(() => { state.groups.groupSync = null; });
  }

export async function synchronizeTeamGroups(state: BrowserOwnerState, teams: readonly TeamTabs[]): Promise<void> {
    if (!teams.length) { state.groups.groupsStatus = { state: 'ready', groups: [] }; return; }
    const directory = path.join(state.profile.profileDir, 'sessionplane-team-tabs');
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    writeFileSync(path.join(directory, 'manifest.json'), JSON.stringify(teamGroupsManifest), { mode: 0o600 });
    writeFileSync(path.join(directory, 'groups.js'), "chrome.runtime.onInstalled.addListener(() => {});\n", { mode: 0o600 });
    writeFileSync(path.join(directory, 'groups.html'), '<!doctype html><title>SessionPlane Team Tabs</title>', { mode: 0o600 });
    const control = await state.process.browser!.newBrowserCDPSession();
    try {
      try {
        const installed = await control.send('Extensions.getExtensions');
        if (!installed.extensions.some(extension => extension.id === TEAM_GROUPS_EXTENSION_ID && extension.path === directory && extension.enabled))
          await control.send('Extensions.loadUnpacked', { path: directory });
      } catch (error) {
        // An extension control failure is diagnostic; do not assume native
        // groups are installed or use UI focus to repair them.
        state.groups.groupsStatus = { state: 'unavailable',
          message: error instanceof Error ? error.message : String(error) };
      }
    } finally { await control.detach(); }
    const url = `chrome-extension://${TEAM_GROUPS_EXTENSION_ID}/groups.html`;
    let page = requireOwnedBrowserContext(state).pages().find(page => page.url() === url);
    if (!page) {
      page = (await createOwnedPage(state)).page;
      try { await page.goto(url); }
      catch {
        await page.close();
        state.groups.groupsStatus = { state: 'extension-required', directory, extensionId: TEAM_GROUPS_EXTENSION_ID,
          message: 'In this managed Chrome, open chrome://extensions, enable Developer mode, select Load unpacked and this directory. No browser restart or security flag change is needed.' };
        return;
      }
    }
    const native = await page.evaluate(syncNativeTeamGroups, teams);
    state.groups.groupsStatus = { state: 'ready', extensionId: TEAM_GROUPS_EXTENSION_ID, ...native,
      bindings: state.pages.pageRegistry.listBindings({ includeClosed: false }) };
  }
