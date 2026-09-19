import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Readable, Writable } from 'node:stream';
import test from 'node:test';

import { callRpc } from '../../src/cli/client.ts';
import { runAgbrowseCli } from '../../src/compat/agbrowse-cli.ts';
import { resolveConfig } from '../../src/config.ts';
import { startCore, type CoreService } from '../../src/main.ts';

test('fetch, extract, search, and research share bounded original-page evidence', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'sessionplane-research-'));
  const fixture = await startFixtureServer();
  const config = resolveConfig({
    cwd: root,
    env: {},
    stateDir: '.state',
    fetchAllowPrivateNetworks: true,
    fetchTimeoutMs: 2_000,
    fetchMaxBytes: 512 * 1024,
    searchMaxCandidates: 5,
  });
  const service = await startCore({
    config,
    startBrowser: false,
    logger: silentLogger(),
  });

  try {
    const fetched = await rpc<Record<string, unknown>>(config.socketPath, 'fetch.read', {
      url: `${fixture.baseUrl}/redirect`,
      includeHtml: true,
    });
    assert.equal(fetched.requestOk, true);
    assert.equal(fetched.status, 200);
    assert.equal(fetched.redirectCount, 1);
    assert.equal(fetched.finalUrl, `${fixture.baseUrl}/article`);
    const document = fetched.document as Record<string, unknown>;
    assert.equal(document.title, 'Primary Evidence');
    assert.ok(Number(document.wordCount) > 100);

    const extracted = await rpc<Record<string, unknown>>(config.socketPath, 'extract.schema', {
      url: `${fixture.baseUrl}/article`,
      schema: {
        type: 'object',
        additionalProperties: true,
        required: ['headline', 'year'],
        properties: {
          headline: { type: 'string' },
          year: { type: 'integer' },
        },
      },
      sourceMode: 'jsonld',
    });
    assert.equal(extracted.ok, true);
    assert.equal(extracted.source, 'jsonld');
    assert.deepEqual(extracted.data, {
      '@type': 'Article',
      headline: 'Primary Evidence',
      year: 2026,
    });

    const candidates = [
      { url: `${fixture.baseUrl}/article`, title: 'Primary Evidence' },
      { url: `${fixture.baseUrl}/thin`, title: 'Thin page' },
      { url: `${fixture.baseUrl}/challenge`, title: 'Blocked page' },
    ];
    const search = await rpc<Record<string, unknown>>(config.socketPath, 'search.query', {
      query: 'primary evidence 2026',
      results: candidates,
      backend: 'fixture',
      maxResults: 3,
    });
    assert.equal(search.requestOk, true);
    assert.equal(search.verifiedCount, 1);
    assert.equal(search.sufficient, false);
    const evidence = search.evidence as Array<Record<string, unknown>>;
    assert.equal(evidence[0]?.verdict, 'verified');
    assert.ok(evidence.some((entry) => entry.verdict === 'blocked'));

    const plan = await rpc<Record<string, unknown>>(config.socketPath, 'research.plan', {
      query: 'primary evidence 2026 official source',
      maxQueries: 4,
    });
    assert.equal(plan.schemaVersion, 'sessionplane-research-plan-v1');

    const normalized = await rpc<Record<string, unknown>>(config.socketPath, 'research.normalize', {
      query: 'primary evidence 2026',
      results: candidates,
      backend: 'fixture',
    });
    assert.equal(normalized.schemaVersion, 'sessionplane-search-results-v1');
    assert.equal((normalized.candidates as unknown[]).length, 3);

    const enrichment = await rpc<Record<string, unknown>>(config.socketPath, 'research.enrich', {
      plan,
      results: normalized,
      maxResults: 3,
    });
    assert.equal(enrichment.schemaVersion, 'sessionplane-research-fetch-enrichment-v1');
    assert.equal(enrichment.verifiedCount, 1);

    const browsePlan = await rpc<Record<string, unknown>>(config.socketPath, 'research.browsePlan', {
      plan,
      enrichment,
      maxActions: 5,
    });
    assert.equal(browsePlan.schemaVersion, 'sessionplane-research-browse-plan-v1');
    assert.ok((browsePlan.actions as unknown[]).length >= 1);

    const compatibleFetch = await captureAgbrowse([
      'fetch',
      `${fixture.baseUrl}/article`,
      '--socket',
      config.socketPath,
      '--json',
    ]);
    assert.equal(compatibleFetch.code, 0);
    assert.equal(JSON.parse(compatibleFetch.stdout).schemaVersion, 'sessionplane-adaptive-fetch-v1');

    for (const args of [
      ['--selector', 'article'],
      ['--browser', 'never'],
      ['--trace'],
    ] as const) {
      const deferredFetch = await captureAgbrowse([
        'fetch',
        `${fixture.baseUrl}/article`,
        ...args,
        '--socket',
        config.socketPath,
        '--json',
      ]);
      assert.equal(deferredFetch.code, 2, deferredFetch.stderr);
      const error = JSON.parse(deferredFetch.stderr) as {
        readonly errorCode: string;
        readonly details: { readonly capabilityId: string; readonly status: string };
      };
      assert.equal(error.errorCode, 'compatibility.unsupported');
      assert.equal(error.details.capabilityId, 'fetch.experimental-escalation');
      assert.equal(error.details.status, 'deferred');
    }

    const compatiblePlan = await captureAgbrowse([
      'research',
      'plan',
      '--query',
      'primary evidence 2026',
      '--socket',
      config.socketPath,
      '--json',
    ]);
    assert.equal(compatiblePlan.code, 0);
    assert.equal(JSON.parse(compatiblePlan.stdout).schemaVersion, 'sessionplane-research-plan-v1');
  } finally {
    await service.close();
    await fixture.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('fetch blocks local/private addresses unless explicitly enabled by core config', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'sessionplane-fetch-private-'));
  const fixture = await startFixtureServer();
  const config = resolveConfig({ cwd: root, env: {}, stateDir: '.state' });
  const service = await startCore({ config, startBrowser: false, logger: silentLogger() });
  try {
    await assert.rejects(
      rpc(config.socketPath, 'fetch.read', { url: `${fixture.baseUrl}/article` }),
      (error: unknown) =>
        error instanceof Error && error.message.includes('blocked address'),
    );
  } finally {
    await service.close();
    await fixture.close();
    rmSync(root, { recursive: true, force: true });
  }
});

async function startFixtureServer(): Promise<{
  readonly server: Server;
  readonly baseUrl: string;
  close(): Promise<void>;
}> {
  const body = 'Primary evidence explains the exact 2026 source. '.repeat(80);
  const server = createServer((request, response) => {
    switch (request.url) {
      case '/redirect':
        response.writeHead(302, { Location: '/article' });
        response.end();
        return;
      case '/article':
        response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        response.end(`<!doctype html><html><head>
          <meta property="og:title" content="Primary Evidence">
          <meta name="description" content="Original fixture source">
          <script type="application/ld+json">{"@type":"Article","headline":"Primary Evidence","year":2026}</script>
          </head><body><article><h1>Primary Evidence</h1><p>${body}</p></article></body></html>`);
        return;
      case '/thin':
        response.writeHead(200, { 'Content-Type': 'text/html' });
        response.end('<html><body><p>tiny</p></body></html>');
        return;
      case '/challenge':
        response.writeHead(403, { 'Content-Type': 'text/html', Server: 'cloudflare' });
        response.end('<html><body>Verify you are human</body></html>');
        return;
      default:
        response.writeHead(404, { 'Content-Type': 'text/plain' });
        response.end('not found');
    }
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('Fixture server has no port');
  return {
    server,
    baseUrl: `http://127.0.0.1:${address.port}`,
    async close(): Promise<void> {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => error === undefined ? resolve() : reject(error)),
      );
    },
  };
}

async function rpc<Result = Readonly<Record<string, unknown>>>(
  socketPath: string,
  method: string,
  params: unknown,
): Promise<Result> {
  return await callRpc<Result>({ socketPath, method, params, timeoutMs: 10_000 });
}

function silentLogger() {
  return { debug() {}, info() {}, warn() {}, error() {} };
}

async function captureAgbrowse(argv: readonly string[]): Promise<{
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}> {
  const stdout = new CaptureWritable();
  const stderr = new CaptureWritable();
  const code = await runAgbrowseCli(argv, {
    stdin: Readable.from([]),
    stdout,
    stderr,
  });
  return { code, stdout: stdout.value.trim(), stderr: stderr.value.trim() };
}

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
