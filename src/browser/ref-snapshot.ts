import { randomUUID } from 'node:crypto';

import type { ElementHandle, Page } from 'playwright-core';
import type { PreparationTarget } from '../providers/provider-adapter.ts';

const REF_PROPERTY = '__sessionplaneRefToken';

export interface BrowserSnapshotNode {
  readonly ref: string;
  readonly id: string;
  readonly role: string;
  readonly name: string;
  readonly tag: string;
  readonly text: string;
  readonly depth: number;
  readonly ancestorIds: readonly string[];
  readonly disabled: boolean;
  readonly checked: boolean | null;
  readonly selected: boolean | null;
  readonly href: string | null;
  readonly placeholder: string | null;
  readonly value: string | null;
  readonly ariaValueText: string | null;
  readonly ariaValueNow: string | null;
  readonly ariaValueMin: string | null;
  readonly ariaValueMax: string | null;
  readonly description: string;
  readonly controls: readonly string[];
  readonly describedBy: readonly string[];
  readonly labelledBy: readonly string[];
  readonly editable: boolean;
  readonly expanded: boolean | null;
  readonly hasPopup: string | null;
  readonly box: {
    readonly x: number;
    readonly y: number;
    readonly width: number;
    readonly height: number;
  } | null;
}

export interface BrowserSnapshot {
  readonly requestOk: true;
  readonly snapshotId: string;
  readonly pageKey: string;
  readonly bindingEpoch: number;
  readonly url: string;
  readonly title: string;
  readonly capturedAt: string;
  readonly interactive: boolean;
  readonly nodes: readonly BrowserSnapshotNode[];
  readonly nodesTruncated: boolean;
  readonly stats: {
    readonly nodeCount: number;
    readonly truncated: boolean;
  };
}

interface SnapshotRecord {
  readonly snapshotId: string;
  readonly bindingEpoch: number;
  readonly tokens: ReadonlyMap<string, string>;
  readonly refsByToken: ReadonlyMap<string, string>;
  readonly nodes: ReadonlyMap<string, BrowserSnapshotNode>;
}

export class BrowserSnapshotError extends Error {
  readonly errorCode: string;

  constructor(errorCode: string, message: string) {
    super(message);
    this.name = 'BrowserSnapshotError';
    this.errorCode = errorCode;
  }
}

export class BrowserRefSnapshotStore {
  readonly #latestByPage = new Map<string, SnapshotRecord>();

  async capture(options: {
    readonly pageKey: string;
    readonly bindingEpoch: number;
    readonly page: Page;
    readonly interactive?: boolean;
    readonly maxNodes?: number;
    readonly rootSelector?: string;
    readonly excludeSelector?: string;
    readonly controlScope?: boolean;
    readonly compact?: boolean;
  }): Promise<BrowserSnapshot> {
    const snapshotId = randomUUID();
    const interactive = options.interactive ?? true;
    const maxNodes = Math.max(1, Math.min(5_000, options.maxNodes ?? 250));
    const evaluation = options.page.evaluate(
      ({ snapshotId: browserSnapshotId, interactive: interactiveOnly, maxNodes: limit, refProperty, rootSelector, excludeSelector, controlScope, compact }) => {
        type MutableSnapshotNode = {
          ref: string;
          token: string;
          id: string;
          role: string;
          name: string;
          tag: string;
          text: string;
          depth: number;
          ancestorIds: string[];
          disabled: boolean;
          checked: boolean | null;
          selected: boolean | null;
          href: string | null;
          placeholder: string | null;
          value: string | null;
          ariaValueText: string | null;
          ariaValueNow: string | null;
          ariaValueMin: string | null;
          ariaValueMax: string | null;
          description: string;
          controls: string[];
          describedBy: string[];
          labelledBy: string[];
          editable: boolean;
          expanded: boolean | null;
          hasPopup: string | null;
          box: { x: number; y: number; width: number; height: number } | null;
        };

        const normalize = (value: string | null | undefined, max = 240): string =>
          (value ?? '').replaceAll(/\s+/g, ' ').trim().slice(0, max);

        const inferredRole = (element: Element): string => {
          const explicit = element.getAttribute('role');
          if (explicit !== null && explicit.trim() !== '') {
            return explicit.trim().toLowerCase();
          }
          const tag = element.tagName.toLowerCase();
          if (tag === 'a' && element.hasAttribute('href')) return 'link';
          if (tag === 'button') return 'button';
          if (tag === 'textarea') return 'textbox';
          if (tag === 'select') return 'combobox';
          if (tag === 'option') return 'option';
          if (tag === 'summary') return 'button';
          if (tag === 'input') {
            const type = (element.getAttribute('type') ?? 'text').toLowerCase();
            if (type === 'checkbox') return 'checkbox';
            if (type === 'radio') return 'radio';
            if (['button', 'submit', 'reset', 'image'].includes(type)) return 'button';
            if (type === 'range') return 'slider';
            return 'textbox';
          }
          if (element.getAttribute('contenteditable') === 'true') return 'textbox';
          return 'generic';
        };

        const evidenceText = (element: Element | null, rendered = false): string => {
          if (element === null) return '';
          if (controlScope && (element.matches('textarea, [contenteditable="true"], [role="textbox"]') ||
              element.querySelector('textarea, [contenteditable="true"], [role="textbox"]') !== null ||
              (excludeSelector !== null && (element.querySelector(excludeSelector) !== null ||
                (element.closest(excludeSelector) !== null && element.closest('[role="alert"], [role="alertdialog"]') === null))))) return '';
          return rendered && element instanceof HTMLElement ? element.innerText : element.textContent ?? '';
        };

        const accessibleName = (element: Element): string => {
          const ariaLabel = element.getAttribute('aria-label');
          if (ariaLabel !== null && ariaLabel.trim() !== '') return normalize(ariaLabel);
          const labelledBy = element.getAttribute('aria-labelledby');
          if (labelledBy !== null) {
            const label = labelledBy
              .split(/\s+/)
              .map((id) => evidenceText(document.getElementById(id)))
              .join(' ');
            if (label.trim() !== '') return normalize(label);
          }
          const htmlElement = element as HTMLElement;
          if (htmlElement.id !== '') {
            try {
              const label = document.querySelector(`label[for="${CSS.escape(htmlElement.id)}"]`);
              if (evidenceText(label).trim()) return normalize(evidenceText(label));
            } catch {
              // Ignore malformed ids and continue through the name fallback chain.
            }
          }
          const wrappingLabel = element.closest('label');
          if (evidenceText(wrappingLabel).trim()) return normalize(evidenceText(wrappingLabel));
          const alt = element.getAttribute('alt');
          if (alt !== null && alt.trim() !== '') return normalize(alt);
          const title = element.getAttribute('title');
          if (title !== null && title.trim() !== '') return normalize(title);
          const placeholder = element.getAttribute('placeholder');
          if (placeholder !== null && placeholder.trim() !== '') return normalize(placeholder);
          if (inferredRole(element) === 'textbox') return '';
          const value =
            element instanceof HTMLInputElement ||
            element instanceof HTMLTextAreaElement ||
            element instanceof HTMLSelectElement
              ? element.value
              : null;
          if (value !== null && value.trim() !== '') return normalize(value);
          return normalize(evidenceText(element, true));
        };

        const isVisible = (element: Element): boolean => {
          if (!(element instanceof HTMLElement || element instanceof SVGElement)) return false;
          if (element.closest('[aria-hidden="true"], [inert]') !== null) return false;
          const style = getComputedStyle(element);
          if (
            style.display === 'none' ||
            style.visibility === 'hidden' ||
            Number(style.opacity) === 0
          ) {
            return false;
          }
          const rect = element.getBoundingClientRect();
          return rect.width > 0 && rect.height > 0;
        };

        const isInteractive = (element: Element, role: string): boolean => {
          if (
            [
              'button',
              'link',
              'textbox',
              'checkbox',
              'radio',
              'combobox',
              'option',
              'slider',
              'status',
              'menuitem',
              'menuitemradio',
              'switch',
              'tab',
              'treeitem',
            ].includes(role)
          ) {
            return true;
          }
          const html = element as HTMLElement;
          return (
            html.tabIndex >= 0 ||
            element.hasAttribute('onclick') ||
            element.getAttribute('contenteditable') === 'true'
          );
        };

        const nodes: MutableSnapshotNode[] = [];
        let truncated = false;
        let sequence = 0;

        const visit = (element: Element, depth: number, ancestorIds: readonly string[]): void => {
          if (element.closest('[aria-hidden="true"], [inert]') !== null) return;
          if (nodes.length >= limit) {
            truncated = true;
            return;
          }
          if (excludeSelector !== null && element.matches(excludeSelector) &&
              !element.matches('[role="alert"], [role="alertdialog"]')) return;
          if (['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE'].includes(element.tagName) || (compact && element instanceof SVGElement)) return;
          const style = getComputedStyle(element);
          if (style.display === 'none' || Number(style.opacity) === 0) return;
          const visible = isVisible(element);
          const keys = new Set((element.getAttribute('aria-keyshortcuts') ?? '').split(/\s+/));
          const ranges = keys.has('ArrowLeft') && keys.has('ArrowRight')
            ? [...element.querySelectorAll('[role="slider"][aria-valuemin][aria-valuemax][aria-valuenow]')]
              .filter(range => range.closest('[aria-keyshortcuts]') === element)
            : [];
          // Composite controls expose their range on a hidden thumb, but keyboard
          // input belongs to the visible receiver. Keep the ref on that receiver.
          const range = ranges.length === 1 ? ranges[0]! : element;
          const role = range === element ? inferredRole(element) : 'slider';
          const actionable = isInteractive(element, role);
          const ownText = [...element.childNodes].some((node) => node.nodeType === Node.TEXT_NODE && node.textContent?.trim());
          const meaningful = actionable || ownText || ['dialog', 'alert', 'status', 'heading', 'menu', 'group', 'radiogroup'].includes(role);
          const control = actionable || ['dialog', 'alert', 'menu', 'group', 'radiogroup'].includes(role);
          const include = visible && (!interactiveOnly || actionable || (compact && control)) && (!compact || meaningful) &&
            (excludeSelector === null || element.querySelector(excludeSelector) === null);
          if (include) {
            sequence += 1;
            const ref = `@e${sequence}`;
            const token = `${browserSnapshotId}:${sequence}`;
            try {
              Object.defineProperty(element, refProperty, {
                value: token,
                configurable: true,
                writable: true,
              });
            } catch {
              (element as Element & Record<string, unknown>)[refProperty] = token;
            }
            const rect = element.getBoundingClientRect();
            const input = element as HTMLInputElement;
            const option = element as HTMLOptionElement;
            const value =
              element instanceof HTMLInputElement ||
              element instanceof HTMLTextAreaElement ||
              element instanceof HTMLSelectElement
                ? normalize(element.value, 500)
              : null;
            const relationship = (name: string): { ids: string[]; text: string } => {
              const ids = (element.getAttribute(name) ?? '').trim().split(/\s+/).filter(Boolean);
              return {
                ids,
                text: ids.map((id) => evidenceText(document.getElementById(id)).trim()).join(' ').slice(0, 500),
              };
            };
            const describedBy = relationship('aria-describedby');
            nodes.push({
              ref,
              token,
              id: element.getAttribute('id') ?? '',
              role,
              name: accessibleName(element),
              tag: element.tagName.toLowerCase(),
              text: compact && role === 'textbox' ? '' : normalize(evidenceText(element, true), 500),
              depth,
              ancestorIds: [...ancestorIds],
              disabled:
                element.getAttribute('aria-disabled') === 'true' ||
                ('disabled' in input && Boolean(input.disabled)),
              checked:
                element instanceof HTMLInputElement &&
                ['checkbox', 'radio'].includes(element.type)
                  ? element.checked
                  : element.getAttribute('aria-checked') === null
                    ? null
                    : element.getAttribute('aria-checked') === 'true',
              selected:
                element instanceof HTMLOptionElement
                  ? option.selected
                  : element.getAttribute('aria-selected') === null && element.getAttribute('aria-pressed') === null
                    ? null
                    : element.getAttribute('aria-selected') === 'true' || element.getAttribute('aria-pressed') === 'true',
              href: element instanceof HTMLAnchorElement ? element.href : null,
              placeholder: element.getAttribute('placeholder'),
              value: compact && role === 'textbox' ? null : value,
              ariaValueText: range.getAttribute('aria-valuetext'),
              ariaValueNow: range.getAttribute('aria-valuenow'),
              ariaValueMin: range.getAttribute('aria-valuemin') ?? (input instanceof HTMLInputElement && input.type === 'range' ? input.min || '0' : null),
              ariaValueMax: range.getAttribute('aria-valuemax') ?? (input instanceof HTMLInputElement && input.type === 'range' ? input.max || '100' : null),
              description: describedBy.text,
              controls: relationship('aria-controls').ids,
              describedBy: describedBy.ids,
              labelledBy: relationship('aria-labelledby').ids,
              editable:
                element instanceof HTMLTextAreaElement ||
                (element instanceof HTMLInputElement && !['button', 'submit', 'reset', 'checkbox', 'radio', 'file'].includes(element.type)) ||
                (element instanceof HTMLElement && element.isContentEditable),
              expanded: element.getAttribute('aria-expanded') === null
                ? null
                : element.getAttribute('aria-expanded') === 'true',
              hasPopup: element.getAttribute('aria-haspopup'),
              box: {
                x: rect.x,
                y: rect.y,
                width: rect.width,
                height: rect.height,
              },
            });
          }

          if (compact && role === 'textbox') return;
          for (const child of element.children) {
            visit(child, depth + 1, element.id === '' ? ancestorIds : [...ancestorIds, element.id]);
            if (truncated) return;
          }
          const shadowRoot = (element as HTMLElement).shadowRoot;
          if (shadowRoot !== null) {
            for (const child of shadowRoot.children) {
              visit(child, depth + 1, element.id === '' ? ancestorIds : [...ancestorIds, element.id]);
              if (truncated) return;
            }
          }
        };

        let roots = rootSelector === null
          ? [document.body ?? document.documentElement]
          : [...document.querySelectorAll(rootSelector)];
        if (controlScope) {
          const excluded = (element: Element): boolean => !element.matches('[role="alert"], [role="alertdialog"]') &&
            excludeSelector !== null && element.closest(excludeSelector) !== null;
          roots = [...document.querySelectorAll('[role="menu"], [role="listbox"], [role="dialog"], [role="alertdialog"], [role="alert"], [role="status"], [role="radiogroup"]')]
            .filter(element => !excluded(element));
          const editors = [...document.querySelectorAll('textarea, [contenteditable="true"], [role="textbox"]')].filter(element => !excluded(element) && isVisible(element));
          if (editors.length === 0) roots.push(...document.querySelectorAll('main, [role="main"]'));
          for (const editor of editors) {
            let region = editor.closest('form') ?? editor.parentElement ?? editor;
            while (region.parentElement && !region.querySelector('button, [role="button"], input[type="submit"]')) {
              if (excluded(region.parentElement)) break;
              region = region.parentElement;
            }
            if (region === document.body || region.matches('main, [role="main"]')) {
              roots.push(...region.querySelectorAll('button, input, textarea, [role="textbox"], [contenteditable="true"], [role="combobox"]'));
            } else {
              roots.push(region);
            }
          }
          roots = [...new Set(roots)].filter(element => !excluded(element));
          roots = roots.filter(element => !roots.some(parent => parent !== element && parent.contains(element)));
        }
        for (const root of roots) {
          if (root !== null) visit(root, 0, []);
          if (truncated) break;
        }
        return {
          url: location.href,
          title: document.title,
          nodes,
          truncated,
        };
      },
      {
        snapshotId,
        interactive,
        maxNodes,
        refProperty: REF_PROPERTY,
        rootSelector: options.rootSelector ?? null,
        excludeSelector: options.excludeSelector ?? null,
        controlScope: options.controlScope ?? false,
        compact: options.compact ?? false,
      },
    );

    let timer: ReturnType<typeof setTimeout> | undefined;
    const result = await Promise.race([
      evaluation,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new BrowserSnapshotError('browser.snapshot-timeout',
          'The provider page did not respond to inspection. The request was not resent; inspect provider health or explicitly refresh this exact request.')), 5_000);
      }),
    ]).finally(() => clearTimeout(timer));

    const tokens = new Map<string, string>();
    const refsByToken = new Map<string, string>();
    const snapshotNodes = new Map<string, BrowserSnapshotNode>();
    const nodes = result.nodes.map(({ token, ...node }) => {
      tokens.set(node.ref, token);
      refsByToken.set(token, node.ref);
      const value = Object.freeze(node);
      snapshotNodes.set(node.ref, value);
      return value;
    });
    this.#latestByPage.set(options.pageKey, {
      snapshotId,
      bindingEpoch: options.bindingEpoch,
      tokens,
      refsByToken,
      nodes: snapshotNodes,
    });
    return Object.freeze({
      requestOk: true,
      snapshotId,
      pageKey: options.pageKey,
      bindingEpoch: options.bindingEpoch,
      url: result.url,
      title: result.title,
      capturedAt: new Date().toISOString(),
      interactive,
      nodes: Object.freeze(nodes),
      nodesTruncated: result.truncated,
      stats: Object.freeze({ nodeCount: nodes.length, truncated: result.truncated }),
    });
  }

  async resolve(options: {
    readonly pageKey: string;
    readonly bindingEpoch: number;
    readonly page: Page;
    readonly ref: string;
    readonly snapshotId?: string;
  }): Promise<ElementHandle<Element>> {
    const record = this.#latestByPage.get(options.pageKey);
    if (record === undefined) {
      throw new BrowserSnapshotError(
        'browser.snapshot-required',
        `No browser snapshot exists for page ${options.pageKey}`,
      );
    }
    if (record.bindingEpoch !== options.bindingEpoch) {
      this.#latestByPage.delete(options.pageKey);
      throw new BrowserSnapshotError(
        'browser.snapshot-stale',
        `Page ${options.pageKey} navigated after the snapshot was captured`,
      );
    }
    if (options.snapshotId !== undefined && options.snapshotId !== record.snapshotId) {
      throw new BrowserSnapshotError(
        'browser.snapshot-stale',
        `Snapshot ${options.snapshotId} is not current for page ${options.pageKey}`,
      );
    }
    const token = record.tokens.get(options.ref);
    if (token === undefined) {
      throw new BrowserSnapshotError(
        'browser.ref-not-found',
        `Unknown browser ref ${options.ref} in snapshot ${record.snapshotId}`,
      );
    }

    const handle = await options.page.evaluateHandle(
      ({ expectedToken, refProperty }) => {
        const visit = (element: Element): Element | null => {
          if ((element as Element & Record<string, unknown>)[refProperty] === expectedToken) {
            return element;
          }
          for (const child of element.children) {
            const found = visit(child);
            if (found !== null) return found;
          }
          const shadowRoot = (element as HTMLElement).shadowRoot;
          if (shadowRoot !== null) {
            for (const child of shadowRoot.children) {
              const found = visit(child);
              if (found !== null) return found;
            }
          }
          return null;
        };
        const root = document.body ?? document.documentElement;
        return root === null ? null : visit(root);
      },
      { expectedToken: token, refProperty: REF_PROPERTY },
    );
    const element = handle.asElement();
    if (element === null) {
      await handle.dispose();
      throw new BrowserSnapshotError(
        'browser.ref-stale',
        `Browser ref ${options.ref} no longer resolves to an element`,
      );
    }
    return element as ElementHandle<Element>;
  }

  node(options: { readonly pageKey: string; readonly snapshotId: string; readonly ref: string }): BrowserSnapshotNode {
    const record = this.#latestByPage.get(options.pageKey);
    const node = record?.snapshotId === options.snapshotId ? record.nodes.get(options.ref) : undefined;
    if (node === undefined) {
      throw new BrowserSnapshotError('browser.snapshot-stale', 'Preparation decision does not match the current observation');
    }
    return node;
  }

  async nodeForElement(options: {
    readonly pageKey: string;
    readonly snapshotId: string;
    readonly element: ElementHandle<Element>;
  }): Promise<BrowserSnapshotNode> {
    const record = this.#latestByPage.get(options.pageKey);
    if (record?.snapshotId !== options.snapshotId) {
      throw new BrowserSnapshotError('browser.snapshot-stale', 'Preparation observation changed while resolving the selected control');
    }
    const token = await options.element.evaluate((element, property) =>
      (element as Element & Record<string, unknown>)[property], REF_PROPERTY);
    const ref = record.refsByToken.get(String(token));
    const node = ref === undefined ? undefined : record.nodes.get(ref);
    if (node === undefined) {
      throw new BrowserSnapshotError('browser.ref-stale', 'Selected control is absent from the current observation');
    }
    return node;
  }

  clear(pageKey: string): void {
    this.#latestByPage.delete(pageKey);
  }
}

export function sameSnapshotSemantics(left: BrowserSnapshotNode, right: BrowserSnapshotNode): boolean {
  const semanticFields = (node: BrowserSnapshotNode): string => {
    const { ref: _ref, box: _box, ...semantics } = node;
    return JSON.stringify(semantics);
  };
  return semanticFields(left) === semanticFields(right);
}

export function matchesPreparationTarget(
  node: BrowserSnapshotNode,
  target: PreparationTarget,
): boolean {
  const normalize = (value: string): string => value.replaceAll(/\s+/g, ' ').trim();
  return node.role === target.role && node.tag === target.tag && node.name === target.name &&
    (target.id === '' || node.id === target.id) &&
    (target.purpose === 'composer' || normalize(node.text) === normalize(target.text)) &&
    (target.placeholder === null || node.placeholder === target.placeholder);
}

export function isPreparationSummary(node: BrowserSnapshotNode, nodes: readonly BrowserSnapshotNode[]): boolean {
  return node.role === 'menuitem' && node.name.trim() !== '' && node.text.trim() !== '' &&
    node.text.trim() !== node.name.trim() && nodes.some((parent) =>
      parent.role === 'menu' && parent.id !== '' && node.ancestorIds.includes(parent.id));
}

export function hasPreparationSelectionEvidence(
  nodes: readonly BrowserSnapshotNode[],
  target: PreparationTarget,
): boolean {
  const normalize = (value: string): string => value.replaceAll(/\s+/g, ' ').trim().toLowerCase();
  if (target.role === 'slider' && target.selectedValue !== null) {
    return nodes.some((node) => matchesPreparationTarget(node, target) &&
      Number(node.ariaValueNow ?? node.value) === target.selectedValue);
  }
  if (target.role === 'menuitem') return nodes.some((node) => matchesPreparationTarget(node, target) &&
    isPreparationSummary(node, nodes));
  if (target.role === 'button') return nodes.some((node) => matchesPreparationTarget(node, target) &&
    node.hasPopup !== null);
  if (nodes.some((node) => matchesPreparationTarget(node, target) &&
      (node.selected === true || node.checked === true))) return true;
  const choice = normalize(target.name || target.text);
  return choice !== '' && nodes.some((node) => ['button', 'combobox'].includes(node.role) &&
    node.controls.some((id) => target.ancestorIds.includes(id)) &&
    normalize(`${node.name} ${node.text}`).includes(choice));
}
