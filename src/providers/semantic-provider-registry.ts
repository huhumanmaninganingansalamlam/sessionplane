import type {
  SemanticCapability, SemanticProviderAdapter,
} from './semantic-adapter.ts';

export type SemanticProviderResolution =
  | { readonly kind: 'available'; readonly adapter: SemanticProviderAdapter }
  | { readonly kind: 'unsupported'; readonly reason:
      'provider_not_registered' | 'capability_not_supported' };

/** Small registry only: adapters own their UI/API specifics and optional
 * browser lease. Neither Core nor the registry dispatches arbitrary DOM work.
 */
export class SemanticProviderRegistry {
  readonly #adapters: ReadonlyMap<string, SemanticProviderAdapter>;

  constructor(adapters: readonly SemanticProviderAdapter[]) {
    const map = new Map<string, SemanticProviderAdapter>();
    for (const adapter of adapters) {
      if (!adapter.providerKey || adapter.capabilities.providerKey !== adapter.providerKey ||
        adapter.capabilities.contractVersion !== 1 ||
        new Set(adapter.capabilities.supports).size !== adapter.capabilities.supports.length) {
        throw new Error('Invalid semantic provider manifest');
      }
      if (map.has(adapter.providerKey)) throw new Error('Duplicate semantic provider key');
      map.set(adapter.providerKey, adapter);
    }
    this.#adapters = map;
  }

  resolve(providerKey: string, capability: SemanticCapability): SemanticProviderResolution {
    const adapter = this.#adapters.get(providerKey);
    if (!adapter) return { kind: 'unsupported', reason: 'provider_not_registered' };
    if (!adapter.capabilities.supports.includes(capability)) {
      return { kind: 'unsupported', reason: 'capability_not_supported' };
    }
    return { kind: 'available', adapter };
  }
}
