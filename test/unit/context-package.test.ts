import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { ContextPackageService } from '../../src/context/context-package.ts';
import { SessionPlaneDomainError } from '../../src/domain/errors.ts';

test('context package selection is deterministic, bounded, and content-addressed', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'sessionplane-context-'));
  const stateDir = path.join(root, '.runtime');
  try {
    mkdirSync(path.join(root, 'src'), { recursive: true });
    mkdirSync(path.join(root, 'node_modules', 'ignored'), { recursive: true });
    writeFileSync(path.join(root, 'src', 'b.ts'), 'export const b = 2;\r\n');
    writeFileSync(path.join(root, 'src', 'a.ts'), 'export const a = 1;\n');
    writeFileSync(path.join(root, 'src', 'binary.bin'), Buffer.from([0, 1, 2, 3]));
    writeFileSync(path.join(root, 'src', 'large.txt'), 'x'.repeat(128));
    writeFileSync(path.join(root, 'node_modules', 'ignored', 'index.js'), 'ignore');
    writeFileSync(path.join(root, 'context-files.txt'), 'src/*.ts\nsrc/*.bin\nsrc/*.txt\n');

    const service = new ContextPackageService({ stateDir });
    const dry = service.dryRun({
      root,
      contextFile: 'context-files.txt',
      prompt: 'Review the selected files.',
      transport: 'upload',
      maxFileBytes: 64,
      maxTotalBytes: 1_024,
      maxInputTokens: 10_000,
    });
    assert.deepEqual(dry.files.map((file) => file.path), ['src/a.ts', 'src/b.ts']);
    assert.deepEqual(
      dry.omitted.map((entry) => [entry.path, entry.reason]),
      [
        ['src/binary.bin', 'binary'],
        ['src/large.txt', 'file-too-large'],
      ],
    );
    assert.equal(dry.artifactPath, null);
    assert.equal(dry.budgetStatus, 'ok');
    assert.equal(dry.files[1]?.content.includes('\r'), false);

    const rendered = service.render({
      root,
      includes: ['src/*.ts'],
      prompt: 'Review the selected files.',
      transport: 'upload',
      maxInputTokens: 10_000,
    });
    assert.notEqual(rendered.artifactPath, null);
    assert.equal(rendered.packageSha256, createHash('sha256').update(
      readFileSync(rendered.artifactPath as string),
    ).digest('hex'));
    assert.equal(statSync(rendered.artifactPath as string).mode & 0o777, 0o600);
    const repeated = service.render({
      root,
      includes: ['src/*.ts'],
      prompt: 'Review the selected files.',
      transport: 'upload',
      maxInputTokens: 10_000,
    });
    assert.equal(repeated.packageSha256, rendered.packageSha256);
    assert.equal(repeated.artifactPath, rendered.artifactPath);

    const inline = service.render({
      root,
      includes: ['src/a.ts'],
      prompt: 'Review.',
      transport: 'inline',
      transform: 'repomix',
      maxInputTokens: 10_000,
    });
    assert.equal(inline.artifactPath, null);
    assert.match(inline.composerText, /^Review\.\n\n<repository/);
    assert.match(inline.composerText, /src\/a\.ts/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('context package rejects symlinks and render fails closed over budget', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'sessionplane-context-safety-'));
  const outside = mkdtempSync(path.join(tmpdir(), 'sessionplane-context-outside-'));
  try {
    writeFileSync(path.join(outside, 'secret.txt'), 'secret');
    symlinkSync(path.join(outside, 'secret.txt'), path.join(root, 'linked.txt'));
    const service = new ContextPackageService({ stateDir: path.join(root, '.state') });
    assert.throws(
      () => service.dryRun({ root, includes: ['linked.txt'] }),
      (error: unknown) =>
        error instanceof SessionPlaneDomainError &&
        error.errorCode === 'context.symlink-rejected',
    );

    rmSync(path.join(root, 'linked.txt'));
    writeFileSync(path.join(root, 'large.txt'), 'token '.repeat(1_000));
    const dry = service.dryRun({
      root,
      includes: ['large.txt'],
      transport: 'inline',
      maxInputTokens: 10,
    });
    assert.equal(dry.budgetStatus, 'over-budget');
    assert.throws(
      () =>
        service.render({
          root,
          includes: ['large.txt'],
          transport: 'inline',
          maxInputTokens: 10,
        }),
      (error: unknown) =>
        error instanceof SessionPlaneDomainError && error.errorCode === 'context.over-budget',
    );
    assert.equal(existsSync(path.join(root, '.state', 'context-packages')), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

