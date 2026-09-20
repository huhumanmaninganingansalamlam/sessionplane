import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
} from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { SessionPlaneDomainError } from '../domain/errors.ts';

export interface SkillDescriptor {
  readonly name: string;
  readonly path: string;
  readonly description: string | null;
}

export interface SkillInstallResult {
  readonly requestOk: true;
  readonly target: string;
  readonly linked: boolean;
  readonly installed: ReadonlyArray<{
    readonly name: string;
    readonly destination: string;
  }>;
}

export class SkillDistributionService {
  readonly #skillsDir: string;

  constructor(options: { readonly skillsDir?: string } = {}) {
    this.#skillsDir = realpathSync(
      options.skillsDir ?? fileURLToPath(new URL('../../skills/', import.meta.url)),
    );
  }

  list(): readonly SkillDescriptor[] {
    return Object.freeze(
      readdirSync(this.#skillsDir, { withFileTypes: true })
        .filter((entry) => entry.isDirectory() && isSkillName(entry.name))
        .map((entry) => this.#descriptor(entry.name))
        .filter((entry): entry is SkillDescriptor => entry !== null)
        .sort((left, right) => left.name.localeCompare(right.name, 'en')),
    );
  }

  get(name: string, full = false): Readonly<Record<string, unknown>> {
    if (name === 'core') {
      const skills = this.list();
      const content = full
        ? skills
            .map((skill) => `<!-- skill:${skill.name} -->\n${readFileSync(path.join(skill.path, 'SKILL.md'), 'utf8').trim()}\n`)
            .join('\n')
        : renderCoreIndex(skills);
      return {
        requestOk: true,
        name: 'core',
        path: this.#skillsDir,
        full,
        content,
      };
    }
    const skill = this.#require(name);
    return {
      requestOk: true,
      name: skill.name,
      path: skill.path,
      full,
      content: readFileSync(path.join(skill.path, 'SKILL.md'), 'utf8'),
    };
  }

  path(name?: string): Readonly<Record<string, unknown>> {
    if (name === undefined || name === 'core') {
      return { requestOk: true, name: name ?? null, path: this.#skillsDir };
    }
    const skill = this.#require(name);
    return { requestOk: true, name: skill.name, path: skill.path };
  }

  install(input: {
    readonly target: string;
    readonly names?: readonly string[];
    readonly link?: boolean;
    readonly force?: boolean;
  }): SkillInstallResult {
    const target = path.resolve(input.target);
    if (existsSync(target) && lstatSync(target).isSymbolicLink()) {
      throw new SessionPlaneDomainError(
        'input.invalid',
        `Skill installation target cannot be a symlink: ${target}`,
      );
    }
    mkdirSync(target, { recursive: true, mode: 0o700 });
    const realTarget = realpathSync(target);
    const names = normalizeNames(input.names ?? this.list().map((skill) => skill.name));
    const installed: Array<{ readonly name: string; readonly destination: string }> = [];
    for (const name of names) {
      const source = this.#require(name).path;
      const destination = path.join(realTarget, name);
      if (!destination.startsWith(`${realTarget}${path.sep}`)) {
        throw new SessionPlaneDomainError('input.invalid', `Unsafe skill name: ${name}`);
      }
      if (existsSync(destination) || isDanglingSymlink(destination)) {
        if (input.force !== true) {
          throw new SessionPlaneDomainError(
            'input.output-exists',
            `Refusing to replace existing skill: ${destination}`,
          );
        }
        rmSync(destination, { recursive: true, force: true });
      }
      if (input.link === true) {
        symlinkSync(source, destination, 'dir');
      } else {
        cpSync(source, destination, {
          recursive: true,
          force: false,
          errorOnExist: true,
          dereference: false,
        });
      }
      installed.push({ name, destination });
    }
    return Object.freeze({
      requestOk: true,
      target: realTarget,
      linked: input.link === true,
      installed: Object.freeze(installed),
    });
  }

  #require(name: string): SkillDescriptor {
    if (!isSkillName(name)) {
      throw new SessionPlaneDomainError('input.invalid', `Invalid skill name: ${name}`);
    }
    const descriptor = this.#descriptor(name);
    if (descriptor === null) {
      throw new SessionPlaneDomainError('input.skill-not-found', `Unknown skill: ${name}`);
    }
    return descriptor;
  }

  #descriptor(name: string): SkillDescriptor | null {
    const directory = path.join(this.#skillsDir, name);
    const skillFile = path.join(directory, 'SKILL.md');
    if (!existsSync(skillFile) || !lstatSync(skillFile).isFile()) return null;
    const content = readFileSync(skillFile, 'utf8');
    return Object.freeze({
      name,
      path: directory,
      description: readFrontmatterDescription(content),
    });
  }
}

function normalizeNames(values: readonly string[]): readonly string[] {
  const names = values.map((value) => value.trim()).filter(Boolean);
  if (names.length === 0) {
    throw new SessionPlaneDomainError('input.invalid', 'At least one skill name is required');
  }
  for (const name of names) {
    if (!isSkillName(name)) {
      throw new SessionPlaneDomainError('input.invalid', `Invalid skill name: ${name}`);
    }
  }
  return Object.freeze([...new Set(names)]);
}

function isSkillName(value: string): boolean {
  return /^[a-z0-9][a-z0-9-]*$/.test(value);
}

function readFrontmatterDescription(content: string): string | null {
  if (!content.startsWith('---\n')) return null;
  const end = content.indexOf('\n---\n', 4);
  if (end < 0) return null;
  const match = /^description:\s*(.+)$/m.exec(content.slice(4, end));
  return match?.[1]?.trim().replace(/^['"]|['"]$/g, '') ?? null;
}

function renderCoreIndex(skills: readonly SkillDescriptor[]): string {
  const lines = [
    '# SessionPlane bundled skills',
    '',
    'Install or inspect these skills through `sessplane skills`.',
    '',
  ];
  for (const skill of skills) {
    lines.push(`- **${skill.name}**${skill.description === null ? '' : ` — ${skill.description}`}`);
  }
  return `${lines.join('\n')}\n`;
}

function isDanglingSymlink(value: string): boolean {
  try {
    return lstatSync(value).isSymbolicLink();
  } catch {
    return false;
  }
}

