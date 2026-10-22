/** Exact provider chrome only; inspect and click share one renderer task. */
export function streamRetrySurface(input: { origin: string; conversationId: string; anchor: string; click: boolean }) {
  const result = (present: boolean, reason: string, clicked = false) => ({ present, reason, clicked });
  if (location.origin !== input.origin || location.pathname !== `/c/${input.conversationId}`)
    return result(false, 'binding-url-changed');
  const visible = (e: Element) => e.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true });
  const messages = '[data-message-author-role], [data-chatgpt-search-message-ids], [data-testid^="conversation-turn"], .markdown';
  const alerts = [...document.querySelectorAll('[role=alert]')].filter(e => visible(e) &&
    !e.closest(`${messages},pre,code,blockquote`) && /^(메시지 스트림에 오류 발생|Error in message stream)[.!]?\s*(다시 시도|Retry|Try again)$/i.test((e as HTMLElement).innerText.trim()));
  if (!alerts.length) return result(false, 'no-stream-retry');
  if (alerts.length !== 1) return result(true, 'ambiguous-stream-retry');
  // Match both provider renderers, including the current single-ID search wrapper.
  const users = [...document.querySelectorAll('[data-message-author-role=user],[data-user-message-bubble]')]
    .map(node => node.closest('[data-message-id],[data-turn-id],[data-dil-message-id],[data-chatgpt-search-message-ids]'))
    .filter((node): node is Element => node !== null);
  const last = users.at(-1);
  const searchIds = (last?.getAttribute('data-chatgpt-search-message-ids') ?? '').trim().split(/\s+/).filter(Boolean);
  const renderedId = last?.getAttribute('data-dil-message-id');
  const renderedGroup = last?.closest('[data-chatgpt-search-message-ids]');
  const validRenderedId = renderedId && (renderedGroup?.getAttribute('data-chatgpt-search-message-ids') ?? '').split(/\s+/).includes(renderedId);
  const id = last?.getAttribute('data-message-id') ?? last?.getAttribute('data-turn-id') ??
    (validRenderedId ? renderedId : searchIds.length === 1 ? searchIds[0] : null);
  if (id !== input.anchor) return result(true, 'original-anchor-not-latest');
  const edits = [...document.querySelectorAll('textarea,input:not([type=hidden]),[contenteditable=true],[role=textbox]')].filter(visible);
  if (edits.some(e => ((e as HTMLInputElement).value ?? (e as HTMLElement).innerText ?? '').trim()))
    return result(true, 'preserve-draft');
  if ([...document.querySelectorAll('[data-testid="stop-button"],[data-is-streaming=true],[data-testid*=thinking],[data-testid*=reasoning]')].some(visible) ||
      [...document.querySelectorAll('button')].some(e => visible(e) && /^(중지|생성 중지|Stop generating|Stop streaming)$/i.test(e.getAttribute('aria-label') ?? e.innerText.trim())))
    return result(true, 'generation-active');
  if ([...document.querySelectorAll('[role=dialog],[role=alertdialog],iframe')].some(visible) ||
      [...document.querySelectorAll('[role=alert]')].some(e => visible(e) && e !== alerts[0] && !e.closest(messages)))
    return result(true, 'other-provider-control');
  if ([...document.querySelectorAll('input[type=file]')].some(e => (e as HTMLInputElement).files?.length) ||
      [...document.querySelectorAll('[data-testid*=attachment]')].some(visible)) return result(true, 'preserve-attachment');
  const buttons = [...alerts[0]!.querySelectorAll('button')].filter(e => visible(e) && /^(다시 시도|Retry|Try again)$/i.test(e.innerText.trim()));
  if (buttons.length !== 1 || buttons[0]!.disabled || buttons[0]!.getAttribute('aria-disabled') === 'true')
    return result(true, 'retry-unavailable');
  const button = buttons[0]!, box = button.getBoundingClientRect();
  const hit = document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2);
  if (!hit || !button.contains(hit)) return result(true, 'retry-obscured');
  if (input.click) button.click();
  return result(true, 'exact-stream-retry', input.click);
}
