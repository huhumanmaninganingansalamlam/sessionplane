import { z } from 'zod';

import type { RpcRouter } from '../router.ts';

export interface BrowserRpcPort {
  health(): unknown;
  pages(): unknown;
  login(input: {
    readonly url?: string | undefined;
    readonly mode?: 'automated' | 'manual' | 'resume' | undefined;
  }): Promise<unknown>;
}

export function registerBrowserMethods(router: RpcRouter, port: BrowserRpcPort): void {
  router.register('browser.health', z.object({}).strict(), () => port.health());
  router.register('browser.pages', z.object({}).strict(), () => port.pages());
  router.register('browser.login', z.object({
    url: z.string().url().optional(),
    mode: z.enum(['automated', 'manual', 'resume']).optional(),
  }).strict(), async params => await port.login(params));
}
