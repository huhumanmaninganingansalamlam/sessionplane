import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import {
  loadAgbrowseManifest,
  replacementReady,
  requiredIncomplete,
} from '../../src/compat/agbrowse-manifest.ts';

test('npm distribution ships the built runtime instead of TypeScript source', () => {
  const packageJson = JSON.parse(readFileSync(path.resolve('package.json'), 'utf8')) as {
    readonly files?: readonly string[];
    readonly scripts?: Readonly<Record<string, string>>;
  };
  assert.deepEqual(packageJson.files, [
    'bin',
    'dist',
    'compat',
    'skills',
    'README.md',
  ]);
  assert.equal(packageJson.scripts?.prepack, 'npm run build');
  assert.equal(packageJson.files?.includes('src'), false);
});

test('agbrowse compatibility manifest is source-bound and browser-complete', () => {
  const manifest = loadAgbrowseManifest();
  assert.equal(manifest.source.commit, '55150e1fe048b81121b952fe8eb965c755c0fd19');
  assert.equal(new Set(manifest.commands.map((command) => command.id)).size, manifest.commands.length);
  assert.equal(requiredIncomplete(manifest, 'browser').length, 0);
  assert.equal(
    requiredIncomplete(manifest, 'web-ai').map((command) => command.id).includes('web-ai.gemini'),
    false,
  );
  assert.equal(
    requiredIncomplete(manifest, 'web-ai').map((command) => command.id).includes('web-ai.grok'),
    false,
  );
  assert.equal(requiredIncomplete(manifest, 'fetch').length, 0);
  assert.equal(requiredIncomplete(manifest, 'search').length, 0);
  assert.equal(requiredIncomplete(manifest, 'skills').length, 0);
  assert.equal(requiredIncomplete(manifest, 'web-ai').length, 0);
  assert.equal(requiredIncomplete(manifest, 'artifact').length, 0);
  const work = manifest.commands.find((command) => command.id === 'web-ai.work');
  assert.equal(work?.required, false);
  assert.equal(work?.status, 'deferred');
  for (const [id, legacyCommand] of [
    ['browser.external-connect', 'connect'],
    ['browser.action-memory', 'action-memory'],
  ] as const) {
    const boundary = manifest.commands.find((command) => command.id === id);
    assert.equal(boundary?.required, false, id);
    assert.equal(boundary?.status, 'deferred', id);
    assert.deepEqual(boundary?.legacyCommands, [legacyCommand], id);
  }
  for (const id of ['web-ai.manual-reattach', 'web-ai.session-maintenance'] as const) {
    const boundary = manifest.commands.find((command) => command.id === id);
    assert.equal(boundary?.required, false, id);
    assert.equal(boundary?.status, 'deferred', id);
  }
  const watch = manifest.commands.find((command) => command.id === 'web-ai.watch');
  assert.equal(watch?.required, false);
  assert.equal(watch?.status, 'deferred');
  assert.deepEqual(watch?.legacyCommands, ['web-ai watch']);
  const mcpServer = manifest.commands.find((command) => command.id === 'web-ai.mcp-server');
  assert.equal(mcpServer?.required, true);
  assert.equal(mcpServer?.status, 'implemented');
  assert.deepEqual(mcpServer?.legacyCommands, ['web-ai mcp-server']);
  assert.deepEqual(mcpServer?.canonicalCommands, ['mcp']);
  const providerArtifacts = manifest.commands.find(
    (command) => command.id === 'artifact.provider-files',
  );
  assert.equal(providerArtifacts?.status, 'implemented');
  assert.deepEqual(providerArtifacts?.rpcMethods, [
    'artifact.discover',
    'artifact.capture',
    'artifact.list',
    'artifact.get',
    'artifact.export',
  ]);
  assert.equal(replacementReady(manifest), true);

  for (const command of manifest.commands) {
    if (command.status !== 'implemented') continue;
    assert.ok(command.contracts.length > 0, `${command.id} must name an executable contract`);
    for (const contract of command.contracts) {
      assert.equal(existsSync(path.resolve(contract)), true, `${command.id}: ${contract}`);
    }
  }
});

test('implemented artifact RPC rows exist in the registered core source', () => {
  const manifest = loadAgbrowseManifest();
  const source = [
    readFileSync(path.resolve('src/rpc/methods/artifact.ts'), 'utf8'),
    readFileSync(path.resolve('src/rpc/methods/code.ts'), 'utf8'),
    readFileSync(path.resolve('src/rpc/methods/context.ts'), 'utf8'),
    readFileSync(path.resolve('src/rpc/methods/send.ts'), 'utf8'),
    readFileSync(path.resolve('src/main.ts'), 'utf8'),
  ].join('\n');
  const methods = manifest.commands
    .filter((command) => command.category === 'artifact' && command.status === 'implemented')
    .flatMap((command) => command.rpcMethods);
  for (const method of new Set(methods)) {
    assert.match(source, new RegExp(`['\"]${escapeRegExp(method)}['\"]`), method);
  }
});

test('implemented fetch/search RPC rows exist in the registered core source', () => {
  const manifest = loadAgbrowseManifest();
  const source = [
    readFileSync(path.resolve('src/rpc/methods/research.ts'), 'utf8'),
    readFileSync(path.resolve('src/main.ts'), 'utf8'),
  ].join('\n');
  const methods = manifest.commands
    .filter((command) =>
      (command.category === 'fetch' || command.category === 'search') &&
      command.status === 'implemented',
    )
    .flatMap((command) => command.rpcMethods);
  for (const method of new Set(methods)) {
    assert.match(source, new RegExp(`['\"]${escapeRegExp(method)}['\"]`), method);
  }
});

test('implemented browser RPC rows exist in the registered core source', () => {
  const manifest = loadAgbrowseManifest();
  const source = [
    readFileSync(path.resolve('src/rpc/methods/browser-control.ts'), 'utf8'),
    readFileSync(path.resolve('src/main.ts'), 'utf8'),
  ].join('\n');
  const methods = manifest.commands
    .filter((command) => command.category === 'browser' && command.status === 'implemented')
    .flatMap((command) => command.rpcMethods);
  for (const method of new Set(methods)) {
    assert.match(source, new RegExp(`['\"]${escapeRegExp(method)}['\"]`), method);
  }
});

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
