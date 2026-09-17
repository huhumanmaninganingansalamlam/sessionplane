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
    z.object({ url: z.string().url().optional() }).strict(),
    async (params) => {
      const loginUrl = params.url ?? dependencies.loginUrl;
      if (!isChatGptUrl(loginUrl)) {
        throw new RpcMethodError('input.invalid', 'browser.login accepts only ChatGPT URLs', {
          rpcCode: -32602,
        });
      }
      const owner = dependencies.browserOwner;
      if (owner === null) {
        throw new RpcMethodError('browser.unavailable', 'Browser owner is not running');
      }
      try {
        const page = await owner.openLoginPage(loginUrl);
        return { requestOk: true, page };
      } catch (error) {
        if (error instanceof BrowserOwnerError) {
          throw new RpcMethodError(error.errorCode, error.message, { details: error.cause });
        }
        throw error;
      }
    },
  );
}

