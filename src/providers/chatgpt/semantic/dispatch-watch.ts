import type { ElementHandle, Page, Request } from "playwright-core";
import type { SemanticDispatchEvidence, SemanticRootPostEvidence } from "../../semantic-adapter.ts";
import type { Control } from "./semantic-types.ts";
import { sha } from "./chatgpt-page-access.ts";
import { isRecord } from "./recover-chatgpt-turn.ts";

export async function clickExactChatGptSend(
  page: Page, handle: ElementHandle<HTMLElement>, expected: Control,
  beforeMutation: () => void,
): Promise<boolean> {
  const hidden = await page.evaluate(() => document.visibilityState === 'hidden');
  if (!hidden) {
    beforeMutation();
    await handle.click({ timeout: 5_000 });
    return false;
  }
  const point = await handle.evaluate((element, signature) => {
    const actual = [
      element.tagName.toLowerCase(), element.id, element.getAttribute('data-testid'),
      element.getAttribute('role'), element.getAttribute('aria-label'),
      element.getAttribute('placeholder'), element.getAttribute('type'),
    ].join('|');
    const rect = element.getBoundingClientRect();
    const x = rect.x + rect.width / 2, y = rect.y + rect.height / 2;
    const hit = document.elementFromPoint(x, y);
    return element.isConnected && actual === signature &&
      element.closest('main') !== null &&
      element.closest('[aria-hidden="true"], [inert]') === null &&
      !element.matches(':disabled, [aria-disabled="true"], [readonly]') &&
      element.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true }) &&
      rect.width > 0 && rect.height > 0 &&
      Number.isFinite(x) && Number.isFinite(y) &&
      x >= 0 && y >= 0 && x < innerWidth && y < innerHeight &&
      (hit === element || element.contains(hit)) ? { x, y } : null;
  }, expected.signature);
  if (!point) throw new Error('Exact hidden send target failed hit test');
  beforeMutation();
  const stillPinned = await handle.evaluate((element, previous) => {
    const actual = [
      element.tagName.toLowerCase(), element.id, element.getAttribute('data-testid'),
      element.getAttribute('role'), element.getAttribute('aria-label'),
      element.getAttribute('placeholder'), element.getAttribute('type'),
    ].join('|');
    const rect = element.getBoundingClientRect();
    const hit = document.elementFromPoint(previous.x, previous.y);
    return element.isConnected && actual === previous.signature &&
      !element.matches(':disabled, [aria-disabled="true"], [readonly]') &&
      element.closest('[aria-hidden="true"], [inert]') === null &&
      Math.abs(rect.x + rect.width / 2 - previous.x) < 1 &&
      Math.abs(rect.y + rect.height / 2 - previous.y) < 1 &&
      (hit === element || element.contains(hit));
  }, { ...point, signature: expected.signature });
  if (!stillPinned) throw new Error('Hidden send target changed before input');
  beforeMutation();
  // A CDP Input.dispatchMouseEvent can be silently ignored by the inactive
  // renderer. HTMLElement.click() dispatches the *same exact button's* click
  // inside its DOM, including the browser's native submit event for a form.
  // This may be untrusted to the provider. The caller still requires one
  // independently witnessed canonical POST; it never retries this invocation.
  await handle.evaluate(element => {
    if (!element.isConnected || element.matches(':disabled, [aria-disabled="true"]')) {
      throw new Error('Exact hidden submit control changed');
    }
    element.click();
  });
  return true;
}

export function watchExactRootDispatch(page: Page, expectedSha256: string,
  onObserved?: (evidence: SemanticRootPostEvidence) => void) {
  const posts: SemanticRootPostEvidence[] = [];
  let wake: (() => void) | null = null;
  const onRequest = (request: Request) => {
    if (request.method() !== 'POST') return;
    try {
      const url = new URL(request.url());
      if (url.origin !== new URL(page.url()).origin ||
          !/^\/backend-api\/(?:f\/)?conversation$/.test(url.pathname)) return;
      const body: unknown = request.postDataJSON();
      if (!isRecord(body) || body.action !== 'next' ||
          (body.conversation_id !== null && body.conversation_id !== undefined &&
            (typeof body.conversation_id !== 'string' ||
              !/^[A-Za-z0-9_-]{1,160}$/.test(body.conversation_id))) ||
          typeof body.parent_message_id !== 'string' || !body.parent_message_id ||
          !Array.isArray(body.messages)) return;
      const users = body.messages.filter(message => isRecord(message) &&
        isRecord(message.author) && message.author.role === 'user');
      if (users.length !== 1) return;
      const user = users[0];
      if (!isRecord(user) || typeof user.id !== 'string' || !user.id ||
          !isRecord(user.content) || user.content.content_type !== 'text' ||
          !Array.isArray(user.content.parts) ||
          !user.content.parts.every(part => typeof part === 'string')) return;
      const textHash = sha(user.content.parts.join('\n').replaceAll('\r\n', '\n'));
      if (textHash !== expectedSha256) return;
      const evidence: SemanticRootPostEvidence = {
        requestConversationId: typeof body.conversation_id === 'string'
          ? body.conversation_id : null,
        messageId: user.id, parentMessageId: body.parent_message_id,
        textHash, observedAt: new Date().toISOString(),
      };
      posts.push(evidence);
      onObserved?.(evidence);
      wake?.();
    } catch { return; /* Malformed/foreign requests grant no root ACK. */ }
  };
  page.on('request', onRequest);
  return {
    snapshot: () => [...posts],
    stop: () => page.off('request', onRequest),
    async collect(timeoutMs: number): Promise<SemanticRootPostEvidence[]> {
      if (posts.length === 0) {
        let timer: ReturnType<typeof setTimeout> | undefined;
        await new Promise<void>(resolve => {
          wake = resolve; timer = setTimeout(resolve, timeoutMs);
        });
        clearTimeout(timer);
        wake = null;
      }
      return this.snapshot();
    },
  };
}

export function watchExactDispatch(page: Page, conversationId: string, expectedSha256: string,
  onObserved?: (evidence: SemanticDispatchEvidence) => void) {
  const attempts: SemanticDispatchEvidence[] = [];
  let wake: (() => void) | null = null;
  const onRequest = (request: Request) => {
    if (request.method() !== 'POST') return;
    try {
      const url = new URL(request.url());
      if (url.origin !== new URL(page.url()).origin ||
        !/^\/backend-api\/(?:f\/)?conversation$/.test(url.pathname)) return;
      const body: unknown = request.postDataJSON();
      if (!isRecord(body) || body.action !== 'next' ||
        body.conversation_id !== conversationId ||
        typeof body.parent_message_id !== 'string' || !body.parent_message_id) return;
      if (!Array.isArray(body.messages)) return;
      const users = body.messages.filter(message => isRecord(message) &&
        isRecord(message.author) && message.author.role === 'user');
      if (users.length !== 1) return;
      const user = users[0];
      if (!isRecord(user) || typeof user.id !== 'string' || !user.id ||
        !isRecord(user.content) || user.content.content_type !== 'text' ||
        !Array.isArray(user.content.parts) ||
        !user.content.parts.every(part => typeof part === 'string')) return;
      const text = user.content.parts.join('\n').replaceAll('\r\n', '\n');
      const textHash = sha(text);
      if (textHash !== expectedSha256) return;
      const attempt = {
        conversationId, messageId: user.id, parentMessageId: body.parent_message_id,
        textHash, observedAt: new Date().toISOString(),
      };
      attempts.push(attempt);
      // Persistence is invoked during the request event, not after the
      // Playwright click/ACK wait. A failed callback marks the result uncertain.
      onObserved?.(attempt);
      wake?.();
    } catch { return; /* Unrelated/malformed requests confer no ACK. */ }
  };
  page.on('request', onRequest);
  return {
    snapshot: () => [...attempts],
    stop: () => page.off('request', onRequest),
    async collect(timeoutMs: number): Promise<SemanticDispatchEvidence[]> {
      if (attempts.length === 0) {
        let timer: ReturnType<typeof setTimeout> | undefined;
        await new Promise<void>(resolve => {
          wake = resolve;
          timer = setTimeout(resolve, timeoutMs);
        });
        clearTimeout(timer);
        wake = null;
      }
      return this.snapshot();
    },
  };
}
