import type { Page } from 'playwright-core';
import type { OwnedPageIdentity } from '../../../browser/owned-page-lifecycle.ts';
import type { PageOperationGate } from '../../../browser/page-operation-gate.ts';
import type { SemanticActionPurpose, SemanticActRequest, SemanticObservation, SemanticTaskContext } from '../../semantic-adapter.ts';
import type { ChatGptSemanticAdapterOptions, ActiveSnapshot } from './semantic-types.ts';

/** The adapter and its two semantic operations share one owned-page lease,
 * operation mutex, action cache and monotonically revoked snapshot identity.
 * Runtime dependencies carry no provider-independent business authority.
 */
export interface ChatGptSemanticRuntime {
  readonly providerKey: 'chatgpt';
  readonly capabilities: SemanticObservation['capabilityManifest'];
  readonly options: ChatGptSemanticAdapterOptions;
  readonly gate: PageOperationGate;
  readonly latest: Map<string, ActiveSnapshot>;
  readonly revision: Map<string, object>;
  readonly resolveExactPage: (
    context: SemanticTaskContext,
  ) => Promise<{ lease: OwnedPageIdentity; page: Page }>;
  readonly assertTrustedOrigin: (page: Page) => void;
  readonly authorizeAction: (
    request: SemanticActRequest, purpose: SemanticActionPurpose,
  ) => Promise<boolean>;
}
