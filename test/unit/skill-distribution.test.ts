import assert from 'node:assert/strict';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { SessionPlaneDomainError } from '../../src/domain/errors.ts';
import { SkillDistributionService } from '../../src/skills/skill-distribution.ts';

test('skill distribution lists, reads, copies, links, and protects existing skills', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'sessionplane-skills-'));
  const skillsDir = path.join(root, 'bundled');
  const target = path.join(root, 'installed');
  try {
    writeSkill(skillsDir, 'browser', 'Browser skill');
    writeSkill(skillsDir, 'web-ai', 'Web AI skill');
    const service = new SkillDistributionService({ skillsDir });
    assert.deepEqual(service.list().map((skill) => skill.name), ['browser', 'web-ai']);
    assert.match(String(service.get('browser').content), /Browser skill/);
    assert.match(String(service.get('core', true).content), /skill:browser/);

    const copied = service.install({ target, names: ['browser'] });
    assert.equal(copied.linked, false);
    assert.equal(readFileSync(path.join(target, 'browser', 'SKILL.md'), 'utf8').includes('Browser skill'), true);
    assert.throws(
      () => service.install({ target, names: ['browser'] }),
      (error: unknown) =>
        error instanceof SessionPlaneDomainError && error.errorCode === 'input.output-exists',
    );

    writeFileSync(path.join(target, 'browser', 'stale.txt'), 'stale');
    service.install({ target, names: ['browser'], force: true });
    assert.equal(existsSync(path.join(target, 'browser', 'stale.txt')), false);

    const linkedTarget = path.join(root, 'linked');
    service.install({ target: linkedTarget, names: ['web-ai'], link: true });
    assert.equal(lstatSync(path.join(linkedTarget, 'web-ai')).isSymbolicLink(), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

function writeSkill(root: string, name: string, description: string): void {
  const directory = path.join(root, name);
  mkdirSync(directory, { recursive: true });
  writeFileSync(
    path.join(directory, 'SKILL.md'),
    `---\nname: ${name}\ndescription: ${description}\n---\n\n# ${name}\n`,
  );
}

