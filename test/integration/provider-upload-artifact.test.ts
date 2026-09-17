import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { callRpc, RpcClientError } from '../../src/cli/client.ts';
import { resolveConfig } from '../../src/config.ts';
import { startCore, type CoreService } from '../../src/main.ts';
import { FakeProviderAdapter } from '../fakes/fake-provider-adapter.ts';

interface TeamSnapshot {
  readonly teamId: string;
}

interface SessionSnapshot {
  readonly sessionId: string;
  readonly generation: number;
}

interface ArtifactRecord {
  readonly artifactId: string;
  readonly providerArtifactId: string;
  readonly artifactState: string;
  readonly name: string;
  readonly sizeBytes: number | null;
  readonly sha256: string | null;
  readonly relativePath: string | null;
}

interface ArtifactList {
  readonly requestOk: boolean;
  readonly sessionId: string;
  readonly generation: number;
  readonly artifacts: readonly ArtifactRecord[];
  readonly failures?: readonly Record<string, unknown>[];
}

test('provider uploads are hashed before submit and generated artifacts are durable', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'sessionplane-provider-artifact-'));
  const config = resolveConfig({ cwd: root, env: {}, stateDir: '.state' });
  const fake = new FakeProviderAdapter('chatgpt');
  let service: CoreService = await startCore({
    config,
    startBrowser: false,
    providerAdapters: [fake],
    logger: silentLogger(),
  });

  try {
    const team = await rpc<TeamSnapshot>(config.socketPath, 'team.create', {
      clientId: 'artifact-client',
      requestId: 'artifact-team',
      name: 'Artifact team',
      primaryRoleKey: 'main',
    });
    const session = await rpc<SessionSnapshot>(config.socketPath, 'session.create', {
      clientId: 'artifact-client',
      requestId: 'artifact-session',
      teamId: team.teamId,
      roleKey: 'main',
      provider: 'chatgpt',
    });
    const submitted = await rpc<SessionSnapshot>(config.socketPath, 'session.send', {
      clientId: 'artifact-client',
      requestId: 'artifact-send',
      sessionId: session.sessionId,
      prompt: 'Create a downloadable artifact.',
      sessionDeadlineSec: 600,
    });
    assert.equal(submitted.generation, 1);

    const artifactBytes = Buffer.from('durable provider artifact\n', 'utf8');
    fake.addArtifact(
      session.sessionId,
      {
        providerArtifactId: 'provider-artifact-1',
        name: 'result.txt',
        sourceUrl: 'https://chatgpt.com/backend-api/files/result.txt',
        mediaType: 'text/plain',
      },
      artifactBytes,
    );

    const discovered = await rpc<ArtifactList>(config.socketPath, 'artifact.discover', {
      clientId: 'artifact-client',
      sessionId: session.sessionId,
      generation: 1,
    });
    assert.equal(discovered.artifacts.length, 1);
    assert.equal(discovered.artifacts[0]?.artifactState, 'discovered');

    const captured = await rpc<ArtifactList>(config.socketPath, 'artifact.capture', {
      clientId: 'artifact-client',
      sessionId: session.sessionId,
      generation: 1,
    });
    assert.equal(captured.requestOk, true);
    assert.equal(captured.artifacts.length, 1);
    const artifact = captured.artifacts[0];
    assert.notEqual(artifact, undefined);
    assert.equal(artifact?.artifactState, 'downloaded');
    assert.equal(artifact?.sizeBytes, artifactBytes.length);
    assert.equal(
      artifact?.sha256,
      createHash('sha256').update(artifactBytes).digest('hex'),
    );
    assert.equal(fake.artifactDownloadCount, 1);
    assert.notEqual(artifact?.relativePath, null);
    if (artifact?.relativePath !== null && artifact?.relativePath !== undefined) {
      const storedPath = path.join(config.artifactDir, artifact.relativePath);
      assert.equal(existsSync(storedPath), true);
      assert.deepEqual(readFileSync(storedPath), artifactBytes);
    }

    const replay = await rpc<ArtifactList>(config.socketPath, 'artifact.capture', {
      clientId: 'artifact-client',
      sessionId: session.sessionId,
      generation: 1,
    });
    assert.equal(replay.requestOk, true);
    assert.equal(fake.artifactDownloadCount, 1, 'durable bytes must be reused');

    await service.close();
    const restarted = new FakeProviderAdapter('chatgpt');
    service = await startCore({
      config,
      startBrowser: false,
      providerAdapters: [restarted],
      logger: silentLogger(),
    });
    const listed = await rpc<ArtifactList>(config.socketPath, 'artifact.list', {
      clientId: 'artifact-client',
      sessionId: session.sessionId,
      generation: 1,
    });
    assert.equal(listed.artifacts.length, 1);
    assert.equal(listed.artifacts[0]?.artifactState, 'downloaded');

    const outputPath = path.join(root, 'exported', 'result.txt');
    const exported = await rpc<Record<string, unknown>>(
      config.socketPath,
      'artifact.export',
      {
        clientId: 'artifact-client',
        artifactId: artifact?.artifactId,
        outputPath,
      },
    );
    assert.equal(exported.requestOk, true);
    assert.deepEqual(readFileSync(outputPath), artifactBytes);

    await assert.rejects(
      rpc(config.socketPath, 'artifact.discover', {
        clientId: 'artifact-client',
        sessionId: session.sessionId,
        generation: 2,
      }),
      (error: unknown) =>
        error instanceof RpcClientError &&
        (error.data as Record<string, unknown>).errorCode === 'session.generation-superseded',
    );
  } finally {
    await service.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('artifact capture fails closed when provider bytes exceed the configured limit', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'sessionplane-artifact-limit-'));
  const config = resolveConfig({
    cwd: root,
    env: {},
    stateDir: '.state',
    maxArtifactFileBytes: 8,
  });
  const fake = new FakeProviderAdapter('gemini');
  const service = await startCore({
    config,
    startBrowser: false,
    providerAdapters: [fake],
    logger: silentLogger(),
  });
  try {
    const team = await rpc<TeamSnapshot>(config.socketPath, 'team.create', {
      clientId: 'artifact-limit-client',
      requestId: 'artifact-limit-team',
      primaryRoleKey: 'main',
    });
    const session = await rpc<SessionSnapshot>(config.socketPath, 'session.create', {
      clientId: 'artifact-limit-client',
      requestId: 'artifact-limit-session',
      teamId: team.teamId,
      roleKey: 'main',
      provider: 'gemini',
    });
    await rpc(config.socketPath, 'session.send', {
      clientId: 'artifact-limit-client',
      requestId: 'artifact-limit-send',
      sessionId: session.sessionId,
      prompt: 'Create a large file.',
      sessionDeadlineSec: 600,
    });
    fake.addArtifact(
      session.sessionId,
      {
        providerArtifactId: 'too-large',
        name: 'large.bin',
        sourceUrl: 'https://gemini.google.com/files/large.bin',
        mediaType: 'application/octet-stream',
      },
      Buffer.alloc(9, 1),
    );
    const captured = await rpc<ArtifactList>(config.socketPath, 'artifact.capture', {
      clientId: 'artifact-limit-client',
      sessionId: session.sessionId,
    });
    assert.equal(captured.requestOk, false);
    assert.equal(captured.artifacts.length, 0);
    assert.equal(captured.failures?.[0]?.errorCode, 'provider.artifact-too-large');
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
  return await callRpc<Result>({ socketPath, method, params, timeoutMs: 10_000 });
}

function silentLogger() {
  return {
    debug() {},
    info() {},
    warn() {},
    error() {},
  };
}

