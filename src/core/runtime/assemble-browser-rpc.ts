import { summarizeBrowserHealth } from '../../browser/browser-health.ts';
import type { BrowserOwner } from '../../browser/browser-owner.ts';
import { BrowserOwnerError } from '../../browser/browser-owner.ts';
import { isChatGptUrl } from '../../browser/page-binding.ts';
import type { PageRegistry } from '../../browser/page-registry.ts';
import type { BrowserRpcPort } from '../../rpc/methods/browser.ts';
import { RpcMethodError } from '../../rpc/router.ts';

export function assembleBrowserRpcPort(dependencies: {
  readonly browserOwner: BrowserOwner | null;
  readonly pageRegistry: PageRegistry;
  readonly loginUrl: string;
  readonly profileDir: string;
  readonly recoverBrowser?: () => Promise<unknown>;
}): BrowserRpcPort {
  return {
    health: () => ({
      requestOk: true,
      browser: summarizeBrowserHealth(
        dependencies.browserOwner?.status ?? {
          state: 'not_started', profileDir: dependencies.profileDir, headless: false,
          chrome: null, transport: null, ownership: null, browserPid: null,
          debuggingPort: null, lastError: null,
        },
        dependencies.pageRegistry.listBindings(),
      ),
    }),
    pages: () => ({ requestOk: true, pages: dependencies.pageRegistry.listBindings() }),
    login: async params => {
      const mode = params.mode ?? 'automated';
      const owner = dependencies.browserOwner;
      if (owner === null) {
        throw new RpcMethodError('browser.unavailable', 'Browser owner is not running');
      }
      if (mode === 'resume' && params.url !== undefined) {
        throw new RpcMethodError('input.invalid',
          'browser.login resume does not accept a URL', { rpcCode: -32602 });
      }
      const loginUrl = params.url ?? dependencies.loginUrl;
      if (mode !== 'resume' && !isChatGptUrl(loginUrl)) {
        throw new RpcMethodError('input.invalid',
          'browser.login accepts only ChatGPT URLs', { rpcCode: -32602 });
      }
      try {
        if (mode === 'manual') return await owner.beginManualLogin(loginUrl);
        if (mode === 'resume') return await owner.resumeManualLogin();
        if (owner.status.state === 'error') await dependencies.recoverBrowser?.();
        return { requestOk: true, mode: 'automated',
          page: await owner.openLoginPage(loginUrl) };
      } catch (error) {
        if (error instanceof BrowserOwnerError) {
          throw new RpcMethodError(error.errorCode, error.message, { details: error.cause });
        }
        throw error;
      }
    },
  };
}
