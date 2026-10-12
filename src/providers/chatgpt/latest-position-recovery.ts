/** Same-chat display recovery only; all renderer guards and dispatch share one task. */
export function restoreLatestPosition(input: {
  origin: string; conversationId: string; anchorIds: string[]; expiresAt: number; explicit?: boolean;
}): boolean {
  if (Date.now() > input.expiresAt || location.origin !== input.origin ||
      location.pathname !== `/c/${input.conversationId}` ||
      (document.visibilityState === 'visible' && input.explicit !== true)) return false;
  const main = document.querySelector('main');
  if (!main || input.anchorIds.length === 0) return false;
  const messages = '[data-message-author-role], [data-chatgpt-search-message-ids], [data-testid="conversation-turn"]';
  if (!main.querySelector(messages)) return false;
  if ([...main.querySelectorAll('[data-message-id], [data-turn-id], [data-chatgpt-search-message-ids]')]
    .some(e => [e.getAttribute('data-message-id'), e.getAttribute('data-turn-id'),
      ...(e.getAttribute('data-chatgpt-search-message-ids') ?? '').split(/\s+/)]
      .some(id => id !== null && input.anchorIds.includes(id)))) return false;
  const visible = (e: Element) => e.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true });
  if (document.getSelection()?.isCollapsed === false) return false;
  if ([...document.querySelectorAll('textarea,input:not([type=hidden]),[contenteditable=true],[role=textbox]')]
    .filter(visible).some(e => ((e as HTMLInputElement).value ?? (e as HTMLElement).innerText ?? '').trim())) return false;
  if ([...document.querySelectorAll('[role=dialog],[role=alertdialog],[role=alert],iframe,[data-testid="stop-button"],[data-is-streaming=true]')].some(visible)) return false;
  if ([...document.querySelectorAll('button[aria-label]')].some(e => visible(e) &&
    /^(중지|생성 중지|Stop generating|Stop streaming)$/i.test(e.getAttribute('aria-label') ?? ''))) return false;
  const buttons = [...main.querySelectorAll<HTMLButtonElement>('button[aria-label]')].filter(e =>
    /^(맨 아래로 스크롤|Scroll to bottom)$/i.test(e.getAttribute('aria-label') ?? '') &&
    !e.closest(messages) && visible(e));
  if (buttons.length !== 1) return false;
  const button = buttons[0]!;
  if (button.disabled || button.getAttribute('aria-disabled') === 'true') return false;
  const rect = button.getBoundingClientRect();
  const hit = document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2);
  if (!hit || !button.contains(hit)) return false;
  button.click();
  return true;
}
