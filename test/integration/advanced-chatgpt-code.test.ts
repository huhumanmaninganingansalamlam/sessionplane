import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { callRpc, RpcClientError } from '../../src/cli/client.ts';
import { resolveConfig } from '../../src/config.ts';
import { startCore } from '../../src/main.ts';
import { FakeProviderAdapter } from '../fakes/fake-provider-adapter.ts';
import { createStoredZip } from '../helpers/zip-fixture.ts';

interface TeamSnapshot {
  readonly teamId: string;
}

interface SessionSnapshot {
  readonly sessionId: string;
  readonly generation: number;
  readonly terminal: boolean;
}

test('Chat-only code ZIP generation and extraction use exact durable ChatGPT sessions', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'sessionplane-advanced-chatgpt-'));
  const config = resolveConfig({
    cwd: root,
    env: {},
    stateDir: '.state',
    enabledProviders: ['chatgpt', 'gemini'],
    observationActiveSweepMs: 5,
    observationQuietSweepMs: 5,
    observationQuietWindowMs: 5,
    backendRecoveryAfterMs: 60_000,
  });
  const fake = new FakeProviderAdapter('chatgpt');
  fake.autoFinalText =
    'DOWNLOAD: [result.zip](sandbox:/mnt/data/result.zip)\nMACHINE: /mnt/data/result.zip';
  const service = await startCore({
    config,
    startBrowser: false,
    providerAdapters: [fake],
    logger: silentLogger(),
  });

  try {
    const team = await rpc<TeamSnapshot>(config.socketPath, 'team.create', {
      clientId: 'advanced-client',
      requestId: 'advanced-team',
      name: 'Advanced ChatGPT',
      primaryRoleKey: 'main',
    });
    const main = await rpc<SessionSnapshot>(config.socketPath, 'session.create', {
      clientId: 'advanced-client',
      requestId: 'advanced-main-session',
      teamId: team.teamId,
      roleKey: 'main',
      provider: 'chatgpt',
    });
    await rpc(config.socketPath, 'team.role.create', {
      clientId: 'advanced-client',
      requestId: 'advanced-gemini-role',
      teamId: team.teamId,
      roleKey: 'expert.gemini',
      roleType: 'expert',
      reportsToRoleKey: 'main',
    });
    const gemini = await rpc<SessionSnapshot>(config.socketPath, 'session.create', {
      clientId: 'advanced-client',
      requestId: 'advanced-gemini-session',
      teamId: team.teamId,
      roleKey: 'expert.gemini',
      provider: 'gemini',
    });
    const submitCountBeforeProviderChecks = fake.submitCount;
    await assert.rejects(
      rpc(config.socketPath, 'session.send', {
        clientId: 'advanced-client',
        requestId: 'advanced-work-surface-rejected',
        sessionId: main.sessionId,
        prompt: 'Do not submit this through Work.',
        surface: 'work',
        sessionDeadlineSec: 60,
      }),
      (error: unknown) =>
        error instanceof RpcClientError &&
        (error.data as Record<string, unknown>).errorCode === 'capability.unsupported',
    );
    await assert.rejects(
      rpc(config.socketPath, 'code.generate', {
        clientId: 'advanced-client',
        requestId: 'advanced-invalid-code-provider',
        sessionId: gemini.sessionId,
        prompt: 'Do not submit code mode to Gemini.',
        sessionDeadlineSec: 10,
      }),
      (error: unknown) =>
        error instanceof RpcClientError &&
        (error.data as Record<string, unknown>).errorCode ===
          'code-mode.vendor-unsupported',
    );
    assert.equal(fake.submitCount, submitCountBeforeProviderChecks);

    const archive = createStoredZip({
      'PLAN.md': '# Plan\n\n- [x] Implement\n- [x] Verify\n',
      'src/index.ts': 'export const ready = true;\n',
    });
    fake.addCodeArtifact(
      main.sessionId,
      {
        providerArtifactId: 'fake-code-result',
        name: 'result.zip',
        sandboxPath: '/mnt/data/result.zip',
        candidateMessageIds: ['tool-code', 'tool-output'],
        mediaType: 'application/zip',
      },
      archive,
    );
    const outputPath = path.join(root, 'output', 'result.zip');
    const generated = await rpc<{
      readonly requestOk: boolean;
      readonly session: SessionSnapshot;
      readonly compliance: { readonly compliant: boolean };
      readonly artifacts: readonly Array<{
        readonly artifactId: string;
        readonly outputPath: string;
        readonly planPath: string | null;
      }>;
    }>(config.socketPath, 'code.generate', {
      clientId: 'advanced-client',
      requestId: 'advanced-code-generate',
      sessionId: main.sessionId,
      prompt: 'Build a TypeScript CLI.',
      sessionDeadlineSec: 10,
      outputPath,
      multiZip: false,
      overwrite: false,
    });

    assert.equal(generated.requestOk, true);
    assert.equal(generated.session.terminal, true);
    assert.equal(generated.compliance.compliant, true);
    assert.equal(generated.artifacts.length, 1);
    assert.equal(generated.artifacts[0]?.planPath, 'PLAN.md');
    assert.equal(generated.artifacts[0]?.outputPath, outputPath);
    assert.equal(existsSync(outputPath), true);
    assert.deepEqual(readFileSync(outputPath), archive);
    assert.equal(fake.codeArtifactDownloadCount, 1);
    const codeRequest = fake.submissionRequests.find(
      (request) => request.session.sessionId === main.sessionId,
    );
    assert.match(codeRequest?.prompt ?? '', /^\[CODE MODE/);
    assert.match(codeRequest?.prompt ?? '', /PLAN\.md/);

    const extracted = await rpc<{
      readonly artifacts: readonly Array<{ readonly artifactId: string }>;
    }>(config.socketPath, 'code.extract', {
      clientId: 'advanced-client',
      sessionId: main.sessionId,
      generation: 1,
      outputPath,
      requirePlan: true,
      overwrite: false,
      multiZip: false,
    });
    assert.equal(extracted.artifacts[0]?.artifactId, generated.artifacts[0]?.artifactId);

    const downloadsBeforeMismatch = fake.codeArtifactDownloadCount;
    await assert.rejects(
      rpc(config.socketPath, 'code.extract', {
        clientId: 'advanced-client',
        sessionId: main.sessionId,
        conversationId: 'different-conversation-123456',
        outputPath: path.join(root, 'wrong.zip'),
        multiZip: false,
        requirePlan: true,
        overwrite: false,
      }),
      (error: unknown) =>
        error instanceof RpcClientError &&
        (error.data as Record<string, unknown>).errorCode ===
          'session.conversation-mismatch',
    );
    assert.equal(fake.codeArtifactDownloadCount, downloadsBeforeMismatch);
  } finally {
    await service.close();
    rmSync(root, { recursive: true, force: true });
  }
});

async function rpc<Result = Readonly<Record<string, unknown>>>(
  socketPath: string,
  method: string,
  params: unknown,
): Promise<Result> {
  return await callRpc<Result>({ socketPath, method, params, timeoutMs: 20_000 });
}

function silentLogger() {
  return {
    debug() {},
    info() {},
    warn() {},
    error() {},
  };
}
