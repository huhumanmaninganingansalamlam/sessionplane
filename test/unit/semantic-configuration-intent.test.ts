import assert from 'node:assert/strict';
import test from 'node:test';

import {
  semanticConfigurationIntent, semanticConfigurationMatches,
} from '../../src/providers/semantic-adapter.ts';

test('legacy ChatGPT Pro intent is explicit reasoning effort, never a model radio', () => {
  assert.deepEqual(semanticConfigurationIntent('chatgpt', 'Pro'),
    { kind: 'reasoning_effort', level: 'Pro' });
  assert.deepEqual(semanticConfigurationIntent('chatgpt', 'GPT-6'),
    { kind: 'model', name: 'GPT-6' });
  assert.deepEqual(semanticConfigurationIntent('gemini', 'Pro'),
    { kind: 'model', name: 'Pro' });

  assert.equal(semanticConfigurationMatches('chatgpt', 'Pro', {
    verifiedModel: 'Pro', verifiedReasoningLevel: 'Medium',
  }), false, 'even a literal Pro model radio cannot satisfy the effort intent');
  assert.equal(semanticConfigurationMatches('chatgpt', 'Pro', {
    verifiedModel: 'GPT-6', verifiedReasoningLevel: 'Pro',
  }), true, 'only the exact verified reasoning-level evidence satisfies Pro');
  assert.equal(semanticConfigurationMatches('chatgpt', 'Pro', {
    verifiedModel: 'GPT-6',
  }), false, 'model radio selection cannot substitute for missing effort evidence');
  assert.equal(semanticConfigurationMatches('chatgpt', 'GPT-6', {
    verifiedModel: null, verifiedReasoningLevel: 'Pro',
  }), false, 'effort level cannot substitute for the required literal model');
  assert.equal(semanticConfigurationMatches('chatgpt', 'GPT-6', {
    verifiedModel: 'GPT-6', verifiedReasoningLevel: 'Medium',
  }), true);
  assert.equal(semanticConfigurationMatches('gemini', 'Pro', {
    verifiedModel: 'Pro', verifiedReasoningLevel: null,
  }), true, 'other providers retain their exact literal model semantics');
  assert.equal(semanticConfigurationMatches('chatgpt', 'Pro', {
    verifiedModel: 'GPT-6', verifiedReasoningLevel: null,
    // Numeric Power slider evidence is never interpreted as Pro.
    sliderValue: 1,
  }), false);
});
