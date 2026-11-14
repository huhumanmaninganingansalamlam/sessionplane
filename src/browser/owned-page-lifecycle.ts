/**
 * Browser-level evidence only. Provider answers and human window focus are
 * independent of DOM visibility emulation and browser lifecycle signals.
 * A snapshot belongs to one exact owned target/epoch/Task slot.
 */
export interface OwnedPageIdentity {
  readonly projectId: string;
  readonly slotId: string;
  readonly slotRevision: number;
  readonly taskId: string;
  readonly pageKey: string;
  readonly targetId: string;
  readonly bindingEpoch: number;
}

export type PageLifecycle = 'unknown' | 'alive' | 'frozen' | 'discarded' | 'crashed' | 'closed';
export type ExecutionActive = 'unknown' | 'confirmed' | 'unavailable';
export type ProviderProgress = 'unknown' | 'idle' | 'streaming' | 'final';

export interface OwnedPageFacts {
  readonly identity: OwnedPageIdentity;
  readonly revision: number;
  /** Actual native tab/window evidence; never inferred from document.visibilityState. */
  readonly humanForeground: boolean | null;
  /** Evidence of renderer/actionability, not merely successful CDP emulation. */
  readonly executionActive: ExecutionActive;
  readonly lifecycleAlive: PageLifecycle;
  readonly providerProgress: ProviderProgress;
  readonly focusEmulationVerified: boolean;
  readonly lastRendererProbeAt: string | null;
  readonly lastProviderProgressAt: string | null;
  readonly lastDiscardedAt: string | null;
  readonly lastCrashAt: string | null;
}

export type OwnedPageEvidence =
  | { readonly kind: 'native_foreground'; readonly isForeground: boolean; readonly at: string }
  | { readonly kind: 'focus_emulation'; readonly verifiedEnabled: boolean; readonly at: string }
  | { readonly kind: 'renderer_probe'; readonly timerAdvanced: boolean;
      readonly animationFrameAdvanced: boolean; readonly domResponsive: boolean; readonly at: string }
  | { readonly kind: 'lifecycle'; readonly state: 'frozen' | 'resumed' |
      'discarded' | 'discard_reloaded' | 'crashed' | 'closed'; readonly at: string }
  | { readonly kind: 'provider_progress'; readonly progress: ProviderProgress; readonly at: string };

function assertExactIdentity(expected: OwnedPageIdentity, actual: OwnedPageIdentity): void {
  for (const key of [
    'projectId', 'slotId', 'slotRevision', 'taskId', 'pageKey', 'targetId', 'bindingEpoch',
  ] as const) {
    if (actual[key] !== expected[key]) throw new Error(`Stale or foreign owned page: ${key}`);
  }
}

export function initialOwnedPageFacts(identity: OwnedPageIdentity): OwnedPageFacts {
  if (!identity.projectId || !identity.slotId || !identity.taskId || !identity.pageKey ||
    !identity.targetId || !Number.isSafeInteger(identity.slotRevision) ||
    !Number.isSafeInteger(identity.bindingEpoch) || identity.bindingEpoch < 1 ||
    identity.slotRevision < 1) throw new Error('Invalid exact page identity');
  return Object.freeze({
    identity: Object.freeze({ ...identity }),
    revision: 1,
    humanForeground: null,
    executionActive: 'unknown',
    lifecycleAlive: 'unknown',
    providerProgress: 'unknown',
    focusEmulationVerified: false,
    lastRendererProbeAt: null,
    lastProviderProgressAt: null,
    lastDiscardedAt: null,
    lastCrashAt: null,
  });
}

export function reduceOwnedPageFacts(
  facts: OwnedPageFacts,
  identity: OwnedPageIdentity,
  evidence: OwnedPageEvidence,
): OwnedPageFacts {
  assertExactIdentity(facts.identity, identity);
  if (!Number.isFinite(Date.parse(evidence.at))) throw new Error('Invalid observation time');
  if (facts.lifecycleAlive === 'closed' || facts.lifecycleAlive === 'crashed') {
    // Exact target recovery requires explicit epoch replacement. Stale events
    // never revive a terminal page.
    if (evidence.kind !== 'native_foreground' && evidence.kind !== 'provider_progress') {
      throw new Error('Terminal page needs an exact new binding epoch');
    }
  }

  if (facts.lifecycleAlive === 'discarded' && (
    evidence.kind === 'renderer_probe' || evidence.kind === 'focus_emulation' ||
    evidence.kind === 'lifecycle' && evidence.state !== 'discard_reloaded'
  )) {
    throw new Error('Discarded page needs verified reload before execution');
  }
  if (facts.lifecycleAlive === 'frozen' && evidence.kind === 'renderer_probe') {
    throw new Error('Frozen page needs an observed resume before renderer probe');
  }

  const next = { ...facts, revision: facts.revision + 1 };
  switch (evidence.kind) {
    case 'native_foreground':
      return { ...next, humanForeground: evidence.isForeground };
    case 'focus_emulation':
      // CDP acknowledgement alone cannot prove renderer execution or human focus.
      return {
        ...next,
        focusEmulationVerified: evidence.verifiedEnabled,
        executionActive: 'unknown',
      };
    case 'renderer_probe': {
      const responsive = evidence.timerAdvanced &&
        evidence.animationFrameAdvanced && evidence.domResponsive;
      return {
        ...next,
        executionActive: responsive ? 'confirmed' : 'unavailable',
        lifecycleAlive: responsive ? 'alive' : facts.lifecycleAlive,
        lastRendererProbeAt: evidence.at,
      };
    }
    case 'lifecycle':
      if (evidence.state === 'discard_reloaded') {
        return {
          ...next, lifecycleAlive: 'unknown', executionActive: 'unknown',
          lastRendererProbeAt: null, lastDiscardedAt: evidence.at,
          focusEmulationVerified: false,
        };
      }
      if (evidence.state === 'resumed') {
        return {
          ...next, lifecycleAlive: 'alive', executionActive: 'unknown',
          lastRendererProbeAt: null,
        };
      }
      return {
        ...next,
        lifecycleAlive: evidence.state,
        executionActive: 'unavailable',
        ...(evidence.state === 'discarded' ? { lastDiscardedAt: evidence.at } : {}),
        ...(evidence.state === 'crashed' ? { lastCrashAt: evidence.at } : {}),
      };
    case 'provider_progress':
      return {
        ...next, providerProgress: evidence.progress,
        lastProviderProgressAt: evidence.at,
      };
  }
}

/**
 * Called only when the owner verifies an exact successor binding. Same pageKey
 * with incremented epoch is allowed for same-target crash recovery; a changed
 * target/slot requires separate explicit ownership, never implicit adoption.
 */
export function rebindExactOwnedPage(
  prior: OwnedPageFacts,
  nextIdentity: OwnedPageIdentity,
): OwnedPageFacts {
  const prev = prior.identity;
  if (nextIdentity.projectId !== prev.projectId ||
    nextIdentity.slotId !== prev.slotId || nextIdentity.taskId !== prev.taskId ||
    nextIdentity.slotRevision !== prev.slotRevision ||
    nextIdentity.pageKey !== prev.pageKey || nextIdentity.targetId !== prev.targetId ||
    nextIdentity.bindingEpoch !== prev.bindingEpoch + 1) {
    throw new Error('Cannot silently replace the exact owned target');
  }
  return initialOwnedPageFacts(nextIdentity);
}
