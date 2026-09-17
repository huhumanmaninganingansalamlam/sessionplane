import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Readable, Writable } from 'node:stream';
import test from 'node:test';

import { PageRegistry } from '../../src/browser/page-registry.ts';
import { runCli } from '../../src/cli/main.ts';
import { resolveConfig } from '../../src/config.ts';
import {
  ProjectSourceService,
  validateProjectUrl,
} from '../../src/core/project-source-service.ts';
import { SessionPlaneDomainError } from '../../src/domain/errors.ts';
import { startCore } from '../../src/main.ts';

test('ChatGPT project URL validation is exact and dry-run hashes local files without a browser', async () => {
  assert.equal(
    validateProjectUrl('https://chatgpt.com/g/project_ABC-123'),
    'https://chatgpt.com/g/project_ABC-123',
  );
  assert.equal(
    validateProjectUrl('https://chatgpt.com/g/project_ABC-123?tab=sources#upload'),
    'https://chatgpt.com/g/project_ABC-123',
  );
  assert.throws(
    () => validateProjectUrl('https://chatgpt.com/c/conversation-123'),
    (error: unknown) =>
      error instanceof SessionPlaneDomainError && error.errorCode === 'input.invalid',
  );
  assert.throws(
    () => validateProjectUrl('https://example.com/g/project_ABC-123'),
    (error: unknown) =>
      error instanceof SessionPlaneDomainError && error.errorCode === 'input.invalid',
  );
  assert.throws(
    () => validateProjectUrl('https://user:secret@chatgpt.com/g/project_ABC-123'),
    (error: unknown) =>
      error instanceof SessionPlaneDomainError && error.errorCode === 'input.invalid',
  );

  const root = mkdtempSync(path.join(tmpdir(), 'sessionplane-project-source-'));
  try {
    const filePath = path.join(root, 'source.md');
    writeFileSync(filePath, '# Source\n', 'utf8');
    const service = new ProjectSourceService({
      browserOwner: null,
      pageRegistry: new PageRegistry(),
      maxUploadFileBytes: 1024,
    });
    const result = await service.add({
      projectUrl: 'https://chatgpt.com/g/project_ABC-123',
      files: [filePath],
      dryRun: true,
    });
    assert.equal(result.requestOk, true);
    assert.equal(result.dryRun, true);
    const uploads = result.uploads as readonly Array<{
      readonly name: string;
      readonly sha256: string;
      readonly uploaded: boolean;
    }>;
    assert.equal(uploads[0]?.name, 'source.md');
    assert.match(uploads[0]?.sha256 ?? '', /^[a-f0-9]{64}$/);
    assert.equal(uploads[0]?.uploaded, false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('canonical CLI accepts a flag-only project source dry-run', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'sessionplane-project-source-cli-'));
  const config = resolveConfig({ cwd: root, env: {}, stateDir: '.state' });
  const sourcePath = path.join(root, 'source.md');
  writeFileSync(sourcePath, '# Source\n', 'utf8');
  const core = await startCore({
    config,
    startBrowser: false,
    logger: silentLogger(),
  });
  try {
    const stdout = new CaptureWritable();
    const stderr = new CaptureWritable();
    const code = await runCli(
      [
        'chatgpt',
        'project-sources',
        'add',
        '--project-url',
        'https://chatgpt.com/g/project_ABC-123',
        '--file',
        sourcePath,
        '--dry-run',
        '--state-dir',
        config.stateDir,
        '--json',
      ],
      { stdin: Readable.from([]), stdout, stderr },
    );
    assert.equal(code, 0, stderr.value);
    const result = JSON.parse(stdout.value) as {
      readonly dryRun: boolean;
      readonly uploads: readonly Array<{ readonly uploaded: boolean }>;
    };
    assert.equal(result.dryRun, true);
    assert.equal(result.uploads[0]?.uploaded, false);
  } finally {
    await core.close();
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

function silentLogger() {
  return {
    debug() {},
    info() {},
    warn() {},
    error() {},
  };
}
