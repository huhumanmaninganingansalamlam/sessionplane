import type { Page } from 'playwright-core';

/** Read the uniquely linked Radix composer model/effort controls in one
 * additional read-only snapshot, after the common trigger/portal is verified.
 * Any change between reads fails closed. Numeric Power ticks are never proof
 * that a model or Pro effort was selected.
 */
export async function inspectComposerRadixControls(
  page: Page, input: {
    openerId: string; menuId: string;
    verifiedReasoningLevel: 'Medium' | 'Pro' | null;
  },
) {
  return await page.evaluate(({ openerId, menuId, verifiedReasoningLevel }) => {
    const visible = (e: Element) =>
      e.closest('article, nav, aside, [role="dialog"], [role="alertdialog"], [data-message-author-role], [data-chatgpt-search-message-ids], [aria-hidden="true"], [inert]') === null &&
      e.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true }) &&
      e.getBoundingClientRect().width > 0;
    const openers = [...document.querySelectorAll<HTMLButtonElement>('button[aria-haspopup="menu"]')]
      .filter(e => e.id === openerId && e.getAttribute('aria-label') === 'ChatGPT 모델 선택' &&
        e.getAttribute('aria-controls') === menuId && e.getAttribute('aria-expanded') === 'true' &&
        e.getAttribute('data-state') === 'open' && visible(e));
    const menus = [...document.querySelectorAll<HTMLElement>('[role="menu"][id]')]
      .filter(e => e.id === menuId && visible(e));
    const initial = {
      optionMenuId: '', options: [] as Array<{value: string; controlLabel: string;
        enabled: boolean; selected: boolean}>,
      reasoningControlState: 'unverified' as 'enabled' | 'disabled' | 'unverified',
      fiveLevelPowerScaleVerified: false,
    };
    if (openers.length !== 1 || menus.length !== 1) return {
      ...initial, status: 'unsupported' as const,
      reason: 'composer-model-menu-changed-between-read-only-snapshots',
    };
    const strategy = 'composer-radix' as const;
    const root = menus[0]!;
    const trusted = { ...initial, verifiedReasoningLevel };
    const radios = (menu: HTMLElement) =>
      [...menu.querySelectorAll<HTMLElement>('[role="menuitemradio"]')]
        .filter(e => e.closest('[role="menu"]') === menu && visible(e))
        .map(e => {
          const controlLabel = (e.getAttribute('aria-label') ?? e.innerText ?? '')
            .replace(/\s+/g, ' ').trim();
          return { value: controlLabel, controlLabel,
            enabled: !e.matches(':disabled, [aria-disabled="true"]'),
            selected: e.getAttribute('aria-checked') === 'true' };
        });
    const optionsValid = (options: ReturnType<typeof radios>) =>
      options.length >= 2 && options.length <= 20 &&
      options.every(o => !!o.value && o.value.length <= 160 &&
        !!o.controlLabel && o.controlLabel.length <= 160 &&
        !/^(?:Chat|Work)$/i.test(o.value)) &&
      new Set(options.map(o => o.value)).size === options.length;
      const inRoot = (selector: string) =>
        [...root.querySelectorAll<HTMLElement>(selector)]
          .filter(control => control.closest('[role="menu"]') === root && visible(control));
      const items = inRoot('[role="menuitem"]');
      const sliders = inRoot('[role="slider"]');
      // The keyboard menuitem can be aria-disabled while the nested pointer
      // slider itself explicitly says aria-disabled=false and data-locked=false.
      // Distinguish these separate controls. The numeric thumb is never a
      // model option or evidence that a particular effort is selected.
      const powerItems = items.filter(item => item.getAttribute('aria-label') === '파워');
      const structuralSliders = [...root.querySelectorAll<HTMLElement>('[role="slider"]')]
        .filter(slider => slider.closest('[role="menu"]') === root);
      const allPowerItems = [...root.querySelectorAll<HTMLElement>(
        '[role="menuitem"][aria-label="파워"]')]
        .filter(item => item.closest('[role="menu"]') === root);
      const pointerControls = allPowerItems.length === 1
        ? [...allPowerItems[0]!.querySelectorAll<HTMLElement>(
          '[data-model-picker-power-slider] > span[aria-disabled][data-locked]')] : [];
      const pointer = pointerControls.length === 1 ? pointerControls[0]! : null;
      const headers = [...root.querySelectorAll<HTMLElement>('[data-power-disabled]')];
      const header = headers.length === 1 ? headers[0]! : null;
      const explicitlyDisabled = pointer?.getAttribute('aria-disabled') === 'true' ||
        pointer?.getAttribute('data-locked') === 'true' ||
        header?.getAttribute('data-power-disabled') === 'true';
      const pointerEnabled = !!pointer && !!header &&
        pointer.getAttribute('aria-disabled') === 'false' &&
        pointer.getAttribute('data-locked') === 'false' &&
        header.getAttribute('data-power-disabled') === 'false';
      const reasoningControlState = explicitlyDisabled ? 'disabled' as const
        : pointerEnabled ? 'enabled' as const : 'unverified' as const;
      const ticks = pointer ? [...pointer.querySelectorAll<HTMLElement>(
        'span[data-selected]')] : [];
      const statuses = [...root.querySelectorAll<HTMLElement>(
        '[role="status"][aria-live="polite"]')];
      const thumb = structuralSliders.length === 1 ? structuralSliders[0]! : null;
      // https://help.openai.com/en/articles/20001354-gpt-6-and-other-models-in-chatgpt
      // The five levels are documented in order: Instant, Medium, High,
      // Extra High, Pro. The *observed* UI independently says Medium is the
      // second of five. Selection is still not accepted until the composer
      // trigger itself reads literally Pro after one trusted pointer click.
      const fiveLevelPowerScaleVerified = strategy === 'composer-radix' &&
        powerItems.length === 1 && pointerEnabled &&
        verifiedReasoningLevel === 'Medium' &&
        header?.textContent?.replace(/\s+/g, ' ').trim() === 'Medium' &&
        statuses.length === 1 &&
        statuses[0]!.textContent?.replace(/\s+/g, ' ').trim() ===
          'Medium, 5개 중 2번째입니다.' &&
        thumb?.getAttribute('aria-hidden') === 'true' &&
        thumb.getAttribute('aria-orientation') === 'horizontal' &&
        thumb.getAttribute('aria-valuemin') === '0' &&
        thumb.getAttribute('aria-valuemax') === '4' &&
        thumb.getAttribute('aria-valuenow') === '1' &&
        ticks.length === 5 &&
        ticks.every((tick, i) => tick.getAttribute('data-selected') ===
          (i < 2 ? 'true' : 'false')) &&
        ticks.every((tick, i) => {
          const bounds = tick.getBoundingClientRect();
          const center = bounds.x + bounds.width / 2;
          const prior = i === 0 ? null : ticks[i - 1]!.getBoundingClientRect();
          return bounds.width > 0 && bounds.height > 0 &&
            Number.isFinite(center) &&
            (prior === null || center > prior.x + prior.width / 2 + 1);
        }) &&
        new Set(ticks.map(tick => tick.parentElement)).size === 1 &&
        ticks[0]!.parentElement?.parentElement?.getAttribute('data-orientation') ===
          'horizontal';
      const composerEvidence = { ...trusted, reasoningControlState,
        fiveLevelPowerScaleVerified };
      const powerSliderVerified = powerItems.length === 1 && structuralSliders.length === 1 &&
        structuralSliders[0]!.closest('[role="menuitem"]') === powerItems[0] &&
        structuralSliders[0]!.checkVisibility({
          checkOpacity: true, checkVisibilityCSS: true,
        }) && structuralSliders[0]!.getBoundingClientRect().width > 0 &&
        ['aria-valuemin', 'aria-valuemax', 'aria-valuenow'].every(attribute => {
          const value = structuralSliders[0]!.getAttribute(attribute);
          return value !== null && value.trim() !== '' && Number.isFinite(Number(value));
        }) &&
        (visible(structuralSliders[0]!) ||
          structuralSliders[0]!.getAttribute('aria-hidden') === 'true');
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
      if (modelRadios.length === 0 && items.length === 2 && powerSliderVerified &&
        items.filter(item => item.getAttribute('aria-label') === '모델 선택').length === 1) {
        return { ...composerEvidence, status: 'nested' as const, reason: null };
      }
      if (items.length === 0 && sliders.length === 0 && optionsValid(options) &&
        modelRadios.every(radio => ['true', 'false'].includes(
          radio.getAttribute('aria-checked') ?? '')) &&
        modelRadios.filter(radio => radio.getAttribute('aria-checked') === 'true').length === 1) {
        return { ...composerEvidence, status: 'open' as const, reason: null,
          optionMenuId: menuId, options };
      }
      return { ...initial, status: 'unsupported' as const,
        reason: 'composer-model-view-ambiguous' };

  }, input);
}
