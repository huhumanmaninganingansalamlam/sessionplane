import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Readable, Writable } from 'node:stream';
import test from 'node:test';

import { callRpc } from '../../src/cli/client.ts';
import { runCli } from '../../src/cli/main.ts';
import { resolveConfig } from '../../src/config.ts';
import { startCore } from '../../src/main.ts';
import { FakeProviderAdapter } from '../fakes/fake-provider-adapter.ts';

test('RPC and CLI share deterministic context package semantics', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'sessionplane-context-cli-'));
  const config = resolveConfig({ cwd: root, env: {}, stateDir: '.state' });
  const fake = new FakeProviderAdapter('chatgpt');
  writeFileSync(path.join(root, 'alpha.ts'), 'export const alpha = 1;\n');
  writeFileSync(path.join(root, 'beta.md'), '# Beta\n');
  const service = await startCore({
    config,
    startBrowser: false,
    providerAdapters: [fake],
    logger: silentLogger(),
  });
  try {
    const rpcDry = await callRpc<{
      readonly packageSha256: string;
      readonly files: readonly Array<{ readonly path: string }>;
    }>({
      socketPath: config.socketPath,
      method: 'context.dryRun',
      params: {
        root,
        includes: ['*.ts', '*.md'],
        excludes: ['beta.md'],
        prompt: 'Review.',
        transport: 'inline',
      },
      timeoutMs: 5_000,
    });
    assert.deepEqual(rpcDry.files.map((file) => file.path), ['alpha.ts']);

    const canonical = await runSessplane([
      'context',
      'dry-run',
      '--root',
      root,
      '--context-from-files',
      '*.ts',
      '--context-from-files',
      '*.md',
      '--context-exclude',
      'beta.md',
      '--context-transport',
      'inline',
      '--prompt',
      'Review.',
      '--json',
    ]);
    assert.equal(canonical.code, 0, canonical.stderr);
    const canonicalValue = JSON.parse(canonical.stdout) as {
      readonly packageSha256: string;
      readonly files: readonly Array<{ readonly path: string }>;
    };
    assert.equal(canonicalValue.packageSha256, rpcDry.packageSha256);
    assert.deepEqual(canonicalValue.files.map((file) => file.path), ['alpha.ts']);

    const rendered = await runSessplane([
      'context',
      'render',
      '--root',
      root,
      '--context-from-files',
      '*.ts',
      '--context-transport',
      'inline',
      '--context-transform',
      'repomix',
      '--prompt',
      'Review.',
      '--json',
    ]);
    assert.equal(rendered.code, 0, rendered.stderr);
    const renderedValue = JSON.parse(rendered.stdout) as {
      readonly composerText: string;
      readonly transform: string;
    };
    assert.equal(renderedValue.transform, 'repomix');
    assert.match(renderedValue.composerText, /^Review\.\n\n<repository/);

    const upload = await runSessplane([
      'context',
      'render',
      '--root',
      root,
      '--context-from-files',
      '*.ts',
      '--context-transport',
      'upload',
      '--state-dir',
      config.stateDir,
      '--json',
    ]);
    assert.equal(upload.code, 0, upload.stderr);
    const uploadValue = JSON.parse(upload.stdout) as { readonly artifactPath: string };
    assert.equal(existsSync(uploadValue.artifactPath), true);
    assert.match(readFileSync(uploadValue.artifactPath, 'utf8'), /alpha\.ts/);

    const team = await callRpc<{ readonly teamId: string }>({
      socketPath: config.socketPath,
      method: 'team.create',
      params: {
        clientId: 'context-client',
        requestId: 'context-team',
        primaryRoleKey: 'main',
      },
      timeoutMs: 5_000,
    });
    const session = await callRpc<{ readonly sessionId: string }>({
      socketPath: config.socketPath,
      method: 'session.create',
      params: {
        clientId: 'context-client',
        requestId: 'context-session',
        teamId: team.teamId,
        roleKey: 'main',
        provider: 'chatgpt',
      },
      timeoutMs: 5_000,
    });
    const sent = await runSessplane([
      'send',
      '--session',
      session.sessionId,
      '--prompt',
      'Use the repository context.',
      '--context-from-files',
      '*.ts',
      '--context-transport',
      'upload',
      '--root',
      root,
      '--state-dir',
      config.stateDir,
      '--client-id',
      'context-client',
      '--request-id',
      'context-send',
      '--json',
    ]);
    assert.equal(sent.code, 0, sent.stderr);
    const submission = fake.submissionRequests.at(-1);
    assert.equal(submission?.prompt, 'Use the repository context.');
    assert.equal(submission?.attachments?.length, 1);
    assert.match(submission?.attachments?.[0]?.path ?? '', /context-packages/);
    assert.match(
      readFileSync(submission?.attachments?.[0]?.path ?? '', 'utf8'),
      /alpha\.ts/,
    );
  } finally {
    await service.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('bundled skills are served and installed by the SessionPlane CLI', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'sessionplane-skills-'));
  try {
    const listed = await runSessplane(['skills', 'list', '--json']);
    assert.equal(listed.code, 0, listed.stderr);
    const names = (JSON.parse(listed.stdout) as {
      readonly skills: readonly Array<{ readonly name: string }>;
    }).skills.map((skill) => skill.name);
    for (const name of ['browser', 'search', 'sessionplane', 'vision-click', 'web-ai']) {
      assert.equal(names.includes(name), true, name);
    }

    const core = await runSessplane(['skills', 'get', 'core', '--full', '--json']);
    assert.equal(core.code, 0, core.stderr);
    assert.match((JSON.parse(core.stdout) as { readonly content: string }).content, /skill:browser/);

    const target = path.join(root, 'skills');
    const installed = await runSessplane([
      'skills',
      'install',
      '--target',
      target,
      '--skill',
      'browser',
      '--skill',
      'web-ai',
      '--skill',
      'sessionplane',
      '--json',
    ]);
    assert.equal(installed.code, 0, installed.stderr);
    assert.equal(existsSync(path.join(target, 'browser', 'SKILL.md')), true);
    assert.equal(existsSync(path.join(target, 'web-ai', 'SKILL.md')), true);
    assert.equal(existsSync(path.join(target, 'sessionplane', 'SKILL.md')), true);
    const webAiSkill = readFileSync(path.join(target, 'web-ai', 'SKILL.md'), 'utf8');
    const coreSkill = readFileSync(path.join(target, 'sessionplane', 'SKILL.md'), 'utf8');
    assert.match(webAiSkill, /Never use Gemini or Grok as an implicit fallback for ChatGPT/);
    assert.match(webAiSkill, /pass `--model Pro`/);
    assert.match(coreSkill, /Never switch providers as recovery/);
    assert.match(coreSkill, /`model=Pro` is a model-family intent/);

    const protectedRun = await runSessplane([
      'skills',
      'install',
      '--target',
      target,
      '--skill',
      'browser',
      '--json',
    ]);
    assert.equal(protectedRun.code, 2);
    assert.match(protectedRun.stderr, /input\.output-exists|Refusing to replace/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

class CaptureWritable extends Writable {
  value = '';

  override _write(
    chunk: Buffer | string,
    _encoding: BufferEncoding,
    callback: (error?: Error | null) => void,
  ): void {
    this.value += chunk.toString();
    callback();
  }
}

async function runSessplane(argv: readonly string[]) {
  const stdout = new CaptureWritable();
  const stderr = new CaptureWritable();
  const code = await runCli(argv, { stdin: Readable.from([]), stdout, stderr });
  return { code, stdout: stdout.value.trim(), stderr: stderr.value.trim() };
}

function silentLogger() {
  return {
    debug() {},
    info() {},
    warn() {},
    error() {},
  };
}

