import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Readable, Writable } from 'node:stream';
import test from 'node:test';

import { runCli } from '../../src/cli/main.ts';

test('bundled skills are served and installed by the SessionPlane CLI', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'sessionplane-skills-'));
  try {
    const listed = await runSessplane(['skills', 'list', '--json']);
    assert.equal(listed.code, 0, listed.stderr);
    const names = (JSON.parse(listed.stdout) as {
      readonly skills: readonly Array<{ readonly name: string }>;
    }).skills.map((skill) => skill.name);
    for (const name of ['sessionplane', 'web-ai']) {
      assert.equal(names.includes(name), true, name);
    }
    assert.equal(names.includes('browser'), false);
    assert.equal(names.includes('vision-click'), false);

    const core = await runSessplane(['skills', 'get', 'core', '--full', '--json']);
    assert.equal(core.code, 0, core.stderr);
    assert.doesNotMatch(
      (JSON.parse(core.stdout) as { readonly content: string }).content,
      /skill:(?:browser|vision-click)/,
    );

    const target = path.join(root, 'skills');
    const installed = await runSessplane([
      'skills',
      'install',
      '--target',
      target,
      '--skill',
      'web-ai',
      '--skill',
      'sessionplane',
      '--json',
    ]);
    assert.equal(installed.code, 0, installed.stderr);
    assert.equal(existsSync(path.join(target, 'browser', 'SKILL.md')), false);
    assert.equal(existsSync(path.join(target, 'vision-click', 'SKILL.md')), false);
    assert.equal(existsSync(path.join(target, 'web-ai', 'SKILL.md')), true);
    assert.equal(existsSync(path.join(target, 'sessionplane', 'SKILL.md')), true);
    const webAiSkill = readFileSync(path.join(target, 'web-ai', 'SKILL.md'), 'utf8');
    const coreSkill = readFileSync(path.join(target, 'sessionplane', 'SKILL.md'), 'utf8');
    const sessionplane = await runSessplane(['skills', 'get', 'sessionplane', '--full', '--json']);
    assert.equal(sessionplane.code, 0, sessionplane.stderr);
    assert.equal(coreSkill, (JSON.parse(sessionplane.stdout) as { content: string }).content);
    const webAi = await runSessplane(['skills', 'get', 'web-ai', '--full', '--json']);
    assert.equal(webAi.code, 0, webAi.stderr);
    assert.equal(webAiSkill, (JSON.parse(webAi.stdout) as { content: string }).content);

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
    assert.match(protectedRun.stderr, /input\.skill-not-found|Unknown skill: browser/);
    assert.equal(existsSync(path.join(target, 'browser')), false);
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
