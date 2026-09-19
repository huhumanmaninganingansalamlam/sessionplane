import assert from 'node:assert/strict';
import test from 'node:test';

import { providerConversationUrl } from '../../src/core/recovery-service.ts';

const urls = {
  chatgptUrl: 'https://chatgpt.com/',
  geminiUrl: 'https://gemini.google.com/app',
  grokUrl: 'https://grok.com/',
} as const;

test('restart recovery opens the exact provider conversation URL', () => {
  assert.equal(
    providerConversationUrl('chatgpt', 'chat-conversation-123456', urls),
    'https://chatgpt.com/c/chat-conversation-123456',
  );
  assert.equal(
    providerConversationUrl('gemini', 'gemini-conversation-123456', urls),
    'https://gemini.google.com/app/gemini-conversation-123456',
  );
  assert.equal(
    providerConversationUrl('grok', 'grok-conversation-123456', urls),
    'https://grok.com/c/grok-conversation-123456',
  );
});

test('restart recovery URL-encodes provider conversation ids', () => {
  assert.equal(
    providerConversationUrl('gemini', 'conversation/with space', urls),
    'https://gemini.google.com/app/conversation%2Fwith%20space',
  );
});
