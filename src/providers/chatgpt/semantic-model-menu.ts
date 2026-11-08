import { createHash } from 'node:crypto';
import type { Page } from 'playwright-core';

const OPENER = 'button[aria-haspopup="menu"]';
const MODEL_LABEL = /(?:model|모델)/i;

export interface SemanticModelChoice {
  readonly value: string;
  readonly enabled: boolean;
  readonly selected: boolean;
}
export interface SemanticModelMenu {
  readonly status: 'closed' | 'open' | 'unsupported';
  readonly reason: string | null;
  readonly openerIndex: number;
  readonly menuId: string;
  readonly evidenceHash: string;
  readonly options: readonly SemanticModelChoice[];
}

/** No popup opening or model selection during observe. This deliberately
 * supports only an unambiguous, explicitly linked model menu; effort sliders,
 * Work controls and nested submenus need the full configuration strategy.
 */
export async function inspectSemanticChatGptModelMenu(page: Page): Promise<SemanticModelMenu | null> {
  const data = await page.evaluate(({ openerSelector, labelPattern }) => {
    const visible = (e: Element) =>
      e.closest('article, nav, aside, [data-message-author-role], [data-chatgpt-search-message-ids], [aria-hidden="true"], [inert]') === null &&
      e.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true }) &&
      e.getBoundingClientRect().width > 0;
    const triggers = [...document.querySelectorAll<HTMLButtonElement>(openerSelector)];
    const selected = triggers.flatMap((element, index) => {
      const label = (element.getAttribute('aria-label') ?? element.innerText ?? '').trim();
      return visible(element) && new RegExp(labelPattern, 'i').test(label)
        ? [{ element, index, label }] : [];
    });
    if (selected.length === 0) return null;
    if (selected.length !== 1) return { status: 'unsupported' as const,
      reason: 'model-chooser-ambiguous', openerIndex: -1, menuId: '',
      label: '', expanded: '', options: [] };
    const { element, index, label } = selected[0]!;
    const menuId = element.getAttribute('aria-controls') ?? '';
    const expanded = element.getAttribute('aria-expanded') ?? '';
    const menus = menuId ? [...document.querySelectorAll('[role="menu"][id]')]
      .filter(menu => menu.id === menuId) : [];
    if (!menuId || !['true', 'false'].includes(expanded) ||
      (expanded === 'true' && (menus.length !== 1 || !visible(menus[0]!)))) {
      return { status: 'unsupported' as const, reason: 'model-menu-link-unverified',
        openerIndex: index, menuId, label, expanded, options: [] };
    }
    const options = expanded === 'true' ? [...menus[0]!.querySelectorAll<HTMLElement>('[role="menuitemradio"]')]
      .filter(visible).map(e => ({
        value: (e.getAttribute('aria-label') ?? e.innerText ?? '').replace(/\s+/g, ' ').trim(),
        enabled: !e.matches(':disabled, [aria-disabled="true"]'),
        selected: e.getAttribute('aria-checked') === 'true',
      })) : [];
    const invalid = expanded === 'true' && (
      options.length < 2 || options.length > 20 ||
      options.some(o => !o.value || o.value.length > 160 || /^(?:Chat|Work)$/i.test(o.value)) ||
      new Set(options.map(o => o.value)).size !== options.length ||
      menus[0]!.querySelector('input, textarea, [role="slider"], [role="menu"]') !== null);
    return {
      status: invalid ? 'unsupported' as const : expanded === 'true' ? 'open' as const : 'closed' as const,
      reason: invalid ? 'nested-or-ambiguous-model-controls' : null,
      openerIndex: index, menuId, label, expanded, options,
    };
  }, { openerSelector: OPENER, labelPattern: MODEL_LABEL.source });
  if (!data) return null;
  const evidenceHash = createHash('sha256').update(JSON.stringify({
    url: page.url(), ...data,
  })).digest('hex');
  return {
    status: data.status, reason: data.reason, openerIndex: data.openerIndex,
    menuId: data.menuId, options: data.options, evidenceHash,
  };
}

export async function openExactChatGptModelMenu(page: Page, expectedHash: string): Promise<void> {
  const current = await inspectSemanticChatGptModelMenu(page);
  if (!current || current.status !== 'closed' ||
    current.evidenceHash !== expectedHash || current.openerIndex < 0) {
    throw new Error('Model opener changed before action');
  }
  const button = await page.locator(OPENER).nth(current.openerIndex).elementHandle();
  if (!button) throw new Error('Model opener disappeared');
  try { await button.click({ timeout: 5_000 }); }
  finally { await button.dispose(); }
  const after = await inspectSemanticChatGptModelMenu(page);
  if (!after || after.status !== 'open' || after.menuId !== current.menuId) {
    throw new Error('Model menu not verified open after one action');
  }
}

export async function selectExactChatGptModelMenu(
  page: Page, expectedHash: string, option: string,
): Promise<void> {
  const current = await inspectSemanticChatGptModelMenu(page);
  if (!current || current.status !== 'open' || current.evidenceHash !== expectedHash ||
    !current.options.some(o => o.value === option && o.enabled)) {
    throw new Error('Model option was not a fresh enabled choice');
  }
  const menu = page.locator('[role="menu"][id]').filter({
    has: page.getByRole('menuitemradio', { name: option, exact: true }),
  });
  if (await menu.count() !== 1 || await menu.getAttribute('id') !== current.menuId) {
    throw new Error('Exact model menu changed before selection');
  }
  const choice = menu.getByRole('menuitemradio', { name: option, exact: true });
  if (await choice.count() !== 1 || !await choice.isEnabled()) {
    throw new Error('Model option became ambiguous or disabled');
  }
  await choice.click({ timeout: 5_000 });
  const after = await inspectSemanticChatGptModelMenu(page);
  if (!after || after.menuId !== current.menuId ||
    after.status !== 'open' ||
    !after.options.some(o => o.value === option && o.selected)) {
    // Provider may close its menu on selection. Without a trustworthy final
    // selected-state read, do not report successful Pro configuration.
    throw new Error('Model selection clicked but selected state is unverified');
  }
}
