import { createHash, randomUUID } from 'node:crypto';
import {
  chmodSync,
  globSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';

import { SessionPlaneDomainError } from '../domain/errors.ts';

const DEFAULT_EXCLUDES = [
  '.git/**',
  'node_modules/**',
  '.state/**',
  'dist/**',
  'coverage/**',
  '.DS_Store',
];

export type ContextTransport = 'inline' | 'upload';
export type ContextTransform = 'raw' | 'repomix';

export interface ContextPackageInput {
  readonly root?: string;
  readonly includes?: readonly string[];
  readonly excludes?: readonly string[];
  readonly contextFile?: string;
  readonly prompt?: string;
  readonly transport?: ContextTransport;
  readonly transform?: ContextTransform;
  readonly maxInputTokens?: number;
  readonly maxFileBytes?: number;
  readonly maxTotalBytes?: number;
}

export interface ContextPackageFile {
  readonly path: string;
  readonly sizeBytes: number;
  readonly sha256: string;
  readonly content: string;
}

export interface ContextPackageOmission {
  readonly path: string;
  readonly reason: 'binary' | 'file-too-large' | 'total-size-limit';
  readonly sizeBytes: number;
}

export interface ContextPackageResult {
  readonly requestOk: true;
  readonly schemaVersion: 'sessionplane-context-package-v1';
  readonly root: string;
  readonly selectors: readonly string[];
  readonly excludes: readonly string[];
  readonly files: readonly ContextPackageFile[];
  readonly omitted: readonly ContextPackageOmission[];
  readonly transport: ContextTransport;
  readonly transform: ContextTransform;
  readonly packageSha256: string;
  readonly packageBytes: number;
  readonly estimatedTokens: number;
  readonly maxInputTokens: number;
  readonly budgetStatus: 'ok' | 'over-budget';
  readonly composerText: string;
  readonly artifactPath: string | null;
}

export class ContextPackageService {
  readonly #stateDir: string;

  constructor(options: { readonly stateDir: string }) {
    this.#stateDir = path.resolve(options.stateDir);
  }

  dryRun(input: ContextPackageInput = {}): ContextPackageResult {
    return this.#build(input, false);
  }

  render(input: ContextPackageInput = {}): ContextPackageResult {
    const result = this.#build(input, true);
    if (result.budgetStatus === 'over-budget') {
      throw new SessionPlaneDomainError(
        'context.over-budget',
        `Context package requires approximately ${result.estimatedTokens} tokens; limit is ${result.maxInputTokens}`,
        {
          estimatedTokens: result.estimatedTokens,
          maxInputTokens: result.maxInputTokens,
          packageSha256: result.packageSha256,
        },
      );
    }
    return result;
  }

  #build(input: ContextPackageInput, writeArtifact: boolean): ContextPackageResult {
    const root = resolveRoot(input.root);
    const selectors = collectSelectors(root, input.includes, input.contextFile);
    const excludes = normalizePatterns(input.excludes ?? [], 'exclude');
    const maxFileBytes = positive(input.maxFileBytes, 2 * 1024 * 1024, 'maxFileBytes');
    const maxTotalBytes = positive(input.maxTotalBytes, 20 * 1024 * 1024, 'maxTotalBytes');
    const maxInputTokens = positive(input.maxInputTokens, 120_000, 'maxInputTokens');
    const transport = input.transport ?? 'upload';
    const transform = input.transform ?? 'raw';
    const prompt = normalizeNewlines(input.prompt ?? '').trim();
    const matched = globSync(selectors, {
      cwd: root,
      exclude: [...DEFAULT_EXCLUDES, ...excludes],
    })
      .map(normalizeRelativePath)
      .filter((value, index, all) => value !== '' && all.indexOf(value) === index)
      .sort((left, right) => left.localeCompare(right, 'en'));

    const files: ContextPackageFile[] = [];
    const omitted: ContextPackageOmission[] = [];
    let totalBytes = 0;
    for (const relativePath of matched) {
      const absolutePath = resolveInside(root, relativePath);
      assertNoSymlink(root, absolutePath);
      const stat = lstatSync(absolutePath);
      if (!stat.isFile()) continue;
      if (stat.size > maxFileBytes) {
        omitted.push({ path: relativePath, reason: 'file-too-large', sizeBytes: stat.size });
        continue;
      }
      if (totalBytes + stat.size > maxTotalBytes) {
        omitted.push({ path: relativePath, reason: 'total-size-limit', sizeBytes: stat.size });
        continue;
      }
      const bytes = readFileSync(absolutePath);
      if (isBinary(bytes)) {
        omitted.push({ path: relativePath, reason: 'binary', sizeBytes: bytes.length });
        continue;
      }
      const content = normalizeNewlines(bytes.toString('utf8'));
      files.push({
        path: relativePath,
        sizeBytes: bytes.length,
        sha256: createHash('sha256').update(bytes).digest('hex'),
        content,
      });
      totalBytes += bytes.length;
    }

    const rendered = transform === 'repomix' ? renderRepomix(files) : renderRaw(files);
    const composerText = prompt.length === 0
      ? rendered
      : rendered.length === 0
        ? prompt
        : `${prompt}\n\n${rendered}`;
    const packageBytes = Buffer.byteLength(rendered, 'utf8');
    const packageSha256 = createHash('sha256').update(rendered, 'utf8').digest('hex');
    const estimatedTokens = estimateTokens(composerText);
    const budgetStatus = estimatedTokens <= maxInputTokens ? 'ok' : 'over-budget';
    const artifactPath =
      writeArtifact && transport === 'upload'
        ? this.#writePackage(packageSha256, rendered, transform)
        : null;

    return Object.freeze({
      requestOk: true,
      schemaVersion: 'sessionplane-context-package-v1',
      root,
      selectors: Object.freeze([...selectors]),
      excludes: Object.freeze([...DEFAULT_EXCLUDES, ...excludes]),
      files: Object.freeze(files.map((file) => Object.freeze(file))),
      omitted: Object.freeze(omitted.map((entry) => Object.freeze(entry))),
      transport,
      transform,
      packageSha256,
      packageBytes,
      estimatedTokens,
      maxInputTokens,
      budgetStatus,
      composerText: transport === 'inline' ? composerText : prompt,
      artifactPath,
    });
  }

  #writePackage(sha256: string, content: string, transform: ContextTransform): string {
    const extension = transform === 'repomix' ? '.xml' : '.md';
    const directory = path.join(this.#stateDir, 'context-packages', 'sha256', sha256.slice(0, 2));
    const destination = path.join(directory, `${sha256}${extension}`);
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    chmodSync(directory, 0o700);
    try {
      const existing = readFileSync(destination, 'utf8');
      if (createHash('sha256').update(existing, 'utf8').digest('hex') !== sha256) {
        throw new SessionPlaneDomainError(
          'internal.invariant-violation',
          `Context package content-address collision: ${sha256}`,
        );
      }
      return destination;
    } catch (error) {
      if (isErrno(error, 'ENOENT')) {
        const temporaryPath = `${destination}.${randomUUID()}.part`;
        try {
          writeFileSync(temporaryPath, content, { flag: 'wx', mode: 0o600 });
          renameSync(temporaryPath, destination);
          chmodSync(destination, 0o600);
          return destination;
        } finally {
          rmSync(temporaryPath, { force: true });
        }
      }
      throw error;
    }
  }
}

function resolveRoot(value: string | undefined): string {
  const root = path.resolve(value ?? process.cwd());
  let real: string;
  try {
    real = realpathSync(root);
  } catch (error) {
    throw new SessionPlaneDomainError('input.invalid', `Context root is unavailable: ${root}`, error);
  }
  if (!lstatSync(real).isDirectory()) {
    throw new SessionPlaneDomainError('input.invalid', `Context root is not a directory: ${real}`);
  }
  return real;
}

function collectSelectors(
  root: string,
  includes: readonly string[] | undefined,
  contextFile: string | undefined,
): readonly string[] {
  const selectors = [...(includes ?? [])];
  if (contextFile !== undefined) {
    const listPath = resolveInside(root, normalizeSelector(contextFile, 'contextFile'));
    assertNoSymlink(root, listPath);
    if (!lstatSync(listPath).isFile()) {
      throw new SessionPlaneDomainError('input.invalid', `Context file list is not a file: ${contextFile}`);
    }
    for (const line of normalizeNewlines(readFileSync(listPath, 'utf8')).split('\n')) {
      const value = line.trim();
      if (value !== '' && !value.startsWith('#')) selectors.push(value);
    }
  }
  return normalizePatterns(selectors.length === 0 ? ['**/*'] : selectors, 'include');
}

function normalizePatterns(values: readonly string[], kind: string): readonly string[] {
  const normalized = values
    .map((value) => normalizeSelector(value, kind))
    .filter((value, index, all) => all.indexOf(value) === index);
  return Object.freeze(normalized);
}

function normalizeSelector(value: string, name: string): string {
  const normalized = value.trim().replaceAll('\\', '/').replace(/^\.\//, '');
  if (
    normalized === '' ||
    path.posix.isAbsolute(normalized) ||
    normalized.split('/').includes('..') ||
    normalized.includes('\u0000')
  ) {
    throw new SessionPlaneDomainError('input.invalid', `Unsafe context ${name}: ${value}`);
  }
  return normalized;
}

function normalizeRelativePath(value: string): string {
  return value.replaceAll('\\', '/').replace(/^\.\//, '');
}

function resolveInside(root: string, relativePath: string): string {
  const resolved = path.resolve(root, relativePath);
  if (resolved !== root && !resolved.startsWith(`${root}${path.sep}`)) {
    throw new SessionPlaneDomainError('input.invalid', `Context path escaped root: ${relativePath}`);
  }
  return resolved;
}

function assertNoSymlink(root: string, absolutePath: string): void {
  let current = absolutePath;
  while (current !== root) {
    const stat = lstatSync(current);
    if (stat.isSymbolicLink()) {
      throw new SessionPlaneDomainError(
        'context.symlink-rejected',
        `Context package rejects symlinks: ${path.relative(root, current)}`,
      );
    }
    current = path.dirname(current);
    if (current.length < root.length) break;
  }
}

function isBinary(bytes: Buffer): boolean {
  const sample = bytes.subarray(0, Math.min(bytes.length, 8_192));
  if (sample.includes(0)) return true;
  let control = 0;
  for (const byte of sample) {
    if (byte < 9 || (byte > 13 && byte < 32)) control += 1;
  }
  return sample.length > 0 && control / sample.length > 0.1;
}

function renderRaw(files: readonly ContextPackageFile[]): string {
  if (files.length === 0) return '';
  const sections = files.map(
    (file) =>
      `## File: ${file.path}\n\n\`\`\`text\n${file.content.replace(/\n*$/, '\n')}\`\`\``,
  );
  return `# SessionPlane Context Package\n\n${sections.join('\n\n')}\n`;
}

function renderRepomix(files: readonly ContextPackageFile[]): string {
  const body = files
    .map(
      (file) =>
        `  <file path="${escapeXml(file.path)}" sha256="${file.sha256}"><![CDATA[${file.content.replaceAll(']]>', ']]]]><![CDATA[>')}]]></file>`,
    )
    .join('\n');
  return `<repository schema="sessionplane-context-package-v1">\n${body}\n</repository>\n`;
}

function escapeXml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('"', '&quot;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');
}

function normalizeNewlines(value: string): string {
  return value.replaceAll('\r\n', '\n').replaceAll('\r', '\n');
}

function estimateTokens(value: string): number {
  return Math.ceil(value.length / 4);
}

function positive(value: number | undefined, fallback: number, name: string): number {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved <= 0) {
    throw new SessionPlaneDomainError('input.invalid', `${name} must be a positive integer`);
  }
  return resolved;
}

function isErrno(error: unknown, code: string): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error && (error as NodeJS.ErrnoException).code === code;
}

