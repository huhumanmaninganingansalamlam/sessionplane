import assert from 'node:assert/strict';
import test from 'node:test';
import { seedExactTurn, seedProviderControl } from '../support/chatgpt-semantic-fixture.ts';
import {
  buildChatGptActionCatalog,
  type ChatGptActionCatalogInput,
} from '../../src/providers/chatgpt/semantic/build-chatgpt-action-catalog.ts';

const lease = {
  projectId: 'p', slotId: 'main', slotRevision: 1, taskId: 't',
  pageKey: 'main-page', targetId: 'native-target-1', bindingEpoch: 1,
};
const context = {
  ...seedExactTurn({ taskId: 't', conversationId: 'exact-conversation',
    userMessageId: 'user-anchor', userTurnId: 'turn-1' }),
  pageLease: lease,
};
const scan = {
  blocker: 'provider_question', reason: 'provider-question-requires-decision',
  ui: { editors: [{ index: 0, value: '', enabled: true, signature: 'editor' }],
    buttons: [], draftSha256: null, fingerprint: 'exact-ui-hash' },
  permission: null, retry: null, freeTextQuestion: null,
  radioQuestion: { available: true, evidenceHash: 'exact-question-hash',
    options: [{ answer: 'Proceed', disabled: false }, { answer: 'Decline', disabled: true }] },
  question: { available: true, evidenceHash: 'exact-question-hash' },
  genericControls: [], observedControls: [], turn: {},
};
function catalog(overrides: Record<string, unknown> = {}) {
  return buildChatGptActionCatalog({
    context, lease, model: null, providerKey: 'chatgpt',
    observedAtMs: 1_000, newActionRef: () => 'deterministic-action-ref',
    scan: { ...scan, ...overrides } as unknown as ChatGptActionCatalogInput['scan'],
  });
}

test('pure action catalog retains exact option choices and a single expired-at binding', () => {
  const before = JSON.stringify(scan);
  const selected = catalog();
  assert.equal(selected.blocker, 'provider_question');
  assert.equal(selected.actions.length, 1);
  const option = selected.actions[0]!;
  assert.equal(option.purpose, 'answer_question');
  assert.equal(option.actionRef, 'deterministic-action-ref');
  assert.equal(option.input.kind, 'option');
  if (option.input.kind === 'option') {
    assert.deepEqual(option.input.options, [
      { value: 'Proceed', enabled: true },
      { value: 'Decline', enabled: false },
    ]);
  }
  const leaseState = selected.cached.get(option.actionRef)!;
  assert.equal(leaseState.expiresAtMs, 31_000);
  assert.equal(leaseState.questionHash, 'exact-question-hash');
  assert.equal(leaseState.purpose, option.purpose);
  assert.equal(leaseState.evidenceHash, option.evidenceHash);
  assert.equal(JSON.stringify(scan), before, 'catalog must not mutate its semantic snapshot');
});

test('no current provider effect or permission grant is invented from blocked evidence', () => {
  const blocked = catalog({
    blocker: 'provider_permission',
    permission: { appName: 'HostSpan', toolName: 'file_read',
      argumentsSummary: null, evidenceHash: 'untrusted',
      detailState: 'redacted', canGrant: false },
    question: null, radioQuestion: null,
  });
  assert.equal(blocked.actions.length, 0);
  assert.equal(blocked.cached.size, 0);
  assert.equal(blocked.blocker, 'provider_permission');
});

test('provider fixture preserves exact control metadata without a selector', () => {
  const control = seedProviderControl({
    purpose: 'grant_permission', effect: 'permission_verified', evidenceHash: 'exact-hash',
  });
  assert.equal(control.purpose, 'grant_permission');
  assert.equal(control.evidenceHash, 'exact-hash');
  assert.equal(Object.isFrozen(control), true);
});
