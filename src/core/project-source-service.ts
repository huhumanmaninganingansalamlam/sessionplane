import { createHash } from 'node:crypto';

import type { Locator, Page } from 'playwright-core';

import type { BrowserOwner } from '../browser/browser-owner.ts';
import type { PageRegistry } from '../browser/page-registry.ts';
import { SessionPlaneDomainError } from '../domain/errors.ts';
import type { ProviderProjectSource } from '../providers/provider-adapter.ts';
import { CHATGPT_SELECTORS } from '../providers/chatgpt/selectors.ts';
import { resolveProviderAttachments } from './submission-service.ts';

export class ProjectSourceService {
  readonly #browserOwner: BrowserOwner | null;
  readonly #pageRegistry: PageRegistry;
  readonly #maxUploadFileBytes: number;
  readonly #mutationTails = new Map<string, Promise<void>>();

  constructor(options: {
    readonly browserOwner: BrowserOwner | null;
    readonly pageRegistry: PageRegistry;
    readonly maxUploadFileBytes: number;
  }) {
    this.#browserOwner = options.browserOwner;
    this.#pageRegistry = options.pageRegistry;
    this.#maxUploadFileBytes = options.maxUploadFileBytes;
  }

  async list(projectUrl: string): Promise<Readonly<Record<string, unknown>>> {
    const url = validateProjectUrl(projectUrl);
    return await this.#withProjectPage(url, async (page) => {
      const sources = await readProjectSources(page);
      return {
        requestOk: true,
        projectUrl: url,
        sources,
        warnings: sources.length === 0 ? ['project-sources-empty-or-unrecognized-dom'] : [],
      };
    });
  }

  async add(input: {
    readonly projectUrl: string;
    readonly files: readonly string[];
    readonly dryRun?: boolean;
  }): Promise<Readonly<Record<string, unknown>>> {
    const url = validateProjectUrl(input.projectUrl);
    const attachments = await resolveProviderAttachments(
      input.files,
      this.#maxUploadFileBytes,
    );
    if (attachments.length === 0) {
      throw new SessionPlaneDomainError(
        'input.invalid',
        'At least one project source file is required',
      );
    }
    if (input.dryRun === true) {
      return {
        requestOk: true,
        projectUrl: url,
        dryRun: true,
        uploads: attachments.map((attachment) => ({
          name: attachment.name,
          sizeBytes: attachment.sizeBytes,
          sha256: attachment.sha256,
          uploaded: false,
        })),
        alreadyPresent: [],
        warnings: ['dry-run-no-upload'],
      };
    }

    return await this.#runMutationExclusive(url, async () =>
      await this.#withProjectPage(url, async (page) => {
        const before = await readProjectSources(page);
        const existingNames = new Set(before.map((source) => source.name));
        const pending = attachments.filter((attachment) => !existingNames.has(attachment.name));
        if (pending.length > 0) {
          await uploadProjectSources(page, pending.map((attachment) => attachment.path));
          await waitForNames(page, pending.map((attachment) => attachment.name));
        }
        const sources = await readProjectSources(page);
        const sourceNames = new Set(sources.map((source) => source.name));
        const missing = pending.filter((attachment) => !sourceNames.has(attachment.name));
        if (missing.length > 0) {
          const body = await page.locator('body').innerText().catch(() => '');
          if (!missing.every((attachment) => body.includes(attachment.name))) {
            throw new SessionPlaneDomainError(
              'provider.attachment-evidence-missing',
              `ChatGPT Project did not acknowledge: ${missing.map((item) => item.name).join(', ')}`,
            );
          }
        }
        return {
          requestOk: true,
          projectUrl: url,
          dryRun: false,
          uploads: pending.map((attachment) => ({
            name: attachment.name,
            sizeBytes: attachment.sizeBytes,
            sha256: attachment.sha256,
            uploaded: true,
          })),
          alreadyPresent: attachments
            .filter((attachment) => existingNames.has(attachment.name))
            .map((attachment) => attachment.name),
          sources,
          warnings: [],
        };
      }),
    );
  }

  async #withProjectPage<Result>(
    projectUrl: string,
    operation: (page: Page) => Promise<Result>,
  ): Promise<Result> {
    if (this.#browserOwner === null) {
      throw new SessionPlaneDomainError(
        'browser.unavailable',
        'Browser owner is required for ChatGPT Project Sources',
      );
    }
    const created = await this.#browserOwner.createPage();
    try {
      await created.page.goto(projectUrl, { waitUntil: 'domcontentloaded', timeout: 30_000 });
      const binding = this.#pageRegistry.refreshPage(created.binding.pageKey);
      if (binding.url !== projectUrl && !binding.url.startsWith(`${projectUrl}/`)) {
        throw new SessionPlaneDomainError(
          'session.page-identity-unverified',
          `ChatGPT Project navigation changed identity: ${binding.url}`,
        );
      }
      return await operation(created.page);
    } finally {
      await created.page.close().catch(() => undefined);
    }
  }

  async #runMutationExclusive<Result>(
    key: string,
    operation: () => Promise<Result>,
  ): Promise<Result> {
    const previous = this.#mutationTails.get(key) ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = previous.then(() => gate);
    this.#mutationTails.set(key, tail);
    await previous;
    try {
      return await operation();
    } finally {
      release();
      if (this.#mutationTails.get(key) === tail) this.#mutationTails.delete(key);
    }
  }
}

export function validateProjectUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch (error) {
    throw new SessionPlaneDomainError('input.invalid', 'Invalid ChatGPT project URL', error);
  }
  if (
    url.protocol !== 'https:' ||
    url.hostname.toLowerCase() !== 'chatgpt.com' ||
    url.port !== '' ||
    url.username !== '' ||
    url.password !== '' ||
    !/^\/g\/[A-Za-z0-9_-]+(?:\/.*)?$/.test(url.pathname)
  ) {
    throw new SessionPlaneDomainError(
      'input.invalid',
      `Not a ChatGPT Project URL: ${value}`,
    );
  }
  url.search = '';
  url.hash = '';
  return url.href.replace(/\/$/, '');
}

async function readProjectSources(page: Page): Promise<readonly ProviderProjectSource[]> {
  const rows: ProviderProjectSource[] = [];
  const seen = new Set<string>();
  for (const selector of CHATGPT_SELECTORS.projectSourceRows) {
    const candidates = page.locator(selector);
    const count = await candidates.count().catch(() => 0);
    for (let index = 0; index < count; index += 1) {
      const candidate = candidates.nth(index);
      if (!(await candidate.isVisible().catch(() => false))) continue;
      const name = ((await candidate.textContent().catch(() => null)) ?? '').trim();
      if (name === '' || seen.has(name)) continue;
      seen.add(name);
      const providerSourceId =
        (await candidate.getAttribute('data-project-file-id').catch(() => null)) ??
        (await candidate.getAttribute('data-source-id').catch(() => null)) ??
        createHash('sha256').update(name).digest('hex').slice(0, 32);
      rows.push(Object.freeze({ providerSourceId, name, mediaType: null }));
    }
    if (rows.length > 0) break;
  }
  return Object.freeze(rows);
}

async function uploadProjectSources(page: Page, paths: readonly string[]): Promise<void> {
  let input = await firstExisting(page, CHATGPT_SELECTORS.projectSourceInputs);
  if (input === null) {
    const trigger = await firstVisible(page, CHATGPT_SELECTORS.projectSourceTriggers);
    if (trigger === null) {
      throw new SessionPlaneDomainError(
        'provider.attachment-surface-unavailable',
        'ChatGPT Project add-source control is unavailable',
      );
    }
    const chooserPromise = page.waitForEvent('filechooser', { timeout: 5_000 }).catch(() => null);
    await trigger.click({ timeout: 5_000 });
    const chooser = await chooserPromise;
    if (chooser !== null) {
      await chooser.setFiles([...paths]);
      return;
    }
    input = await firstExisting(page, CHATGPT_SELECTORS.projectSourceInputs);
  }
  if (input === null) {
    throw new SessionPlaneDomainError(
      'provider.attachment-surface-unavailable',
      'ChatGPT Project file input is unavailable',
    );
  }
  await input.setInputFiles([...paths]);
}

async function waitForNames(page: Page, names: readonly string[]): Promise<void> {
  const deadline = Date.now() + 30_000;
  do {
    const body = await page.locator('body').innerText().catch(() => '');
    if (names.every((name) => body.includes(name))) return;
    await page.waitForTimeout(100);
  } while (Date.now() < deadline);
}

async function firstExisting(page: Page, selectors: readonly string[]): Promise<Locator | null> {
  for (const selector of selectors) {
    const candidate = page.locator(selector).first();
    if ((await candidate.count().catch(() => 0)) > 0) return candidate;
  }
  return null;
}

async function firstVisible(page: Page, selectors: readonly string[]): Promise<Locator | null> {
  for (const selector of selectors) {
    const candidates = page.locator(selector);
    const count = await candidates.count().catch(() => 0);
    for (let index = 0; index < count; index += 1) {
      const candidate = candidates.nth(index);
      if (await candidate.isVisible().catch(() => false)) return candidate;
    }
  }
  return null;
}
