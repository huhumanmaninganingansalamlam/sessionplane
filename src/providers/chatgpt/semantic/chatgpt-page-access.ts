import { createHash } from "node:crypto";
import type { ElementHandle, Page } from "playwright-core";
import type { OwnedPageIdentity } from "../../../browser/owned-page-lifecycle.ts";
import type { SemanticTaskContext } from "../../semantic-adapter.ts";
import { EDITORS, BUTTONS, EMPTY_PROSEMIRROR_MARKER, SEND_LABEL } from "./semantic-types.ts";
import type { Control, UiSnapshot } from "./semantic-types.ts";

export function sha(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

export function conversationBindingProblem(page: Page, context: SemanticTaskContext): string | null {
  const id = context.providerConversationId;
  const current = new URL(page.url());
  if (id === null) {
    if (context.submittedUserMessageId !== null || context.submittedUserTurnId !== null) {
      return 'unbound-root-cannot-have-a-submitted-turn';
    }
    return current.pathname === '/' && current.search === '' && current.hash === ''
      ? null : 'conversation-binding-required';
  }
  if (!/^[A-Za-z0-9_-]{1,160}$/.test(id)) return 'conversation-binding-required';
  const expected = `/c/${encodeURIComponent(id)}`;
  return current.pathname === expected ? null : 'conversation-url-mismatch';
}

export function contextKey(context: SemanticTaskContext): string {
  return JSON.stringify(context);
}

export function exactContext(context: SemanticTaskContext, lease: OwnedPageIdentity): boolean {
  return context.projectId === lease.projectId && context.slotId === lease.slotId &&
    context.slotRevision === lease.slotRevision && context.taskId === lease.taskId;
}

export async function captureUi(page: Page): Promise<UiSnapshot> {
  const ui = await page.evaluate(async ({ editorsSelector, buttonSelector, sendPattern, emptyEditorMarker }) => {
    const visible = (element: Element) =>
      !element.closest('nav, aside, article, [role="navigation"], [role="search"], [role="dialog"], [role="alertdialog"], [aria-hidden="true"], [inert], [data-message-author-role], [data-chatgpt-search-message-ids], .markdown') &&
      element.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true }) &&
      element.getBoundingClientRect().width > 0;
    const enabled = (element: Element) => !element.matches(
      ':disabled, [aria-disabled="true"], [readonly]');
    const signature = (e: Element) => [
      e.tagName.toLowerCase(), e.id, e.getAttribute('data-testid'),
      e.getAttribute('role'), e.getAttribute('aria-label'),
      e.getAttribute('placeholder'), e.getAttribute('type'),
    ].join('|');
    const allEditors = [...document.querySelectorAll<HTMLElement>(editorsSelector)];
    const editors = allEditors.flatMap((e, index) => {
      if (!visible(e) || !enabled(e) || !(e.isContentEditable || e instanceof HTMLTextAreaElement)) return [];
      const raw = e instanceof HTMLTextAreaElement ? e.value : e.innerText;
      const structuralPlaceholder = !(e instanceof HTMLTextAreaElement) && e.classList.contains('ProseMirror') &&
        raw === '\n' && e.textContent === '' && e.querySelector(emptyEditorMarker) !== null;
      // innerText may collapse a human-entered whitespace-only paragraph to an
      // empty string. textContent is the final guard against overwriting it.
      const value = structuralPlaceholder ? '' : raw === '' && e.textContent !== '' ? e.textContent : raw;
      return [{ index, signature: signature(e), value, enabled: true }];
    });
    const editor = editors.length === 1 ? allEditors[editors[0]!.index] ?? null : null;
    const composer = editor?.closest('[data-chatgpt-composer]') ?? null;
    const allButtons = [...document.querySelectorAll<HTMLElement>(buttonSelector)];
    const buttons = allButtons.flatMap((e, index) => {
      if (!visible(e)) return [];
      const label = (e.getAttribute('aria-label') ?? e.innerText ?? '').replace(/\s+/g, ' ').trim();
      const known = (e.id === 'composer-submit-button' || e.getAttribute('data-testid') === 'send-button') &&
        (composer === null || e.closest('[data-chatgpt-composer]') === composer);
      const nativeSubmit = e.getAttribute('type') === 'submit' && editor !== null &&
        e.closest('form') !== null && e.closest('form') === editor.closest('form');
      const labelledSubmit = composer !== null &&
        e.closest('[data-chatgpt-composer]') === composer && (new RegExp(sendPattern, 'i')).test(label);
      if (!known && !nativeSubmit && !labelledSubmit) return [];
      return [{ index, signature: signature(e), value: label, enabled: enabled(e) }];
    });
    // A not-yet-submitted Task has no canonical user ID. Pin its existing
    // transcript boundary along with the composer, so a new human turn
    // cannot inherit an old compose/submit actionRef. Keep user text inside
    // the renderer and return only its digest.
    const userNodes = [...document.querySelectorAll<HTMLElement>(
      'main [data-message-author-role="user"], main [data-user-message-bubble]',
    )].filter(node => node.parentElement?.closest(
      '[data-message-author-role="user"], [data-user-message-bubble]') === null);
    const userBoundary = JSON.stringify(userNodes.map(node => [
      node.getAttribute('data-message-id'), node.getAttribute('data-turn-id'),
      node.getAttribute('data-dil-message-id'),
      node.closest('[data-chatgpt-search-message-ids]')?.getAttribute('data-chatgpt-search-message-ids'),
      node.textContent,
    ]));
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(userBoundary));
    const userBoundarySha256 = [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('');
    return { editors, buttons, userBoundarySha256 };
  }, { editorsSelector: EDITORS, buttonSelector: BUTTONS, sendPattern: SEND_LABEL.source,
    emptyEditorMarker: EMPTY_PROSEMIRROR_MARKER });
  const editor = ui.editors.length === 1 ? ui.editors[0]! : null;
  const draftSha256 = editor === null ? null : sha(editor.value.replaceAll('\r\n', '\n'));
  return {
    ...ui, draftSha256,
    fingerprint: sha(JSON.stringify({ editor: ui.editors, buttons: ui.buttons,
      draftSha256, userBoundarySha256: ui.userBoundarySha256 })),
  };
}

export async function exactHandle(page: Page, selector: string, expected: Control): Promise<ElementHandle<HTMLElement>> {
  const handle = await page.locator(selector).nth(expected.index).elementHandle({ timeout: 2_000 });
  if (handle === null) throw new Error('Exact semantic control disappeared');
  const actual = await handle.evaluate(e => [
    e.tagName.toLowerCase(), e.id, e.getAttribute('data-testid'),
    e.getAttribute('role'), e.getAttribute('aria-label'),
    e.getAttribute('placeholder'), e.getAttribute('type'),
  ].join('|')).catch(() => null);
  if (actual !== expected.signature) {
    await handle.dispose();
    throw new Error('Semantic control was replaced during action');
  }
  return handle as ElementHandle<HTMLElement>;
}

export async function readExactEditorValue(handle: ElementHandle<HTMLElement>,
  expected: Control): Promise<string | null> {
  return await handle.evaluate((element, input) => {
    const signature = [
      element.tagName.toLowerCase(), element.id, element.getAttribute('data-testid'),
      element.getAttribute('role'), element.getAttribute('aria-label'),
      element.getAttribute('placeholder'), element.getAttribute('type'),
    ].join('|');
    if (!element.isConnected || signature !== input.signature ||
      element.matches(':disabled, [aria-disabled="true"], [readonly]')) return null;
    if (element instanceof HTMLTextAreaElement) return element.value;
    if (!element.isContentEditable) return null;
    const raw = element.innerText;
    const structuralPlaceholder = element.classList.contains('ProseMirror') && raw === '\n' &&
      element.textContent === '' && element.querySelector(input.emptyEditorMarker) !== null;
    return structuralPlaceholder ? '' :
      raw === '' && element.textContent !== '' ? element.textContent : raw;
  }, {
    signature: expected.signature,
    emptyEditorMarker: EMPTY_PROSEMIRROR_MARKER,
  }).catch(() => null);
}

export async function exactControlReady(handle: ElementHandle<HTMLElement>,
  expected: Control): Promise<boolean> {
  return await handle.evaluate((element, signature) =>
    element.isConnected &&
    !element.matches(':disabled, [aria-disabled="true"], [readonly]') &&
    [
      element.tagName.toLowerCase(), element.id, element.getAttribute('data-testid'),
      element.getAttribute('role'), element.getAttribute('aria-label'),
      element.getAttribute('placeholder'), element.getAttribute('type'),
    ].join('|') === signature,
  expected.signature).catch(() => false);
}
