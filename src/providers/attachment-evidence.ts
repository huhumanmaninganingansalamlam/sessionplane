import type { Page } from 'playwright-core';
import type { ProviderAttachment } from './provider-adapter.ts';

export async function attachmentsAcknowledged(
  page: Page,
  attachments: readonly ProviderAttachment[],
  markers: readonly string[],
  messages: readonly string[],
): Promise<boolean> {
  const values = await page.locator([...markers, 'form'].join(', ')).evaluateAll((elements, excluded) => {
    const values: string[] = [];
    for (const element of elements) {
      if (element.closest(excluded) !== null || element.getClientRects().length === 0) continue;
      values.push(element.getAttribute('aria-label') ?? '', element.getAttribute('title') ?? '');
      const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
      for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
        const parent = node.parentElement;
        if (parent !== null && parent.closest(excluded) === null && parent.getClientRects().length > 0 &&
            getComputedStyle(parent).visibility !== 'hidden') values.push(node.textContent ?? '');
      }
    }
    return values;
  }, [...messages, 'article', 'nav', 'aside', '[role="navigation"]', 'textarea', '[contenteditable="true"]', '[role="textbox"]', 'script', 'style'].join(', '));
  const normalize = (value: string) => value.toLowerCase().replace(/\s+/g, ' ').trim();
  const evidence = normalize(values.join(' '));
  return attachments.every(({ name }) => evidence.includes(normalize(name)));
}
