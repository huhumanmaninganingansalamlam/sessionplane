import { createHash } from 'node:crypto';
import type { Page } from 'playwright-core';
import { SessionPlaneDomainError } from '../../domain/errors.ts';
import { readChatGptMessages } from './message-dom.ts';

// This provider-owned card submits its answer options directly. Ordinary model
// radios, permission dialogs and arbitrary page forms are not question controls.
const QUESTION = '[data-codex-composer-request-navigation="true"][data-user-input-auto-resolution="true"]';

export async function inspectChatGptQuestion(page: Page) {
  const question = await page.locator(QUESTION).evaluateAll(elements => {
    const visible = (e: Element) => e.closest('[aria-hidden="true"], [inert]') === null &&
      e.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true }) && e.getBoundingClientRect().width > 0;
    const panels = elements.filter(visible);
    if (panels.length !== 1) return null;
    const panel = panels[0]!;
    if (panel.closest('article, [data-message-author-role], nav, aside, [role="dialog"], [role="alertdialog"], [role="menu"]')) return null;
    const groups = [...panel.querySelectorAll('[role="radiogroup"]')].filter(visible);
    if (groups.length !== 1) return null;
    const buttons = [...groups[0]!.querySelectorAll('button[role="radio"][type="button"]')].filter(visible);
    const options = buttons.map(e => ({ answer: (e.getAttribute('aria-label') ?? '').trim(),
      disabled: e.matches(':disabled, [aria-disabled="true"]') }));
    if (options.length < 2 || options.length > 20 || options.some(o => !o.answer || o.answer.length > 500) ||
        new Set(options.map(o => o.answer)).size !== options.length) return null;
    const editors = [...panel.querySelectorAll('textarea, input, [contenteditable="true"]')];
    const draftPresent = editors.some(e => (e instanceof HTMLInputElement || e instanceof HTMLTextAreaElement
      ? e.value : (e as HTMLElement).innerText).trim().length > 0);
    const text = (panel as HTMLElement).innerText.trim();
    return { text: text.slice(0, 4000), truncated: text.length > 4000, options, draftPresent };
  });
  if (question === null) return null;
  const users = (await readChatGptMessages(page)).filter(message => message.role === 'user');
  const evidenceHash = createHash('sha256').update(JSON.stringify({ url: page.url(),
    userMessageId: users.at(-1)?.messageId ?? null, text: question.text, options: question.options })).digest('hex');
  return { ...question, evidenceHash, available: !question.truncated && !question.draftPresent };
}

export async function answerChatGptQuestion(page: Page, input: { answer: string; evidenceHash: string }, beforeClick: () => void) {
  const observed = await inspectChatGptQuestion(page);
  if (!observed?.available || observed.evidenceHash !== input.evidenceHash ||
      !observed.options.some(option => option.answer === input.answer && !option.disabled)) {
    throw new SessionPlaneDomainError('provider.question-unverified',
      'Inspect the current owned question and choose an enabled exact answer with its fresh evidenceHash; preserve any draft');
  }
  // No default/recommended answer is selected by SessionPlane.
  const option = page.locator(QUESTION).getByRole('radio', { name: input.answer, exact: true });
  if (await option.count() !== 1) throw new SessionPlaneDomainError('provider.question-unverified', 'Question answer is ambiguous');
  beforeClick();
  let clickError: unknown;
  try { await option.click({ timeout: 5000 }); }
  catch (error) { clickError = error; }
  const deadline = performance.now() + 1500;
  do {
    const current = await inspectChatGptQuestion(page);
    if (current === null || current.evidenceHash !== observed.evidenceHash) return {
      outcome: current === null ? 'answered' as const : 'advanced' as const,
      evidenceHash: observed.evidenceHash, questionStillVisible: current !== null,
      promptSubmitted: false as const,
    };
    if (performance.now() >= deadline) break;
    await page.waitForTimeout(100);
  } while (true);
  throw new SessionPlaneDomainError('provider.action-unknown',
    clickError ? 'Question click outcome is unknown; inspect without repeating the answer'
      : 'Question did not visibly advance after one answer click; inspect without repeating it');
}
