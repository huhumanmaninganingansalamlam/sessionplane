

import { type Page } from 'playwright-core';

import { focusNativeTab, TEAM_GROUPS_EXTENSION_ID } from '../team-tab-groups.ts';

import type { BrowserOwnerState } from "../browser-owner-state.ts";
import { BrowserOwnerError } from "../browser-owner-types.ts";

import { requireOwnedBrowserContext } from "../browser-process-owner.ts";

export async function focusExactNativePage(state: BrowserOwnerState, pageKey: string, page: Page) {
    const binding = state.pages.pageRegistry.getBinding(pageKey);
    if (state.pages.pageRegistry.pageForObservation(pageKey, binding.bindingEpoch) !== page || !binding.targetId)
      throw new BrowserOwnerError('browser.unavailable', 'Exact native focus target is unavailable');
    const controller = requireOwnedBrowserContext(state).pages().find(page =>
      page.url() === `chrome-extension://${TEAM_GROUPS_EXTENSION_ID}/groups.html`);
    if (!controller) throw new BrowserOwnerError('browser.unavailable', 'Native tab activation controller is unavailable');
    const result = await controller.evaluate(focusNativeTab, { targetId: binding.targetId, url: page.url() });
    if (state.pages.pageRegistry.pageForObservation(pageKey, binding.bindingEpoch) !== page)
      throw new BrowserOwnerError('browser.unavailable', 'Exact native focus target changed');
    return result;
  }
