import { createHash } from 'node:crypto';
import type { Page } from 'playwright-core';

const PANEL = '[data-codex-composer-request-navigation="true"][data-user-input-auto-resolution="true"]';
const EDITOR = 'textarea, input[type="text"], [role="textbox"][contenteditable="true"]';
const BUTTON = 'button, [role="button"]';
const CONTROL_LABEL = /^(submit|send|confirm|continue|제출|전송|확인|계속)$/i;

/** Provider-owned question panel only. General page forms and the ordinary
 * chat composer never qualify as an agent-input request.
 */
export async function inspectChatGptFreeTextQuestion(page: Page) {
  const observed = await page.locator(PANEL).evaluateAll((panels, { editorSelector, buttonSelector, labelPattern }) => {
    const visible = (element: Element) =>
      element.closest('[aria-hidden="true"], [inert]') === null &&
      element.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true }) &&
      element.getBoundingClientRect().width > 0;
    const current = panels.filter(visible);
    if (current.length !== 1) return null;
    const panel = current[0]!;
    if (panel.closest('article, [data-message-author-role], nav, aside, [role="dialog"], [role="alertdialog"], [role="menu"]') ||
      panel.querySelector('[role="radiogroup"]') !== null) return null;
    const editors = [...panel.querySelectorAll<HTMLElement>(editorSelector)];
    const candidateEditors = editors.flatMap((e, index) => visible(e) && !e.matches(
      ':disabled, [aria-disabled="true"], [readonly]') ? [{
        index, tag: e.tagName.toLowerCase(), role: e.getAttribute('role'),
        label: e.getAttribute('aria-label') ?? '', draft: e instanceof HTMLInputElement ||
          e instanceof HTMLTextAreaElement ? e.value : e.innerText,
      }] : []);
    const buttons = [...panel.querySelectorAll<HTMLElement>(buttonSelector)];
    const candidateButtons = buttons.flatMap((e, index) => {
      if (!visible(e) || e.matches(':disabled, [aria-disabled="true"]')) return [];
      const label = (e.getAttribute('aria-label') ?? e.innerText ?? '').replace(/\s+/g, ' ').trim();
      const form = candidateEditors.length === 1 ? editors[candidateEditors[0]!.index]?.closest('form') : null;
      const submitForm = e.getAttribute('type') === 'submit' &&
        form !== null && form === e.closest('form');
      if (!submitForm && !(new RegExp(labelPattern, 'i')).test(label)) return [];
      return [{ index, tag: e.tagName.toLowerCase(), label, type: e.getAttribute('type') }];
    });
    const text = (panel as HTMLElement).innerText.trim();
    return {
      text: text.slice(0, 4_000), truncated: text.length > 4_000,
      editor: candidateEditors.length === 1 ? candidateEditors[0] : null,
      submit: candidateButtons.length === 1 ? candidateButtons[0] : null,
      editorCount: candidateEditors.length,
      submitCount: candidateButtons.length,
    };
  }, { editorSelector: EDITOR, buttonSelector: BUTTON, labelPattern: CONTROL_LABEL.source });
  if (!observed) return null;
  const evidenceHash = createHash('sha256').update(JSON.stringify({
    url: page.url(), text: observed.text, editor: observed.editor,
    submit: observed.submit, editorCount: observed.editorCount,
    submitCount: observed.submitCount,
  })).digest('hex');
  return {
    ...observed, evidenceHash,
    available: !observed.truncated && observed.text.length > 0 &&
      observed.editorCount === 1 && observed.submitCount === 1 &&
      observed.editor?.draft.length === 0,
  };
}

/**
 * Fill and submit one exact owned free-text question after a fresh evidence
 * check. A click is not retried; if the question remains, the outcome is
 * uncertain. Any retained draft prevents a second fill.
 */
export async function answerChatGptFreeTextQuestion(
  page: Page,
  input: { readonly answer: string; readonly evidenceHash: string },
  beforeSubmit: () => void,
): Promise<void> {
  if (!input.answer.trim() || input.answer.length > 2_000) {
    throw new Error('Free-text question answer must be bounded and nonempty');
  }
  const observed = await inspectChatGptFreeTextQuestion(page);
  if (!observed?.available || observed.evidenceHash !== input.evidenceHash ||
    !observed.editor || !observed.submit) {
    throw new Error('Free-text question changed or contains an existing draft');
  }
  const panel = page.locator(PANEL);
  if (await panel.count() !== 1) throw new Error('Question panel ambiguous');
  const editor = await panel.locator(EDITOR).nth(observed.editor.index).elementHandle();
  const submit = await panel.locator(BUTTON).nth(observed.submit.index).elementHandle();
  if (!editor || !submit) {
    await editor?.dispose(); await submit?.dispose();
    throw new Error('Exact free-text question controls disappeared');
  }
  try {
    // Keep handles tied to the original controls; no re-resolving by a generic
    // label after the editor rerenders or the panel changes identity.
    const editorSignature = await editor.evaluate(e => ({
      tag: e.tagName.toLowerCase(), role: e.getAttribute('role'),
      label: e.getAttribute('aria-label') ?? '',
      draft: e instanceof HTMLInputElement || e instanceof HTMLTextAreaElement
        ? e.value : (e as HTMLElement).innerText,
    }));
    if (JSON.stringify(editorSignature) !== JSON.stringify({
      tag: observed.editor.tag, role: observed.editor.role,
      label: observed.editor.label, draft: observed.editor.draft,
    })) throw new Error('Question editor changed before fill');
    await editor.fill(input.answer, { timeout: 5_000 });
    beforeSubmit();
    const buttonSignature = await submit.evaluate(e => ({
      tag: e.tagName.toLowerCase(),
      label: (e.getAttribute('aria-label') ?? (e as HTMLElement).innerText ?? '').replace(/\s+/g, ' ').trim(),
      type: e.getAttribute('type'),
      connected: e.isConnected && !e.matches(':disabled, [aria-disabled="true"]'),
    }));
    if (!buttonSignature.connected || buttonSignature.tag !== observed.submit.tag ||
      buttonSignature.label !== observed.submit.label ||
      buttonSignature.type !== observed.submit.type) {
      throw new Error('Question submission control changed after fill');
    }
    await submit.click({ timeout: 5_000 });
  } finally {
    await editor.dispose(); await submit.dispose();
  }
  // Verify a real provider question transition, not merely an input event.
  const deadline = Date.now() + 1_500;
  do {
    const current = await page.locator(PANEL).count();
    if (current === 0) return;
    if (Date.now() >= deadline) break;
    await page.waitForTimeout(100);
  } while (true);
  throw new Error('Free-text question still mounted after one submission; inspect before retry');
}
