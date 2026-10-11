import assert from 'node:assert/strict';
import test from 'node:test';
import { ChatGptAdapter, type ChatGptAdapterOptions } from '../../src/providers/chatgpt/adapter.ts';
import { ProviderSubmissionError, type ProviderRecoveryRequest } from '../../src/providers/provider-adapter.ts';

test('deletion preparation distinguishes exact deleted proof, HTTP deferral and a single PATCH', async () => {
  const id = 'original-conversation';
  let status = 200, body: unknown = {}, patches = 0, closed = 0;
  const response = (code: number, data: unknown) => ({
    ok: () => code >= 200 && code < 300, status: () => code,
    headers: () => ({ 'retry-after': '9' }), dispose: async () => {},
    json: async () => { if (data === 'html') throw new SyntaxError('Not JSON'); return data; },
  });
  const api = {
    get: async (url: string) => url.endsWith('/api/auth/session')
      ? response(200, { accessToken: 'fixture-secret-token' }) : response(status, body),
    patch: async (url: string, options: { data: unknown }) => {
      assert.equal(url, `https://chatgpt.com/backend-api/conversation/${id}`);
      assert.deepEqual(options.data, { is_visible: false }); patches++;
      return response(200, { success: true });
    },
  };
  const adapter = new ChatGptAdapter({
    browserOwner: { createPage: async () => ({ page: {
      context: () => ({ request: api }), close: async () => { closed++; },
    } }) }, pageRegistry: {}, loginUrl: 'https://chatgpt.com/', acknowledgementTimeoutMs: 100,
  } as unknown as ChatGptAdapterOptions);
  const input = { session: { conversationId: id }, generation: 2 } as ProviderRecoveryRequest;
  for (const code of [429, 401, 403]) {
    status = code; body = 'html';
    await assert.rejects(adapter.openDeletion(input), (error: unknown) => {
      assert.ok(error instanceof ProviderSubmissionError);
      assert.equal(error.errorCode, code === 401 ? 'provider.authentication-required' : 'provider.unavailable');
      assert.deepEqual(error.details, { stage: 'conversation-verification', httpStatus: code, retryAfterMs: 9000 });
      assert.ok(!JSON.stringify(error).includes('fixture-secret-token'));
      return true;
    });
  }
  assert.equal(patches, 0); assert.equal(closed, 3);
  status = 404; body = { detail: { code: 'conversation_deleted', conversation_id: 'other' } };
  await assert.rejects(adapter.openDeletion(input), ProviderSubmissionError);
  body = { detail: { code: 'conversation_deleted', conversation_id: id } };
  const deleted = await adapter.openDeletion(input);
  assert.equal(deleted.alreadyDeleted, true); assert.equal(await deleted.deleteOnce(), true);
  await deleted.close(); assert.equal(patches, 0);
  status = 200; body = { conversation_id: id };
  const available = await adapter.openDeletion(input);
  assert.equal(available.alreadyDeleted, false); assert.equal(await available.deleteOnce(), true);
  await available.close(); assert.equal(patches, 1); assert.equal(closed, 6);
});
