import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import {
  loadAgbrowseManifest,
  replacementReady,
  requiredIncomplete,
} from '../../src/compat/agbrowse-manifest.ts';

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
  assert.equal(replacementReady(manifest), false);

  for (const command of manifest.commands) {
    if (command.status !== 'implemented') continue;
    assert.ok(command.contracts.length > 0, `${command.id} must name an executable contract`);
    for (const contract of command.contracts) {
      assert.equal(existsSync(path.resolve(contract)), true, `${command.id}: ${contract}`);
    }
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
