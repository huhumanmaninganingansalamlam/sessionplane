/** Same-chat display recovery only; all renderer guards and dispatch share one task. */
export function restoreLatestPosition(input: {
  origin: string; conversationId: string; anchorIds: string[]; expiresAt: number; explicit?: boolean; scrollMounted?: boolean;
}): boolean {
  if (Date.now() > input.expiresAt || location.origin !== input.origin ||
      location.pathname !== `/c/${input.conversationId}` ||
      (document.visibilityState === 'visible' && input.explicit !== true)) return false;
  const main = document.querySelector('main');
  if (!main || input.anchorIds.length === 0) return false;
  const messages = '[data-message-author-role], [data-chatgpt-search-message-ids], [data-testid="conversation-turn"]';
  if (!main.querySelector(messages)) return false;
  const anchors = [...main.querySelectorAll('[data-message-id], [data-turn-id], [data-chatgpt-search-message-ids]')]
    .filter(e => [e.getAttribute('data-message-id'), e.getAttribute('data-turn-id'),
      ...(e.getAttribute('data-chatgpt-search-message-ids') ?? '').split(/\s+/)]
      .some(id => id !== null && input.anchorIds.includes(id)));
  if (anchors.length > 0 && !input.scrollMounted) return false;
  const visible = (e: Element) => e.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true });
  if (document.getSelection()?.isCollapsed === false) return false;
  if ([...document.querySelectorAll('textarea,input:not([type=hidden]),[contenteditable=true],[role=textbox]')]
    .filter(visible).some(e => ((e as HTMLInputElement).value ?? (e as HTMLElement).innerText ?? '').trim())) return false;
  if ([...document.querySelectorAll('[role=dialog],[role=alertdialog],[role=alert],iframe,[data-testid="stop-button"],[data-is-streaming=true]')].some(visible)) return false;
  if ([...document.querySelectorAll('button[aria-label]')].some(e => visible(e) &&
    /^(중지|생성 중지|Stop generating|Stop streaming)$/i.test(e.getAttribute('aria-label') ?? ''))) return false;
  if (input.scrollMounted) {
    if (!input.explicit || anchors.length !== 1) return false;
    const anchor = anchors[0]!;
    if ([...main.querySelectorAll('[data-message-author-role="user"], [data-user-message-bubble]')].some(user =>
      !anchor.contains(user) && !!(anchor.compareDocumentPosition(user) & Node.DOCUMENT_POSITION_FOLLOWING))) return false;
    let scroller = anchor.parentElement;
    while (scroller && !(scroller.scrollHeight > scroller.clientHeight &&
      /auto|scroll/.test(getComputedStyle(scroller).overflowY))) scroller = scroller.parentElement;
    scroller ??= document.scrollingElement as HTMLElement | null;
    if (!scroller || scroller.scrollHeight <= scroller.clientHeight) return false;
    const before = scroller.scrollTop;
    scroller.scrollTo({ top: scroller.scrollHeight, behavior: 'instant' });
    return scroller.scrollTop !== before;
  }
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
