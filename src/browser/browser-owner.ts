import { BrowserOwnerState } from './browser-owner-state.ts';
import { scheduleTeamGroups } from './team-group-synchronizer.ts';
import type { BrowserStatusSource } from './browser-health.ts';
import type { Page, APIRequestContext } from 'playwright-core';
import type { PageBindingSnapshot } from './page-binding.ts';
import { browserOwnerStatus } from './browser-owner-status.ts';
import type { TeamTabGroupStatus } from './team-group-synchronizer.ts';
import type { BrowserOwnerOptions, ManualLoginSnapshot, ManualLoginResumeSnapshot } from './browser-owner-types.ts';
export type { BrowserOwnerOptions, ManualLoginSnapshot, ManualLoginResumeSnapshot } from './browser-owner-types.ts';
export { BrowserOwnerError } from './browser-owner-types.ts';
export { buildHostBrowserArguments, buildManualLoginArguments } from './browser-process-helpers.ts';
import { recoveryRequestContext, startOrAdoptBrowserProcess, stopBrowserOwner, restartOwnedBrowserProcess, resetOwnedBrowserProfile } from "./browser-process-owner.ts";
import { syncTeamGroups } from "./team-group-synchronizer.ts";
import { createOwnedPage, isFailedOwnedConversationPage, closeRetiredConversationTargets, prepareOwnedPageInteraction, recoverCrashedOwnedPage } from "./owned-page-recovery.ts";
import { captureOwnedPageDownload } from "./download-capture.ts";
import { openManualLoginPage, beginManualLogin, resumeManualLogin } from "./manual-login-session.ts";
import { focusExactNativePage } from "./diagnostics/browser-focus.ts";

/** One Core-owned browser lifecycle; operations live in specialized modules. */
export class BrowserOwner {
  readonly #state: BrowserOwnerState;
  constructor(options: BrowserOwnerOptions) {
    this.#state = new BrowserOwnerState(options);
    if (options.resolveTeam) options.pageRegistry.subscribe(() => scheduleTeamGroups(this.#state));
  }
  get status(): BrowserStatusSource & { teamTabGroups: TeamTabGroupStatus } {
    return browserOwnerStatus(this.#state);
  }
  get teamGroupsBusy(): boolean { return this.#state.groups.groupSync !== null; }

  recoveryRequestContext(): APIRequestContext { return recoveryRequestContext(this.#state); }

  async syncTeamGroups(): Promise<void> { return syncTeamGroups(this.#state); }

  async start(): Promise<void> { return startOrAdoptBrowserProcess(this.#state); }

  async focusPage(pageKey: string, page: Page) { return focusExactNativePage(this.#state, pageKey, page); }

  async captureDownload(page: Page, name: string, activate: () => Promise<void>): Promise<Uint8Array> { return captureOwnedPageDownload(this.#state, page, name, activate); }

  async close(): Promise<void> { return stopBrowserOwner(this.#state); }

  async restart(): Promise<BrowserStatusSource> { return restartOwnedBrowserProcess(this.#state); }

  async resetProfile(): Promise<BrowserStatusSource> { return resetOwnedBrowserProfile(this.#state); }

  async createPage(): Promise<{ readonly page: Page; readonly binding: PageBindingSnapshot }> { return createOwnedPage(this.#state); }

  async isFailedConversationPage(pageKey: string, provider: string, conversationId: string): Promise<boolean> { return isFailedOwnedConversationPage(this.#state, pageKey, provider, conversationId); }

  async closeCrashedConversationPages(provider: string, conversationId: string, canClose: () => boolean) { return closeRetiredConversationTargets(this.#state, provider, conversationId, canClose); }

  async preparePageInteraction(pageKey: string, expected: {
    readonly sessionId: string; readonly generation: number; readonly conversationId: string | null;
  }): Promise<Page> { return prepareOwnedPageInteraction(this.#state, pageKey, expected); }

  async recoverCrashedPage(pageKey: string, expected: PageBindingSnapshot): Promise<void> { return recoverCrashedOwnedPage(this.#state, pageKey, expected); }

  async openLoginPage(loginUrl: string): Promise<PageBindingSnapshot> { return openManualLoginPage(this.#state, loginUrl); }

  async beginManualLogin(loginUrl: string): Promise<ManualLoginSnapshot> { return beginManualLogin(this.#state, loginUrl); }

  async resumeManualLogin(): Promise<ManualLoginResumeSnapshot> { return resumeManualLogin(this.#state); }

}
