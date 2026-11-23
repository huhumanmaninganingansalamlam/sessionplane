

import { mkdirSync, readFileSync, unlinkSync } from 'node:fs';

import path from 'node:path';
import { type Browser, type Page } from 'playwright-core';

import type { BrowserOwnerState } from "./browser-owner-state.ts";
import { BrowserOwnerError } from "./browser-owner-types.ts";

import { requireOwnedBrowserContext } from "./browser-process-owner.ts";

export async function captureOwnedPageDownload(state: BrowserOwnerState, page: Page, name: string, activate: () => Promise<void>): Promise<Uint8Array> {
    if (state.process.browser === null || state.process.state !== 'ready') throw new BrowserOwnerError('browser.unavailable', 'Download owner is not ready');
    // Only a currently owned Page from this exact browser can activate a download.
    const owned = state.pages.pageRegistry.listBindings({ includeClosed: false }).filter(binding => {
      if (binding.state !== 'owned' || binding.targetId === null) return false;
      try { return state.pages.pageRegistry.pageForObservation(binding.pageKey, binding.bindingEpoch) === page; }
      catch { return false; }
    });
    if (page.context() !== requireOwnedBrowserContext(state) || owned.length !== 1) {
      throw new BrowserOwnerError('session.page-identity-unverified', 'Download requires one exact owned page');
    }
    const exactOwner = owned[0]!;
    // noDefaults adoption intentionally skips Playwright's download setup. Restore
    // only the dedicated profile's download transport, without per-page overrides.
    const directory = path.join(state.profile.profileDir, 'sessionplane-downloads');
    if (state.downloads.downloadControl === null) {
      mkdirSync(directory, { recursive: true, mode: 0o700 });
      state.downloads.downloadControl = state.process.browser.newBrowserCDPSession().then(async control => {
        await control.send('Browser.setDownloadBehavior', { behavior: 'allowAndName', downloadPath: directory, eventsEnabled: true });
        return control;
      });
    }
    const control = await state.downloads.downloadControl;
    const frameControl = await page.context().newCDPSession(page);
    let frameId: string;
    try { frameId = (await frameControl.send('Page.getFrameTree')).frameTree.frame.id; }
    finally { await frameControl.detach(); }
    let guid: string | null = null;
    let resolve!: (bytes: Uint8Array) => void;
    let reject!: (error: Error) => void;
    const completion = new Promise<Uint8Array>((yes, no) => { resolve = yes; reject = no; });
    // Install a handler before activation so failure does not leave a rejection unhandled.
    const settled = completion.then(bytes => ({ bytes }), error => ({ error }));
    const fail = (message: string) => reject(new BrowserOwnerError('browser.download-failed', message));
    const onBegin = (event: { frameId: string; suggestedFilename: string; guid: string }) => {
      if (event.frameId !== frameId) return;
      if (event.suggestedFilename !== name || guid !== null || !/^[a-f0-9-]+$/i.test(event.guid)) {
        fail('Download identity is missing, changed or ambiguous'); return;
      }
      guid = event.guid;
    };
    const onProgress = (event: { guid: string; state: string; receivedBytes: number; totalBytes: number; filePath?: string }) => {
      if (event.guid !== guid || event.state === 'inProgress') return;
      if (event.state !== 'completed') { fail('Exact download was not completed'); return; }
      const file = path.join(directory, event.guid);
      if (event.filePath !== undefined && event.filePath !== file) { fail('Download path differs from the owned sink'); return; }
      try {
        const bytes = readFileSync(file);
        if (bytes.length !== event.receivedBytes || (event.totalBytes > 0 && bytes.length !== event.totalBytes)) {
          fail('Completed download byte count differs'); return;
        }
        unlinkSync(file); // Only this exact completed GUID; preserve sibling downloads.
        resolve(new Uint8Array(bytes));
      } catch { fail('Completed download bytes are unavailable'); }
    };
    control.on('Browser.downloadWillBegin', onBegin);
    control.on('Browser.downloadProgress', onProgress);
    const timer = setTimeout(() => fail('No confirmed download completion'), 15_000);
    try {
      const current = state.pages.pageRegistry.refreshPage(exactOwner.pageKey);
      if (current.state !== 'owned' || current.bindingEpoch !== exactOwner.bindingEpoch ||
          current.targetId !== exactOwner.targetId || current.sessionId !== exactOwner.sessionId ||
          current.generation !== exactOwner.generation || current.conversationId !== exactOwner.conversationId ||
          state.pages.pageRegistry.pageForObservation(exactOwner.pageKey, exactOwner.bindingEpoch) !== page) {
        throw new BrowserOwnerError('session.page-identity-unverified', 'Download page ownership changed before activation');
      }
      await activate();
      const result = await settled;
      if ('error' in result) throw result.error;
      return result.bytes;
    } finally {
      clearTimeout(timer);
      control.off('Browser.downloadWillBegin', onBegin);
      control.off('Browser.downloadProgress', onProgress);
    }
  }
