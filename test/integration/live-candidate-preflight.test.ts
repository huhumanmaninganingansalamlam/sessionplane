import assert from 'node:assert/strict';
import test from 'node:test';

import {
  evaluateInstalledCandidate, inspectLiveCandidate,
} from '../../scripts/live-candidate-preflight.mjs';

const sha = 'a'.repeat(40);
const candidate = { version: '0.4.93', sourceCommit: sha, sourceState: 'clean' };
const health = {
  version: '0.4.93', sourceCommit: sha, sourceState: 'clean',
  browser: { state: 'ready', ownership: 'spawned', debuggingPort: 43865 },
  database: { schemaVersion: 15 },
};
const targets = [
  { type: 'page', url: 'https://chatgpt.com/' },
  { type: 'page', url: 'https://chatgpt.com/c/do-not-leak-conversation-1' },
  { type: 'page', url: 'https://chatgpt.com/c/do-not-leak-conversation-2' },
  { type: 'page', url: 'https://example.org/sensitive-private-page' },
  { type: 'service_worker', url: 'https://chatgpt.com/' },
];

test('live preflight rejects a running older schema even when Chrome and Pro are available', () => {
  const report = evaluateInstalledCandidate({
    health: {
      ...health, database: { schemaVersion: 8 }, sourceCommit: null,
    },
    pages: Array.from({ length: 35 }, () => ({ state: 'owned' })),
    targets,
    observations: [
      { kind: 'root', readyState: 'loading', composerPresent: false },
      { kind: 'conversation', readyState: 'complete', composerPresent: true,
        composerEditable: true, modelProVisible: true },
    ],
    candidate,
  });
  assert.equal(report.installed.trackedPageCount, 35);
  assert.equal(report.chrome.chatgptConversationPages, 2);
  assert.equal(report.chrome.sampledConversationProVisible, 1);
  assert.equal(report.outcome.candidateMatchesLiveCore, false);
  assert.equal(report.outcome.mutationPerformed, false);
  assert.deepEqual(report.outcome.blockers, [
    'installed_core_schema_differs_from_candidate',
    'installed_core_source_not_verified_as_candidate',
  ]);
  assert.doesNotMatch(JSON.stringify(report), /do-not-leak|sensitive-private-page/,
    'The machine-readable report must not reveal existing account conversation IDs');
});

test('an exact successor that adopted the preserved browser is a valid live candidate', () => {
  const report = evaluateInstalledCandidate({
    health: { ...health, browser: { ...health.browser, ownership: 'adopted' } },
    pages: [{ state: 'owned' }], targets,
    observations: [{ kind: 'conversation', readyState: 'complete',
      composerPresent: true, composerEditable: true, modelProVisible: true }],
    candidate,
  });
  assert.equal(report.outcome.candidateMatchesLiveCore, true);
  assert.deepEqual(report.outcome.blockers, []);
  assert.equal(report.installed.browserOwner, 'adopted');
});

test('matching Core and Pro composer are compatible but a preflight never submits', () => {
  const report = evaluateInstalledCandidate({
    health, pages: [{ state: 'owned' }], targets,
    observations: [
      { kind: 'root', readyState: 'complete', composerPresent: true },
      { kind: 'conversation', readyState: 'complete', composerPresent: true,
        composerEditable: true, modelProVisible: true },
    ], candidate,
  });
  assert.equal(report.outcome.candidateMatchesLiveCore, true);
  assert.deepEqual(report.outcome.blockers, []);
  assert.equal(report.outcome.mutationPerformed, false);
  assert.equal(report.outcome.liveTaskSubmitted, false);
  assert.equal(report.chrome.sampledRootReady, true);
});

test('read-only live inventory accesses only system.health and browser.pages', async () => {
  const methods: string[] = [];
  const seenTargets: string[] = [];
  const report = await inspectLiveCandidate({
    socketPath: '/synthetic-socket-not-opened',
    candidate,
    rpc: async (method: string) => {
      methods.push(method);
      if (method === 'system.health') return health;
      if (method === 'browser.pages') return { pages: [{ state: 'owned' }] };
      throw new Error('Unexpected public mutation attempted: ' + method);
    },
    listTargets: async () => targets,
    observe: async (target: { url: string }) => {
      seenTargets.push(target.url);
      return {
        readyState: 'complete', composerPresent: true,
        composerEditable: true, modelProVisible: true,
      };
    },
  });
  assert.deepEqual(methods, ['system.health', 'browser.pages']);
  assert.deepEqual(seenTargets, targets.slice(0, 3).map(target => target.url));
  assert.equal(report.outcome.candidateMatchesLiveCore, true);
  assert.equal(report.outcome.mutationPerformed, false);
});
