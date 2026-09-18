import { z } from 'zod';

import type { BrowserOwner } from '../../browser/browser-owner.ts';
import { BrowserOwnerError } from '../../browser/browser-owner.ts';
import { summarizeBrowserHealth } from '../../browser/browser-health.ts';
import { isChatGptUrl } from '../../browser/page-binding.ts';
import type { PageRegistry } from '../../browser/page-registry.ts';
import { RpcMethodError, type RpcRouter } from '../router.ts';

export function registerBrowserMethods(
  router: RpcRouter,
  dependencies: {
    readonly browserOwner: BrowserOwner | null;
    readonly pageRegistry: PageRegistry;
    readonly loginUrl: string;
    readonly profileDir: string;
  },
): void {
  router.register('browser.health', z.object({}).strict(), () => ({
    requestOk: true,
    browser: summarizeBrowserHealth(
      dependencies.browserOwner?.status ?? {
        state: 'not_started',
        profileDir: dependencies.profileDir,
        headless: false,
        chrome: null,
        transport: null,
        ownership: null,
        browserPid: null,
        debuggingPort: null,
        lastError: null,
      },
      dependencies.pageRegistry.listBindings(),
    ),
  }));

  router.register('browser.pages', z.object({}).strict(), () => ({
    requestOk: true,
    pages: dependencies.pageRegistry.listBindings(),
  }));

  router.register(
    'browser.login',
    z.object({
      url: z.string().url().optional(),
      mode: z.enum(['automated', 'manual', 'resume']).optional(),
    }).strict(),
    async (params) => {
      const mode = params.mode ?? 'automated';
      const owner = dependencies.browserOwner;
      if (owner === null) {
        throw new RpcMethodError('browser.unavailable', 'Browser owner is not running');
      }
      if (mode === 'resume' && params.url !== undefined) {
        throw new RpcMethodError(
          'input.invalid',
          'browser.login resume does not accept a URL',
          { rpcCode: -32602 },
        );
      }
      const loginUrl = params.url ?? dependencies.loginUrl;
      if (mode !== 'resume' && !isChatGptUrl(loginUrl)) {
        throw new RpcMethodError('input.invalid', 'browser.login accepts only ChatGPT URLs', {
          rpcCode: -32602,
        });
      }
      try {
        if (mode === 'manual') return await owner.beginManualLogin(loginUrl);
        if (mode === 'resume') return await owner.resumeManualLogin();
        const page = await owner.openLoginPage(loginUrl);
        return { requestOk: true, mode: 'automated', page };
      } catch (error) {
        if (error instanceof BrowserOwnerError) {
          throw new RpcMethodError(error.errorCode, error.message, { details: error.cause });
        }
        throw error;
      }
    },
  );
}

