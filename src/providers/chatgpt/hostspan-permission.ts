import { createHash } from 'node:crypto';
import type { Page } from 'playwright-core';
import { SessionPlaneDomainError } from '../../domain/errors.ts';
import { readChatGptMessages } from './message-dom.ts';
import { CHATGPT_SELECTORS } from './selectors.ts';

export interface HostSpanPermissionInput {
  action: 'inspect' | 'allow';
  appName: string;
  toolName?: string | undefined;
  evidenceHash?: string | undefined;
  allowMode?: 'once' | 'always' | undefined;
}

const once = /^(?:허용|이번만 허용|한 번 허용|한 번만 허용|Allow|Allow once|Allow this time)(?:\s*⏎)?$/i;

const always = /^(?:항상 허용|Always allow)(?:\s*⏎)?$/i;

/** Reveal provider work in the exact owned conversation; never grants or submits. */
export async function revealCurrentWorkPermission(page: Page, submittedUserMessageId: string) {
  const users = (await readChatGptMessages(page, true)).filter(message => message.role === 'user');
  const anchor = users.filter(message => message.messageId === submittedUserMessageId);
  if (anchor.length !== 1 || users.at(-1) !== anchor[0] || anchor[0]!.elementIndex === undefined) {
    return false;
  }
  // A pending permission can remain in earlier work after a literal Continue.
  // Opening provider disclosures does not attribute their answer to that Continue.
  let opened = false;
  const work = page.locator('[class~="group/activity-header"] > button[aria-expanded]').or(
    page.getByRole('button', { name: /^(?:작업 중입니다|(?:[\d\s시간분초.]+ 동안 )?작업함|Working(?:…|\.\.\.)?|Worked for .+)$/i }))
    .and(page.locator('[aria-expanded="false"], [data-state="closed"]'));
  for (const button of await work.all()) {
    const visibleGrant = page.locator('[role="alert"], [role="alertdialog"], [role="dialog"]')
      .filter({ hasText: /hostspan(?:-[a-z0-9_-]+)?/i }).filter({ visible: true });
    if (await visibleGrant.count() > 0) break;
    if (!await button.isVisible() || (await button.getAttribute('aria-expanded') !== 'false' &&
        await button.getAttribute('data-state') !== 'closed')) continue;
    const start = users[0]!;
    const anchorElement = await page.locator(CHATGPT_SELECTORS.messages).nth(start.elementIndex!).elementHandle();
    if (!anchorElement) throw unavailable('The original user anchor is no longer mounted');
    const current = await button.evaluate((element, user) =>
      !!(user.compareDocumentPosition(element) & Node.DOCUMENT_POSITION_FOLLOWING) &&
      !element.closest('nav, aside, [role="navigation"], .markdown, [data-message-author-role="user"], [data-user-message-bubble]'), anchorElement).finally(() => anchorElement.dispose());
    if (current) { await button.click({ timeout: 5_000 }); opened = true; }
  }
  return opened;
}

/** Only an explicitly selected HostSpan tool permission, never a generic UI click. */
export async function controlHostSpanPermission(page: Page, input: HostSpanPermissionInput, submittedUserMessageId: string) {
  if (!/^hostspan(?:-[a-z0-9_-]+)?$/i.test(input.appName)) throw unavailable('Only HostSpan permissions are supported');
  const allowMode = input.allowMode ?? 'once';
  const allow = allowMode === 'always' ? always : once;
  if (input.action === 'allow' && !input.toolName) throw unavailable('Select the observed tool name before allowing it');
  await revealCurrentWorkPermission(page, submittedUserMessageId);
  const app = new RegExp(`(^|[^\\w-])${input.appName}($|[^\\w-])`, 'i');
  const scopes = page.locator('[role="dialog"], [role="alertdialog"], [role="alert"]');
  const matching = async () => {
    const matches = [];
    for (const scope of await scopes.all()) {
      if (!await scope.isVisible()) continue;
      const text = (await scope.innerText()).trim();
      if (app.test(text) && (input.toolName === undefined || text.includes(input.toolName))) matches.push(scope);
    }
    return matches;
  };
  const permissionAnchor = async (scope: ReturnType<Page['locator']>) => {
    const users = (await readChatGptMessages(page, true)).filter(message => message.role === 'user');
    for (const user of users.toReversed()) {
      if (user.elementIndex === undefined) continue;
      const element = await page.locator(CHATGPT_SELECTORS.messages).nth(user.elementIndex).elementHandle();
      if (element && await scope.evaluate((card, node) =>
          !!(node.compareDocumentPosition(card) & Node.DOCUMENT_POSITION_FOLLOWING), element).finally(() => element.dispose())) return user.messageId;
    }
    return null;
  };
  if (input.action === 'inspect' && input.toolName === undefined) {
    const cards = [];
    for (const scope of await matching()) cards.push({ permissionText: (await scope.innerText()).trim(),
      submittedUserMessageId: await permissionAnchor(scope),
      buttons: await scope.getByRole('button').allTextContents() });
    return { outcome: 'discovered', allowMode, appName: input.appName, cards,
      workDisclosures: await page.getByRole('button', { name: /작업|Working|Worked for/i, includeHidden: true })
        .evaluateAll(elements => elements.map(element => ({ name: element.getAttribute('aria-label') ?? element.textContent,
          expanded: element.getAttribute('aria-expanded'), state: element.getAttribute('data-state'),
          visible: element.getClientRects().length > 0 }))) };
  }
  // ChatGPT opens command details in a separate modal over the permission alert.
  // Inspect and close only that exact modal, then act on the original permission.
  const closeDetails = async () => {
    const dialogs = await matching();
    let command = '';
    for (const dialog of dialogs) {
      if (!['dialog', 'alertdialog'].includes(await dialog.getAttribute('role') ?? '')) continue;
      const close = dialog.getByRole('button', { name: /^(?:대화 상자 닫기|Close dialog)$/i });
      if (await close.count() !== 1 || await dialog.getByRole('button', { name: allow }).count() !== 0) continue;
      if (command) throw unavailable('The exact HostSpan command details are ambiguous');
      command = (await dialog.innerText()).trim();
      await close.click({ timeout: 5_000 });
      await dialog.waitFor({ state: 'hidden', timeout: 5_000 });
    }
    return command;
  };
  const find = async () => {
    let matches = await matching();
    if (matches.length === 2) {
      // Details can expose the exact grant in a modal over its original alert.
      const grants = [];
      for (const match of matches) if (['dialog', 'alertdialog'].includes(await match.getAttribute('role') ?? '') &&
          await match.getByRole('button', { name: allow }).count() === 1) grants.push(match);
      if (grants.length === 1) matches = grants;
    }
    if (matches.length !== 1) throw unavailable('The exact HostSpan tool permission is absent or ambiguous');
    let scope = matches[0]!;
    // The permission's action row can be a sibling of its ARIA alert.
    // Use only the nearest card with this single alert, never the page/main.
    while (await scope.getByRole('button', { name: allow }).count() === 0) {
      const parent = scope.locator('..');
      if (await parent.evaluate(element => element.matches('body, main, [role="main"]') ||
          element.querySelector('[data-message-author-role="user"]') !== null) ||
          await parent.locator('[role="alert"], [role="alertdialog"], [role="dialog"]').count() !== 1) break;
      scope = parent;
    }
    if (await scope.getByRole('button', { name: allow }).count() !== 1) {
      throw unavailable('The exact permission card must have one selected Allow control');
    }
    return scope;
  };
  let command = await closeDetails();
  const cards = await matching();
  if (cards.length === 1) {
    const details = cards[0]!.getByRole('button', { name: /^(?:자세히 보기|View details|See details)$/i });
    if (await details.count() === 1 && await details.getAttribute('aria-expanded') !== 'true') {
      // The current permission may expose only Details until its actions open.
      await details.click({ timeout: 5_000 });
      command = await closeDetails() || command;
    }
  }
  const scope = await find();
  const text = (await scope.innerText()).trim();
  const alertText = (await (await matching())[0]!.innerText()).trim();
  const buttons = await scope.getByRole('button').evaluateAll(elements => elements.map(element =>
    element.getAttribute('aria-label') ?? element.textContent ?? ''));
  const permissionText = command ? `${text}\n${command}` : text;
  const permissionUserMessageId = await permissionAnchor(scope);
  const evidenceHash = createHash('sha256').update(JSON.stringify([page.url(), input.appName, input.toolName, allowMode, permissionUserMessageId, permissionText])).digest('hex');
  if (input.action === 'inspect') return { outcome: 'inspected', allowMode, appName: input.appName, toolName: input.toolName,
    evidenceHash, permissionUserMessageId, permissionText, buttons: buttons.map(name => name.trim()) };
  if (input.evidenceHash !== evidenceHash) throw unavailable('Inspect the current exact permission before allowing it');
  // Recheck the command/details and explicitly selected button in the same DOM operation.
  const clicked = await scope.evaluate((element, expected) => {
    if (!(element instanceof HTMLElement) || element.innerText.trim() !== expected.text) return false;
    const buttons = [...element.querySelectorAll('button, [role="button"]')].filter(button =>
      button instanceof HTMLElement && button.getClientRects().length > 0 &&
      !button.hasAttribute('disabled') && button.getAttribute('aria-disabled') !== 'true' &&
      new RegExp(expected.allow, 'i').test((button.getAttribute('aria-label') ?? button.textContent ?? '').trim()));
    if (buttons.length !== 1) return false;
    (buttons[0] as HTMLElement).click();
    return true;
  }, { text, allow: allow.source });
  if (!clicked) throw unavailable('The exact selected Allow control changed or is unavailable');
  await page.waitForFunction(expected => ![...document.querySelectorAll('[role="dialog"], [role="alertdialog"], [role="alert"]')]
    .some(element => element instanceof HTMLElement && element.getClientRects().length > 0 &&
      element.innerText.trim() === expected), alertText, { timeout: 5_000 }).catch(() => undefined);
  return { outcome: 'clicked', allowMode, appName: input.appName, toolName: input.toolName, evidenceHash, permissionUserMessageId,
    permissionStillVisible: await scopes.evaluateAll((elements, expected) => elements.some(element =>
      element instanceof HTMLElement && element.getClientRects().length > 0 && element.innerText.trim() === expected), alertText) };
}

function unavailable(message: string) { return new SessionPlaneDomainError('provider.permission-unverified', message); }
