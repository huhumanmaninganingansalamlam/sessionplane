import assert from 'node:assert/strict';
import test from 'node:test';

import { scanChatGptConversationForCodeArtifacts } from '../../src/providers/chatgpt/code-artifacts.ts';

test('conversation scan keeps distinct zip paths and newest-first tool candidates', () => {
  const candidates = scanChatGptConversationForCodeArtifacts('conv-123456789', {
    mapping: {
      user: {
        message: {
          id: 'user-message',
          author: { role: 'user' },
          create_time: 1,
          content: { content_type: 'text', parts: ['/mnt/data/ignore.zip'] },
        },
      },
      code: {
        message: {
          id: 'tool-code-old',
          author: { role: 'assistant' },
          create_time: 2,
          content: {
            content_type: 'code',
            text: 'write /mnt/data/source-code-should-not-count.zip',
          },
        },
      },
      output: {
        message: {
          id: 'tool-output-new',
          author: { role: 'tool' },
          create_time: 3,
          content: { content_type: 'execution_output', text: 'done' },
        },
      },
      duplicateOutputIdentity: {
        message: {
          id: 'tool-output-new',
          author: { role: 'tool' },
          create_time: 3.5,
          content: { content_type: 'execution_output', text: 'same tool identity' },
        },
      },
      answer: {
        message: {
          id: 'assistant-final',
          author: { role: 'assistant' },
          create_time: 4,
          content: {
            content_type: 'text',
            parts: [
              'MACHINE: /mnt/data/result.zip',
              'MACHINE: /mnt/data/frontend.zip',
              'MACHINE: /mnt/data/result.zip',
              'MACHINE: /mnt/data/../escape.zip',
              'MACHINE: /mnt/data//ambiguous.zip',
            ],
          },
        },
      },
    },
  });

  assert.deepEqual(
    candidates.map((candidate) => candidate.sandboxPath),
    ['/mnt/data/result.zip', '/mnt/data/frontend.zip'],
  );
  assert.deepEqual(candidates[0]?.candidateMessageIds, [
    'tool-code-old',
    'tool-output-new',
  ]);
  assert.equal(candidates[0]?.name, 'result.zip');
  assert.match(candidates[0]?.providerArtifactId ?? '', /^chatgpt-code-/);
});
