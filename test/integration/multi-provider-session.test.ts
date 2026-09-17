import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { callRpc } from '../../src/cli/client.ts';
import { resolveConfig } from '../../src/config.ts';
import type { SessionSnapshot } from '../../src/domain/session.ts';
import { startCore } from '../../src/main.ts';
import { FakeProviderAdapter } from '../fakes/fake-provider-adapter.ts';

test('ChatGPT, Gemini, and Grok sessions share team identity without cross-provider mixing', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'sessionplane-multi-provider-'));
  const config = resolveConfig({
    cwd: root,
    env: {},
    stateDir: '.state',
    observationActiveSweepMs: 5,
    observationQuietSweepMs: 10,
    observationQuietWindowMs: 5,
  });
  const adapters = {
    chatgpt: new FakeProviderAdapter('chatgpt'),
    gemini: new FakeProviderAdapter('gemini'),
    grok: new FakeProviderAdapter('grok'),
  };
  const service = await startCore({
    config,
    startBrowser: false,
    providerAdapters: Object.values(adapters),
    logger: silentLogger(),
  });

  try {
    const team = await rpc<{ teamId: string }>(config.socketPath, 'team.create', {
      clientId: 'multi-provider',
      requestId: 'team',
      name: 'Provider Team',
      primaryRoleKey: 'main',
    });
    for (const provider of ['gemini', 'grok'] as const) {
      await rpc(config.socketPath, 'team.role.create', {
        clientId: 'multi-provider',
        requestId: `role-${provider}`,
        teamId: team.teamId,
        roleKey: `expert.${provider}`,
        roleType: 'expert',
        reportsToRoleKey: 'main',
      });
    }
    const attachmentPath = path.join(root, 'context.txt');
    writeFileSync(attachmentPath, 'shared context', 'utf8');
    const sessions = await Promise.all(
      (['chatgpt', 'gemini', 'grok'] as const).map((provider) =>
        rpc<SessionSnapshot>(config.socketPath, 'session.create', {
          clientId: 'multi-provider',
          requestId: `session-${provider}`,
          teamId: team.teamId,
          roleKey: provider === 'chatgpt' ? 'main' : `expert.${provider}`,
          provider,
        }),
      ),
    );
    assert.deepEqual(sessions.map((session) => session.provider), ['chatgpt', 'gemini', 'grok']);

    const submitted = await Promise.all(
      sessions.map((session) =>
        rpc<SessionSnapshot>(config.socketPath, 'session.send', {
          clientId: 'multi-provider',
          requestId: `send-${session.provider}`,
          sessionId: session.sessionId,
          prompt: `Prompt for ${session.provider}`,
          model: 'test-model',
          effort: 'high',
          surface: 'chat',
          files: [attachmentPath],
          sessionDeadlineSec: 600,
        }),
      ),
    );
    assert.equal(new Set(submitted.map((session) => session.conversationId)).size, 3);
    for (const session of submitted) {
      assert.match(
        session.conversationId ?? '',
        session.provider === 'chatgpt'
          ? /^conversation-/
          : new RegExp(`^${session.provider}-conversation-`),
      );
      const request = adapters[session.provider as keyof typeof adapters].submissionRequests[0];
      assert.equal(request?.effort, 'high');
      assert.equal(request?.surface, 'chat');
      assert.equal(request?.attachments?.length, 1);
      assert.equal(
        request?.attachments?.[0]?.sha256,
        createHash('sha256').update('shared context').digest('hex'),
      );
      adapters[session.provider as keyof typeof adapters].emitObservation(session.sessionId, {
        candidate: {
          responseMessageId: `${session.provider}-final-1`,
          answerText: `${session.provider} final`,
          terminalMarker: true,
          streamingMarker: false,
        },
        activity: 'none',
      });
    }

    const finals = await Promise.all(
      submitted.map((session) => waitForTerminal(config.socketPath, session.sessionId)),
    );
    assert.deepEqual(
      finals.map((session) => session.answerText).sort(),
      ['chatgpt final', 'gemini final', 'grok final'],
    );
    assert.ok(finals.every((session) => session.teamId === team.teamId));
  } finally {
    await service.close();
    rmSync(root, { recursive: true, force: true });
  }
});

async function waitForTerminal(socketPath: string, sessionId: string): Promise<SessionSnapshot> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const snapshot = await rpc<SessionSnapshot>(socketPath, 'session.wait', {
      clientId: 'multi-provider',
      sessionId,
      generation: 1,
      waitMs: 25,
    });
    if (snapshot.terminal) return snapshot;
  }
  throw new Error(`Timed out waiting for ${sessionId}`);
}

async function rpc<Result = Readonly<Record<string, unknown>>>(
  socketPath: string,
  method: string,
  params: unknown,
): Promise<Result> {
  return await callRpc<Result>({ socketPath, method, params, timeoutMs: 5_000 });
}

function silentLogger() {
  return {
    debug() {},
    info() {},
    warn() {},
    error() {},
  };
}
