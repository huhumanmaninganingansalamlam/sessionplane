import { existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';

import type {
  ConsoleMessage,
  ElementHandle,
  Page,
  Request,
  Response,
} from 'playwright-core';

import type { BrowserOwner } from '../browser/browser-owner.ts';
import type { PageBindingSnapshot } from '../browser/page-binding.ts';
import { PageRegistryError, type PageRegistry } from '../browser/page-registry.ts';
import {
  BrowserRefSnapshotStore,
  BrowserSnapshotError,
  type BrowserSnapshot,
  type BrowserSnapshotNode,
} from '../browser/ref-snapshot.ts';

interface ConsoleRecord {
  readonly time: string;
  readonly type: string;
  readonly text: string;
  readonly location: Readonly<Record<string, unknown>>;
}

interface NetworkRecord {
  readonly time: string;
  readonly phase: 'request' | 'response' | 'failed';
  readonly method: string;
  readonly url: string;
  readonly resourceType: string;
  readonly status: number | null;
  readonly failure: string | null;
}

interface DiagnosticBuffer {
  readonly console: ConsoleRecord[];
  readonly network: NetworkRecord[];
}

export class BrowserControlError extends Error {
  readonly errorCode: string;
  readonly details: unknown;

  constructor(errorCode: string, message: string, details?: unknown) {
    super(message);
    this.name = 'BrowserControlError';
    this.errorCode = errorCode;
    this.details = details;
  }
}

export class BrowserControlService {
  readonly #browserOwner: BrowserOwner | null;
  readonly #pageRegistry: PageRegistry;
  readonly #onStarted: (() => Promise<unknown>) | null;
  readonly #genericMutationsEnabled: boolean;
  readonly #refs = new BrowserRefSnapshotStore();
  readonly #diagnostics = new Map<string, DiagnosticBuffer>();
  readonly #attachedPages = new WeakSet<Page>();
  #selectedPageKey: string | null = null;

  constructor(options: {
    readonly browserOwner: BrowserOwner | null;
    readonly pageRegistry: PageRegistry;
    readonly onStarted?: (() => Promise<unknown>) | undefined;
    readonly genericMutationsEnabled?: boolean | undefined;
  }) {
    this.#browserOwner = options.browserOwner;
    this.#pageRegistry = options.pageRegistry;
    this.#onStarted = options.onStarted ?? null;
    this.#genericMutationsEnabled = options.genericMutationsEnabled ?? false;
  }

  runtimeStatus(): Readonly<Record<string, unknown>> {
    const owner = this.#requireBrowserOwner();
    return {
      requestOk: true,
      browser: owner.status,
      selectedPageKey: this.#selectedPageKey,
      pageCount: this.#pageRegistry.listBindings({ includeClosed: false }).length,
    };
  }

  async startRuntime(): Promise<Readonly<Record<string, unknown>>> {
    const owner = this.#requireBrowserOwner();
    const previousState = owner.status.state;
    await owner.start();
    if (previousState === 'ready' || this.#onStarted === null) {
      return this.runtimeStatus();
    }
    const recovery = await this.#onStarted();
    return {
      ...this.runtimeStatus(),
      recovery,
    };
  }

  async stopRuntime(): Promise<Readonly<Record<string, unknown>>> {
    const owner = this.#requireBrowserOwner();
    await owner.close();
    this.#selectedPageKey = null;
    return this.runtimeStatus();
  }

  async resetRuntime(force: boolean): Promise<Readonly<Record<string, unknown>>> {
    this.#requireGenericMutation('browser-reset');
    if (!force) {
      throw new BrowserControlError(
        'input.confirmation-required',
        'Browser profile reset requires force=true',
      );
    }
    const owner = this.#requireBrowserOwner();
    await owner.resetProfile();
    this.#selectedPageKey = null;
    return this.runtimeStatus();
  }

  async tabs(): Promise<Readonly<Record<string, unknown>>> {
    const bindings = this.#pageRegistry.listBindings({ includeClosed: false });
    this.#repairSelection(bindings);
    const tabs = await Promise.all(
      bindings.map(async (binding) => {
        const page = this.#pageRegistry.pageForObservation(binding.pageKey);
        this.#attachDiagnostics(binding.pageKey, page);
        return {
          ...binding,
          title: await page.title().catch(() => ''),
          selected: binding.pageKey === this.#selectedPageKey,
        };
      }),
    );
    return {
      requestOk: true,
      selectedPageKey: this.#selectedPageKey,
      tabs,
    };
  }

  async select(pageKey: string): Promise<Readonly<Record<string, unknown>>> {
    const { binding, page } = this.#resolvePage(pageKey);
    this.#attachDiagnostics(binding.pageKey, page);
    this.#selectedPageKey = binding.pageKey;
    return {
      requestOk: true,
      selectedPageKey: binding.pageKey,
      binding,
      title: await page.title().catch(() => ''),
    };
  }

  async newPage(
    url?: string,
    options: { readonly activate?: boolean } = {},
  ): Promise<Readonly<Record<string, unknown>>> {
    this.#requireGenericMutation('new-tab');
    const owner = this.#requireBrowserOwner();
    const activate = options.activate ?? true;
    const created = await owner.createPage();
    if (activate) this.#selectedPageKey = created.binding.pageKey;
    this.#attachDiagnostics(created.binding.pageKey, created.page);
    if (url !== undefined) {
      await created.page.goto(validateNavigationUrl(url), {
        waitUntil: 'domcontentloaded',
        timeout: 30_000,
      });
    }
    const binding = this.#pageRegistry.refreshPage(created.binding.pageKey);
    return {
      requestOk: true,
      createdPageKey: binding.pageKey,
      selectedPageKey: this.#selectedPageKey,
      activated: activate,
      binding,
      title: await created.page.title().catch(() => ''),
    };
  }

  async closePage(pageKey?: string): Promise<Readonly<Record<string, unknown>>> {
    this.#requireGenericMutation('tab-close');
    const resolved = this.#resolvePage(pageKey);
    await resolved.page.close();
    this.#refs.clear(resolved.binding.pageKey);
    this.#diagnostics.delete(resolved.binding.pageKey);
    if (this.#selectedPageKey === resolved.binding.pageKey) {
      this.#selectedPageKey = null;
    }
    this.#repairSelection(this.#pageRegistry.listBindings({ includeClosed: false }));
    return {
      requestOk: true,
      closedPageKey: resolved.binding.pageKey,
      selectedPageKey: this.#selectedPageKey,
    };
  }

  async cleanup(options: {
    readonly keepPageKey?: string | undefined;
  } = {}): Promise<Readonly<Record<string, unknown>>> {
    this.#requireGenericMutation('browser-cleanup');
    const keepPageKey = options.keepPageKey ?? this.#selectedPageKey;
    const bindings = this.#pageRegistry.listBindings({ includeClosed: false });
    const closed: string[] = [];
    for (const binding of bindings) {
      if (binding.pageKey === keepPageKey || binding.state === 'owned') {
        continue;
      }
      const page = this.#pageRegistry.pageForObservation(binding.pageKey);
      await page.close().catch(() => undefined);
      this.#refs.clear(binding.pageKey);
      this.#diagnostics.delete(binding.pageKey);
      closed.push(binding.pageKey);
    }
    this.#selectedPageKey = keepPageKey ?? null;
    this.#repairSelection(this.#pageRegistry.listBindings({ includeClosed: false }));
    return { requestOk: true, closed, selectedPageKey: this.#selectedPageKey };
  }

  async navigate(input: {
    readonly pageKey?: string | undefined;
    readonly url: string;
  }): Promise<Readonly<Record<string, unknown>>> {
    this.#requireGenericMutation('navigate');
    const resolved = this.#resolvePage(input.pageKey);
    await resolved.page.goto(validateNavigationUrl(input.url), {
      waitUntil: 'domcontentloaded',
      timeout: 30_000,
    });
    const binding = this.#pageRegistry.refreshPage(resolved.binding.pageKey);
    return this.#pageResult(binding, resolved.page);
  }

  async reload(pageKey?: string): Promise<Readonly<Record<string, unknown>>> {
    this.#requireGenericMutation('reload');
    const resolved = this.#resolvePage(pageKey);
    await resolved.page.reload({ waitUntil: 'domcontentloaded', timeout: 30_000 });
    const binding = this.#pageRegistry.refreshPage(resolved.binding.pageKey);
    return this.#pageResult(binding, resolved.page);
  }

  async history(
    direction: 'back' | 'forward',
    pageKey?: string,
  ): Promise<Readonly<Record<string, unknown>>> {
    this.#requireGenericMutation('history');
    const resolved = this.#resolvePage(pageKey);
    if (direction === 'back') {
      await resolved.page.goBack({ waitUntil: 'domcontentloaded', timeout: 30_000 });
    } else {
      await resolved.page.goForward({ waitUntil: 'domcontentloaded', timeout: 30_000 });
    }
    const binding = this.#pageRegistry.refreshPage(resolved.binding.pageKey);
    return this.#pageResult(binding, resolved.page);
  }

  async resize(input: {
    readonly pageKey?: string | undefined;
    readonly width: number;
    readonly height: number;
  }): Promise<Readonly<Record<string, unknown>>> {
    this.#requireGenericMutation('resize');
    const resolved = this.#resolvePage(input.pageKey);
    await resolved.page.setViewportSize({ width: input.width, height: input.height });
    return {
      requestOk: true,
      pageKey: resolved.binding.pageKey,
      viewport: resolved.page.viewportSize(),
    };
  }

  async snapshot(input: {
    readonly pageKey?: string | undefined;
    readonly interactive?: boolean | undefined;
    readonly maxNodes?: number | undefined;
  } = {}): Promise<BrowserSnapshot> {
    const resolved = this.#resolvePage(input.pageKey);
    const binding = this.#pageRegistry.refreshPage(resolved.binding.pageKey);
    return await this.#refs.capture({
      pageKey: binding.pageKey,
      bindingEpoch: binding.bindingEpoch,
      page: resolved.page,
      ...(input.interactive === undefined ? {} : { interactive: input.interactive }),
      ...(input.maxNodes === undefined ? {} : { maxNodes: input.maxNodes }),
    });
  }

  async click(input: {
    readonly pageKey?: string | undefined;
    readonly ref: string;
    readonly snapshotId?: string | undefined;
    readonly button?: 'left' | 'right' | 'middle' | undefined;
    readonly clickCount?: number | undefined;
  }): Promise<Readonly<Record<string, unknown>>> {
    this.#requireGenericMutation('click');
    return await this.#withElement(input, async (element, pageKey) => {
      await element.click({
        button: input.button ?? 'left',
        clickCount: input.clickCount ?? 1,
        timeout: 10_000,
      });
      return { requestOk: true, pageKey, ref: input.ref, action: 'click' };
    });
  }

  async type(input: {
    readonly pageKey?: string | undefined;
    readonly ref: string;
    readonly snapshotId?: string | undefined;
    readonly text: string;
    readonly append?: boolean | undefined;
  }): Promise<Readonly<Record<string, unknown>>> {
    this.#requireGenericMutation('type');
    return await this.#withElement(input, async (element, pageKey) => {
      if (input.append === true) {
        await element.type(input.text, { timeout: 10_000 });
      } else {
        await element.fill(input.text, { timeout: 10_000 });
      }
      return {
        requestOk: true,
        pageKey,
        ref: input.ref,
        action: input.append === true ? 'type' : 'fill',
      };
    });
  }

  async press(input: {
    readonly pageKey?: string | undefined;
    readonly ref?: string | undefined;
    readonly snapshotId?: string | undefined;
    readonly key: string;
  }): Promise<Readonly<Record<string, unknown>>> {
    this.#requireGenericMutation('press');
    if (input.ref !== undefined) {
      return await this.#withElement(
        { ...input, ref: input.ref },
        async (element, pageKey) => {
          await element.press(input.key, { timeout: 10_000 });
          return { requestOk: true, pageKey, ref: input.ref, action: 'press', key: input.key };
        },
      );
    }
    const resolved = this.#resolvePage(input.pageKey);
    await resolved.page.keyboard.press(input.key);
    return {
      requestOk: true,
      pageKey: resolved.binding.pageKey,
      action: 'press',
      key: input.key,
    };
  }

  async hover(input: {
    readonly pageKey?: string | undefined;
    readonly ref: string;
    readonly snapshotId?: string | undefined;
  }): Promise<Readonly<Record<string, unknown>>> {
    this.#requireGenericMutation('hover');
    return await this.#withElement(input, async (element, pageKey) => {
      await element.hover({ timeout: 10_000 });
      return { requestOk: true, pageKey, ref: input.ref, action: 'hover' };
    });
  }

  async selectOption(input: {
    readonly pageKey?: string | undefined;
    readonly ref: string;
    readonly snapshotId?: string | undefined;
    readonly values: readonly string[];
  }): Promise<Readonly<Record<string, unknown>>> {
    this.#requireGenericMutation('select');
    return await this.#withElement(input, async (element, pageKey) => {
      const selected = await element.selectOption(input.values.map((value) => ({ value })));
      return { requestOk: true, pageKey, ref: input.ref, action: 'select', selected };
    });
  }

  async setChecked(input: {
    readonly pageKey?: string | undefined;
    readonly ref: string;
    readonly snapshotId?: string | undefined;
    readonly checked: boolean;
  }): Promise<Readonly<Record<string, unknown>>> {
    this.#requireGenericMutation(input.checked ? 'check' : 'uncheck');
    return await this.#withElement(input, async (element, pageKey) => {
      if (input.checked) {
        await element.check({ timeout: 10_000 });
      } else {
        await element.uncheck({ timeout: 10_000 });
      }
      return {
        requestOk: true,
        pageKey,
        ref: input.ref,
        action: input.checked ? 'check' : 'uncheck',
      };
    });
  }

  async upload(input: {
    readonly pageKey?: string | undefined;
    readonly ref: string;
    readonly snapshotId?: string | undefined;
    readonly files: readonly string[];
  }): Promise<Readonly<Record<string, unknown>>> {
    this.#requireGenericMutation('upload');
    const files = input.files.map((file) => path.resolve(file));
    for (const file of files) {
      if (!existsSync(file)) {
        throw new BrowserControlError('input.invalid', `Upload file does not exist: ${file}`);
      }
    }
    return await this.#withElement(input, async (element, pageKey) => {
      await element.setInputFiles(files);
      return {
        requestOk: true,
        pageKey,
        ref: input.ref,
        action: 'upload',
        fileCount: files.length,
        files: files.map((file) => path.basename(file)),
      };
    });
  }

  async drag(input: {
    readonly pageKey?: string | undefined;
    readonly sourceRef: string;
    readonly targetRef: string;
    readonly snapshotId?: string | undefined;
  }): Promise<Readonly<Record<string, unknown>>> {
    this.#requireGenericMutation('drag');
    const resolved = this.#resolvePage(input.pageKey);
    const binding = this.#pageRegistry.refreshPage(resolved.binding.pageKey);
    const source = await this.#refs.resolve({
      pageKey: binding.pageKey,
      bindingEpoch: binding.bindingEpoch,
      page: resolved.page,
      ref: input.sourceRef,
      ...(input.snapshotId === undefined ? {} : { snapshotId: input.snapshotId }),
    });
    const target = await this.#refs.resolve({
      pageKey: binding.pageKey,
      bindingEpoch: binding.bindingEpoch,
      page: resolved.page,
      ref: input.targetRef,
      ...(input.snapshotId === undefined ? {} : { snapshotId: input.snapshotId }),
    });
    try {
      const sourceBox = await source.boundingBox();
      const targetBox = await target.boundingBox();
      if (sourceBox === null || targetBox === null) {
        throw new BrowserControlError(
          'browser.ref-stale',
          'Drag source or target has no visible bounding box',
        );
      }
      await resolved.page.mouse.move(
        sourceBox.x + sourceBox.width / 2,
        sourceBox.y + sourceBox.height / 2,
      );
      await resolved.page.mouse.down();
      await resolved.page.mouse.move(
        targetBox.x + targetBox.width / 2,
        targetBox.y + targetBox.height / 2,
        { steps: 10 },
      );
      await resolved.page.mouse.up();
    } finally {
      await source.dispose();
      await target.dispose();
    }
    return {
      requestOk: true,
      pageKey: binding.pageKey,
      action: 'drag',
      sourceRef: input.sourceRef,
      targetRef: input.targetRef,
    };
  }

  async mouse(input: {
    readonly pageKey?: string | undefined;
    readonly action: 'click' | 'move' | 'down' | 'up';
    readonly x?: number | undefined;
    readonly y?: number | undefined;
    readonly button?: 'left' | 'right' | 'middle' | undefined;
  }): Promise<Readonly<Record<string, unknown>>> {
    this.#requireGenericMutation('mouse');
    const resolved = this.#resolvePage(input.pageKey);
    if (input.action === 'click' || input.action === 'move') {
      if (input.x === undefined || input.y === undefined) {
        throw new BrowserControlError('input.invalid', 'Mouse x and y coordinates are required');
      }
    }
    if (input.action === 'click') {
      await resolved.page.mouse.click(input.x as number, input.y as number, {
        button: input.button ?? 'left',
      });
    } else if (input.action === 'move') {
      await resolved.page.mouse.move(input.x as number, input.y as number);
    } else if (input.action === 'down') {
      await resolved.page.mouse.down({ button: input.button ?? 'left' });
    } else {
      await resolved.page.mouse.up({ button: input.button ?? 'left' });
    }
    return {
      requestOk: true,
      pageKey: resolved.binding.pageKey,
      action: `mouse-${input.action}`,
      ...(input.x === undefined ? {} : { x: input.x }),
      ...(input.y === undefined ? {} : { y: input.y }),
    };
  }

  async scroll(input: {
    readonly pageKey?: string | undefined;
    readonly deltaX: number;
    readonly deltaY: number;
  }): Promise<Readonly<Record<string, unknown>>> {
    this.#requireGenericMutation('scroll');
    const resolved = this.#resolvePage(input.pageKey);
    await resolved.page.mouse.wheel(input.deltaX, input.deltaY);
    return {
      requestOk: true,
      pageKey: resolved.binding.pageKey,
      action: 'scroll',
      deltaX: input.deltaX,
      deltaY: input.deltaY,
    };
  }

  async wait(input: {
    readonly pageKey?: string | undefined;
    readonly timeoutMs: number;
    readonly selector?: string | undefined;
    readonly text?: string | undefined;
    readonly ref?: string | undefined;
    readonly snapshotId?: string | undefined;
  }): Promise<Readonly<Record<string, unknown>>> {
    const resolved = this.#resolvePage(input.pageKey);
    if (input.selector !== undefined) {
      await resolved.page.locator(input.selector).first().waitFor({
        state: 'visible',
        timeout: input.timeoutMs,
      });
      return {
        requestOk: true,
        pageKey: resolved.binding.pageKey,
        condition: 'selector',
        selector: input.selector,
      };
    }
    if (input.text !== undefined) {
      await resolved.page.getByText(input.text, { exact: false }).first().waitFor({
        state: 'visible',
        timeout: input.timeoutMs,
      });
      return {
        requestOk: true,
        pageKey: resolved.binding.pageKey,
        condition: 'text',
        text: input.text,
      };
    }
    if (input.ref !== undefined) {
      return await this.#withElement(
        { ...input, ref: input.ref },
        async (element, pageKey) => {
          await element.waitForElementState('visible', { timeout: input.timeoutMs });
          return { requestOk: true, pageKey, condition: 'ref', ref: input.ref };
        },
      );
    }
    await resolved.page.waitForTimeout(input.timeoutMs);
    return {
      requestOk: true,
      pageKey: resolved.binding.pageKey,
      condition: 'timeout',
      timeoutMs: input.timeoutMs,
    };
  }

  async screenshot(input: {
    readonly pageKey?: string | undefined;
    readonly outputPath: string;
    readonly fullPage?: boolean | undefined;
  }): Promise<Readonly<Record<string, unknown>>> {
    const resolved = this.#resolvePage(input.pageKey);
    const outputPath = path.resolve(input.outputPath);
    mkdirSync(path.dirname(outputPath), { recursive: true, mode: 0o700 });
    await resolved.page.screenshot({ path: outputPath, fullPage: input.fullPage ?? false });
    return {
      requestOk: true,
      pageKey: resolved.binding.pageKey,
      path: outputPath,
      fullPage: input.fullPage ?? false,
    };
  }

  async text(input: {
    readonly pageKey?: string | undefined;
    readonly selector?: string | undefined;
    readonly maxChars?: number | undefined;
  } = {}): Promise<Readonly<Record<string, unknown>>> {
    const resolved = this.#resolvePage(input.pageKey);
    const maxChars = Math.max(1, Math.min(2_000_000, input.maxChars ?? 200_000));
    const value = input.selector === undefined
      ? await resolved.page.locator('body').innerText()
      : await resolved.page.locator(input.selector).first().innerText();
    return {
      requestOk: true,
      pageKey: resolved.binding.pageKey,
      text: value.slice(0, maxChars),
      textChars: value.length,
      truncated: value.length > maxChars,
    };
  }

  async dom(input: {
    readonly pageKey?: string | undefined;
    readonly selector?: string | undefined;
    readonly maxChars?: number | undefined;
  } = {}): Promise<Readonly<Record<string, unknown>>> {
    const resolved = this.#resolvePage(input.pageKey);
    const maxChars = Math.max(1, Math.min(4_000_000, input.maxChars ?? 500_000));
    const html = input.selector === undefined
      ? await resolved.page.content()
      : await resolved.page
          .locator(input.selector)
          .first()
          .evaluate((node) => (node as Element).outerHTML);
    return {
      requestOk: true,
      pageKey: resolved.binding.pageKey,
      html: html.slice(0, maxChars),
      htmlChars: html.length,
      truncated: html.length > maxChars,
    };
  }

  async evaluate(input: {
    readonly pageKey?: string | undefined;
    readonly script: string;
  }): Promise<Readonly<Record<string, unknown>>> {
    this.#requireGenericMutation('evaluate');
    const resolved = this.#resolvePage(input.pageKey);
    const value = await resolved.page.evaluate((source) => (0, eval)(source), input.script);
    return { requestOk: true, pageKey: resolved.binding.pageKey, value };
  }

  console(input: {
    readonly pageKey?: string | undefined;
    readonly clear?: boolean | undefined;
    readonly limit?: number | undefined;
  } = {}): Readonly<Record<string, unknown>> {
    const resolved = this.#resolvePage(input.pageKey);
    this.#attachDiagnostics(resolved.binding.pageKey, resolved.page);
    const buffer = this.#diagnostics.get(resolved.binding.pageKey) as DiagnosticBuffer;
    const entries =
      input.limit === undefined
        ? [...buffer.console]
        : buffer.console.slice(-Math.max(1, Math.min(10_000, input.limit)));
    if (input.clear === true) buffer.console.length = 0;
    return { requestOk: true, pageKey: resolved.binding.pageKey, entries };
  }

  network(input: {
    readonly pageKey?: string | undefined;
    readonly clear?: boolean | undefined;
  } = {}): Readonly<Record<string, unknown>> {
    const resolved = this.#resolvePage(input.pageKey);
    this.#attachDiagnostics(resolved.binding.pageKey, resolved.page);
    const buffer = this.#diagnostics.get(resolved.binding.pageKey) as DiagnosticBuffer;
    const entries = [...buffer.network];
    if (input.clear === true) buffer.network.length = 0;
    return { requestOk: true, pageKey: resolved.binding.pageKey, entries };
  }

  async observationBundle(input: {
    readonly pageKey?: string | undefined;
    readonly screenshotPath?: string | undefined;
    readonly includeBoxes?: boolean | undefined;
    readonly maxTextChars?: number | undefined;
    readonly maxNodes?: number | undefined;
  } = {}): Promise<Readonly<Record<string, unknown>>> {
    const snapshot = await this.snapshot({
      pageKey: input.pageKey,
      interactive: true,
      maxNodes: input.maxNodes,
    });
    const text = await this.text({
      pageKey: snapshot.pageKey,
      maxChars: input.maxTextChars ?? 2_000,
    });
    const resolved = this.#resolvePage(snapshot.pageKey);
    const screenshot = input.screenshotPath === undefined
      ? null
      : await this.screenshot({
          pageKey: snapshot.pageKey,
          outputPath: input.screenshotPath,
          fullPage: false,
        });
    const nodes = input.includeBoxes === false
      ? snapshot.nodes.map(({ box: _box, ...node }) => node)
      : snapshot.nodes;
    return {
      requestOk: true,
      schemaVersion: 'observation-bundle-v1',
      observationId: snapshot.snapshotId,
      pageKey: snapshot.pageKey,
      url: snapshot.url,
      title: snapshot.title,
      viewport: resolved.page.viewportSize(),
      dpr: await resolved.page.evaluate(() => devicePixelRatio),
      capturedAt: snapshot.capturedAt,
      refs: nodes,
      screenshot: screenshot === null ? null : screenshot.path,
      textSummary: text.text,
      stats: {
        refCount: snapshot.nodes.length,
        boxCount: input.includeBoxes === false
          ? 0
          : snapshot.nodes.filter((node) => node.box !== null).length,
        textChars: text.textChars,
        hasScreenshot: screenshot !== null,
      },
    };
  }

  async observeActions(input: {
    readonly pageKey?: string | undefined;
    readonly instruction: string;
    readonly topN?: number | undefined;
    readonly includeDisabled?: boolean | undefined;
  }): Promise<Readonly<Record<string, unknown>>> {
    const snapshot = await this.snapshot({ pageKey: input.pageKey, interactive: true, maxNodes: 500 });
    const tokens = tokenize(input.instruction);
    const candidates = snapshot.nodes
      .filter((node) => input.includeDisabled === true || !node.disabled)
      .map((node) => scoreAction(node, tokens))
      .sort((left, right) => right.confidence - left.confidence || left.ref.localeCompare(right.ref))
      .slice(0, Math.max(1, Math.min(100, input.topN ?? 10)));
    return {
      requestOk: true,
      snapshotId: snapshot.snapshotId,
      pageKey: snapshot.pageKey,
      url: snapshot.url,
      instruction: input.instruction,
      candidates,
    };
  }

  #requireBrowserOwner(): BrowserOwner {
    if (this.#browserOwner === null) {
      throw new BrowserControlError('browser.unavailable', 'Browser owner is disabled');
    }
    return this.#browserOwner;
  }

  #requireGenericMutation(action: string): void {
    if (this.#genericMutationsEnabled) return;
    throw new BrowserControlError(
      'capability.unsupported',
      `Generic browser mutation is disabled in SessionPlane runtime: ${action}. ` +
        'Use Playwright for general browser automation.',
    );
  }

  #resolvePage(pageKey?: string): {
    readonly binding: PageBindingSnapshot;
    readonly page: Page;
  } {
    try {
      const bindings = this.#pageRegistry.listBindings({ includeClosed: false });
      this.#repairSelection(bindings);
      const resolvedKey = pageKey ?? this.#selectedPageKey ?? onlyPageKey(bindings);
      if (resolvedKey === null) {
        throw new BrowserControlError(
          'input.page-required',
          bindings.length === 0
            ? 'No browser Page is available'
            : 'Multiple Pages are available; pass pageKey or select one explicitly',
          { pageKeys: bindings.map((binding) => binding.pageKey) },
        );
      }
      const binding = this.#pageRegistry.refreshPage(resolvedKey);
      if (binding.state === 'closed') {
        throw new BrowserControlError('browser.unavailable', `Page ${resolvedKey} is closed`);
      }
      const page = this.#pageRegistry.pageForObservation(resolvedKey, binding.bindingEpoch);
      this.#attachDiagnostics(resolvedKey, page);
      if (pageKey !== undefined) this.#selectedPageKey = resolvedKey;
      return { binding, page };
    } catch (error) {
      if (error instanceof BrowserControlError) throw error;
      if (error instanceof PageRegistryError) {
        throw new BrowserControlError(error.errorCode, error.message);
      }
      throw error;
    }
  }

  async #withElement<Result extends Readonly<Record<string, unknown>>>(
    input: {
      readonly pageKey?: string | undefined;
      readonly ref: string;
      readonly snapshotId?: string | undefined;
    },
    operation: (element: ElementHandle<Element>, pageKey: string) => Promise<Result>,
  ): Promise<Result> {
    const resolved = this.#resolvePage(input.pageKey);
    try {
      const element = await this.#refs.resolve({
        pageKey: resolved.binding.pageKey,
        bindingEpoch: resolved.binding.bindingEpoch,
        page: resolved.page,
        ref: input.ref,
        ...(input.snapshotId === undefined ? {} : { snapshotId: input.snapshotId }),
      });
      try {
        return await operation(element, resolved.binding.pageKey);
      } finally {
        await element.dispose();
      }
    } catch (error) {
      if (error instanceof BrowserSnapshotError) {
        throw new BrowserControlError(error.errorCode, error.message);
      }
      throw error;
    }
  }

  #repairSelection(bindings: readonly PageBindingSnapshot[]): void {
    if (
      this.#selectedPageKey !== null &&
      bindings.some((binding) => binding.pageKey === this.#selectedPageKey)
    ) {
      return;
    }
    this.#selectedPageKey = bindings.length === 1 ? bindings[0]?.pageKey ?? null : null;
  }

  #attachDiagnostics(pageKey: string, page: Page): void {
    if (!this.#diagnostics.has(pageKey)) {
      this.#diagnostics.set(pageKey, { console: [], network: [] });
    }
    if (this.#attachedPages.has(page)) return;
    this.#attachedPages.add(page);
    const buffer = this.#diagnostics.get(pageKey) as DiagnosticBuffer;
    page.on('console', (message) => appendLimited(buffer.console, consoleRecord(message), 500));
    page.on('request', (request) =>
      appendLimited(buffer.network, requestRecord(request, 'request'), 1_000),
    );
    page.on('response', (response) =>
      appendLimited(buffer.network, responseRecord(response), 1_000),
    );
    page.on('requestfailed', (request) =>
      appendLimited(buffer.network, requestRecord(request, 'failed'), 1_000),
    );
  }

  async #pageResult(
    binding: PageBindingSnapshot,
    page: Page,
  ): Promise<Readonly<Record<string, unknown>>> {
    return {
      requestOk: true,
      binding,
      selectedPageKey: this.#selectedPageKey,
      title: await page.title().catch(() => ''),
    };
  }
}

function onlyPageKey(bindings: readonly PageBindingSnapshot[]): string | null {
  return bindings.length === 1 ? bindings[0]?.pageKey ?? null : null;
}

function validateNavigationUrl(value: string): string {
  const url = new URL(value);
  if (!['http:', 'https:', 'about:', 'data:'].includes(url.protocol)) {
    throw new BrowserControlError(
      'input.invalid',
      `Unsupported navigation protocol: ${url.protocol}`,
    );
  }
  return url.href;
}

function appendLimited<Value>(values: Value[], value: Value, limit: number): void {
  values.push(value);
  if (values.length > limit) values.splice(0, values.length - limit);
}

function consoleRecord(message: ConsoleMessage): ConsoleRecord {
  return {
    time: new Date().toISOString(),
    type: message.type(),
    text: message.text().slice(0, 20_000),
    location: message.location(),
  };
}

function requestRecord(request: Request, phase: 'request' | 'failed'): NetworkRecord {
  return {
    time: new Date().toISOString(),
    phase,
    method: request.method(),
    url: sanitizeNetworkUrl(request.url()),
    resourceType: request.resourceType(),
    status: null,
    failure: phase === 'failed' ? request.failure()?.errorText ?? 'request-failed' : null,
  };
}

function responseRecord(response: Response): NetworkRecord {
  const request = response.request();
  return {
    time: new Date().toISOString(),
    phase: 'response',
    method: request.method(),
    url: sanitizeNetworkUrl(response.url()),
    resourceType: request.resourceType(),
    status: response.status(),
    failure: null,
  };
}

function sanitizeNetworkUrl(value: string): string {
  try {
    const url = new URL(value);
    const keys = [...new Set([...url.searchParams.keys()])].sort();
    url.search = keys.length === 0 ? '' : `?${keys.map((key) => `${encodeURIComponent(key)}=[redacted]`).join('&')}`;
    url.username = '';
    url.password = '';
    return url.href;
  } catch {
    return value.slice(0, 2_000);
  }
}

function tokenize(value: string): ReadonlySet<string> {
  return new Set(
    value
      .toLowerCase()
      .split(/[^\p{L}\p{N}]+/u)
      .filter((token) => token.length > 1),
  );
}

function scoreAction(
  node: BrowserSnapshotNode,
  instructionTokens: ReadonlySet<string>,
): Readonly<Record<string, unknown>> & { readonly ref: string; readonly confidence: number } {
  const nodeTokens = tokenize(`${node.role} ${node.name} ${node.text} ${node.placeholder ?? ''}`);
  const overlap = [...instructionTokens].filter((token) => nodeTokens.has(token));
  const roleWeight = ['button', 'link', 'checkbox', 'radio', 'combobox', 'option'].includes(node.role)
    ? 0.35
    : node.role === 'textbox'
      ? 0.3
      : 0.1;
  const overlapWeight = instructionTokens.size === 0
    ? 0
    : Math.min(0.55, overlap.length / instructionTokens.size * 0.55);
  const enabledWeight = node.disabled ? 0 : 0.1;
  const confidence = Math.max(0, Math.min(1, roleWeight + overlapWeight + enabledWeight));
  const action = node.role === 'textbox'
    ? 'type'
    : node.role === 'combobox' || node.role === 'option'
      ? 'select'
      : node.role === 'checkbox' || node.role === 'radio'
        ? 'check'
        : 'click';
  return {
    ref: node.ref,
    role: node.role,
    name: node.name,
    action,
    method: action === 'click' ? 'browser_click_ref' : `browser_${action}_ref`,
    args: { ref: node.ref },
    confidence,
    signals: [
      `role:${node.role}`,
      ...(overlap.length === 0 ? [] : [`instruction-overlap:${overlap.join(',')}`]),
    ],
    riskFlags: node.name.toLowerCase().match(/delete|remove|purchase|buy|pay|삭제|결제/)
      ? ['destructive']
      : [],
  };
}
