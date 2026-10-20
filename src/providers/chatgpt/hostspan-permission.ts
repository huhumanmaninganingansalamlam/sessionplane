import { createHash } from 'node:crypto';
import type { Page } from 'playwright-core';
import { SessionPlaneDomainError } from '../../domain/errors.ts';

export interface HostSpanPermissionInput {
  action: 'inspect' | 'allow';
  appName: string;
  toolName: string;
  evidenceHash?: string | undefined;
}

const once = /^(?:허용|이번만 허용|한 번 허용|Allow|Allow once|Allow this time)$/i;

/** Only an explicitly selected HostSpan tool permission, never a generic UI click. */
export async function controlHostSpanPermission(page: Page, input: HostSpanPermissionInput) {
  if (!/^hostspan(?:-[a-z0-9_-]+)?$/i.test(input.appName)) throw unavailable('Only HostSpan permissions are supported');
  const app = new RegExp(`(^|[^\\w-])${input.appName}($|[^\\w-])`, 'i');
  const scopes = page.locator('[role="dialog"], [role="alertdialog"], [role="alert"]');
  const find = async () => {
    const matches = [];
    for (const scope of await scopes.all()) {
      if (!await scope.isVisible()) continue;
      const text = (await scope.innerText()).trim();
      if (app.test(text) && text.includes(input.toolName)) matches.push(scope);
    }
    if (matches.length !== 1) throw unavailable('The exact HostSpan tool permission is absent or ambiguous');
    return matches[0]!;
  };
  let scope = await find();
  if (input.action === 'inspect') {
    const details = scope.getByRole('button', { name: /^(?:자세히 보기|View details|See details)$/i });
    if (await details.count() === 1 && await details.getAttribute('aria-expanded') !== 'true') {
      await details.click({ timeout: 5_000 });
      scope = await find();
    }
  }
  const text = (await scope.innerText()).trim();
  const buttons = await scope.getByRole('button').allTextContents();
  const evidenceHash = createHash('sha256').update(JSON.stringify([page.url(), input.appName, input.toolName, text])).digest('hex');
  if (input.action === 'inspect') return { outcome: 'inspected', appName: input.appName, toolName: input.toolName,
    evidenceHash, permissionText: text, buttons: buttons.map(name => name.trim()) };
  if (input.evidenceHash !== evidenceHash) throw unavailable('Inspect the current exact permission before allowing it');
  // Recheck the command/details and once-only button in the same DOM operation.
  const clicked = await scope.evaluate((element, expected) => {
    if (!(element instanceof HTMLElement) || element.innerText.trim() !== expected.text) return false;
    const buttons = [...element.querySelectorAll('button, [role="button"]')].filter(button =>
      button instanceof HTMLElement && button.getClientRects().length > 0 &&
      !button.hasAttribute('disabled') && button.getAttribute('aria-disabled') !== 'true' &&
      new RegExp(expected.once, 'i').test((button.textContent ?? '').trim()));
    if (buttons.length !== 1) return false;
    (buttons[0] as HTMLElement).click();
    return true;
  }, { text, once: once.source });
  if (!clicked) throw unavailable('The exact one-time Allow control changed or is unavailable');
  await page.waitForFunction(expected => ![...document.querySelectorAll('[role="dialog"], [role="alertdialog"], [role="alert"]')]
    .some(element => element instanceof HTMLElement && element.getClientRects().length > 0 &&
      element.innerText.trim() === expected), text, { timeout: 5_000 }).catch(() => undefined);
  return { outcome: 'clicked', appName: input.appName, toolName: input.toolName, evidenceHash,
    permissionStillVisible: (await scopes.allTextContents()).some(value => value.trim() === text) };
}

function unavailable(message: string) { return new SessionPlaneDomainError('provider.permission-unverified', message); }
