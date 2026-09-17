import { randomUUID } from 'node:crypto';

import type { ElementHandle, Page } from 'playwright-core';

const REF_PROPERTY = '__sessionplaneRefToken';

export interface BrowserSnapshotNode {
  readonly ref: string;
  readonly role: string;
  readonly name: string;
  readonly tag: string;
  readonly text: string;
  readonly depth: number;
  readonly disabled: boolean;
  readonly checked: boolean | null;
  readonly selected: boolean | null;
  readonly href: string | null;
  readonly placeholder: string | null;
  readonly value: string | null;
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
  readonly stats: {
    readonly nodeCount: number;
    readonly truncated: boolean;
  };
}

interface SnapshotRecord {
  readonly snapshotId: string;
  readonly bindingEpoch: number;
  readonly tokens: ReadonlyMap<string, string>;
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
  }): Promise<BrowserSnapshot> {
    const snapshotId = randomUUID();
    const interactive = options.interactive ?? true;
    const maxNodes = Math.max(1, Math.min(5_000, options.maxNodes ?? 250));
    const result = await options.page.evaluate(
      ({ snapshotId: browserSnapshotId, interactive: interactiveOnly, maxNodes: limit, refProperty }) => {
        type MutableSnapshotNode = {
          ref: string;
          token: string;
          role: string;
          name: string;
          tag: string;
          text: string;
          depth: number;
          disabled: boolean;
          checked: boolean | null;
          selected: boolean | null;
          href: string | null;
          placeholder: string | null;
          value: string | null;
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

        const accessibleName = (element: Element): string => {
          const ariaLabel = element.getAttribute('aria-label');
          if (ariaLabel !== null && ariaLabel.trim() !== '') return normalize(ariaLabel);
          const labelledBy = element.getAttribute('aria-labelledby');
          if (labelledBy !== null) {
            const label = labelledBy
              .split(/\s+/)
              .map((id) => document.getElementById(id)?.textContent ?? '')
              .join(' ');
            if (label.trim() !== '') return normalize(label);
          }
          const htmlElement = element as HTMLElement;
          if (htmlElement.id !== '') {
            try {
              const label = document.querySelector(`label[for="${CSS.escape(htmlElement.id)}"]`);
              if (label?.textContent?.trim()) return normalize(label.textContent);
            } catch {
              // Ignore malformed ids and continue through the name fallback chain.
            }
          }
          const wrappingLabel = element.closest('label');
          if (wrappingLabel?.textContent?.trim()) return normalize(wrappingLabel.textContent);
          const alt = element.getAttribute('alt');
          if (alt !== null && alt.trim() !== '') return normalize(alt);
          const title = element.getAttribute('title');
          if (title !== null && title.trim() !== '') return normalize(title);
          const placeholder = element.getAttribute('placeholder');
          if (placeholder !== null && placeholder.trim() !== '') return normalize(placeholder);
          const value =
            element instanceof HTMLInputElement ||
            element instanceof HTMLTextAreaElement ||
            element instanceof HTMLSelectElement
              ? element.value
              : null;
          if (value !== null && value.trim() !== '') return normalize(value);
          return normalize(element.textContent);
        };

        const isVisible = (element: Element): boolean => {
          if (!(element instanceof HTMLElement || element instanceof SVGElement)) return false;
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
              'menuitem',
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

        const visit = (element: Element, depth: number): void => {
          if (nodes.length >= limit) {
            truncated = true;
            return;
          }
          const visible = isVisible(element);
          const role = inferredRole(element);
          const include = visible && (!interactiveOnly || isInteractive(element, role));
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
            nodes.push({
              ref,
              token,
              role,
              name: accessibleName(element),
              tag: element.tagName.toLowerCase(),
              text: normalize(element.textContent, 500),
              depth,
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
                  : element.getAttribute('aria-selected') === null
                    ? null
                    : element.getAttribute('aria-selected') === 'true',
              href: element instanceof HTMLAnchorElement ? element.href : null,
              placeholder: element.getAttribute('placeholder'),
              value,
              box: {
                x: rect.x,
                y: rect.y,
                width: rect.width,
                height: rect.height,
              },
            });
          }

          if (!visible && element !== document.body && element !== document.documentElement) {
            return;
          }
          for (const child of element.children) {
            visit(child, depth + 1);
            if (truncated) return;
          }
          const shadowRoot = (element as HTMLElement).shadowRoot;
          if (shadowRoot !== null) {
            for (const child of shadowRoot.children) {
              visit(child, depth + 1);
              if (truncated) return;
            }
          }
        };

        const root = document.body ?? document.documentElement;
        if (root !== null) visit(root, 0);
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
      },
    );

    const tokens = new Map<string, string>();
    const nodes = result.nodes.map(({ token, ...node }) => {
      tokens.set(node.ref, token);
      return Object.freeze(node);
    });
    this.#latestByPage.set(options.pageKey, {
      snapshotId,
      bindingEpoch: options.bindingEpoch,
      tokens,
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

  clear(pageKey: string): void {
    this.#latestByPage.delete(pageKey);
  }
}
