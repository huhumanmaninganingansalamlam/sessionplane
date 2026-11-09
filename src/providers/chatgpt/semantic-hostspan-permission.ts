import { createHash } from 'node:crypto';
import type { Page } from 'playwright-core';

/** Untrusted provider-page evidence, never an instruction or a grant token. */
export interface SemanticHostSpanPermission {
  readonly appName: string;
  readonly toolName: string | null;
  readonly visibleSummary: string;
  readonly argumentsSummary: string | null;
  readonly detailState: 'not_visible' | 'visible_unverified' | 'truncated' | 'redacted';
  readonly evidenceHash: string;
  readonly canGrant: false;
}

const MAX_SUMMARY = 1600;
const MAX_ARGUMENTS = 1600;
const SECRET_MARKER = /[\"']?(?:password|secret|token|api[_-]?key|private[_-]?key|cookie|authorization)[\"']?\s*[:=]|\bbearer\s+[A-Za-z0-9._~+/-]{8,}|\b(?:sk|ghp|gho|github_pat)[-_][A-Za-z0-9_-]{8,}/i;

/**
 * Only a visible provider-owned HostSpan grant card after the exact latest
 * acknowledged user message is in scope. A quoted tool call or transcript
 * button is never a grant. Read-only: does not open Details or click Allow.
 * A03: when material arguments cannot be validated, agent review is required
 * and no executable grant candidate is returned.
 */
export async function inspectSemanticHostSpanPermission(
  page: Page, submittedUserMessageId: string,
): Promise<SemanticHostSpanPermission | null> {
  const raw = await page.evaluate(({ userId, maxSummary, maxArguments }) => {
    const visible = (e: Element) =>
      e.closest('[aria-hidden="true"], [inert]') === null &&
      e.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true }) &&
      e.getBoundingClientRect().width > 0;
    const getId = (node: Element) => {
      // Current DIL user bubbles carry identity on the enclosing transcript group.
      // Only a single ID on an explicit user unit can anchor a permission.
      const group = node.matches('[data-user-message-bubble]')
        ? node.closest<HTMLElement>('[data-chatgpt-search-message-ids]') : null;
      if (group !== null) {
        const ids = [...new Set((group.getAttribute('data-chatgpt-search-message-ids') ?? '')
          .split(/\s+/).filter(Boolean))];
        return group.getAttribute('data-chatgpt-search-unit-key')?.endsWith(':user') === true &&
          ids.length === 1 ? ids[0]! : null;
      }
      const identity = node.closest('[data-message-id], [data-turn-id], [data-dil-message-id]') ?? node;
      const values = [
        identity.getAttribute('data-message-id'),
        identity.getAttribute('data-turn-id'),
        identity.getAttribute('data-dil-message-id'),
        node.getAttribute('data-message-id'),
        node.getAttribute('data-dil-message-id'),
        ...(node.getAttribute('data-chatgpt-search-message-ids') ?? '').split(/\s+/),
      ].filter(Boolean);
      return values.length === 1 ? values[0] : values.includes(userId) ? userId : null;
    };
    const users = [...document.querySelectorAll<HTMLElement>(
      '[data-message-author-role="user"], [data-user-message-bubble]',
    )].filter(node => !node.closest('nav, aside, [role="navigation"]'));
    const owned = users.filter(node => getId(node) === userId);
    if (owned.length !== 1 || users.at(-1) !== owned[0]) return null;
    const anchor = owned[0]!;
    const candidates = [...document.querySelectorAll<HTMLElement>(
      '[role="alert"], [role="alertdialog"], [role="dialog"]',
    )].filter(card => {
      if (!visible(card) || card.closest(
        'article, [data-message-author-role], [data-user-message-bubble], nav, aside, pre, code, blockquote',
      ) || card.contains(anchor)) return false;
      const position = anchor.compareDocumentPosition(card);
      if (position & Node.DOCUMENT_POSITION_DISCONNECTED ||
          !(position & Node.DOCUMENT_POSITION_FOLLOWING)) return false;
      const appToken = /\bhostspan(?:-[a-z0-9_-]+)?\b/i.test(card.innerText);
      if (!appToken) return false;
      const grants = [...card.querySelectorAll<HTMLElement>('button, [role="button"]')]
        .filter(e => visible(e) && /^(?:Allow|Allow once|Allow this time|허용|이번만 허용|한 번 허용|한 번만 허용)$/i
          .test((e.getAttribute('aria-label') ?? e.innerText ?? '').trim()));
      return grants.length === 1;
    });
    // Multiple popup cards or other ambiguous provider chrome must be handled
    // through bounded expansion; never pick the first matching Allow.
    if (candidates.length !== 1) return null;
    const card = candidates[0]!;
    const text = card.innerText.trim();
    const appName = text.match(/\bhostspan(?:-[a-z0-9_-]+)?\b/i)?.[0] ?? '';
    if (!appName || text.length > 8_000) return null;
    const fromKorean = text.match(/\bhostspan(?:-[a-z0-9_-]+)?의\s+([\w.-]{1,100})\s+도구/i)?.[1];
    const fromEnglish = text.match(/\b(?:calling|call)\s+(?:the\s+)?([\w.-]{1,100})\s+tool\s+(?:from|of)\s+hostspan/i)?.[1];
    const marked = card.querySelector<HTMLElement>('[data-tool-name]')?.getAttribute('data-tool-name');
    const toolName = (fromKorean ?? fromEnglish ?? marked ?? '').trim();
    const validTool = /^[A-Za-z0-9_.-]{1,100}$/.test(toolName) ? toolName : null;
    const details = [...card.querySelectorAll<HTMLElement>('pre')].filter(visible);
    const argument = details.length === 1 ? details[0]!.innerText.trim() : null;
    return {
      appName: appName.toLowerCase(), toolName: validTool,
      text, argument,
      summaryTooLong: text.length > maxSummary,
      argumentsTooLong: argument !== null && argument.length > maxArguments,
    };
  }, { userId: submittedUserMessageId, maxSummary: MAX_SUMMARY, maxArguments: MAX_ARGUMENTS });
  if (!raw) return null;
  const hasSecret = SECRET_MARKER.test(raw.text) ||
    (raw.argument !== null && SECRET_MARKER.test(raw.argument));
  const detailState: SemanticHostSpanPermission['detailState'] = hasSecret
    ? 'redacted' : raw.summaryTooLong || raw.argumentsTooLong
      ? 'truncated' : raw.argument === null
        ? 'not_visible' : 'visible_unverified';
  // Never turn raw provider text into permission or return unbounded details.
  const visibleSummary = hasSecret
    ? '[Sensitive permission details withheld; explicit secure review required]'
    : raw.summaryTooLong ? '[Permission details exceed bounded review packet; expansion required]'
      : raw.text;
  const argumentsSummary = detailState === 'visible_unverified' ? raw.argument : null;
  return {
    appName: raw.appName, toolName: raw.toolName,
    visibleSummary, argumentsSummary, detailState,
    evidenceHash: createHash('sha256').update(JSON.stringify({
      pageUrl: page.url(), submittedUserMessageId, raw,
    })).digest('hex'),
    canGrant: false,
  };
}
