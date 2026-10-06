export type LoadSurface = { kind: 'retry' | 'normal' | 'held' | 'other'; reason: string; clicked: boolean; loadError: boolean };

/** Self-contained for Page.evaluate: inspect and optional click run in one renderer task. */
export function conversationLoadSurface(input: { origin: string; conversationId: string; click: boolean; expiresAt?: number }): LoadSurface {
  let loadError = false;
  const result = (kind: LoadSurface['kind'], reason: string, clicked = false): LoadSurface => ({ kind, reason, clicked, loadError });
  if (location.origin !== input.origin || location.pathname !== `/c/${input.conversationId}`) return result('held', 'binding-url-changed');
  const visible = (e: Element) => e.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true });
  const main = document.querySelector('main');
  if (!main) return result('other', 'main-unavailable');
  const messages = '[data-message-author-role], [data-chatgpt-search-message-ids], [data-testid="conversation-turn"]';
  const noticePattern = /^(이 ChatGPT 대화를 불러올 수 없습니다|대화를 불러올 수 없습니다|Unable to load conversation(?:\s+[a-f0-9-]+)?|This conversation could not be loaded|Cannot load conversation)[.!]?$/i;
  const notices = [...main.querySelectorAll('div,p,h1,h2,span')].filter(e => visible(e) && !e.closest(messages) && e.children.length === 0 && noticePattern.test((e.textContent ?? '').trim()));
  loadError = notices.length > 0;
  const edits = [...document.querySelectorAll('textarea,input:not([type=hidden]),[contenteditable=true],[role=textbox]')].filter(visible);
  const composer = edits.some(e => e.closest('main') && (e.matches('[contenteditable=true],[role=textbox],textarea')));
  if (notices.length === 0) return result(composer && main.querySelector(messages) ? 'normal' : 'other', composer ? 'conversation-rendered' : 'load-surface-unverified');
  if (edits.some(e => ((e as HTMLInputElement).value ?? (e as HTMLElement).innerText ?? '').trim().length > 0)) return result('held', 'manual-draft');
  const buttons = [...document.querySelectorAll('button')].filter(visible);
  if (buttons.some(e => e.matches('[data-testid="stop-button"]') || /^(중지|생성 중지|Stop generating|Stop streaming)$/i.test(e.getAttribute('aria-label') ?? e.innerText.trim())) ||
      [...main.querySelectorAll('[data-is-streaming=true],[data-testid*=thinking],[data-testid*=reasoning]')].some(visible)) return result('held', 'generation-active');
  const barriers = [...document.querySelectorAll('[role=alert],[role=alertdialog],[role=dialog],iframe')].filter(visible);
  if (barriers.some(e => !e.closest(messages) && /captcha|verify you|human verification|로그인|인증|권한|permission|sign in|log in/i.test((e as HTMLElement).innerText || e.getAttribute('title') || e.getAttribute('src') || ''))) return result('held', 'verification-or-permission');
  if (notices.length !== 1 || main.querySelector(messages)) return result('held', 'mixed-or-ambiguous-surface');
  if (/captcha|verify you|human verification|로그인|인증|권한|permission|sign in|log in/i.test(main.innerText)) return result('held', 'verification-or-permission');
  if (/too many requests|rate limit|429|사용량.*제한|요청.*너무|잠시 후.*다시/i.test(main.innerText)) return result('held', 'service-limited');
  let scope: Element | null = notices[0]!.parentElement;
  for (let i = 0; scope && scope !== main && i < 3; i++, scope = scope.parentElement) {
    const nearby = [...scope.querySelectorAll('button')].filter(visible);
    if (nearby.length !== 1) continue;
    const button = nearby[0]!;
    if (!/^(다시 시도|새로고침|Retry|Reload|Refresh)$/i.test(button.innerText.trim()) || button.disabled || button.getAttribute('aria-disabled') === 'true') continue;
    const noticeRect = notices[0]!.getBoundingClientRect(), buttonRect = button.getBoundingClientRect();
    if (buttonRect.top < noticeRect.bottom - 2 || !scope.contains(notices[0]!)) continue;
    const hit = document.elementFromPoint(buttonRect.x + buttonRect.width / 2, buttonRect.y + buttonRect.height / 2);
    if (!hit || !button.contains(hit)) return result('held', 'load-retry-button-obscured');
    // No awaited gap: a manual draft/turn or changed surface cannot race the guard and dispatch.
    if (input.click && (input.expiresAt === undefined || Date.now() > input.expiresAt)) return result('held', 'click-lease-expired');
    if (input.click) button.click();
    return result('retry', 'conversation-load-retry', input.click);
  }
  return result('held', 'load-retry-button-unavailable');
}
