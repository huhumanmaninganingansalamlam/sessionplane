import type { ElementHandle, Page, Response } from 'playwright-core';
import { ProviderSubmissionError, type ProviderArtifactCandidate, type ProviderArtifactRequest } from '../provider-adapter.ts';
import { readChatGptMessages } from './message-dom.ts';
import { CHATGPT_SELECTORS } from './selectors.ts';

const downloadSelector = 'button[aria-label="Download file"],button[aria-label="파일 다운로드"]';
const previewSelector = 'button[aria-label^="Open preview of "],button[aria-label$=" 미리보기 열기"]';
const source = (response: string, name: string) => `sessionplane-file-card:${encodeURIComponent(response)}/${encodeURIComponent(name)}`;
function unavailable(message: string): never {
  throw new ProviderSubmissionError('provider.artifacts-unavailable', message);
}

async function exactRoot(page: Page, request: ProviderArtifactRequest, requireAnchor = true): Promise<ElementHandle<HTMLElement>> {
  const messages = await readChatGptMessages(page, true);
  const answers = messages.filter(m => m.role === 'assistant' && m.messageId === request.session.responseMessageId);
  if (answers.length !== 1 || answers[0]?.elementIndex === undefined) unavailable('Exact artifact answer is not unique');
  const answer = answers[0];
  const anchors = messages.filter(m => m.role === 'user' &&
    ((request.session.submittedUserMessageId !== null && m.messageId === request.session.submittedUserMessageId) ||
     (request.session.submittedUserTurnId !== null && m.turnId === request.session.submittedUserTurnId)));
  if (requireAnchor && anchors.length !== 1) unavailable('Exact artifact user anchor is not unique');
  if (requireAnchor && anchors[0]!.rootIndex !== answer.rootIndex) unavailable('Artifact answer belongs to another DOM root');
  const start = messages.indexOf(anchors[0]!);
  const end = messages.indexOf(answer);
  if (requireAnchor && (end <= start || messages.slice(start + 1, end).some(m => m.role === 'user'))) unavailable('Artifact answer ancestry changed');
  const node = await page.locator(CHATGPT_SELECTORS.messages).nth(answer.elementIndex!).elementHandle();
  if (node === null) unavailable('Exact artifact answer disappeared');
  const stillExact = await node.evaluate((el, expected) => {
    const root = el.closest('[data-message-id], [data-turn-id]') ?? el;
    const ids = [...new Set((el.getAttribute('data-chatgpt-search-message-ids') ?? '').split(/\s+/).filter(Boolean))];
    return (root.getAttribute('data-message-id') ?? el.getAttribute('data-message-id') ?? (ids.length === 1 ? ids[0] : null)) === expected;
  }, request.session.responseMessageId);
  if (!stillExact) { await node.dispose(); unavailable('Artifact response identity changed'); }
  const handle = await node.evaluateHandle(el => el.closest<HTMLElement>('[data-message-id], [data-turn-id]') ?? el as HTMLElement);
  await node.dispose();
  const root = handle.asElement();
  if (root === null) unavailable('Exact artifact answer disappeared');
  return root;
}

async function cards(root: ElementHandle<HTMLElement>) {
  return await root.evaluate((root, { downloadSelector, previewSelector }) => [...root.querySelectorAll<HTMLButtonElement>(downloadSelector)].map((button, index) => {
    let parent = button.parentElement;
    while (parent && root.contains(parent)) {
      const previews = parent.querySelectorAll<HTMLButtonElement>(previewSelector);
      if (previews.length === 1 && parent.querySelectorAll(downloadSelector).length === 1) {
        const label = previews[0]!.getAttribute('aria-label')!;
        return { index, name: label.startsWith('Open preview of ') ? label.slice('Open preview of '.length) : label.slice(0, -' 미리보기 열기'.length) };
      }
      if (parent === root) break;
      parent = parent.parentElement;
    }
    return { index, name: '' };
  }), { downloadSelector, previewSelector });
}

export async function discoverFileCards(page: Page, request: ProviderArtifactRequest, check: () => void) {
  const root = await exactRoot(page, request, false);
  try {
    if ((await root.$$(downloadSelector)).length === 0) return [];
    const verified = await exactRoot(page, request);
    await verified.dispose();
    // Expanding this exact answer's file list never opens a preview or submits.
    const more = await root.$$('button');
    for (const button of more) {
      if (/^\d+ more$/.test((await button.innerText()).trim())) {
        check();
        await button.click({ timeout: 5_000 });
        break;
      }
    }
  } finally { await root.dispose(); }
  check();
  const current = await exactRoot(page, request);
  try {
    const found = await cards(current);
    if (found.some(c => !c.name) || new Set(found.map(c => c.name)).size !== found.length) unavailable('File card names are missing or ambiguous');
    return found.map(c => ({ source: source(request.session.responseMessageId!, c.name), name: c.name, mediaType: null }));
  } finally { await current.dispose(); }
}

export async function downloadFileCard(page: Page, request: ProviderArtifactRequest, candidate: ProviderArtifactCandidate, check: () => void) {
  const root = await exactRoot(page, request);
  try {
    const found = (await cards(root)).filter(c => source(request.session.responseMessageId!, c.name) === candidate.sourceUrl);
    if (found.length !== 1) unavailable('Exact file card is missing or ambiguous');
    const buttons = await root.$$(downloadSelector);
    const button = buttons[found[0]!.index];
    if (!button || !await button.isVisible() || !await button.isEnabled()) unavailable('Exact download control is unavailable');
    const stillNamed = await button.evaluate((button, { expected, previewSelector }) => {
      let parent = button.parentElement;
      while (parent) {
        const previews = parent.querySelectorAll(previewSelector);
        if (previews.length === 1) {
          const label = previews[0]!.getAttribute('aria-label');
          return label === 'Open preview of ' + expected || label === expected + ' 미리보기 열기';
        }
        if (previews.length > 1) return false;
        parent = parent.parentElement;
      }
      return false;
    }, { expected: found[0]!.name, previewSelector });
    if (!stillNamed) unavailable('File card changed before download');
    check();
    // Keyboard activation avoids the observed preview overlay; never force-click it.
    const transport: string[] = [];
    const attachmentResponses: Response[] = [];
    let popups = 0;
    const onPopup = () => { popups++; };
    const onResponse = (response: Response) => {
      if (!['fetch', 'xhr', 'document'].includes(response.request().resourceType())) return;
      const url = new URL(response.url());
      const category = url.pathname.includes('/files/') ? 'file-metadata'
        : url.pathname.includes('/content') ? 'file-content' : 'provider-request';
      const headers = response.headers();
      const retryAfter = headers['retry-after'];
      const mime = headers['content-type']?.split(';')[0];
      const contentType = mime && /^[a-z0-9.+-]+\/[a-z0-9.+-]+$/i.test(mime) ? mime : 'unknown';
      const disposition = headers['content-disposition'] ?? '';
      const filename = /(?:^|;)\s*filename=(?:"([^"]*)"|([^;\s]+))/i.exec(disposition);
      const exactFilename = (filename?.[1] ?? filename?.[2]) === found[0]!.name;
      if (category === 'file-content' && response.request().method() === 'GET' && response.status() === 200 && /^attachment\b/i.test(disposition) && exactFilename) {
        attachmentResponses.push(response);
      }
      transport.push(`${category}:HTTP${response.status()}:type=${contentType}:attachment=${/^attachment\b/i.test(disposition)}:exactFilename=${exactFilename}${retryAfter && /^\d+$/.test(retryAfter) ? `:Retry-After=${retryAfter}s` : ''}`);
    };
    page.on('response', onResponse);
    page.on('popup', onPopup);
    const pending = page.waitForEvent('download', { timeout: 15_000 }).then(download => ({ download }), error => ({ error }));
    let result;
    try {
      await button.focus();
      await button.press('Enter', { timeout: 5_000 });
      result = await pending;
    } finally {
      page.off('response', onResponse);
      page.off('popup', onPopup);
    }
    if ('error' in result) {
      // A noDefaults controller preserves sibling settings but has no download
      // event setup. Read the exact named attachment through the same authenticated
      // page instead of changing browser-wide download behavior.
      if (attachmentResponses.length === 1) {
        check();
        const verified = await exactRoot(page, request);
        await verified.dispose();
        const file = await page.evaluate(async ({ url, name }) => {
          const response = await fetch(url, { credentials: 'include' });
          const disposition = response.headers.get('content-disposition') ?? '';
          const filename = /(?:^|;)\s*filename=(?:"([^"]*)"|([^;\s]+))/i.exec(disposition);
          if (response.status !== 200 || !/^attachment\b/i.test(disposition) || (filename?.[1] ?? filename?.[2]) !== name) {
            return { ok: false as const, status: response.status, retryAfter: response.headers.get('retry-after'), base64: '' };
          }
          const bytes = new Uint8Array(await response.arrayBuffer());
          let binary = '';
          for (let offset = 0; offset < bytes.length; offset += 0x8000) binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
          return { ok: true as const, base64: btoa(binary) };
        }, { url: attachmentResponses[0]!.url(), name: found[0]!.name });
        if (!file.ok) throw new ProviderSubmissionError('provider.artifact-download-failed',
          `Exact attachment read failed (HTTP${file.status}${file.retryAfter && /^\d+$/.test(file.retryAfter) ? `; Retry-After=${file.retryAfter}s` : ''})`);
        check();
        const final = await exactRoot(page, request);
        await final.dispose();
        return { candidate, bytes: new Uint8Array(Buffer.from(file.base64, 'base64')) };
      }
      const focused = await button.evaluate(element => document.activeElement === element).catch(() => false);
      throw new ProviderSubmissionError('provider.artifact-download-failed',
        `File card produced no confirmed download (${transport.slice(-10).join(', ') || 'no transport response'}; popups=${popups}; downloadControlFocused=${focused})`);
    }
    check();
    if (result.download.suggestedFilename() !== found[0]!.name) unavailable('Downloaded filename does not match the exact file card');
    const stream = await result.download.createReadStream();
    const chunks: Buffer[] = [];
    for await (const chunk of stream) chunks.push(Buffer.from(chunk));
    return { candidate, bytes: new Uint8Array(Buffer.concat(chunks)) };
  } finally { await root.dispose(); }
}
