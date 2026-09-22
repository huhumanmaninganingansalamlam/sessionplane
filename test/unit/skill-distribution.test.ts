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

test('skill distribution retires generic browser routing and protects provider skills', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'sessionplane-skills-'));
  const skillsDir = path.join(root, 'bundled');
  const target = path.join(root, 'installed');
  try {
    writeSkill(skillsDir, 'browser', 'Browser skill');
    writeSkill(skillsDir, 'vision-click', 'Vision click skill');
    writeSkill(skillsDir, 'web-ai', 'Web AI skill');
    const service = new SkillDistributionService({ skillsDir });
    assert.deepEqual(service.list().map((skill) => skill.name), ['web-ai']);
    for (const retired of ['browser', 'vision-click']) {
      assert.throws(
        () => service.get(retired),
        (error: unknown) =>
          error instanceof SessionPlaneDomainError && error.errorCode === 'input.skill-not-found',
      );
    }
    assert.doesNotMatch(String(service.get('core', true).content), /skill:(?:browser|vision-click)/);
    assert.match(String(service.get('core', true).content), /skill:web-ai/);

    for (const retired of ['browser', 'vision-click']) {
      assert.throws(
        () => service.install({ target, names: [retired] }),
        (error: unknown) =>
          error instanceof SessionPlaneDomainError && error.errorCode === 'input.skill-not-found',
      );
      assert.equal(existsSync(path.join(target, retired)), false);
    }

    const copied = service.install({ target, names: ['web-ai'] });
    assert.equal(copied.linked, false);
    assert.equal(readFileSync(path.join(target, 'web-ai', 'SKILL.md'), 'utf8').includes('Web AI skill'), true);
    assert.throws(
      () => service.install({ target, names: ['web-ai'] }),
      (error: unknown) =>
        error instanceof SessionPlaneDomainError && error.errorCode === 'input.output-exists',
    );

    writeFileSync(path.join(target, 'web-ai', 'stale.txt'), 'stale');
    service.install({ target, names: ['web-ai'], force: true });
    assert.equal(existsSync(path.join(target, 'web-ai', 'stale.txt')), false);

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

