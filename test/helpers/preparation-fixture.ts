import assert from 'node:assert/strict';
import type { Page } from 'playwright-core';
import { BrowserRefSnapshotStore } from '../../src/browser/ref-snapshot.ts';
import type { ProviderSubmission, PreparationChoices } from '../../src/providers/provider-adapter.ts';

// These fixtures have one composer and a Send button. Model decisions are
// exercised through the public MCP workflow, not inferred by this helper.
export async function prepareFixture(submission: ProviderSubmission, page: Page): Promise<void> {
  await submission.prepareForObservation?.();
  const snapshot = await new BrowserRefSnapshotStore().capture({ page, pageKey: submission.pageKey, bindingEpoch: 1, interactive: false });
  const composer = snapshot.nodes.find((node) => node.role === 'textbox' && node.editable);
  const submit = snapshot.nodes.find((node) => node.role === 'button' && node.name === 'Send');
  assert.ok(composer);
  assert.ok(submit);
  const choices: PreparationChoices = {
    composer: { ...composer, purpose: 'composer', selectedValue: null },
    submit: { ...submit, purpose: 'submit', selectedValue: null },
  };
  await submission.prepare(choices);
}
