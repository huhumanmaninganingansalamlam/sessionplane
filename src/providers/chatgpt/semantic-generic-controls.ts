import { createHash } from 'node:crypto';
import type { ElementHandle, Page } from 'playwright-core';
import type { SemanticControlDescriptor } from '../semantic-adapter.ts';

const CARDS = '[role="dialog"], [role="alertdialog"], [role="alert"], [data-state="open"]';
const CONTROLS = [
  'button', 'input', 'textarea', 'select', '[contenteditable="true"]',
  '[role="button"]', '[role="radio"]', '[role="checkbox"]', '[role="switch"]',
  '[role="option"]', '[role="menuitem"]', '[role="menuitemradio"]',
  '[role="textbox"]', '[role="combobox"]',
].join(', ');

interface RawControl {
  readonly cardIndex: number;
  readonly controlIndex: number;
  readonly signature: string;
  readonly role: string;
  readonly label: string;
  readonly contextSummary: string;
  readonly operation: SemanticControlDescriptor['operation'];
  readonly enabled: boolean;
  readonly selected: boolean | null;
  readonly currentValue: string | null;
  readonly options: readonly { readonly value: string; readonly enabled: boolean }[];
  readonly expectedEffect: string;
  readonly relevance: string;
  readonly risk: SemanticControlDescriptor['risk'];
  readonly executable: boolean;
}

export interface GenericChatGptControl {
  readonly descriptor: SemanticControlDescriptor;
  readonly cardIndex: number;
  readonly controlIndex: number;
  readonly signature: string;
}

function sha(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function refFor(raw: RawControl): string {
  return sha(JSON.stringify({
    cardIndex: raw.cardIndex, controlIndex: raw.controlIndex,
    signature: raw.signature, role: raw.role, label: raw.label,
    contextSummary: raw.contextSummary,
    operation: raw.operation, options: raw.options.map(option => option.value),
  }));
}

/**
 * Observe controls in provider-owned chrome following the exact latest user
 * turn. Ordinary transcript buttons, navigation, the composer and hidden cards
 * are excluded. Unsafe/unknown buttons are still described for the agent, but
 * only configuration choices and bounded value fields become executable.
 */
export async function inspectGenericChatGptControls(
  page: Page, submittedUserMessageId: string,
): Promise<readonly GenericChatGptControl[]> {
  const raw: RawControl[] = await page.evaluate(({ userId, cardsSelector, controlsSelector }: {
    userId: string; cardsSelector: string; controlsSelector: string;
  }) => {
    const visible = (element: Element) =>
      element.closest('[aria-hidden="true"], [inert], nav, aside, [role="navigation"]') === null &&
      element.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true }) &&
      element.getBoundingClientRect().width > 0 && element.getBoundingClientRect().height > 0;
    const enabled = (element: Element) => !element.matches(
      ':disabled, [aria-disabled="true"], [readonly]');
    const normalized = (value: string | null | undefined, max = 1_000) =>
      (value ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
    const identity = (node: Element) => {
      const owner = node.closest('[data-message-id], [data-turn-id], [data-dil-message-id], [data-turn-key], [data-chatgpt-search-message-ids]') ?? node;
      const values = [
        owner.getAttribute('data-message-id'), owner.getAttribute('data-turn-id'),
        owner.getAttribute('data-dil-message-id'), owner.getAttribute('data-turn-key'),
        owner.getAttribute('data-chatgpt-search-message-ids'),
        node.getAttribute('data-message-id'), node.getAttribute('data-turn-id'),
      ].filter((value): value is string => typeof value === 'string');
      return values.some(value => value === userId || value.split(/\s+/).includes(userId));
    };
    const users = [...document.querySelectorAll<HTMLElement>(
      '[data-message-author-role="user"], [data-user-message-bubble]',
    )].filter(node => !node.closest('nav, aside, [role="navigation"]'));
    const owned = users.filter(identity);
    if (owned.length !== 1 || users.at(-1) !== owned[0]) return [];
    const anchor = owned[0]!;
    const cards = [...document.querySelectorAll<HTMLElement>(cardsSelector)];
    const output: RawControl[] = [];
    for (let cardIndex = 0; cardIndex < cards.length; cardIndex++) {
      const card = cards[cardIndex]!;
      if (!visible(card) || card.contains(anchor) ||
          card.closest('article, [data-message-author-role], [data-user-message-bubble], pre, code, blockquote, .markdown')) continue;
      const position = anchor.compareDocumentPosition(card);
      if (position & Node.DOCUMENT_POSITION_DISCONNECTED ||
          !(position & Node.DOCUMENT_POSITION_FOLLOWING)) continue;
      if (card.parentElement?.closest(cardsSelector)) continue;
      const contextSummary = (card.innerText ?? '').replace(/\s+/g, ' ').trim();
      if (!contextSummary) continue;
      const controls = [...card.querySelectorAll<HTMLElement>(controlsSelector)];
      for (let controlIndex = 0; controlIndex < controls.length; controlIndex++) {
        const control = controls[controlIndex]!;
        if (!visible(control) || control.parentElement?.closest(controlsSelector)) continue;
        const tag = control.tagName.toLowerCase();
        const explicitRole = normalized(control.getAttribute('role'), 64).toLowerCase();
        const type = normalized(control.getAttribute('type'), 64).toLowerCase();
        const role = explicitRole ||
          (tag === 'select' ? 'combobox' : tag === 'textarea' || control.isContentEditable ||
           tag === 'input' && !['button', 'submit', 'radio', 'checkbox'].includes(type)
            ? 'textbox' : tag === 'button' || ['button', 'submit'].includes(type)
              ? 'button' : type === 'radio' ? 'radio' : type === 'checkbox' ? 'checkbox' : tag);
        const label = normalized(
          control.getAttribute('aria-label') ?? control.getAttribute('title') ??
          control.getAttribute('placeholder') ?? control.innerText ??
          (control instanceof HTMLInputElement ? control.value : ''),
        );
        if (!label) continue;
        const isText = role === 'textbox' ||
          (tag === 'input' && !['button', 'submit', 'radio', 'checkbox'].includes(type)) ||
          tag === 'textarea' || control.isContentEditable;
        const isSelect = tag === 'select';
        const isChoice = ['radio', 'checkbox', 'switch', 'option', 'menuitemradio'].includes(role) ||
          (role === 'button' && (control.hasAttribute('aria-pressed') ||
            control.hasAttribute('aria-selected') ||
            control.closest('[role="radiogroup"], [role="listbox"], [role="menu"]') !== null));
        const destructivePattern = /\b(?:delete|remove|erase|clear|reset|purchase|buy|pay|subscribe|publish|share|send|submit|grant|allow|authorize|revoke|disconnect)\b|삭제|제거|지우|초기화|구매|결제|구독|게시|공유|전송|허용|승인|권한|연결 해제|취소/i;
        const genericAffirmativePattern = /^(?:confirm|ok|okay|yes|continue|proceed|accept|do it|확인|예|네|계속|진행|수락)$/i;
        const destructive = destructivePattern.test(label) ||
          (genericAffirmativePattern.test(label) && destructivePattern.test(contextSummary));
        const ordinaryActivation = ['button', 'menuitem'].includes(role) &&
          !destructive && type !== 'submit';
        const operation: RawControl['operation'] = isText ? 'set_text'
          : isSelect ? 'select_value' : 'activate';
        const executable = enabled(control) &&
          (isText || isSelect || isChoice || ordinaryActivation);
        const risk: RawControl['risk'] = !executable ? 'requires_human'
          : isText ? 'draft' : 'configuration';
        const selectedValue = control.getAttribute('aria-checked') ??
          control.getAttribute('aria-selected') ?? control.getAttribute('aria-pressed');
        const selected = control instanceof HTMLInputElement &&
          ['radio', 'checkbox'].includes(control.type) ? control.checked
          : selectedValue === null ? null : selectedValue === 'true';
        const currentValue = control instanceof HTMLInputElement ||
          control instanceof HTMLTextAreaElement || control instanceof HTMLSelectElement
          ? control.value : control.isContentEditable ? control.innerText : null;
        const options = control instanceof HTMLSelectElement
          ? [...control.options].map(option => ({
              value: option.value, enabled: !option.disabled,
            })) : [];
        const signature = [
          tag, control.id, control.getAttribute('data-testid'), role,
          control.getAttribute('aria-label'), control.getAttribute('name'), type, label,
        ].join('|');
        output.push({
          cardIndex, controlIndex, signature, role, label, contextSummary,
          operation, enabled: enabled(control), selected, currentValue, options,
          expectedEffect: operation === 'set_text'
            ? 'Update this provider-owned field without submitting the chat request'
            : operation === 'select_value'
              ? 'Select one current provider option without submitting the chat request'
              : 'Activate this current provider configuration choice',
          relevance: 'Visible provider-owned control after the exact latest user turn',
          risk, executable,
        });
      }
    }
    return output;
  }, {
    userId: submittedUserMessageId, cardsSelector: CARDS,
    controlsSelector: CONTROLS,
  });
  return raw.map(item => ({
    descriptor: {
      controlRef: refFor(item), role: item.role, label: item.label,
      contextSummary: item.contextSummary, operation: item.operation,
      enabled: item.enabled, selected: item.selected, currentValue: item.currentValue,
      options: item.options, expectedEffect: item.expectedEffect,
      relevance: item.relevance, risk: item.risk, executable: item.executable,
    },
    cardIndex: item.cardIndex, controlIndex: item.controlIndex, signature: item.signature,
  }));
}

async function exactElement(
  page: Page, candidate: GenericChatGptControl,
): Promise<ElementHandle<HTMLElement> | null> {
  const card = page.locator(CARDS).nth(candidate.cardIndex);
  const handle = await card.locator(CONTROLS).nth(candidate.controlIndex)
    .elementHandle({ timeout: 2_000 }).catch(() => null);
  if (handle === null) return null;
  const signature = await handle.evaluate((element: HTMLElement) => {
    const normalized = (value: string | null | undefined, max = 1_000) =>
      (value ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
    const tag = element.tagName.toLowerCase();
    const explicitRole = normalized(element.getAttribute('role'), 64).toLowerCase();
    const type = normalized(element.getAttribute('type'), 64).toLowerCase();
    const role = explicitRole ||
      (tag === 'select' ? 'combobox' : tag === 'textarea' || element.isContentEditable ||
       tag === 'input' && !['button', 'submit', 'radio', 'checkbox'].includes(type)
        ? 'textbox' : tag === 'button' || ['button', 'submit'].includes(type)
          ? 'button' : type === 'radio' ? 'radio' : type === 'checkbox' ? 'checkbox' : tag);
    const label = normalized(
      element.getAttribute('aria-label') ?? element.getAttribute('title') ??
      element.getAttribute('placeholder') ?? element.innerText ??
      (element instanceof HTMLInputElement ? element.value : ''),
    );
    return [tag, element.id, element.getAttribute('data-testid'), role,
      element.getAttribute('aria-label'), element.getAttribute('name'), type, label].join('|');
  }).catch(() => null);
  if (signature !== candidate.signature) {
    await handle.dispose();
    return null;
  }
  return handle as ElementHandle<HTMLElement>;
}

export async function actGenericChatGptControl(
  page: Page, submittedUserMessageId: string, expected: GenericChatGptControl,
  input?: string,
): Promise<'performed' | 'stale' | 'unverified'> {
  const latest = await inspectGenericChatGptControls(page, submittedUserMessageId);
  const matches = latest.filter(candidate =>
    candidate.descriptor.controlRef === expected.descriptor.controlRef);
  if (matches.length !== 1 || !matches[0]!.descriptor.executable ||
      matches[0]!.signature !== expected.signature) return 'stale';
  const current = matches[0]!;
  const beforeSelected = current.descriptor.selected;
  const handle = await exactElement(page, current);
  if (handle === null) return 'stale';
  try {
    if (current.descriptor.operation === 'set_text') {
      if (typeof input !== 'string' || input.length > 200_000) return 'stale';
      await handle.fill(input, { timeout: 5_000 });
      const value = await handle.evaluate((element: HTMLElement) =>
        element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement
          ? element.value : element.isContentEditable ? element.innerText : null);
      return value === input ? 'performed' : 'unverified';
    }
    if (current.descriptor.operation === 'select_value') {
      if (typeof input !== 'string' ||
          !current.descriptor.options.some(option => option.enabled && option.value === input)) return 'stale';
      await (handle as ElementHandle<HTMLSelectElement>).selectOption(input, { timeout: 5_000 });
      const value = await handle.evaluate((element: HTMLElement) =>
        element instanceof HTMLSelectElement ? element.value : null);
      return value === input ? 'performed' : 'unverified';
    }
    if (input !== undefined) return 'stale';
    const hidden = await page.evaluate(() => document.visibilityState === 'hidden');
    if (hidden) await handle.evaluate((element: HTMLElement) => element.click());
    else await handle.click({ timeout: 5_000 });
  } catch {
    return 'unverified';
  } finally {
    await handle.dispose();
  }
  await page.waitForTimeout(50);
  const after = await inspectGenericChatGptControls(page, submittedUserMessageId);
  const same = after.filter(candidate =>
    candidate.descriptor.controlRef === expected.descriptor.controlRef);
  if (same.length === 0) return 'performed';
  if (same.length !== 1) return 'unverified';
  return same[0]!.descriptor.selected !== beforeSelected ? 'performed' : 'unverified';
}
