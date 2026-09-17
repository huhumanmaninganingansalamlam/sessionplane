import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Readable, Writable } from 'node:stream';
import test from 'node:test';

import { runAgbrowseCli } from '../../src/compat/agbrowse-cli.ts';
import { resolveConfig } from '../../src/config.ts';
import { startCore } from '../../src/main.ts';
import { FakeProviderAdapter } from '../fakes/fake-provider-adapter.ts';

test('agbrowse web-ai normal chat compatibility uses durable multi-provider sessions', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'sessionplane-web-ai-compat-'));
  const config = resolveConfig({
    cwd: root,
    env: {},
    stateDir: '.state',
    observationActiveSweepMs: 5,
    observationQuietSweepMs: 10,
    observationQuietWindowMs: 5,
  });
  const chatgpt = new FakeProviderAdapter('chatgpt');
  const gemini = new FakeProviderAdapter('gemini');
  const grok = new FakeProviderAdapter('grok');
  chatgpt.autoFinalText = 'ChatGPT query final';
  const service = await startCore({
    config,
    startBrowser: false,
    providerAdapters: [chatgpt, gemini, grok],
    logger: silentLogger(),
  });

  try {
    const rendered = await runJson([
      'web-ai',
      'render',
      '--vendor',
      'gemini',
      '--prompt',
      'Rendered prompt',
      '--state-dir',
      config.stateDir,
      '--json',
    ]);
    assert.equal(rendered.code, 0, rendered.stderr);
    assert.equal(JSON.parse(rendered.stdout).status, 'rendered');

    const queried = await runJson([
      'web-ai',
      'query',
      '--vendor',
      'chatgpt',
      '--prompt',
      'Query prompt',
      '--timeout',
      '2',
      '--state-dir',
      config.stateDir,
      '--json',
    ]);
    assert.equal(queried.code, 0, queried.stderr);
    const queryValue = JSON.parse(queried.stdout) as Record<string, unknown>;
    assert.equal(queryValue.status, 'complete');
    assert.equal(queryValue.answerText, 'ChatGPT query final');

    const attachment = path.join(root, 'gemini-context.txt');
    writeFileSync(attachment, 'Gemini context', 'utf8');
    const sent = await runJson([
      'web-ai',
      'send',
      '--vendor',
      'gemini',
      '--model',
      'pro',
      '--effort',
      'high',
      '--file',
      attachment,
      '--prompt',
      'Gemini prompt',
      '--state-dir',
      config.stateDir,
      '--json',
    ]);
    assert.equal(sent.code, 0, sent.stderr);
    const sentValue = JSON.parse(sent.stdout) as {
      sessionId: string;
      generation: number;
      provider: string;
    };
    assert.equal(sentValue.provider, 'gemini');
    gemini.emitObservation(sentValue.sessionId, {
      candidate: {
        responseMessageId: 'gemini-final-1',
        answerText: 'Gemini final',
        terminalMarker: true,
        streamingMarker: false,
      },
      activity: 'none',
    });
    const polled = await runJson([
      'web-ai',
      'poll',
      '--vendor',
      'gemini',
      '--session',
      sentValue.sessionId,
      '--timeout',
      '2',
      '--state-dir',
      config.stateDir,
      '--json',
    ]);
    assert.equal(polled.code, 0, polled.stderr);
    assert.equal(JSON.parse(polled.stdout).answerText, 'Gemini final');
    assert.equal(gemini.submissionRequests[0]?.attachments?.length, 1);

    const grokSend = await runJson([
      'web-ai',
      'send',
      '--vendor',
      'grok',
      '--prompt',
      'Stop this Grok generation',
      '--state-dir',
      config.stateDir,
      '--json',
    ]);
    assert.equal(grokSend.code, 0, grokSend.stderr);
    const grokSession = JSON.parse(grokSend.stdout).sessionId as string;
    const stopped = await runJson([
      'web-ai',
      'stop',
      '--vendor',
      'grok',
      '--session',
      grokSession,
      '--state-dir',
      config.stateDir,
      '--json',
    ]);
    assert.equal(stopped.code, 0, stopped.stderr);
    assert.equal(JSON.parse(stopped.stdout).providerState, 'stopped');
    assert.equal(grok.stopCount, 1);

    const sessions = await runJson([
      'web-ai',
      'sessions',
      'list',
      '--state-dir',
      config.stateDir,
      '--json',
    ]);
    assert.equal(sessions.code, 0, sessions.stderr);
    assert.equal(JSON.parse(sessions.stdout).sessions.length, 3);

    const status = await runJson([
      'web-ai',
      'status',
      '--session',
      sentValue.sessionId,
      '--state-dir',
      config.stateDir,
      '--json',
    ]);
    assert.equal(status.code, 0, status.stderr);
    assert.equal(JSON.parse(status.stdout).answerText, 'Gemini final');

    const unsupported = await runJson([
      'web-ai',
      'work',
      'send',
      '--prompt',
      'advanced',
      '--state-dir',
      config.stateDir,
      '--json',
    ]);
    assert.equal(unsupported.code, 2);
    assert.equal(JSON.parse(unsupported.stderr).errorCode, 'compatibility.unsupported');
  } finally {
    await service.close();
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

async function runJson(argv: readonly string[]) {
  const stdout = new CaptureWritable();
  const stderr = new CaptureWritable();
  const code = await runAgbrowseCli(argv, {
    stdin: Readable.from([]),
    stdout,
    stderr,
  });
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
