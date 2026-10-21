import type { Page } from 'playwright-core';

export interface ChatGptSurface {
  readonly mode: 'chat' | 'work' | 'unknown';
  readonly source: 'selected-control' | 'composer-state' | 'conflicting-evidence' | 'unavailable';
  readonly observedAt: string;
}

/** Read only the mounted composer's explicit selection, never model/effort or a default. */
export function inspectChatGptSurfaceDocument(): Omit<ChatGptSurface, 'observedAt'> {
  const controls = new Set<'chat' | 'work'>();
  for (const e of document.querySelectorAll('[role="radio"], [role="tab"], [role="menuitemradio"]')) {
    if (!e.getBoundingClientRect().width || e.closest('[data-message-author-role], article, [data-chatgpt-search-message-ids]')) continue;
    if (e.getAttribute('aria-checked') !== 'true' && e.getAttribute('aria-selected') !== 'true' &&
        !['on', 'checked', 'active'].includes(e.getAttribute('data-state') ?? '')) continue;
    const label = (e.getAttribute('aria-label') ?? e.textContent ?? '').trim().toLowerCase();
    if (label === 'chat') controls.add('chat');
    if (label === 'work') controls.add('work');
  }
  const state = new Set<'chat' | 'work'>();
  for (const composer of document.querySelectorAll('[data-chatgpt-composer], #prompt-textarea, [data-testid="prompt-textarea"]')) {
    if (!composer.getBoundingClientRect().width || composer.closest('[data-message-author-role], article')) continue;
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
  const modes = new Set([...controls, ...state]);
  if (modes.size > 1) return { mode: 'unknown', source: 'conflicting-evidence' };
  if (modes.size === 0) return { mode: 'unknown', source: 'unavailable' };
  return { mode: [...modes][0]!, source: controls.size ? 'selected-control' : 'composer-state' };
}

export async function observeChatGptSurface(page: Page): Promise<ChatGptSurface> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const selection = await Promise.race([page.evaluate(inspectChatGptSurfaceDocument),
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('Surface read timed out')), 2_000); })]);
    return { ...selection, observedAt: new Date().toISOString() };
  } catch {
    return { mode: 'unknown', source: 'unavailable', observedAt: new Date().toISOString() };
  } finally { clearTimeout(timer); }
}
