import { createHash } from 'node:crypto';
import type { Page } from 'playwright-core';
import { BrowserRefSnapshotStore, type BrowserSnapshot, type BrowserSnapshotNode } from '../../browser/ref-snapshot.ts';
import { SessionPlaneDomainError } from '../../domain/errors.ts';
import { CHATGPT_PREPARATION_SNAPSHOT } from './selectors.ts';

export interface ConfigurationOption {
  readonly id: string;
  readonly label: string;
  readonly version: string;
  readonly power: number | null;
}

export interface ConfigurationCatalog {
  readonly status: 'available' | 'unavailable';
  readonly observedAt: string;
  readonly options: readonly ConfigurationOption[];
  readonly unavailableVersions: readonly string[];
  readonly message?: string;
}

// Labels and combinations come from the provider, not a model-name table.
// The caller holds the exact preparation page's mutation lease throughout.
export class ChatGptConfigurationMenu {
  readonly #page: Page;
  readonly #refs = new BrowserRefSnapshotStore();
  readonly #pageKey: string;
  #snapshot!: BrowserSnapshot;

  constructor(page: Page, pageKey: string) {
    this.#page = page;
    this.#pageKey = pageKey;
  }

  async #capture(): Promise<readonly BrowserSnapshotNode[]> {
    this.#snapshot = await this.#refs.capture({ page: this.#page, pageKey: this.#pageKey,
      bindingEpoch: 1, ...CHATGPT_PREPARATION_SNAPSHOT, maxNodes: 5000 });
    return this.#snapshot.nodes;
  }

  async #wait(predicate: (nodes: readonly BrowserSnapshotNode[]) => boolean | Promise<boolean>, timeoutMs = 5000) {
    const deadline = Date.now() + timeoutMs;
    do {
      const nodes = await this.#capture();
      if (await predicate(nodes)) return nodes;
      await this.#page.waitForTimeout(50);
    } while (Date.now() < deadline);
    throw new SessionPlaneDomainError('provider.configuration-unavailable', 'Provider configuration controls did not expose a verifiable state');
  }

  async #click(node: BrowserSnapshotNode) {
    if (node.disabled) throw new SessionPlaneDomainError('provider.model-unavailable', `Configuration is disabled: ${node.text || node.name}`);
    const element = await this.#refs.resolve({ page: this.#page, pageKey: this.#pageKey,
      bindingEpoch: 1, snapshotId: this.#snapshot.snapshotId, ref: node.ref });
    // Menus are verified by their following DOM state, not navigation completion.
    try { await element.click({ timeout: 5000, noWaitAfter: true }); } finally { await element.dispose(); }
  }

  #opener(nodes: readonly BrowserSnapshotNode[]) {
    return nodes.find(n => n.role === 'button' && n.hasPopup === 'menu' &&
      /(?:model|모델)/i.test(n.name));
  }

  #summary(nodes: readonly BrowserSnapshotNode[]) {
    const menus = new Set(nodes.filter(n => n.role === 'menu').map(n => n.id));
    return nodes.find(n => n.role === 'menuitem' && /(?:model|모델)/i.test(n.name) &&
      n.ancestorIds.some(id => menus.has(id)));
  }

  async #readyMainMenu() {
    return await this.#wait(async nodes => this.#summary(nodes) !== undefined &&
      (nodes.some(n => n.role === 'slider') || await this.#page.locator('[role="menu"] [role="slider"]').count() === 0));
  }

  async #mainMenu() {
    let nodes = await this.#capture();
    // ChatGPT's lightweight home editor mounts the chooser only after focus.
    // Focusing hydrates the editor without replacing its draft.
    if (nodes.some(n => n.id === 'pending-home-input')) {
      // Focus can synchronously replace the lightweight editor. Resolve and focus
      // atomically so Playwright does not retry an already-detached placeholder.
      await this.#page.evaluate(() => document.getElementById('pending-home-input')?.focus());
      await this.#page.locator('#pending-home-input').waitFor({ state: 'hidden', timeout: 30000 });
      nodes = await this.#wait(ns => this.#opener(ns) !== undefined, 30000);
    }
    if (this.#summary(nodes)) return await this.#readyMainMenu();
    let opener = this.#opener(nodes);
    if (!opener) {
      const composer = nodes.find(n => n.role === 'textbox' && n.editable);
      if (composer) {
        const element = await this.#refs.resolve({ page: this.#page, pageKey: this.#pageKey,
          bindingEpoch: 1, snapshotId: this.#snapshot.snapshotId, ref: composer.ref });
        try { await element.focus(); } finally { await element.dispose(); }
      }
      nodes = await this.#wait(ns => this.#opener(ns) !== undefined, 30000);
      opener = this.#opener(nodes)!;
    }
    if (opener.expanded) {
      const controls = opener.controls;
      await this.#page.keyboard.press('Escape');
      nodes = await this.#wait(ns => this.#opener(ns)?.expanded === false);
      // Radix resets the submenu when its closing animation unmounts. Reopening
      // at aria-expanded=false alone can reopen the old version submenu.
      for (const id of controls) {
        await this.#page.locator(`[id=${JSON.stringify(id)}]`).waitFor({ state: 'hidden', timeout: 5000 });
      }
      nodes = await this.#capture();
      opener = this.#opener(nodes)!;
    }
    await this.#click(opener);
    return await this.#readyMainMenu();
  }

  async #versions() {
    const current = await this.#capture();
    if (current.some(n => n.role === 'menuitemradio')) return current;
    const nodes = await this.#mainMenu();
    await this.#click(this.#summary(nodes)!);
    return await this.#wait(ns => ns.some(n => n.role === 'menuitemradio'));
  }

  async #version(label: string) {
    const nodes = await this.#versions();
    const option = nodes.find(n => n.role === 'menuitemradio' && n.text === label);
    if (!option) throw new SessionPlaneDomainError('provider.model-unavailable', `Observed version is no longer available: ${label}`);
    await this.#click(option);
    return await this.#mainMenu();
  }

  async #power(value: number) {
    const nodes = await this.#mainMenu();
    const slider = nodes.find(n => n.role === 'slider');
    if (!slider || slider.disabled || slider.ariaValueNow === null || slider.ariaValueMin === null || slider.ariaValueMax === null ||
        !Number.isInteger(value) || value < Number(slider.ariaValueMin) || value > Number(slider.ariaValueMax)) {
      throw new SessionPlaneDomainError('provider.model-unavailable', 'Observed power is no longer available');
    }
    const delta = value - Number(slider.ariaValueNow);
    const element = await this.#refs.resolve({ page: this.#page, pageKey: this.#pageKey,
      bindingEpoch: 1, snapshotId: this.#snapshot.snapshotId, ref: slider.ref });
    try {
      await element.focus();
      for (let i = 0; i < Math.abs(delta); i++) await element.press(delta < 0 ? 'ArrowLeft' : 'ArrowRight');
    } finally { await element.dispose(); }
    return await this.#wait(ns => ns.some(n => n.role === 'slider' && Number(n.ariaValueNow) === value));
  }

  async discover(): Promise<ConfigurationCatalog> {
    const initial = await this.#mainMenu();
    const initialPower = initial.find(n => n.role === 'slider')?.ariaValueNow;
    const versions = (await this.#versions()).filter(n => n.role === 'menuitemradio');
    const initialVersion = versions.find(n => n.checked === true || n.selected === true)?.text;
    if (!initialVersion) throw new SessionPlaneDomainError('provider.configuration-unavailable', 'Current version is not identified; discovery cannot preserve its selection');
    const options: ConfigurationOption[] = [];
    try {
      for (const version of versions.filter(n => !n.disabled)) {
        let nodes = await this.#version(version.text);
        const slider = nodes.find(n => n.role === 'slider');
        const min = Number(slider?.ariaValueMin), max = Number(slider?.ariaValueMax);
        if (slider && (slider.ariaValueMin === null || slider.ariaValueMax === null ||
            !Number.isInteger(min) || !Number.isInteger(max) || max < min || max - min > 20)) {
          throw new SessionPlaneDomainError('provider.configuration-unavailable', 'Provider power range is not enumerable');
        }
        const values: (number | null)[] = slider ? Array.from({ length: max - min + 1 }, (_, i) => min + i) : [null];
        for (const power of values) {
          if (power !== null) nodes = await this.#power(power);
          const summary = this.#summary(nodes);
          if (!summary?.text) throw new SessionPlaneDomainError('provider.configuration-unavailable', 'Provider did not expose the combined configuration label');
          const identity = JSON.stringify([version.text, power, summary.text]);
          options.push({ id: createHash('sha256').update(identity).digest('hex').slice(0, 24),
            label: summary.text, version: version.text, power });
        }
      }
    } finally {
      await this.#version(initialVersion);
      if (initialPower != null) await this.#power(Number(initialPower));
      const opener = this.#opener(await this.#capture());
      if (opener?.expanded) await this.#click(opener);
    }
    return { status: 'available', observedAt: new Date().toISOString(), options,
      unavailableVersions: versions.filter(n => n.disabled).map(n => n.text) };
  }

  async select(option: ConfigurationOption): Promise<BrowserSnapshotNode> {
    let nodes = await this.#version(option.version);
    if (option.power !== null) nodes = await this.#power(option.power);
    const summary = this.#summary(nodes);
    if (!summary || summary.text !== option.label) {
      throw new SessionPlaneDomainError('provider.configuration-stale', 'Configuration changed since discovery; discover current options before choosing again');
    }
    // Keep the confirmed evidence visible when filling the composer closes menus.
    const opener = this.#opener(nodes)!;
    await this.#click(opener);
    // Open-menu and closed-chooser labels can differ. Read the persistent
    // evidence only after the closing menu has finished unmounting.
    await this.#wait(ns => this.#opener(ns)?.expanded === false);
    for (const id of opener.controls) {
      await this.#page.locator(`[id=${JSON.stringify(id)}]`).waitFor({ state: 'hidden', timeout: 5000 });
    }
    nodes = await this.#capture();
    return this.#opener(nodes)!;
  }
}
