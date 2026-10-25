import assert from 'node:assert/strict';
import test from 'node:test';
import { ChatGptAdapter, type ChatGptAdapterOptions } from '../../src/providers/chatgpt/adapter.ts';
import { ProviderSubmissionError, type ProviderRecoveryRequest } from '../../src/providers/provider-adapter.ts';

test('deletion preparation distinguishes exact deleted proof, HTTP deferral and a single PATCH', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: new Date('2026-10-26T00:00:00Z') });
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
    t.mock.timers.tick(9000);
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

test('deletion preparation shares 429 cooldown across conversations without new pages or HTTP, then permits an explicit later call', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: new Date('2026-10-26T00:00:00Z') });
  for (const stage of ['authentication', 'conversation-verification']) {
    for (const header of ['9', 'date', undefined, 'invalid', '0']) {
      const retryAfter = header === 'date' ? new Date(Date.now() + 9000).toUTCString() : header;
      let pages = 0, auths = 0, verifications = 0, patches = 0, closed = 0, limited = true;
      const delay = retryAfter === undefined || retryAfter === 'invalid' || retryAfter === '0' ? 5000 : 9000;
      const response = (status: number, body: unknown) => ({
        ok: () => status === 200, status: () => status,
        headers: () => retryAfter === undefined ? {} : { 'Retry-After': retryAfter },
        json: async () => body, dispose: async () => {},
      });
      const api = {
        get: async (url: string) => {
          if (url.endsWith('/api/auth/session')) {
            auths++;
            return response(limited && stage === 'authentication' ? 429 : 200, { accessToken: 'fixture-secret-token' });
          }
          verifications++;
          return response(limited ? 429 : 200, {});
        },
        patch: async () => { patches++; return response(200, { success: true }); },
      };
      const adapter = new ChatGptAdapter({
        browserOwner: { createPage: async () => { pages++; return { page: {
          context: () => ({ request: api }), close: async () => { closed++; },
        } }; } }, pageRegistry: {}, loginUrl: 'https://chatgpt.com/', acknowledgementTimeoutMs: 100,
      } as unknown as ChatGptAdapterOptions);
      const input = (id: string) => ({ session: { conversationId: id }, generation: 1 }) as ProviderRecoveryRequest;
      const results = await Promise.allSettled(['one', 'two', 'three'].map(id => adapter.openDeletion(input(id))));
      for (const result of results) {
        assert.equal(result.status, 'rejected');
        if (result.status !== 'rejected') throw new Error('Expected deletion deferral');
        assert.ok(result.reason instanceof ProviderSubmissionError);
        assert.equal(result.reason.errorCode, 'provider.unavailable');
        assert.equal(result.reason.details.stage, stage);
        assert.equal(result.reason.details.httpStatus, 429);
        assert.doesNotMatch(JSON.stringify(result.reason), /fixture-secret-token/);
      }
      assert.equal(pages, 1); assert.equal(auths, 1);
      assert.equal(verifications, stage === 'authentication' ? 0 : 1);
      assert.equal(patches, 0); assert.equal(closed, 1);
      t.mock.timers.tick(delay - 1);
      await assert.rejects(adapter.openDeletion(input('four')), (error: unknown) => {
        assert.ok(error instanceof ProviderSubmissionError);
        assert.deepEqual(error.details, { stage, httpStatus: 429, retryAfterMs: 1 });
        return true;
      });
      assert.equal(pages, 1); assert.equal(auths, 1);
      t.mock.timers.tick(1); limited = false;
      const available = await adapter.openDeletion(input('four'));
      assert.equal(await available.deleteOnce(), true); await available.close();
      assert.equal(patches, 1); assert.equal(pages, 2); assert.equal(closed, 2);
    }
  }
});
