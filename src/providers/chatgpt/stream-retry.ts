/** Exact provider chrome only; inspect and click share one renderer task. */
export function streamRetrySurface(input: { origin: string; conversationId: string; anchor: string; click: boolean; preserveContinuationDraft?: boolean; prepareViewport?: boolean; dismissOutputPopover?: boolean; expiresAt?: number; outputPanel?: 'inspect' | 'close'; expectedOutputIdentity?: string }) {
  let outputPopover: { dialogId: string; ariaModal: string | null; state: string | null;
    controls: { label: string; expanded: string | null; description: string }[];
    triggers: { label: string; expanded: string | null; hasPopup: string | null }[]; eligible: boolean; inactive: boolean;
    identity: string; rendering: ReturnType<typeof rendering> } | undefined;
  const result = (present: boolean, reason: string, clicked = false, geometry?: {
    buttonBox: { x: number; y: number; width: number; height: number };
    viewport: { width: number; height: number }; centerInViewport: boolean; centerHit: 'button' | 'other' | 'none';
  }) => ({ present, reason, clicked, ...(geometry ? { geometry } : {}), ...(outputPopover ? { outputPopover } : {}) });
  if (location.origin !== input.origin || location.pathname !== `/c/${input.conversationId}`)
    return result(false, 'binding-url-changed');
  const visible = (e: Element) => e.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true });
  const rendering = (dialog: Element, retry?: HTMLButtonElement) => {
    const chain = [];
    for (let e: Element | null = dialog; e && chain.length < 6; e = e.parentElement) {
      const style = getComputedStyle(e), box = e.getBoundingClientRect();
      chain.push({ tag: e.tagName.toLowerCase(), id: e.id.slice(0, 160), role: e.getAttribute('role'),
        state: e.getAttribute('data-state'), ariaHidden: e.getAttribute('aria-hidden'), inert: e.hasAttribute('inert'),
        box: { x: box.x, y: box.y, width: box.width, height: box.height },
        display: style.display, visibility: style.visibility, opacity: style.opacity,
        pointerEvents: style.pointerEvents, overflowX: style.overflowX, overflowY: style.overflowY,
        clipPath: style.clipPath.slice(0, 160), transform: style.transform.slice(0, 160),
        animations: e.getAnimations().slice(0, 4).map(a => ({ playState: a.playState,
          currentTime: typeof a.currentTime === 'number' ? a.currentTime : null })) });
    }
    const box = retry?.getBoundingClientRect(), x = box ? box.x + box.width / 2 : -1, y = box ? box.y + box.height / 2 : -1;
    const hit = document.elementFromPoint(x, y);
    return { checkVisibility: visible(dialog), viewport: { width: innerWidth, height: innerHeight }, chain,
      retry: box && retry ? { box: { x: box.x, y: box.y, width: box.width, height: box.height },
        centerInViewport: x >= 0 && x < innerWidth && y >= 0 && y < innerHeight,
        centerHit: hit && retry.contains(hit) ? 'button' : hit && dialog.contains(hit) ? 'output-popover' : hit ? 'other' : 'none' } : null };
  };
  const messages = '[data-message-author-role], [data-chatgpt-search-message-ids], [data-testid^="conversation-turn"], .markdown';
  const alerts = [...document.querySelectorAll('[role=alert]')].filter(e => visible(e) &&
    !e.closest(`${messages},pre,code,blockquote`) && /^(메시지 스트림에 오류 발생|Error in message stream|Hmm\.{3}something seems to have gone wrong)[.!]?\s*(다시 시도|Retry|Try again)$/i.test((e as HTMLElement).innerText.trim()));
  if (!input.outputPanel && !alerts.length) return result(false, 'no-stream-retry');
  if (!input.outputPanel && alerts.length !== 1) return result(true, 'ambiguous-stream-retry');
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
  if (!input.outputPanel && edits.some(e => {
    const text = ((e as HTMLInputElement).value ?? (e as HTMLElement).innerText ?? '').trim();
    return text && !(input.preserveContinuationDraft && text === '계속' &&
      e.matches('#prompt-textarea, [data-testid="prompt-textarea"], main [role="textbox"][contenteditable="true"]') &&
      !e.closest(`${messages}, article, nav, aside`));
  }))
    return result(true, 'preserve-draft');
  if (!input.outputPanel && ([...document.querySelectorAll('[data-testid="stop-button"],[data-is-streaming=true],[data-testid*=thinking],[data-testid*=reasoning]')].some(visible) ||
      [...document.querySelectorAll('button')].some(e => visible(e) && /^(중지|생성 중지|Stop generating|Stop streaming)$/i.test(e.getAttribute('aria-label') ?? e.innerText.trim()))))
    return result(true, 'generation-active');
  if ([...document.querySelectorAll('[role=alert]')].some(e => visible(e) && (input.outputPanel || e !== alerts[0]) && !e.closest(messages)))
    return result(true, 'other-provider-control');
  if (!input.outputPanel && ([...document.querySelectorAll('input[type=file]')].some(e => (e as HTMLInputElement).files?.length) ||
      [...document.querySelectorAll('[data-testid*=attachment]')].some(visible))) return result(true, 'preserve-attachment');
  const buttons = [...(alerts[0]?.querySelectorAll('button') ?? [])].filter(e => visible(e) && /^(다시 시도|Retry|Try again)$/i.test(e.innerText.trim()));
  if (!input.outputPanel && (buttons.length !== 1 || buttons[0]!.disabled || buttons[0]!.getAttribute('aria-disabled') === 'true'))
    return result(true, 'retry-unavailable');
  const blockers = [...document.querySelectorAll('[role=dialog],[role=alertdialog],iframe')].filter(e => visible(e) ||
    (input.outputPanel && e.matches('[role=dialog][data-state=closed][inert][aria-hidden=true]')));
  if (blockers.length) {
    // An output list is provider chrome, not a tool permission. Require its
    // exact external toggle and file-list-only contents; never exempt dialogs.
    const dialog = blockers.length === 1 && blockers[0]!.matches('[role=dialog]') ? blockers[0]! : null;
    if (!dialog || dialog.closest(`${messages},article,pre,code,blockquote`)) return result(true, 'other-provider-control');
    const label = (e: Element) => (e.getAttribute('aria-label') ?? (e as HTMLElement).innerText ?? '').trim();
    const controls = [...dialog.querySelectorAll('button,a,input,select,textarea,summary,[role=button],[role=link],[role=checkbox],[role=radio],[role=combobox],[role=menuitem],[contenteditable=true]')].filter(e => input.outputPanel || visible(e));
    const description = (e: Element) => (e.getAttribute('aria-describedby') ?? '').split(/\s+/)
      .map(id => document.getElementById(id)?.textContent ?? '').join(' ').trim();
    const triggers = [...document.querySelectorAll('button[aria-controls]')].filter(e => visible(e) && dialog.id &&
      e.getAttribute('aria-controls')?.trim() === dialog.id && !e.closest(`${messages},article,form,[role=dialog],[role=alertdialog]`));
    const trigger = triggers.length === 1 ? triggers[0] as HTMLButtonElement : null;
    const outputs = controls.filter(e => e.matches('button[aria-expanded=true]') && /^(출력|Outputs?)$/i.test(label(e)));
    const documents = controls.filter(e => !outputs.includes(e));
    const text = (e: Element) => (e as HTMLElement).innerText.trim().replaceAll(/\s+/g, ' ');
    const expectedText = [...outputs, ...documents].map(e => {
      const value = text(e), desc = description(e);
      return desc && !value.endsWith(desc) ? `${value} ${desc}` : value;
    }).join(' ');
    const documentOnly = !!dialog.id && [...document.querySelectorAll('[id]')].filter(e => e.id === dialog.id).length === 1 &&
      controls.length <= 20 && outputs.length === 1 && documents.length > 0 && documents.every(e => e.matches('button') &&
      /^(문서|Document|이미지|Image|코드|Code)$/i.test(description(e)) && /^(Open .+|.+ 열기)$/i.test(label(e))) &&
      text(dialog).replaceAll(/\s/g, '') === expectedText.replaceAll(/\s/g, '');
    const box = trigger?.getBoundingClientRect();
    const hit = box && document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2);
    const eligible = documentOnly && [null, 'false'].includes(dialog.getAttribute('aria-modal')) && dialog.getAttribute('data-state') === 'open' &&
      dialog.closest('[inert],[aria-hidden=true]') === null &&
      trigger !== null && trigger.type === 'button' && trigger.getAttribute('aria-haspopup') === 'dialog' &&
      trigger.getAttribute('aria-expanded') === 'true' && !trigger.disabled && trigger.getAttribute('aria-disabled') !== 'true' &&
      trigger.closest('[inert],[aria-hidden=true]') === null && hit !== null && hit !== undefined && trigger.contains(hit);
    const closed = documentOnly && [null, 'false'].includes(dialog.getAttribute('aria-modal')) &&
      dialog.getAttribute('data-state') === 'closed' && triggers.every(e => e.getAttribute('aria-expanded') === 'false');
    // The provider retains this exact document panel after closing it. CSS
    // visibility alone does not distinguish its inert, accessibility-hidden state.
    // Other dialogs remain blockers; the actual Retry hit test still runs below.
    const inactive = closed && dialog.hasAttribute('inert') && dialog.getAttribute('aria-hidden') === 'true';
    // Bounded structural evidence only: no document body, draft, handlers or credentials.
    outputPopover = { dialogId: dialog.id, ariaModal: dialog.getAttribute('aria-modal'), state: dialog.getAttribute('data-state'),
      controls: controls.slice(0, 20).map(e => ({ label: label(e).slice(0, 160), expanded: e.getAttribute('aria-expanded'), description: description(e).slice(0, 80) })),
      triggers: triggers.slice(0, 4).map(e => ({ label: label(e).slice(0, 80), expanded: e.getAttribute('aria-expanded'), hasPopup: e.getAttribute('aria-haspopup') })),
      eligible, inactive, identity: '', rendering: rendering(dialog, buttons[0]) };
    outputPopover.identity = JSON.stringify({ dialogId: dialog.id, state: outputPopover.state, ariaModal: outputPopover.ariaModal,
      inert: dialog.hasAttribute('inert'), ariaHidden: dialog.getAttribute('aria-hidden'),
      controls: controls.map(e => [label(e), e.getAttribute('aria-expanded'), description(e)]),
      triggers: triggers.map(e => [label(e), e.getAttribute('aria-expanded'), e.getAttribute('aria-haspopup')]) });
    if (input.outputPanel && input.expectedOutputIdentity !== undefined && input.expectedOutputIdentity !== outputPopover.identity)
      return result(true, 'output-panel-evidence-stale');
    if (!inactive) {
      if (closed) return result(true, 'output-popover-closing');
      if (!eligible) return result(true, 'other-provider-control');
      if (!input.dismissOutputPopover && input.outputPanel !== 'close') return result(true, 'output-popover-open');
      if (input.expiresAt === undefined || Date.now() > input.expiresAt) return result(true, 'popover-lease-expired');
      if (document.getSelection()?.isCollapsed === false) return result(true, 'preserve-selection');
      trigger!.click();
      // Dispatch is not proof of dismissal. The caller must verify the entire surface again.
      return result(true, 'output-popover-toggle-dispatched', !!input.outputPanel);
    }
  }
  if (input.outputPanel) return result(!!outputPopover, outputPopover?.inactive ? 'output-panel-inactive' : 'output-panel-absent');
  const button = buttons[0]!, box = button.getBoundingClientRect();
  const x = box.x + box.width / 2, y = box.y + box.height / 2;
  const hit = document.elementFromPoint(x, y);
  const geometry = { buttonBox: { x: box.x, y: box.y, width: box.width, height: box.height },
    viewport: { width: innerWidth, height: innerHeight },
    centerInViewport: x >= 0 && x < innerWidth && y >= 0 && y < innerHeight,
    centerHit: hit && button.contains(hit) ? 'button' as const : hit ? 'other' as const : 'none' as const };
  if (!geometry.centerInViewport) {
    if (!input.prepareViewport) return result(true, 'retry-offscreen', false, geometry);
    if (input.expiresAt === undefined || Date.now() > input.expiresAt) return result(true, 'viewport-lease-expired', false, geometry);
    if (document.getSelection()?.isCollapsed === false) return result(true, 'preserve-selection', false, geometry);
    button.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'instant' });
    // Preparation never clicks. The caller must freshly revalidate the turn and hit test.
    return result(true, 'viewport-prepared', false, geometry);
  }
  if (!hit || !button.contains(hit)) return result(true, 'retry-obscured', false, geometry);
  if (input.click && (input.expiresAt === undefined || Date.now() > input.expiresAt)) return result(true, 'click-lease-expired', false, geometry);
  if (input.click) button.click();
  return result(true, 'exact-stream-retry', input.click, geometry);
}
