import { createHash } from 'node:crypto';
import type { Locator, Page } from 'playwright-core';

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
  readonly strategy: 'linked-radio' | 'composer-radix';
  readonly openerId: string;
  readonly status: 'closed' | 'open' | 'nested' | 'unsupported';
  readonly reason: string | null;
  readonly openerIndex: number;
  readonly menuId: string;
  readonly optionMenuId: string;
  readonly submenuId: string;
  readonly submenuTriggerIndex: number;
  readonly evidenceHash: string;
  readonly options: readonly SemanticModelChoice[];
  /** Exact visible Pro badge on the *closed* canonical composer picker. */
  readonly closedVerifiedModel: 'Pro' | null;
}

/**
 * Read-only B-specific inspection of linked radio menus (including the
 * historical Pro submenu) and the observed composer Radix picker. Its
 * thinking-effort slider is never presented as a model choice or modified.
 */
export async function inspectSemanticChatGptModelMenu(page: Page): Promise<SemanticModelMenu | null> {
  const data = await page.evaluate(({ openerSelector, labelPattern }) => {
    const visible = (e: Element) =>
      e.closest('article, nav, aside, [role="dialog"], [role="alertdialog"], [data-message-author-role], [data-chatgpt-search-message-ids], [aria-hidden="true"], [inert]') === null &&
      e.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true }) &&
      e.getBoundingClientRect().width > 0;
    const triggers = [...document.querySelectorAll<HTMLButtonElement>(openerSelector)];
    const selected = triggers.flatMap((element, index) => {
      const label = (element.getAttribute('aria-label') ?? element.innerText ?? '').trim();
      return element.closest('main') !== null &&
        visible(element) && new RegExp(labelPattern, 'i').test(label)
        ? [{ element, index, label }] : [];
    });
    const base = {
      strategy: 'linked-radio' as 'linked-radio' | 'composer-radix',
      openerId: '', openerIndex: -1, menuId: '', optionMenuId: '',
      submenuId: '', submenuTriggerIndex: -1,
      label: '', expanded: '',
      options: [] as Array<{ value: string; controlLabel: string;
        enabled: boolean; selected: boolean }>,
      closedVerifiedModel: null as 'Pro' | null,
    };
    if (selected.length === 0) return null;
    if (selected.length !== 1) return { ...base,
      status: 'unsupported' as const, reason: 'model-chooser-ambiguous' };
    const { element, index, label } = selected[0]!;
    const menuId = element.getAttribute('aria-controls') ?? '';
    const expanded = element.getAttribute('aria-expanded') ?? '';
    const strategy = element.getAttribute('aria-label') === 'ChatGPT 모델 선택'
      ? 'composer-radix' as const : 'linked-radio' as const;
    const openerId = element.id;
    const linked = (id: string) => id && /^[A-Za-z0-9_.:-]{1,128}$/.test(id)
      ? [...document.querySelectorAll<HTMLElement>('[role="menu"][id]')]
        .filter(menu => menu.id === id) : [];
    const menus = linked(menuId);
    const initial = { ...base, strategy, openerId, openerIndex: index, menuId, label, expanded };
    // The composer Radix trigger receives aria-controls only after opening.
    // In that one verified pattern, bind the newly mounted portal back to
    // this unique trigger via both aria-controls and aria-labelledby.
    const idValid = (id: string) => /^[A-Za-z0-9_.:-]{1,128}$/.test(id);
    const rootLinked = expanded === 'true'
      ? menus.length === 1 && visible(menus[0]!)
      : menus.length <= 1 && (menus.length === 0 || !visible(menus[0]!));
    const openerBound = strategy === 'linked-radio' ? idValid(menuId)
      : idValid(openerId) &&
        [...document.querySelectorAll<HTMLElement>('[id]')]
          .filter(candidate => candidate.id === openerId).length === 1 &&
        (!menuId || idValid(menuId)) &&
        element.getAttribute('data-state') === (expanded === 'true' ? 'open' : 'closed');
    if (!openerBound || !['true', 'false'].includes(expanded) || !rootLinked) {
      return { ...initial, status: 'unsupported' as const,
        reason: 'model-menu-link-unverified' };
    }
    if (expanded === 'false') {
      // Current ChatGPT composer picker displays the selected Pro level
      // *inside the one verified closed trigger*. Its exact visible label is
      // stronger than a cached menu choice, and unlike an open-menu radio it
      // persists through the subsequent Compose -> Submit observations.
      // Never infer Pro from unrelated text, other triggers or an effort
      // slider. All other labels remain unverified until opening the menu.
      const displayed = element.innerText.replace(/\s+/g, ' ').trim();
      const exactPro = strategy === 'composer-radix' &&
        element.getAttribute('aria-label') === 'ChatGPT 모델 선택' &&
        element.getAttribute('aria-haspopup') === 'menu' &&
        !element.disabled && element.getAttribute('aria-disabled') !== 'true' &&
        menuId === '' &&
        /^(?:Pro|추론 수준 Pro|Thinking level Pro|Thinking effort Pro)$/.test(displayed);
      return { ...initial, status: 'closed' as const, reason: null,
        closedVerifiedModel: exactPro ? 'Pro' as const : null };
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
    if (strategy === 'composer-radix') {
      const inRoot = (selector: string) =>
        [...root.querySelectorAll<HTMLElement>(selector)]
          .filter(control => control.closest('[role="menu"]') === root && visible(control));
      const items = inRoot('[role="menuitem"]');
      const sliders = inRoot('[role="slider"]');
      const inputs = inRoot('input, textarea');
      const modelRadios = inRoot('[role="menuitemradio"]');
      const options = radios(root);
      if (root.getAttribute('aria-labelledby') !== openerId ||
        root.getAttribute('data-state') !== 'open' ||
        root.querySelector('[role="menu"], [role="menuitemcheckbox"]') !== null ||
        inputs.length !== 0) {
        return { ...initial, status: 'unsupported' as const,
          reason: 'composer-model-menu-link-or-controls-unverified' };
      }
      if (modelRadios.length === 0 && items.length === 2 && sliders.length === 1 &&
        items.filter(item => item.getAttribute('aria-label') === '모델 선택').length === 1 &&
        items.filter(item => item.getAttribute('aria-label') === '파워').length === 1) {
        return { ...initial, status: 'nested' as const, reason: null };
      }
      if (items.length === 0 && sliders.length === 0 && optionsValid(options) &&
        modelRadios.every(radio => ['true', 'false'].includes(
          radio.getAttribute('aria-checked') ?? '')) &&
        modelRadios.filter(radio => radio.getAttribute('aria-checked') === 'true').length === 1) {
        return { ...initial, status: 'open' as const, reason: null,
          optionMenuId: menuId, options };
      }
      return { ...initial, status: 'unsupported' as const,
        reason: 'composer-model-view-ambiguous' };
    }
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
  // Composer Radix controls have a verified unique DOM id. Unrelated chat
  // actions can mount/unmount before them in document order; the volatile
  // querySelectorAll index is not part of this control's identity.
  const evidenceHash = createHash('sha256').update(JSON.stringify({
    url: page.url(), ...data,
    openerIndex: data.strategy === 'composer-radix' && ID.test(data.openerId)
      ? null : data.openerIndex,
  })).digest('hex');
  return {
    strategy: data.strategy, openerId: data.openerId,
    status: data.status, reason: data.reason, openerIndex: data.openerIndex,
    menuId: data.menuId, optionMenuId: data.optionMenuId,
    submenuId: data.submenuId, submenuTriggerIndex: data.submenuTriggerIndex,
    options: data.options, closedVerifiedModel: data.closedVerifiedModel, evidenceHash,
  };
}

// A composer menu may paint several seconds after its one authorized disclosure.
// Wait for the exact linked view, then let the full semantic inspector verify it.
async function waitForComposerMenuView(page: Page, openerId: string, priorMenuId: string,
  view: 'root' | 'models'): Promise<void> {
  // Poll from Core, not with a hidden Chrome tab's throttled renderer timer.
  // Every sample still verifies the menu is linked to the unique exact opener.
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const current = await inspectSemanticChatGptModelMenu(page);
    if (current?.strategy === 'composer-radix' &&
        current.openerId === openerId && ID.test(current.menuId) &&
        (priorMenuId === '' || current.menuId === priorMenuId) &&
        (view === 'root' ? ['nested', 'open'].includes(current.status)
          : current.status === 'open' && current.optionMenuId === current.menuId &&
            current.options.length >= 2)) {
      return;
    }
    await new Promise<void>(resolve => setTimeout(resolve, 200));
  }
  throw new Error('Exact linked model menu view was not verified');
}

/** Pin the original control and recheck its linked menu after any async
 * authorization wait. A same-label replacement must not inherit this click. */
async function clickExactModelControl(
  page: Page, expected: SemanticModelMenu, target: Locator,
  beforeMutation: () => void | Promise<void>, expectedOpenerId: string | null = null,
): Promise<void> {
  const handle = await target.elementHandle();
  if (!handle) throw new Error('Exact model control disappeared');
  try {
    if (expectedOpenerId !== null && await handle.getAttribute('id') !== expectedOpenerId) {
      throw new Error('Model control changed while resolving the exact opener');
    }
    await beforeMutation();
    const current = await inspectSemanticChatGptModelMenu(page);
    if (!current || current.evidenceHash !== expected.evidenceHash) {
      throw new Error('Model menu changed before exact control click');
    }
    const connected = await handle.evaluate((element, id) =>
      element.isConnected && !element.matches(':disabled, [aria-disabled="true"]') &&
      (id === null || (element.id === id && document.getElementById(id) === element)), expectedOpenerId);
    if (!connected) throw new Error('Exact model control was replaced before click');
    // Playwright's actionability click waits for renderer animation frames.
    // A long-hidden provider tab may stop those frames entirely. For the
    // uniquely identified closed composer picker only, use one trusted CDP
    // mouse click after revalidating the exact hit-tested button and lease.
    // Never fall back after a timed-out click: its effect could be unknown.
    const hiddenComposer = expected.strategy === 'composer-radix' &&
      expected.status === 'closed' &&
      await page.evaluate(() => document.visibilityState === 'hidden');
    if (hiddenComposer) {
      await beforeMutation();
      const latest = await inspectSemanticChatGptModelMenu(page);
      if (!latest || latest.evidenceHash !== expected.evidenceHash) {
        throw new Error('Hidden model control changed before exact click');
      }
      const point = await handle.evaluate((element, id) => {
        const rect = element.getBoundingClientRect();
        const x = rect.left + rect.width / 2;
        const y = rect.top + rect.height / 2;
        const hit = document.elementFromPoint(x, y);
        if (!element.isConnected || element.id !== id ||
            document.getElementById(id!) !== element ||
            !element.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true }) ||
            element.matches(':disabled, [aria-disabled="true"]') ||
            !Number.isFinite(x) || !Number.isFinite(y) ||
            !(rect.width > 0 && rect.height > 0) ||
            x < 0 || y < 0 || x >= innerWidth || y >= innerHeight ||
            !(hit === element || element.contains(hit))) return null;
        return { x, y };
      }, expectedOpenerId);
      if (!point) throw new Error('Hidden model picker failed exact hit test');
      await page.mouse.click(point.x, point.y, { button: 'left', clickCount: 1 });
    } else {
      await handle.click({ timeout: 5_000 });
    }
  } finally { await handle.dispose(); }
}

// Report only the bounded failing phase and error type; never log provider
// text, selection content, DOM or page URL. A consumed action is still uncertain.
async function checkedModelStage<T>(phase: 'opener_click' | 'linked_root_wait',
  operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    const name = error instanceof Error ? error.name.replace(/[^A-Za-z]/g, '').slice(0, 32)
      : 'unknown';
    console.error('[SessionPlane model action] phase=' + phase + ' class=' + name);
    throw error;
  }
}

export async function openExactChatGptModelMenu(
  page: Page, expectedHash: string, beforeMutation: () => void | Promise<void>,
): Promise<void> {
  const current = await inspectSemanticChatGptModelMenu(page);
  const validIdentity = current?.strategy === 'composer-radix'
    ? ID.test(current.openerId) &&
      (current.status === 'closed' || ID.test(current.menuId))
    : !!current && ID.test(current.menuId);
  if (!current || !['closed', 'nested'].includes(current.status) ||
    current.evidenceHash !== expectedHash || current.openerIndex < 0 ||
    !validIdentity) {
    throw new Error('Model opener changed before action');
  }
  if (current.status === 'closed') {
    // Never re-address a verified Radix composer by an index that unrelated
    // sidebar menus can shift between observation and the exact UI action.
    const opener = current.strategy === 'composer-radix'
      ? page.locator(OPENER + '[id="' + current.openerId + '"]')
      : page.locator(OPENER).nth(current.openerIndex);
    if (await opener.count() !== 1) throw new Error('Exact model opener no longer unique');
    await checkedModelStage('opener_click', () =>
      clickExactModelControl(page, current, opener, beforeMutation, current.openerId));
    if (current.strategy === 'composer-radix') {
      await checkedModelStage('linked_root_wait', () =>
        waitForComposerMenuView(page, current.openerId, current.menuId, 'root'));
    }
    const after = await inspectSemanticChatGptModelMenu(page);
    if (!after || after.strategy !== current.strategy ||
      after.openerId !== current.openerId ||
      (current.menuId !== '' && after.menuId !== current.menuId) ||
      !ID.test(after.menuId) || !['open', 'nested'].includes(after.status)) {
      throw new Error('Model menu not verified open after one action');
    }
    return;
  }
  if (current.strategy === 'composer-radix') {
    const root = page.locator('[role="menu"][id="' + current.menuId + '"]');
    if (await root.count() !== 1 || !await root.isVisible()) {
      throw new Error('Composer model root menu disappeared');
    }
    const disclosure = root.getByRole('menuitem', { name: '모델 선택', exact: true });
    if (await disclosure.count() !== 1 || !await disclosure.isEnabled()) {
      throw new Error('Composer model list disclosure changed');
    }
    await clickExactModelControl(page, current, disclosure, beforeMutation);
    await waitForComposerMenuView(page, current.openerId, current.menuId, 'models');
    const after = await inspectSemanticChatGptModelMenu(page);
    if (!after || after.strategy !== current.strategy ||
      after.openerId !== current.openerId || after.menuId !== current.menuId ||
      after.status !== 'open' || after.optionMenuId !== current.menuId) {
      throw new Error('Composer model list not verified after disclosure');
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
  await clickExactModelControl(page, current, trigger, beforeMutation);
  const after = await inspectSemanticChatGptModelMenu(page);
  if (!after || after.status !== 'open' || after.menuId !== current.menuId ||
    after.optionMenuId !== current.submenuId || after.submenuId !== current.submenuId) {
    throw new Error('Pro effort menu not verified open after one action');
  }
}

export async function selectExactChatGptModelMenu(
  page: Page, expectedHash: string, option: string, beforeMutation: () => void | Promise<void>,
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
  await clickExactModelControl(page, current, choice, beforeMutation);
  const after = await inspectSemanticChatGptModelMenu(page);
  if (!after || after.strategy !== current.strategy ||
    after.openerId !== current.openerId || after.menuId !== current.menuId ||
    after.status !== 'open' || after.optionMenuId !== current.optionMenuId ||
    !after.options.some(o => o.value === option && o.selected)) {
    // Provider may close its menu on selection. Without a trustworthy final
    // selected-state read, do not report successful Pro configuration.
    throw new Error('Model selection clicked but selected state is unverified');
  }
}
