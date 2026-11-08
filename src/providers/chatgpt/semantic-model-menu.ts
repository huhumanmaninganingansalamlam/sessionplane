import { createHash } from 'node:crypto';
import type { Page } from 'playwright-core';

const OPENER = 'button[aria-haspopup="menu"]';
const MODEL_LABEL = /(?:model|모델)/i;
const ID = /^[A-Za-z0-9_.:-]{1,128}$/;

export interface SemanticModelChoice {
  readonly value: string;
  readonly controlLabel: string;
  readonly enabled: boolean;
  readonly selected: boolean;
}
export interface SemanticModelMenu {
  readonly status: 'closed' | 'open' | 'nested' | 'unsupported';
  readonly reason: string | null;
  readonly openerIndex: number;
  readonly menuId: string;
  readonly optionMenuId: string;
  readonly submenuId: string;
  readonly submenuTriggerIndex: number;
  readonly evidenceHash: string;
  readonly options: readonly SemanticModelChoice[];
}

/**
 * Read-only inspection of an explicitly linked ChatGPT model menu. A single
 * Pro submenu with a separately linked Standard/Extended radio menu is
 * supported as two distinct, reauthorized actions. No UI control is opened
 * while observing, and unknown nested/slider controls fail closed.
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
    const base = {
      openerIndex: -1, menuId: '', optionMenuId: '',
      submenuId: '', submenuTriggerIndex: -1,
      label: '', expanded: '',
      options: [] as Array<{ value: string; controlLabel: string;
        enabled: boolean; selected: boolean }>,
    };
    if (selected.length === 0) return null;
    if (selected.length !== 1) return { ...base,
      status: 'unsupported' as const, reason: 'model-chooser-ambiguous' };
    const { element, index, label } = selected[0]!;
    const menuId = element.getAttribute('aria-controls') ?? '';
    const expanded = element.getAttribute('aria-expanded') ?? '';
    const linked = (id: string) => id && /^[A-Za-z0-9_.:-]{1,128}$/.test(id)
      ? [...document.querySelectorAll<HTMLElement>('[role="menu"][id]')]
        .filter(menu => menu.id === id) : [];
    const menus = linked(menuId);
    const initial = { ...base, openerIndex: index, menuId, label, expanded };
    // Portals commonly mount only after opening; the declared aria-controls
    // identity is sufficient to attempt disclosure, but the resulting menu
    // must be mounted, unique and visible before any model can be chosen.
    const rootLinked = expanded === 'true'
      ? menus.length === 1 && visible(menus[0]!)
      : menus.length <= 1 && (menus.length === 0 || !visible(menus[0]!));
    if (!/^[A-Za-z0-9_.:-]{1,128}$/.test(menuId) || !['true', 'false'].includes(expanded) || !rootLinked) {
      return { ...initial, status: 'unsupported' as const,
        reason: 'model-menu-link-unverified' };
    }
    if (expanded === 'false') {
      return { ...initial, status: 'closed' as const, reason: null };
    }
    const root = menus[0]!;
    const radios = (menu: HTMLElement, prefix = '') =>
      [...menu.querySelectorAll<HTMLElement>('[role="menuitemradio"]')]
        .filter(e => e.closest('[role="menu"]') === menu && visible(e))
        .map(e => {
          const controlLabel = (e.getAttribute('aria-label') ?? e.innerText ?? '')
            .replace(/\s+/g, ' ').trim();
          const value = prefix && !/^Pro\s/i.test(controlLabel)
            ? prefix + ' ' + controlLabel : controlLabel;
          return { value, controlLabel,
            enabled: !e.matches(':disabled, [aria-disabled="true"]'),
            selected: e.getAttribute('aria-checked') === 'true' };
        });
    const branches = [...root.querySelectorAll<HTMLElement>('[role="menuitem"][aria-haspopup="menu"]')];
    const nested = branches.flatMap((trigger, submenuTriggerIndex) =>
      trigger.closest('[role="menu"]') === root && visible(trigger)
        ? [{ trigger, submenuTriggerIndex }] : []);
    const unsafe = root.querySelector('input, textarea, [role="slider"]') !== null;
    const optionsValid = (options: ReturnType<typeof radios>) =>
      options.length >= 2 && options.length <= 20 &&
      options.every(o => !!o.value && o.value.length <= 160 &&
        !!o.controlLabel && o.controlLabel.length <= 160 &&
        !/^(?:Chat|Work)$/i.test(o.value)) &&
      new Set(options.map(o => o.value)).size === options.length;
    if (unsafe || nested.length > 1) return { ...initial,
      status: 'unsupported' as const, reason: 'nested-or-ambiguous-model-controls' };
    if (nested.length === 0) {
      const options = radios(root);
      if (!optionsValid(options) || root.querySelector('[role="menu"]') !== null) {
        return { ...initial, status: 'unsupported' as const,
          reason: 'nested-or-ambiguous-model-controls' };
      }
      return { ...initial, status: 'open' as const, reason: null,
        optionMenuId: menuId, options };
    }
    const { trigger, submenuTriggerIndex } = nested[0]!;
    const triggerLabel = (trigger.getAttribute('aria-label') ?? trigger.innerText ?? '').trim();
    const submenuId = trigger.getAttribute('aria-controls') ?? '';
    const subExpanded = trigger.getAttribute('aria-expanded') ?? '';
    const subMenus = linked(submenuId);
    const subLinked = subExpanded === 'true'
      ? subMenus.length === 1 && visible(subMenus[0]!)
      : subMenus.length <= 1 && (subMenus.length === 0 || !visible(subMenus[0]!));
    if (!/^(?:Pro|프로)$/i.test(triggerLabel) || !/^[A-Za-z0-9_.:-]{1,128}$/.test(submenuId) ||
      !['true', 'false'].includes(subExpanded) || submenuId === menuId || !subLinked) {
      return { ...initial, status: 'unsupported' as const,
        reason: 'pro-submenu-link-unverified' };
    }
    const evidence = { ...initial, submenuId, submenuTriggerIndex };
    if (subExpanded === 'false') {
      return { ...evidence, status: 'nested' as const, reason: null };
    }
    const subMenu = subMenus[0]!;
    const options = radios(subMenu, 'Pro');
    if (!visible(subMenu) || !optionsValid(options) ||
      options.some(o => !/^(?:Pro )?(?:Standard|Extended)$/i.test(o.value)) ||
      subMenu.querySelector('input, textarea, [role="slider"], [role="menu"]') !== null) {
      return { ...evidence, status: 'unsupported' as const,
        reason: 'pro-effort-options-unverified' };
    }
    return { ...evidence, status: 'open' as const, reason: null,
      optionMenuId: submenuId, options };
  }, { openerSelector: OPENER, labelPattern: MODEL_LABEL.source });
  if (!data) return null;
  const evidenceHash = createHash('sha256').update(JSON.stringify({
    url: page.url(), ...data,
  })).digest('hex');
  return {
    status: data.status, reason: data.reason, openerIndex: data.openerIndex,
    menuId: data.menuId, optionMenuId: data.optionMenuId,
    submenuId: data.submenuId, submenuTriggerIndex: data.submenuTriggerIndex,
    options: data.options, evidenceHash,
  };
}

export async function openExactChatGptModelMenu(page: Page, expectedHash: string): Promise<void> {
  const current = await inspectSemanticChatGptModelMenu(page);
  if (!current || !['closed', 'nested'].includes(current.status) ||
    current.evidenceHash !== expectedHash || current.openerIndex < 0 ||
    !ID.test(current.menuId)) {
    throw new Error('Model opener changed before action');
  }
  if (current.status === 'closed') {
    const button = await page.locator(OPENER).nth(current.openerIndex).elementHandle();
    if (!button) throw new Error('Model opener disappeared');
    try { await button.click({ timeout: 5_000 }); }
    finally { await button.dispose(); }
    const after = await inspectSemanticChatGptModelMenu(page);
    if (!after || after.menuId !== current.menuId ||
      !['open', 'nested'].includes(after.status)) {
      throw new Error('Model menu not verified open after one action');
    }
    return;
  }
  if (!ID.test(current.submenuId) || current.submenuTriggerIndex < 0) {
    throw new Error('Pro submenu cannot be uniquely addressed');
  }
  const root = page.locator('[role="menu"][id="' + current.menuId + '"]');
  if (await root.count() !== 1) throw new Error('Root model menu lost');
  const trigger = root.locator('[role="menuitem"][aria-haspopup="menu"]')
    .nth(current.submenuTriggerIndex);
  if (await trigger.getAttribute('aria-controls') !== current.submenuId ||
    await trigger.getAttribute('aria-expanded') !== 'false' ||
    !await trigger.isEnabled()) {
    throw new Error('Pro submenu trigger changed before action');
  }
  await trigger.click({ timeout: 5_000 });
  const after = await inspectSemanticChatGptModelMenu(page);
  if (!after || after.status !== 'open' || after.menuId !== current.menuId ||
    after.optionMenuId !== current.submenuId || after.submenuId !== current.submenuId) {
    throw new Error('Pro effort menu not verified open after one action');
  }
}

export async function selectExactChatGptModelMenu(
  page: Page, expectedHash: string, option: string,
): Promise<void> {
  const current = await inspectSemanticChatGptModelMenu(page);
  const selected = current?.options.find(o => o.value === option && o.enabled);
  if (!current || current.status !== 'open' ||
    current.evidenceHash !== expectedHash || !selected ||
    !ID.test(current.optionMenuId)) {
    throw new Error('Model option was not a fresh enabled choice');
  }
  const menu = page.locator('[role="menu"][id="' + current.optionMenuId + '"]');
  if (await menu.count() !== 1 || !await menu.isVisible()) {
    throw new Error('Exact model menu changed before selection');
  }
  const choice = menu.getByRole('menuitemradio', { name: selected.controlLabel, exact: true });
  if (await choice.count() !== 1 || !await choice.isEnabled()) {
    throw new Error('Model option became ambiguous or disabled');
  }
  await choice.click({ timeout: 5_000 });
  const after = await inspectSemanticChatGptModelMenu(page);
  if (!after || after.menuId !== current.menuId || after.status !== 'open' ||
    after.optionMenuId !== current.optionMenuId ||
    !after.options.some(o => o.value === option && o.selected)) {
    // Provider may close its menu on selection. Without a trustworthy final
    // selected-state read, do not report successful Pro configuration.
    throw new Error('Model selection clicked but selected state is unverified');
  }
}
