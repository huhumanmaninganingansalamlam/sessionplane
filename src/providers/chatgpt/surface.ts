import type { Page } from 'playwright-core';
import type { BrowserSnapshotNode } from '../../browser/ref-snapshot.ts';
import { SessionPlaneDomainError } from '../../domain/errors.ts';

export function isChatGptModeControl(node: Pick<BrowserSnapshotNode, 'role' | 'name' | 'text'>) {
  return ['button', 'radio', 'tab', 'menuitemradio', 'menuitem', 'option'].includes(node.role) &&
    [node.name, node.text].some(label => /^(?:chat(?:\s+mode)?$|(?:chatgpt\s+)?work(?:\b|\s|\())/i.test(label.trim()));
}

export interface ChatGptSurface {
  readonly mode: 'chat' | 'work' | 'unknown';
  readonly source: 'selected-control' | 'chat-default' | 'composer-state' | 'conflicting-evidence' | 'unavailable';
  readonly observedAt: string;
  /** Diagnostic labels/state only; never a ref or a selectable action. */
  readonly modeControls?: readonly {
    tag: string; role: string | null; label: 'chat' | 'work';
    checked: string | null; selected: string | null; pressed: string | null;
    state: string | null; current: string | null; hasPopup: string | null; navigation: boolean;
    ancestorRoles: readonly string[];
  }[];
}

/** Honor explicit mode evidence; Chat is the default when its optional selector is absent. */
export function inspectChatGptSurfaceDocument(knownOnly = false): Omit<ChatGptSurface, 'observedAt'> | null {
  const modeControls: NonNullable<ChatGptSurface['modeControls']>[number][] = [];
  for (const e of document.querySelectorAll('button, a, input[type="radio"], [role="radio"], [role="tab"], [role="menuitemradio"], [role="combobox"]')) {
    if (modeControls.length >= 16 || !e.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true }) ||
        e.closest('[data-message-author-role], article, [data-chatgpt-search-message-ids]')) continue;
    const label = [e.getAttribute('aria-label'), e.textContent].map(s => (s ?? '').trim().toLowerCase())
      .find(s => /^(?:chat(?:\s+mode)?|(?:chatgpt\s+)?work(?:\s*\([^)]*\))?(?:\s+mode)?)$/i.test(s)) ?? '';
    if (!/^(?:chat(?:\s+mode)?|(?:chatgpt\s+)?work(?:\s*\([^)]*\))?(?:\s+mode)?)$/i.test(label)) continue;
    const attribute = (name: string, allowed: readonly string[]) => {
      const value = e.getAttribute(name);
      return value !== null && allowed.includes(value) ? value : null;
    };
    const ancestorRoles: string[] = [];
    for (let p = e.parentElement, depth = 0; p && depth < 4; p = p.parentElement, depth++) {
      ancestorRoles.push(['navigation', 'radiogroup', 'tablist', 'group', 'menu', 'main', 'dialog'].includes(p.getAttribute('role') ?? '')
        ? p.getAttribute('role')! : p.tagName.toLowerCase());
    }
    modeControls.push({ tag: e.tagName.toLowerCase(), role: attribute('role', ['radio', 'tab', 'menuitemradio', 'combobox', 'button', 'link']), label: /^chat(?:\s+mode)?$/.test(label) ? 'chat' : 'work',
      checked: attribute('aria-checked', ['true', 'false', 'mixed']), selected: attribute('aria-selected', ['true', 'false']), pressed: attribute('aria-pressed', ['true', 'false', 'mixed']),
      state: attribute('data-state', ['on', 'off', 'checked', 'unchecked', 'active', 'inactive', 'open', 'closed']),
      current: attribute('aria-current', ['page', 'true', 'false']),
      hasPopup: attribute('aria-haspopup', ['true', 'false', 'menu', 'listbox', 'dialog']),
      navigation: e.closest('nav, aside, [role="navigation"]') !== null, ancestorRoles });
  }
  const result = (mode: ChatGptSurface['mode'], source: ChatGptSurface['source']) => ({ mode, source, modeControls });
  const controls = new Set<'chat' | 'work'>();
  // Current composer chrome uses a two-button toggle group, not radio roles.
  // Require both visible complementary states in the same group; a lone Chat
  // label/pressed button elsewhere is not mode proof.
  for (const group of document.querySelectorAll('[role="group"]')) {
    if (group.closest('[data-message-author-role], article, [data-chatgpt-search-message-ids], nav, aside, [role="navigation"]')) continue;
    const buttons = [...group.querySelectorAll('button[aria-pressed]')].filter(e =>
      e.closest('[role="group"]') === group && e.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true }) &&
      e.getBoundingClientRect().width > 0);
    const named = (label: string) => buttons.filter(e =>
      (e.getAttribute('aria-label') ?? e.textContent ?? '').trim().toLowerCase() === label);
    const chat = named('chat'), work = named('work');
    if (chat.length !== 1 || work.length !== 1) continue;
    const selected = [chat[0]!, work[0]!].filter(e => e.getAttribute('aria-pressed') === 'true');
    const other = [chat[0]!, work[0]!].filter(e => e.getAttribute('aria-pressed') === 'false');
    if (selected.length !== 1 || other.length !== 1) return knownOnly ? null : result('unknown', 'conflicting-evidence');
    controls.add(selected[0] === chat[0] ? 'chat' : 'work');
  }
  for (const e of document.querySelectorAll('[role="radio"], [role="tab"], [role="menuitemradio"]')) {
    if (!e.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true }) || !e.getBoundingClientRect().width ||
        e.closest('[data-message-author-role], article, [data-chatgpt-search-message-ids], nav, aside, [role="navigation"]')) continue;
    if (e.getAttribute('aria-checked') !== 'true' && e.getAttribute('aria-selected') !== 'true' &&
        !['on', 'checked', 'active'].includes(e.getAttribute('data-state') ?? '')) continue;
    const label = (e.getAttribute('aria-label') ?? e.textContent ?? '').trim().toLowerCase();
    if (label === 'chat') controls.add('chat');
    if (/^(?:chatgpt\s+)?work(?:\b|\s|\()/i.test(label)) controls.add('work');
  }
  const state = new Set<'chat' | 'work'>();
  let composerAvailable = false;
  for (const composer of document.querySelectorAll('[data-chatgpt-composer], #prompt-textarea, [data-testid="prompt-textarea"]')) {
    if (!composer.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true }) || !composer.getBoundingClientRect().width ||
        composer.closest('[data-message-author-role], article')) continue;
    const editors = composer.matches('textarea, [contenteditable="true"], [role="textbox"]')
      ? [composer] : [...composer.querySelectorAll('textarea, [contenteditable="true"], [role="textbox"]')];
    composerAvailable ||= editors.some(editor => editor.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true }) &&
      editor.getBoundingClientRect().width > 0 && !editor.matches(':disabled, [aria-disabled="true"], [readonly]'));
    // Current ChatGPT hides the switch on existing threads. Its mounted UI passes
    // this explicit boolean to the composer; do not inspect hooks or invoke callbacks.
    const key = Object.keys(composer).find(key => key.startsWith('__reactFiber$'));
    type Fiber = { memoizedProps?: { isWorkConversation?: unknown }; return?: Fiber };
    let fiber = key ? (composer as unknown as Record<string, Fiber>)[key] : undefined;
    for (let depth = 0; fiber && depth < 60; depth++, fiber = fiber.return) {
      const work = fiber.memoizedProps?.isWorkConversation;
      if (typeof work === 'boolean') state.add(work ? 'work' : 'chat');
    }
  }
  // An inherited false prop is not selected-control evidence. Positive Work
  // state remains blocking, including when the provider hides its selector.
  const modes = new Set([...controls, ...(state.has('work') ? ['work' as const] : [])]);
  if (modes.size > 1) return knownOnly ? null : result('unknown', 'conflicting-evidence');
  if (modes.size === 0) {
    // Do not require an optional new-chat selector on every ordinary follow-up.
    // Visible incomplete/ambiguous mode controls still require resolution.
    if (composerAvailable && !modeControls.some(control => !control.navigation)) return result('chat', 'chat-default');
    return knownOnly ? null : result('unknown', state.size ? 'composer-state' : 'unavailable');
  }
  return result([...modes][0]!, controls.size ? 'selected-control' : 'composer-state');
}

export async function requireChatGptSurface(page: Page): Promise<void> {
  const surface = await observeChatGptSurface(page, 5_000);
  if (surface.mode !== 'chat') throw new SessionPlaneDomainError('provider.preparation-required',
    surface.mode === 'work'
      ? 'This conversation is Work and is observation-only. Preserve original work, then use an authorized same-role Chat replacement.'
      : 'Actual Chat selection is unverified. Preserve the request and draft; composer state or model labels do not prove Chat.');
}

export async function observeChatGptSurface(page: Page, timeoutMs = 2_000): Promise<ChatGptSurface> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const selection = await Promise.race([page.evaluate(inspectChatGptSurfaceDocument, false),
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('Surface read timed out')), timeoutMs); })]);
    return { ...(selection ?? { mode: 'unknown', source: 'unavailable' }), observedAt: new Date().toISOString() };
  } catch {
    return { mode: 'unknown', source: 'unavailable', observedAt: new Date().toISOString() };
  } finally { clearTimeout(timer); }
}
