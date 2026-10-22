import { createHash } from 'node:crypto';
import type { Page } from 'playwright-core';
import { SessionPlaneDomainError } from '../../domain/errors.ts';

export interface HostSpanPermissionInput {
  action: 'inspect' | 'allow';
  appName: string;
  toolName: string;
  evidenceHash?: string | undefined;
}

const once = /^(?:허용|이번만 허용|한 번 허용|한 번만 허용|Allow|Allow once|Allow this time)(?:\s*⏎)?$/i;

/** Only an explicitly selected HostSpan tool permission, never a generic UI click. */
export async function controlHostSpanPermission(page: Page, input: HostSpanPermissionInput) {
  if (!/^hostspan(?:-[a-z0-9_-]+)?$/i.test(input.appName)) throw unavailable('Only HostSpan permissions are supported');
  const app = new RegExp(`(^|[^\\w-])${input.appName}($|[^\\w-])`, 'i');
  const scopes = page.locator('[role="dialog"], [role="alertdialog"], [role="alert"]');
  const matching = async () => {
    const matches = [];
    for (const scope of await scopes.all()) {
      if (!await scope.isVisible()) continue;
      const text = (await scope.innerText()).trim();
      if (app.test(text) && text.includes(input.toolName)) matches.push(scope);
    }
    return matches;
  };
  // ChatGPT opens command details in a separate modal over the permission alert.
  // Inspect and close only that exact modal, then act on the original permission.
  const closeDetails = async () => {
    const dialogs = await matching();
    let command = '';
    for (const dialog of dialogs) {
      if (!['dialog', 'alertdialog'].includes(await dialog.getAttribute('role') ?? '')) continue;
      const close = dialog.getByRole('button', { name: /^(?:대화 상자 닫기|Close dialog)$/i });
      if (await close.count() !== 1 || await dialog.getByRole('button', { name: once }).count() !== 0) continue;
      if (command) throw unavailable('The exact HostSpan command details are ambiguous');
      command = (await dialog.innerText()).trim();
      await close.click({ timeout: 5_000 });
      await dialog.waitFor({ state: 'hidden', timeout: 5_000 });
    }
    return command;
  };
  const find = async () => {
    const matches = await matching();
    if (matches.length !== 1) throw unavailable('The exact HostSpan tool permission is absent or ambiguous');
    let scope = matches[0]!;
    // The permission's action row can be a sibling of its ARIA alert.
    // Use only the nearest card with this single alert, never the page/main.
    while (await scope.getByRole('button', { name: once }).count() === 0) {
      const parent = scope.locator('..');
      if (await parent.evaluate(element => element.matches('body, main, [role="main"]') ||
          element.querySelector('[data-message-author-role="user"]') !== null) ||
          await parent.locator('[role="alert"], [role="alertdialog"], [role="dialog"]').count() !== 1) break;
      scope = parent;
    }
    if (await scope.getByRole('button', { name: once }).count() !== 1) {
      throw unavailable('The exact permission card must have one one-time Allow control');
    }
    return scope;
  };
  let command = await closeDetails();
  let scope = await find();
  const details = scope.getByRole('button', { name: /^(?:자세히 보기|View details|See details)$/i });
  if (await details.count() === 1 && await details.getAttribute('aria-expanded') !== 'true') {
    await details.click({ timeout: 5_000 });
    command = await closeDetails() || command;
    scope = await find();
  }
  const text = (await scope.innerText()).trim();
  const alertText = (await (await matching())[0]!.innerText()).trim();
  const buttons = await scope.getByRole('button').evaluateAll(elements => elements.map(element =>
    element.getAttribute('aria-label') ?? element.textContent ?? ''));
  const permissionText = command ? `${text}\n${command}` : text;
  const evidenceHash = createHash('sha256').update(JSON.stringify([page.url(), input.appName, input.toolName, permissionText])).digest('hex');
  if (input.action === 'inspect') return { outcome: 'inspected', appName: input.appName, toolName: input.toolName,
    evidenceHash, permissionText, buttons: buttons.map(name => name.trim()) };
  if (input.evidenceHash !== evidenceHash) throw unavailable('Inspect the current exact permission before allowing it');
  // Recheck the command/details and once-only button in the same DOM operation.
  const clicked = await scope.evaluate((element, expected) => {
    if (!(element instanceof HTMLElement) || element.innerText.trim() !== expected.text) return false;
    const buttons = [...element.querySelectorAll('button, [role="button"]')].filter(button =>
      button instanceof HTMLElement && button.getClientRects().length > 0 &&
      !button.hasAttribute('disabled') && button.getAttribute('aria-disabled') !== 'true' &&
      new RegExp(expected.once, 'i').test((button.getAttribute('aria-label') ?? button.textContent ?? '').trim()));
    if (buttons.length !== 1) return false;
    (buttons[0] as HTMLElement).click();
    return true;
  }, { text, once: once.source });
  if (!clicked) throw unavailable('The exact one-time Allow control changed or is unavailable');
  await page.waitForFunction(expected => ![...document.querySelectorAll('[role="dialog"], [role="alertdialog"], [role="alert"]')]
    .some(element => element instanceof HTMLElement && element.getClientRects().length > 0 &&
      element.innerText.trim() === expected), alertText, { timeout: 5_000 }).catch(() => undefined);
  return { outcome: 'clicked', appName: input.appName, toolName: input.toolName, evidenceHash,
    permissionStillVisible: await scopes.evaluateAll((elements, expected) => elements.some(element =>
      element instanceof HTMLElement && element.getClientRects().length > 0 && element.innerText.trim() === expected), alertText) };
}

function unavailable(message: string) { return new SessionPlaneDomainError('provider.permission-unverified', message); }
