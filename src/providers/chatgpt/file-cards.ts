import type { ElementHandle, Page } from 'playwright-core';
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
    const pending = page.waitForEvent('download', { timeout: 15_000 }).then(download => ({ download }), error => ({ error }));
    await button.focus();
    await button.press('Enter', { timeout: 5_000 });
    const result = await pending;
    if ('error' in result) throw new ProviderSubmissionError('provider.artifact-download-failed', 'File card produced no confirmed download');
    check();
    if (result.download.suggestedFilename() !== found[0]!.name) unavailable('Downloaded filename does not match the exact file card');
    const stream = await result.download.createReadStream();
    const chunks: Buffer[] = [];
    for await (const chunk of stream) chunks.push(Buffer.from(chunk));
    return { candidate, bytes: new Uint8Array(Buffer.concat(chunks)) };
  } finally { await root.dispose(); }
}
