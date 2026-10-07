export type LoadSurface = { kind: 'retry' | 'normal' | 'held' | 'other'; reason: string; clicked: boolean; loadError: boolean };

/** Self-contained for Page.evaluate: inspect and optional click run in one renderer task. */
export function conversationLoadSurface(input: { origin: string; conversationId: string; submittedUserMessageId?: string | null; click: boolean; expiresAt?: number }): LoadSurface {
  let loadError = false;
  const result = (kind: LoadSurface['kind'], reason: string, clicked = false): LoadSurface => ({ kind, reason, clicked, loadError });
  if (location.origin !== input.origin || location.pathname !== `/c/${input.conversationId}`) return result('held', 'binding-url-changed');
  const visible = (e: Element) => e.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true });
  const main = document.querySelector('main');
  if (!main) return result('other', 'main-unavailable');
  const messages = '[data-message-author-role], [data-chatgpt-search-message-ids], [data-testid^="conversation-turn"], .markdown, [class^="MarkdownRoot-"], [class*=" MarkdownRoot-"]';
  const noticePattern = /^(이 ChatGPT 대화를 불러올 수 없습니다|대화를 불러올 수 없습니다|Unable to load conversation(?:\s+[a-f0-9-]+)?|This conversation could not be loaded|Cannot load conversation)[.!]?$/i;
  // The live error card has a direct text node followed by its button, not a leaf notice.
  const ownText = (e: Element) => [...e.childNodes].filter(n => n.nodeType === Node.TEXT_NODE).map(n => n.textContent ?? '').join('').trim();
  const notices = [...main.querySelectorAll('div,p,h1,h2,span')].filter(e => visible(e) && !e.closest(`${messages},pre,code,blockquote`) && noticePattern.test(ownText(e)));
  // Words in a transcript are not provider state. Standalone alerts can use a same-row Retry.
  const cards = notices.flatMap(notice => {
    const alert = notice.closest('[role=alert]');
    const scopes: Element[] = alert && main.contains(alert) && !alert.closest(`${messages},pre,code,blockquote`) &&
      !alert.querySelector(messages) ? [alert] : [];
    let scope: Element | null = notice;
    for (let i = 0; scope && scope !== main && i < 3; i++, scope = scope.parentElement) {
      if (!scopes.includes(scope)) scopes.push(scope);
    }
    for (const scope of scopes) {
      const nearby = [...scope.querySelectorAll('button')].filter(visible);
      if (nearby.length !== 1) continue;
      const button = nearby[0]!;
      if (!/^(다시 시도|새로고침|Retry|Reload|Refresh)$/i.test(button.innerText.trim())) continue;
      const textNode = [...notice.childNodes].find(n => n.nodeType === Node.TEXT_NODE && n.textContent?.trim())!;
      const range = document.createRange(); range.selectNodeContents(textNode);
      if (scope === alert) {
        if (!(notice.compareDocumentPosition(button) & Node.DOCUMENT_POSITION_FOLLOWING)) continue;
      } else if (button.getBoundingClientRect().top < range.getBoundingClientRect().bottom - 2) continue;
      return [{ button, alert: scope === alert ? alert : null }];
    }
    return [];
  });
  loadError = cards.length > 0;
  const edits = [...document.querySelectorAll('textarea,input:not([type=hidden]),[contenteditable=true],[role=textbox]')].filter(visible);
  const composer = edits.some(e => e.closest('main') && (e.matches('[contenteditable=true],[role=textbox],textarea')));
  if (!loadError) return result(composer && main.querySelector(messages) ? 'normal' : 'other', composer ? 'conversation-rendered' : 'load-surface-unverified');
  if (edits.some(e => ((e as HTMLInputElement).value ?? (e as HTMLElement).innerText ?? '').trim().length > 0)) return result('held', 'manual-draft');
  const buttons = [...document.querySelectorAll('button')].filter(visible);
  if (buttons.some(e => e.matches('[data-testid="stop-button"]') || /^(중지|생성 중지|Stop generating|Stop streaming)$/i.test(e.getAttribute('aria-label') ?? e.innerText.trim())) ||
      [...main.querySelectorAll('[data-is-streaming=true],[data-testid*=thinking],[data-testid*=reasoning]')].some(visible)) return result('held', 'generation-active');
  const barriers = [...document.querySelectorAll('[role=alert],[role=alertdialog],[role=dialog],iframe')].filter(visible);
  if (barriers.some(e => !e.closest(messages) && /captcha|verify you|human verification|로그인|인증|권한|permission|sign in|log in/i.test((e as HTMLElement).innerText || e.getAttribute('title') || e.getAttribute('src') || ''))) return result('held', 'verification-or-permission');
  const history = [...main.querySelectorAll(messages)];
  const anchor = history.find(message => {
    const ids = new Set((message.getAttribute('data-chatgpt-search-message-ids') ?? '').split(/\s+/).filter(Boolean));
    return !!input.submittedUserMessageId && (message.getAttribute('data-message-id') === input.submittedUserMessageId ||
      (ids.size === 1 && ids.has(input.submittedUserMessageId)));
  });
  if (notices.length !== 1 || cards.length !== 1 || history.some(message => !cards[0]!.alert ||
      !anchor || !(message.compareDocumentPosition(cards[0]!.alert) & Node.DOCUMENT_POSITION_FOLLOWING) ||
      (message !== anchor && !message.contains(anchor) && !anchor.contains(message) &&
        !(message.compareDocumentPosition(anchor) & Node.DOCUMENT_POSITION_FOLLOWING)))) return result('held', 'mixed-or-ambiguous-surface');
  if (/captcha|verify you|human verification|로그인|인증|권한|permission|sign in|log in/i.test(main.innerText)) return result('held', 'verification-or-permission');
  if (/too many requests|rate limit|429|사용량.*제한|요청.*너무|잠시 후.*다시/i.test(main.innerText)) return result('held', 'service-limited');
  const button = cards[0]!.button;
  if (button.disabled || button.getAttribute('aria-disabled') === 'true') return result('held', 'load-retry-button-unavailable');
  const buttonRect = button.getBoundingClientRect();
  const hit = document.elementFromPoint(buttonRect.x + buttonRect.width / 2, buttonRect.y + buttonRect.height / 2);
  if (!hit || !button.contains(hit)) return result('held', 'load-retry-button-obscured');
  // No awaited gap: a manual draft/turn or changed surface cannot race the guard and dispatch.
  if (input.click && (input.expiresAt === undefined || Date.now() > input.expiresAt)) return result('held', 'click-lease-expired');
  if (input.click) button.click();
  return result('retry', 'conversation-load-retry', input.click);
}
