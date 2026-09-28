import type { ElementHandle, Locator } from 'playwright-core';
import type { ProviderAttachment } from './provider-adapter.ts';

export async function attachmentsAcknowledged(
  composer: Locator | ElementHandle<Element>,
  attachments: readonly ProviderAttachment[],
  markers: readonly string[],
  messages: readonly string[],
): Promise<boolean> {
  return await (composer as Locator).evaluate((editor, { names, markers, excluded }) => {
    if (!editor.isConnected) return false;
    const form = editor.closest('form');
    let root: Element | null = form ?? editor.parentElement;
    while (form === null && root !== null && root.querySelector(markers) === null) root = root.parentElement;
    if (root === null) return false;
    const normalize = (value: string) => value.replace(/\s+/g, ' ').trim();
    const values = new Set<string>();
    const elements = form === null ? [...root.querySelectorAll(markers)] : [form, ...form.querySelectorAll(markers)];
    for (const element of elements) {
      if (element.closest('form') !== form || element.closest(excluded) !== null || element.getClientRects().length === 0 ||
          getComputedStyle(element).visibility === 'hidden') continue;
      values.add(normalize(element.getAttribute('aria-label') ?? ''));
      values.add(normalize(element.getAttribute('title') ?? ''));
      const parts: string[] = [];
      const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
      for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
        const parent = node.parentElement;
        if (parent !== null && parent.closest('form') === form && parent.closest(excluded) === null &&
            parent.getClientRects().length > 0 && getComputedStyle(parent).visibility !== 'hidden') {
          const text = node.textContent ?? '';
          values.add(normalize(text));
          parts.push(text);
        }
      }
      if (element !== form) values.add(normalize(parts.join('')));
    }
    return names.every((name) => values.has(normalize(name)));
  }, { names: attachments.map(({ name }) => name), markers: markers.join(', '),
    excluded: [...messages, 'article', 'nav', 'aside', '[role="navigation"]', 'textarea', 'input', '[contenteditable="true"]', '[role="textbox"]', 'button', '[role="button"]', 'script', 'style'].join(', ') });
}
