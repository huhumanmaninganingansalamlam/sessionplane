import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';

import {
  initialOwnedPageFacts,
  rebindExactOwnedPage,
  reduceOwnedPageFacts,
} from '../../src/browser/owned-page-lifecycle.ts';
import type { OwnedPageIdentity } from '../../src/browser/owned-page-lifecycle.ts';
import { PageOperationGate } from '../../src/browser/page-operation-gate.ts';
import { KeyedMutex } from '../../src/scheduler/keyed-mutex.ts';

const at = '2026-11-08T00:00:00.000Z';
function lease(pageKey = 'page-one', epoch = 1): OwnedPageIdentity {
  return {
    projectId: 'project-one',
    slotId: 'main',
    slotRevision: 1,
    taskId: pageKey === 'page-one' ? 'task-one' : 'task-two',
    pageKey,
    targetId: `target-${pageKey}`,
    bindingEpoch: epoch,
  };
}

test('CDP focus emulation is not human foreground or proof of an active renderer', () => {
  const identity = lease();
  let facts = initialOwnedPageFacts(identity);
  facts = reduceOwnedPageFacts(facts, identity, {
    kind: 'focus_emulation', verifiedEnabled: true, at,
  });
  assert.equal(facts.focusEmulationVerified, true);
  assert.equal(facts.executionActive, 'unknown');
  assert.equal(facts.humanForeground, null);
  facts = reduceOwnedPageFacts(facts, identity, {
    kind: 'native_foreground', isForeground: false, at,
  });
  assert.equal(facts.humanForeground, false);
  facts = reduceOwnedPageFacts(facts, identity, {
    kind: 'renderer_probe', timerAdvanced: true,
    animationFrameAdvanced: true, domResponsive: true, at,
  });
  assert.equal(facts.executionActive, 'confirmed');
  assert.equal(facts.lifecycleAlive, 'alive');
  assert.equal(facts.humanForeground, false,
    'renderer or emulated focus cannot assert native human focus');
  facts = reduceOwnedPageFacts(facts, identity, {
    kind: 'provider_progress', progress: 'streaming', at,
  });
  assert.equal(facts.providerProgress, 'streaming');
  assert.equal(facts.humanForeground, false);
  assert.equal(facts.executionActive, 'confirmed');
});

test('frozen, discarded, crash and closed have distinct evidence and no silent revival', () => {
  const identity = lease();
  let facts = initialOwnedPageFacts(identity);
  facts = reduceOwnedPageFacts(facts, identity, {
    kind: 'lifecycle', state: 'frozen', at,
  });
  assert.equal(facts.lifecycleAlive, 'frozen');
  assert.equal(facts.executionActive, 'unavailable');
  assert.throws(() => reduceOwnedPageFacts(facts, identity, {
    kind: 'renderer_probe', timerAdvanced: true,
    animationFrameAdvanced: true, domResponsive: true, at,
  }), /Frozen page/);
  facts = reduceOwnedPageFacts(facts, identity, {
    kind: 'lifecycle', state: 'resumed', at,
  });
  assert.equal(facts.lifecycleAlive, 'alive');
  assert.equal(facts.executionActive, 'unknown',
    'a resume event is not proof the renderer is actionable');
  facts = reduceOwnedPageFacts(facts, identity, {
    kind: 'lifecycle', state: 'discarded', at,
  });
  assert.equal(facts.lifecycleAlive, 'discarded');
  assert.equal(facts.lastDiscardedAt, at);
  assert.throws(() => reduceOwnedPageFacts(facts, identity, {
    kind: 'lifecycle', state: 'resumed', at,
  }), /Discarded page/);
  // Read-only backend observations may continue while the page is absent.
  facts = reduceOwnedPageFacts(facts, identity, {
    kind: 'provider_progress', progress: 'final', at,
  });
  assert.equal(facts.providerProgress, 'final');
  facts = reduceOwnedPageFacts(facts, identity, {
    kind: 'lifecycle', state: 'discard_reloaded', at,
  });
  assert.equal(facts.lifecycleAlive, 'unknown');
  assert.equal(facts.executionActive, 'unknown');
  assert.equal(facts.focusEmulationVerified, false);
  assert.equal(facts.providerProgress, 'final');
  facts = reduceOwnedPageFacts(facts, identity, {
    kind: 'renderer_probe', timerAdvanced: true,
    animationFrameAdvanced: true, domResponsive: true, at,
  });
  assert.equal(facts.executionActive, 'confirmed');
  facts = reduceOwnedPageFacts(facts, identity, {
    kind: 'lifecycle', state: 'crashed', at,
  });
  assert.equal(facts.lifecycleAlive, 'crashed');
  assert.equal(facts.lastCrashAt, at);
  facts = reduceOwnedPageFacts(facts, identity, {
    kind: 'provider_progress', progress: 'final', at,
  });
  assert.equal(facts.lifecycleAlive, 'crashed',
    'read-only backend FINAL can progress while its page remains crashed');
  assert.throws(() => reduceOwnedPageFacts(facts, identity, {
    kind: 'lifecycle', state: 'resumed', at,
  }), /Terminal page/);
  assert.throws(() => rebindExactOwnedPage(facts, {
    ...identity, targetId: 'different-target', bindingEpoch: 2,
  }), /silently replace/);
  assert.throws(() => rebindExactOwnedPage(facts, {
    ...identity, bindingEpoch: 3,
  }), /silently replace/);
  const rebound = rebindExactOwnedPage(facts, { ...identity, bindingEpoch: 2 });
  assert.equal(rebound.lifecycleAlive, 'unknown');
  assert.equal(rebound.lastCrashAt, null);
  assert.throws(() => reduceOwnedPageFacts(rebound, identity, {
    kind: 'provider_progress', progress: 'idle', at,
  }), /Stale or foreign/);
  const closed = reduceOwnedPageFacts(rebound, rebound.identity, {
    kind: 'lifecycle', state: 'closed', at,
  });
  assert.equal(closed.lifecycleAlive, 'closed');
  assert.throws(() => reduceOwnedPageFacts(closed, rebound.identity, {
    kind: 'renderer_probe', timerAdvanced: true,
    animationFrameAdvanced: true, domResponsive: true, at,
  }), /Terminal page/);
});

test('unresponsive probe cannot be mistaken for provider completion or native focus', () => {
  const identity = lease();
  let facts = initialOwnedPageFacts(identity);
  facts = reduceOwnedPageFacts(facts, identity, {
    kind: 'renderer_probe', timerAdvanced: true,
    animationFrameAdvanced: false, domResponsive: true, at,
  });
  assert.equal(facts.executionActive, 'unavailable');
  assert.equal(facts.lifecycleAlive, 'unknown');
  assert.equal(facts.providerProgress, 'unknown');
  assert.equal(facts.humanForeground, null);
  assert.throws(() => reduceOwnedPageFacts(facts, {
    ...identity, slotRevision: 2,
  }, { kind: 'native_foreground', isForeground: true, at }), /Stale or foreign/);
});

test('one hung page mutation retains only its exact lease while other page progresses', async () => {
  const first = lease();
  const second = lease('page-two');
  const bound = new Map([[first.pageKey, first], [second.pageKey, second]]);
  const gate = new PageOperationGate(identity =>
    bound.get(identity.pageKey) === identity);
  let settle!: (value: string) => void;
  const hung = new Promise<string>(resolve => { settle = resolve; });
  let firstCalls = 0;
  const uncertain = await gate.run(first, 'mutate', () => {
    firstCalls++;
    return hung;
  }, 15);
  assert.deepEqual(uncertain, { kind: 'uncertain', reason: 'timeout' });
  assert.equal(firstCalls, 1);
  assert.equal(gate.isBusy(first.pageKey), true);
  assert.deepEqual(await gate.run(first, 'mutate', async () => {
    firstCalls++;
    return 'replay';
  }, 15), { kind: 'busy' }, 'timed-out mutation must not run twice');
  assert.equal(firstCalls, 1);
  assert.deepEqual(await gate.run(second, 'observe', async () => 'live', 100),
    { kind: 'ok', value: 'live' });
  assert.equal(gate.isBusy(second.pageKey), false);
  settle('late-completion');
  await delay(0);
  assert.equal(gate.isBusy(first.pageKey), false);
  assert.deepEqual(await gate.run(first, 'observe', async () => 'recovered', 100),
    { kind: 'ok', value: 'recovered' });
});

test('stale leases and changed epochs reject mutations before and after dispatch', async () => {
  const identity = lease();
  let current = identity;
  const gate = new PageOperationGate(expected => current === expected);
  const foreign = { ...identity, slotId: 'other-slot' };
  assert.deepEqual(await gate.run(foreign, 'mutate', async () => 'wrong', 50),
    { kind: 'stale' });
  let release!: (value: string) => void;
  const running = new Promise<string>(resolve => { release = resolve; });
  const submitted = gate.run(identity, 'mutate', () => running, 100);
  await delay(0);
  current = { ...identity, bindingEpoch: 2 };
  release('browser-returned');
  assert.deepEqual(await submitted, {
    kind: 'uncertain', reason: 'lease_changed_during_mutation',
  });
  assert.deepEqual(await gate.run(identity, 'observe', async () => true, 50),
    { kind: 'stale' });
});

test('lease revoked in the queued microtask cannot execute a browser mutation', async () => {
  const identity = lease();
  let current = identity;
  let calls = 0;
  const gate = new PageOperationGate(expected => current === expected);
  const pending = gate.run(identity, 'mutate', async () => {
    calls++;
    return 'not-allowed';
  }, 100);
  current = { ...identity, bindingEpoch: 2 };
  assert.deepEqual(await pending, { kind: 'stale' });
  assert.equal(calls, 0, 'revocation must be checked again immediately before dispatch');
  assert.equal(gate.isBusy(identity.pageKey), false);
});

test('observation timeout/unavailable differs from possibly executed mutation', async () => {
  const identity = lease();
  const gate = new PageOperationGate(() => true);
  const observation = await gate.run(identity, 'observe', async () => {
    throw new Error('renderer unavailable');
  }, 50);
  assert.deepEqual(observation, { kind: 'unavailable', reason: 'operation_error' });
  const mutation = await gate.run(identity, 'mutate', async () => {
    throw new Error('send uncertain');
  }, 50);
  assert.deepEqual(mutation, { kind: 'uncertain', reason: 'operation_error' });
  await assert.rejects(gate.run(identity, 'observe', async () => true, 0),
    /Invalid page operation deadline/);
});
test('semantic gate shares the Core page mutex, including timed-out browser operations', async () => {
  const identity = lease();
  const shared = new KeyedMutex();
  const gate = new PageOperationGate(() => true, shared);
  let enterCore!: () => void;
  const entered = new Promise<void>(resolve => { enterCore = resolve; });
  let leaveCore!: () => void;
  const hold = new Promise<void>(resolve => { leaveCore = resolve; });
  const currentCore = shared.runExclusive(identity.pageKey, async () => {
    enterCore();
    await hold;
  });
  await entered;
  let browserMutations = 0;
  assert.deepEqual(await gate.run(identity, 'mutate', async () => {
    browserMutations++;
    return 'wrong';
  }, 50), { kind: 'busy' });
  assert.equal(browserMutations, 0, 'legacy Core must keep exclusive ownership');
  leaveCore();
  await currentCore;

  let settle!: (value: string) => void;
  const pendingBrowser = new Promise<string>(resolve => { settle = resolve; });
  assert.deepEqual(await gate.run(identity, 'mutate', () => pendingBrowser, 20),
    { kind: 'uncertain', reason: 'timeout' });
  assert.equal(shared.isBusy(identity.pageKey), true,
    'Core page mutex remains held until an ambiguous browser mutation settles');
  let futureCoreStarted = false;
  const futureCore = shared.runExclusive(identity.pageKey, async () => {
    futureCoreStarted = true;
  });
  await delay(0);
  assert.equal(futureCoreStarted, false, 'legacy Core must not overlap an uncertain click');
  settle('completed');
  await futureCore;
  assert.equal(futureCoreStarted, true);
  assert.equal(shared.isBusy(identity.pageKey), false);
});
