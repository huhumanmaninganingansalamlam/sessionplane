import type { Page } from 'playwright-core';

import type { NativeTabApi } from './owned-tab-policy.ts';
import { TEAM_GROUPS_EXTENSION_ID } from './team-tab-groups.ts';

/**
 * Chrome's native tabs/debugger APIs are accessible only from our bounded
 * extension page, never from provider DOM. The browser owner must first
 * establish the exact Task/page lease before invoking the resulting API.
 * No attach, navigation, focus, window move or arbitrary tab update is exposed.
 */
export function nativeTabApiFromController(controller: Page): NativeTabApi {
  const expectedUrl = 'chrome-extension://' + TEAM_GROUPS_EXTENSION_ID + '/groups.html';
  const requireExtension = () => {
    if (controller.isClosed() || controller.url() !== expectedUrl) {
      throw new Error('Exact native tab extension controller is unavailable');
    }
  };
  const scoped = async <T>(operation: () => Promise<T>): Promise<T> => {
    requireExtension();
    const result = await operation();
    // A controller replacement after an API call cannot be reported as a
    // confirmed native observation or mutation.
    requireExtension();
    return result;
  };

  return {
    debugger: {
      getTargets: () => scoped(() => controller.evaluate(async () =>
        (await (globalThis as any).chrome.debugger.getTargets())
          .map((target: any) => ({
            id: target.id as string,
            ...(typeof target.tabId === 'number' ? { tabId: target.tabId as number } : {}),
          })))),
    },
    tabs: {
      get: tabId => scoped(() => controller.evaluate(async id => {
        const tab = await (globalThis as any).chrome.tabs.get(id);
        return {
          id: tab.id as number,
          windowId: tab.windowId as number,
          incognito: tab.incognito as boolean,
          active: tab.active as boolean,
          ...(typeof tab.url === 'string' ? { url: tab.url as string } : {}),
          ...(typeof tab.discarded === 'boolean'
            ? { discarded: tab.discarded as boolean } : {}),
          ...(typeof tab.frozen === 'boolean'
            ? { frozen: tab.frozen as boolean } : {}),
          ...(typeof tab.autoDiscardable === 'boolean'
            ? { autoDiscardable: tab.autoDiscardable as boolean } : {}),
        };
      }, tabId)),
      update: (tabId, props) => scoped(() => controller.evaluate(async input =>
        (globalThis as any).chrome.tabs.update(input.tabId, input.props), { tabId, props })),
    },
    windows: {
      get: windowId => scoped(() => controller.evaluate(async id => {
        const window = await (globalThis as any).chrome.windows.get(id);
        return { id: window.id as number, focused: window.focused as boolean };
      }, windowId)),
    },
  };
}
