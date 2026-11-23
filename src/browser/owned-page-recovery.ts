

import { chromium, type Browser, type Page } from 'playwright-core';

import { isProviderUrl, parseProviderConversationId, type PageBindingSnapshot } from './page-binding.ts';

import type { BrowserOwnerState } from "./browser-owner-state.ts";
import { BrowserOwnerError } from "./browser-owner-types.ts";

import { requireOwnedBrowserContext } from "./browser-process-owner.ts";
import { settleWithin } from "./browser-process-helpers.ts";

export async function createOwnedPage(state: BrowserOwnerState): Promise<{ readonly page: Page; readonly binding: PageBindingSnapshot }> {
    const context = requireOwnedBrowserContext(state);
    const session = await context.browser()!.newBrowserCDPSession();
    const existing = new Set(context.pages());
    try {
      const { targetId } = await session.send('Target.createTarget', { url: 'about:blank', background: true });
      const deadline = Date.now() + 10_000;
      do {
        for (const page of context.pages()) {
          if (existing.has(page)) continue;
          const binding = await identifyOwnedPage(state, page);
          if (binding.targetId === targetId) return { page, binding };
        }
        await new Promise(resolve => setTimeout(resolve, 20));
      } while (Date.now() < deadline);
      throw new BrowserOwnerError('browser.unavailable', 'Background page did not attach to its exact browser target');
    } finally {
      await session.detach();
    }
  }

export async function isFailedOwnedConversationPage(state: BrowserOwnerState, pageKey: string, provider: string, conversationId: string): Promise<boolean> {
    const binding = state.pages.pageRegistry.refreshPage(pageKey);
    if (binding.state !== 'unbound' || binding.sessionId !== null || binding.conversationId !== null ||
        binding.url !== 'chrome-error://chromewebdata/' || binding.targetId === null) return false;
    const page = state.pages.pageRegistry.pageForObservation(pageKey, binding.bindingEpoch);
    const control = await page.context().newCDPSession(page);
    try {
      const { frameTree } = await control.send('Page.getFrameTree');
      const { targetInfo } = await control.send('Target.getTargetInfo');
      const current = state.pages.pageRegistry.refreshPage(pageKey);
      return current.bindingEpoch === binding.bindingEpoch && current.state === binding.state &&
        current.sessionId === null && current.url === binding.url && current.targetId === binding.targetId &&
        targetInfo.targetId === binding.targetId && targetInfo.type === 'page' &&
        frameTree.frame.url === binding.url && frameTree.frame.unreachableUrl === targetInfo.url &&
        isProviderUrl(provider, targetInfo.url) && parseProviderConversationId(targetInfo.url) === conversationId;
    } finally { await control.detach(); }
  }

export async function closeRetiredConversationTargets(state: BrowserOwnerState, provider: string, conversationId: string, canClose: () => boolean) {
    const result = { closedPages: 0, pageErrors: [] as string[] };
    const browser = state.process.browser;
    if (browser === null) return result;
    const control = await browser.newBrowserCDPSession();
    try {
      const { targetInfos } = await control.send('Target.getTargets');
      const { browserContextIds } = await control.send('Target.getBrowserContexts');
      const registered = () => new Set(state.pages.pageRegistry.listBindings({ includeClosed: false }).map(p => p.targetId));
      for (const target of targetInfos) {
        // This owner controls the persistent default context only. Never touch
        // another context, an unidentified home/draft or a registered live Page.
        if (target.type !== 'page' || registered().has(target.targetId) ||
            (target.browserContextId !== undefined && browserContextIds.includes(target.browserContextId)) ||
            !isProviderUrl(provider, target.url) || parseProviderConversationId(target.url) !== conversationId) continue;
        let sessionId: string | undefined;
        let crashed = false;
        let notify!: () => void;
        const observed = new Promise<void>(resolve => { notify = resolve; });
        const onMessage = (event: { sessionId: string; message: string }) => {
          if (event.sessionId !== sessionId) return;
          const message = JSON.parse(event.message) as { method?: string };
          if (message.method === 'Inspector.targetCrashed') { crashed = true; notify(); }
          if (message.method === 'Inspector.targetReloadedAfterCrash') crashed = false;
        };
        control.on('Target.receivedMessageFromTarget', onMessage);
        try {
          ({ sessionId } = await control.send('Target.attachToTarget', { targetId: target.targetId, flatten: false }));
          await control.send('Target.sendMessageToTarget', { sessionId,
            message: JSON.stringify({ id: 1, method: 'Inspector.enable' }) });
          await settleWithin(observed, 1_000);
          const { targetInfo: current } = await control.send('Target.getTargetInfo', { targetId: target.targetId });
          if (!crashed || !canClose() || registered().has(target.targetId) || current.type !== 'page' ||
              current.url !== target.url || current.browserContextId !== target.browserContextId) {
            throw new BrowserOwnerError('session.cleanup-not-ready', 'Preserve an unverified or newly active target');
          }
          const closed = await control.send('Target.closeTarget', { targetId: target.targetId });
          const remaining = await control.send('Target.getTargets');
          if (!closed.success || remaining.targetInfos.some(t => t.targetId === target.targetId)) {
            throw new BrowserOwnerError('browser.unavailable', 'Retired crashed target closure was not confirmed');
          }
          result.closedPages++;
        } catch (error) {
          result.pageErrors.push(error instanceof BrowserOwnerError ? error.errorCode : 'browser.unavailable');
        } finally {
          control.off('Target.receivedMessageFromTarget', onMessage);
          if (sessionId !== undefined) await control.send('Target.detachFromTarget', { sessionId }).catch(() => undefined);
        }
      }
    } finally { await control.detach(); }
    return result;
  }

export async function prepareOwnedPageInteraction(state: BrowserOwnerState, pageKey: string, expected: {
    readonly sessionId: string; readonly generation: number; readonly conversationId: string | null;
  }): Promise<Page> {
    const page = state.pages.pageRegistry.requireSessionPage(pageKey, expected);
    let ready = state.pages.interactionReady.get(page);
    if (!ready) {
      ready = (async () => {
        const session = await page.context().newCDPSession(page);
        try {
          // noDefaults avoids initializing unavailable siblings during adoption.
          // Restore only this page's normal Playwright background rendering:
          // hidden pages otherwise suspend rAF and actionability/menu transitions.
          if (await settleWithin(session.send('Emulation.setFocusEmulationEnabled', { enabled: true }), 5_000) === undefined)
            throw new BrowserOwnerError('browser.unavailable', 'Exact page background rendering did not acknowledge');
        } catch (error) {
          await settleWithin(session.detach().catch(() => undefined), 1_000);
          throw error;
        }
        // Detaching resets emulation, so retain it for this controller's lifetime.
        page.once('close', () => { void session.detach().catch(() => undefined); });
      })();
      state.pages.interactionReady.set(page, ready);
      void ready.catch(() => state.pages.interactionReady.delete(page));
    }
    await ready;
    if (state.pages.pageRegistry.requireSessionPage(pageKey, expected) !== page)
      throw new BrowserOwnerError('browser.unavailable', 'Interaction page changed during initialization');
    return page;
  }

export async function recoverCrashedOwnedPage(state: BrowserOwnerState, pageKey: string, expected: PageBindingSnapshot): Promise<void> {
    requireOwnedBrowserContext(state);
    const page = state.pages.pageRegistry.pageForObservation(pageKey);
    const current = state.pages.pageRegistry.getBinding(pageKey);
    const sameOwner = () => {
      const binding = state.pages.pageRegistry.getBinding(pageKey);
      return binding.bindingEpoch === expected.bindingEpoch && binding.targetId === expected.targetId &&
        binding.sessionId === expected.sessionId && binding.generation === expected.generation &&
        binding.url === expected.url && binding.conversationId === expected.conversationId &&
        binding.expectedConversationId === expected.expectedConversationId && (binding.state === 'owned' || binding.state === 'reserved');
    };
    if (!sameOwner() || !state.pages.pageRegistry.observedCrash(pageKey) || current.targetId == null ||
        state.process.debuggingPort === null || state.process.browserPid === null) {
      throw new BrowserOwnerError('browser.unavailable', 'Exact crashed target is not available for controller recovery');
    }
    const browserPid = state.process.browserPid;
    const debuggingPort = state.process.debuggingPort;
    const timeout = Math.min(state.process.launchTimeoutMs, 10_000);
    const deadline = Date.now() + timeout;
    const remaining = () => {
      const ms = deadline - Date.now();
      if (ms <= 0) throw new BrowserOwnerError('browser.unavailable', 'Same-target controller recovery deadline expired');
      return ms;
    };
    const attach = async (target: Page) => {
      const budget = remaining();
      const pending = target.context().newCDPSession(target);
      const attached = await settleWithin(pending, budget);
      if (attached === undefined) {
        // A late attachment must not outlive the failed recovery attempt.
        void pending.then(session => session.detach()).catch(() => undefined);
        throw new BrowserOwnerError('browser.unavailable', 'Recovery target attachment unavailable');
      }
      return attached;
    };
    const session = await attach(page);
    let replacement: Browser | null = null;
    try {
      const identity = await settleWithin(session.send('Target.getTargetInfo'), remaining());
      if (identity?.targetInfo.targetId !== current.targetId || identity.targetInfo.type !== 'page' ||
          identity.targetInfo.url !== expected.url || !sameOwner()) {
        throw new BrowserOwnerError('browser.unavailable', 'Crashed target identity could not be verified');
      }
      // Page.reload() rejects a permanently crashed Playwright Page. A fresh
      // public CDP session reloads the same Chrome target; never patch private state.
      const reloadBudget = remaining();
      if (!sameOwner()) throw new BrowserOwnerError('browser.unavailable', 'Crashed target changed before reload');
      if (await settleWithin(session.send('Page.reload'), reloadBudget) === undefined) {
        throw new BrowserOwnerError('browser.unavailable', 'Same-target reload acknowledgement unavailable; do not repeat automatically');
      }
      // This is an auxiliary controller for an existing profile. Reapplying
      // focus/media/download defaults to every sibling can block attachment
      // and changes unrelated pages while recovering this one target.
      replacement = await chromium.connectOverCDP(`http://127.0.0.1:${debuggingPort}`, {
        timeout: remaining(), noDefaults: true,
      });
      let recovered: Page | undefined;
      for (const candidate of replacement.contexts()[0]?.pages() ?? []) {
        const probe = await attach(candidate);
        try {
          const found = await settleWithin(probe.send('Target.getTargetInfo'), remaining());
          if (found?.targetInfo.targetId === current.targetId) { recovered = candidate; break; }
        } finally { await settleWithin(probe.detach(), 1_000); }
      }
      if (!recovered || state.process.browserPid !== browserPid || state.process.debuggingPort !== debuggingPort || !sameOwner()) {
        throw new BrowserOwnerError('browser.unavailable', 'The same crashed target did not reattach; original binding retained');
      }
      await recovered.waitForLoadState('domcontentloaded', { timeout: remaining() });
      remaining();
      if (state.process.browserPid !== browserPid || state.process.debuggingPort !== debuggingPort || !sameOwner()) {
        throw new BrowserOwnerError('browser.unavailable', 'Crashed target ownership changed before controller reassociation');
      }
      state.pages.pageRegistry.reconnectCrashedPage(pageKey, expected, recovered, current.targetId);
      const previous = state.pages.recoveryControllers.get(pageKey);
      const controller = replacement;
      state.pages.recoveryControllers.set(pageKey, controller);
      recovered.once('close', () => {
        if (state.pages.recoveryControllers.get(pageKey) !== controller) return;
        state.pages.recoveryControllers.delete(pageKey);
        void controller.close().catch(() => undefined);
      });
      replacement = null;
      // connectOverCDP Browser.close disconnects only this auxiliary controller.
      if (previous) await settleWithin(previous.close(), 1_000);
    } finally {
      await settleWithin(session.detach(), 1_000);
      if (replacement) await settleWithin(replacement.close(), 1_000);
    }
  }

export async function identifyOwnedPage(state: BrowserOwnerState, page: Page): Promise<PageBindingSnapshot> {
    const session = await page.context().newCDPSession(page);
    try {
      const { targetInfo } = await session.send('Target.getTargetInfo');
      return state.pages.pageRegistry.identifyPage(page, targetInfo.targetId);
    } finally {
      await session.detach();
    }
  }
