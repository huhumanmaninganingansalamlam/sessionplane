import type { BrowserOwner } from '../../browser/browser-owner.ts';
import type { PageRegistry } from '../../browser/page-registry.ts';
import { DomProviderAdapter } from '../provider-dom-runtime.ts';
import { GROK_SELECTORS } from './selectors.ts';

export class GrokAdapter extends DomProviderAdapter {
  constructor(options: {
    readonly browserOwner: BrowserOwner;
    readonly pageRegistry: PageRegistry;
    readonly loginUrl: string;
    readonly acknowledgementTimeoutMs: number;
  }) {
    super({
      provider: 'grok',
      selectors: GROK_SELECTORS,
      ...options,
    });
  }
}
