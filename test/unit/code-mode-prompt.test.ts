import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildCodeModePrompt,
  checkCodeContractCompliance,
  CODE_ARTIFACT_PATH,
} from '../../src/core/chatgpt-workflow-service.ts';

test('single code prompt requires one verified result.zip and a root plan', () => {
  const prompt = buildCodeModePrompt('Build a small TypeScript CLI.');
  assert.match(prompt, /PLAN\.md 또는 00_plan\.md/);
  assert.match(prompt, new RegExp(CODE_ARTIFACT_PATH.replaceAll('/', '\\/')));
  assert.match(prompt, /find \/mnt\/data/);
  assert.match(prompt, /DOWNLOAD:/);
  assert.match(prompt, /MACHINE:/);
});

test('multi zip prompt and final answer compliance are explicit', () => {
  const prompt = buildCodeModePrompt('Build frontend and backend.', true);
  assert.match(prompt, /MULTI-ZIP/);
  assert.match(prompt, /의미 있는 이름의 zip/);
  assert.deepEqual(
    checkCodeContractCompliance(
      [
        'DOWNLOAD: [frontend.zip](sandbox:/mnt/data/frontend.zip)',
        'MACHINE: /mnt/data/frontend.zip',
        'DOWNLOAD: [backend.zip](sandbox:/mnt/data/backend.zip)',
        'MACHINE: /mnt/data/backend.zip',
      ].join('\n'),
      true,
    ),
    { compliant: true, mentionsPath: true },
  );
  assert.equal(
    checkCodeContractCompliance(
      'DOWNLOAD: [frontend.zip](sandbox:/mnt/data/frontend.zip)\nMACHINE: /mnt/data/backend.zip',
      true,
    ).compliant,
    false,
  );
  assert.deepEqual(checkCodeContractCompliance('Created it.'), {
    compliant: false,
    mentionsPath: false,
  });
});
