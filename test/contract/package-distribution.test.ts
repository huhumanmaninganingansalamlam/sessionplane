import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

test('npm distribution ships only the built SessionPlane runtime', () => {
  const packageJson = JSON.parse(readFileSync(path.resolve('package.json'), 'utf8')) as {
    readonly bin?: Readonly<Record<string, string>>;
    readonly files?: readonly string[];
    readonly scripts?: Readonly<Record<string, string>>;
  };
  assert.deepEqual(packageJson.bin, {
    sessplane: 'bin/sessplane.mjs',
  });
  assert.deepEqual(packageJson.files, [
    'bin/sessplane.mjs',
    'bin/runtime-state.mjs',
    'dist',
    'skills',
    'README.md',
  ]);
  assert.equal(packageJson.scripts?.prepack, 'npm run build');
  assert.match(packageJson.scripts?.clean ?? '', /rmSync\('dist'/);
  assert.equal(packageJson.scripts?.build, 'npm run clean && tsc -p tsconfig.json');
  assert.equal(packageJson.files?.includes('src'), false);
});
