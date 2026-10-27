import { createHash } from 'node:crypto';
import type { Page } from 'playwright-core';
import { REF_PROPERTY } from '../../browser/ref-snapshot.ts';
import { SessionPlaneDomainError } from '../../domain/errors.ts';
import { readChatGptMessages } from './message-dom.ts';
import { CHATGPT_SELECTORS } from './selectors.ts';

export interface HostSpanPermissionInput {
  action: 'inspect' | 'allow';
  appName: string;
  toolName?: string | undefined;
  evidenceHash?: string | undefined;
  allowMode?: 'once' | 'always' | undefined;
}

const once = /^(?:허용|이번만 허용|한 번 허용|한 번만 허용|Allow|Allow once|Allow this time)(?:\s*⏎)?$/i;

const always = /^(?:항상 허용|Always allow)(?:\s*⏎)?$/i;

/** Read mounted work activity, including hidden cards, without revealing or granting it. */
export async function inspectHostSpanActivity(page: Page, submittedUserMessageId: string,
  retainedAcknowledgements: ReadonlySet<string> = new Set()) {
  const users = (await readChatGptMessages(page, true)).filter(message => message.role === 'user');
  const unavailable = (reason: string) => ({ scope: 'mounted-dom' as const, available: false as const,
    reason, submittedUserMessageId, providerMutation: false as const });
  if (users.at(-1)?.messageId !== submittedUserMessageId ||
      users.filter(message => message.messageId === submittedUserMessageId).length !== 1)
    return unavailable('exact-current-ack-not-mounted');
  let start = users.length - 1;
  while (start > 0 && users[start]!.text.trim() === '계속' && users[start - 1]!.rootIndex === users[start]!.rootIndex) start--;
  const work = users[start]!;
  if (work.elementIndex === undefined) return unavailable('work-anchor-unavailable');
  const surface = await page.locator(CHATGPT_SELECTORS.messages).nth(work.elementIndex).evaluate((anchor, input) => {
    const identity = anchor.closest('[data-message-id], [data-turn-id], [data-dil-message-id]') ?? anchor;
    const ids = [identity.getAttribute('data-message-id'), anchor.getAttribute('data-message-id'),
      anchor.getAttribute('data-dil-message-id'), ...(anchor.getAttribute('data-chatgpt-search-message-ids') ?? '').split(/\s+/)];
    if (input.workId === null || !ids.includes(input.workId)) return null;
    const root = anchor.getRootNode() as Document | ShadowRoot;
    const app = /(^|[^\w-])hostspan(?:-[a-z0-9_-]+)?($|[^\w-])/i;
    const action = /^(?:항상 허용|Always allow|허용|이번만 허용|한 번 허용|한 번만 허용|Allow|Allow once|Allow this time|자세히 보기|View details|See details|다시 연결|Reconnect)(?:\s*⏎)?$/i;
    const userNodes = [...root.querySelectorAll(input.selector)].flatMap(node => {
      if (node.getAttribute('data-message-author-role') !== 'user' && !node.querySelector('[data-user-message-bubble]')) return [];
      const identity = node.closest('[data-message-id], [data-turn-id], [data-dil-message-id]') ?? node;
      const id = identity.getAttribute('data-message-id') ?? node.getAttribute('data-message-id') ??
        node.getAttribute('data-dil-message-id') ?? node.getAttribute('data-chatgpt-search-message-ids');
      return [{ node, id }];
    });
    const association = (element: Element) => {
      const owner = userNodes.filter(({ node }) => {
        const position = node.compareDocumentPosition(element);
        return !(position & Node.DOCUMENT_POSITION_DISCONNECTED) && !!(position & Node.DOCUMENT_POSITION_FOLLOWING);
      }).at(-1);
      return owner?.id && input.retainedIds.includes(owner.id) ? owner.id : null;
    };
    const inCurrentWork = (element: Element) => {
      const position = anchor.compareDocumentPosition(element);
      return !(position & Node.DOCUMENT_POSITION_DISCONNECTED) && !!(position & Node.DOCUMENT_POSITION_FOLLOWING);
    };
    const inWork = (element: Element) => element.closest('nav, aside, [role="navigation"]') === null &&
      (inCurrentWork(element) || association(element) !== null);
    const provenance = (element: Element) => ({ association: inCurrentWork(element) ? 'current-work' : 'retained-acknowledged-turn',
      owningUserMessageId: association(element) });
    const name = (element: Element) => element.getAttribute('aria-label') ||
      (element.getAttribute('aria-labelledby') ?? '').split(/\s+/).map(id => root.getElementById(id)?.textContent ?? '').join(' ').trim() ||
      (element.textContent ?? '').trim();
    const visible = (element: Element) => element.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true });
    // Reuse snapshot element identity: equal labels and DOM order never select a disclosure.
    const ref = (element: Element) => {
      const existing = Reflect.get(element, input.refProperty);
      if (typeof existing === 'string') return existing;
      const token = `hostspan-activity:${crypto.randomUUID()}`;
      Object.defineProperty(element, input.refProperty, { value: token, configurable: true });
      return token;
    };
    const controls = (element: Element) => [...element.querySelectorAll('button, [role="button"], summary, a[href], [role="link"]')].slice(0, 20)
      .map(button => {
        const href = button.getAttribute('href');
        let url: URL | null = null;
        try {
          const parsed = href === null ? null : new URL(href, location.href);
          if (parsed?.protocol === 'https:' || parsed?.protocol === 'http:') url = parsed;
        } catch { /* Malformed links remain diagnostic controls without a URL. */ }
        return { name: name(button).slice(0, 500), visible: visible(button),
          disabled: button.hasAttribute('disabled') || button.getAttribute('aria-disabled') === 'true',
          role: button.getAttribute('role') ?? (button.tagName === 'A' ? 'link' : 'button'),
          href: url === null ? null : url.origin + url.pathname,
          urlParameterNames: url === null ? [] : [...url.searchParams.keys()].sort() };
      });
    const cards = new Set<Element>();
    for (const element of root.querySelectorAll('[role="alert"], [role="alertdialog"], [role="dialog"]'))
      if (inWork(element) && app.test(element.textContent ?? '')) cards.add(element);
    // An observed control may live beside an alert, or in a card with no ARIA role.
    // These are diagnostic candidates, never permission evidence or click targets.
    for (const button of root.querySelectorAll('button, [role="button"]')) {
      if (!inWork(button) || !action.test(name(button))) continue;
      let card = button.parentElement;
      for (let depth = 0; card && depth < 4; depth++, card = card.parentElement) {
        if (card.matches('body, main, [role="main"]') || card.contains(anchor) ||
            card.querySelector('[data-message-author-role="user"], [data-user-message-bubble]')) break;
        if (app.test(card.textContent ?? '') && inWork(card)) { cards.add(card); break; }
      }
    }
    // Only inherit app context from a structural activity wrapper, never a nearby label.
    const appActivity = (element: Element) => {
      if (app.test(name(element))) return null;
      for (let container = element.parentElement; container; container = container.parentElement) {
        if (container.matches('body, main, [role="main"]') || container.querySelector('[data-message-author-role="user"], [data-user-message-bubble]')) break;
        const headers = container.querySelectorAll(':scope > [class~="group/activity-header"] > button[aria-expanded]');
        if (headers.length !== 1) continue;
        const header = headers[0]!;
        if (header === element || !app.test(name(header)) || !visible(header) ||
            header.getAttribute('aria-expanded') !== 'true' || association(header) !== association(element)) continue;
        return { ref: ref(header), name: name(header), expanded: header.getAttribute('aria-expanded'), state: header.getAttribute('data-state') };
      }
      return null;
    };
    // Bind a generic previous-activity opener to its nearest single-app container.
    const containedApp = (element: Element) => {
      if (!/^(이전 활동|Previous activity)$/i.test(name(element))) return null;
      const container = element.closest('[class~="group/activity-header"]')?.parentElement ?? element.parentElement;
      if (!container || container.matches('body, main, [role="main"]') ||
          container.querySelector('[data-message-author-role="user"], [data-user-message-bubble]')) return null;
      const openers = [...container.querySelectorAll('button[aria-expanded]')].filter(button => /^(이전 활동|Previous activity)$/i.test(name(button)));
      const headers = [...container.querySelectorAll('button[aria-expanded]')].filter(header => header !== element && app.test(name(header)));
      if (openers.length !== 1 || openers[0] !== element || headers.length !== 1) return null;
      const header = headers[0]!;
      if (association(header) === null || association(header) !== association(element)) return null;
      return { containerRef: ref(container), ref: ref(header), name: name(header),
        expanded: header.getAttribute('aria-expanded'), state: header.getAttribute('data-state') };
    };
    const disclosures = [...root.querySelectorAll('button[aria-expanded], summary')].filter(element => inWork(element) &&
      (element.closest('[class~="group/activity-header"], details') !== null ||
        /이전 활동|작업|활동|previous activity|working|worked|activity/i.test(name(element))));
    return {
      cards: [...cards].slice(0, 20).map(card => ({ role: card.getAttribute('role'),
        text: (card.textContent ?? '').trim().slice(0, 4000), textTruncated: (card.textContent ?? '').trim().length > 4000,
        visible: visible(card), controls: controls(card), ...provenance(card) })),
      disclosures: disclosures.slice(0, 40).map(element => {
        const contained = containedApp(element);
        const container = contained === null ? null
          : element.closest('[class~="group/activity-header"]')?.parentElement ?? element.parentElement;
        const text = (container?.textContent ?? '').trim();
        return { activityRef: ref(element), name: name(element).slice(0, 500), visible: visible(element),
        expanded: element.getAttribute('aria-expanded'), state: element.getAttribute('data-state'),
        appActivity: appActivity(element), containedApp: contained,
        containedActivity: container === null ? null : { text: text.slice(0, 4000), textTruncated: text.length > 4000,
          controls: controls(container) },
        revealAvailable: element.tagName === 'BUTTON' &&
          ((element.closest('[class~="group/activity-header"]') !== null && (app.test(name(element)) || appActivity(element) !== null)) || contained !== null) &&
          visible(element) && !element.hasAttribute('disabled') && element.getAttribute('aria-disabled') !== 'true' &&
          (element.getAttribute('aria-expanded') === 'false' || element.getAttribute('data-state') === 'closed'),
        controls: (element.getAttribute('aria-controls') ?? '').split(/\s+/).filter(Boolean), ...provenance(element) };
      }),
      truncated: cards.size > 20 || disclosures.length > 40,
    };
  }, { workId: work.messageId, selector: CHATGPT_SELECTORS.messages, retainedIds: [...retainedAcknowledgements, submittedUserMessageId], refProperty: REF_PROPERTY });
  if (surface === null) return unavailable('work-anchor-changed-during-inspection');
  const current = (await readChatGptMessages(page)).filter(message => message.role === 'user');
  if (current.length !== users.length || current.some((user, index) =>
      user.messageId !== users[index]?.messageId || user.text !== users[index]?.text || user.rootIndex !== users[index]?.rootIndex))
    return unavailable('user-boundary-changed-during-inspection');
  return { scope: 'mounted-dom' as const, available: true as const, submittedUserMessageId,
    workUserMessageId: work.messageId, providerMutation: false as const, ...surface,
    disclosures: surface.disclosures.map(disclosure => ({ ...disclosure,
      activityEvidenceHash: disclosure.revealAvailable && disclosure.owningUserMessageId !== null
        ? createHash('sha256').update(JSON.stringify(['hostspan-activity-inspection', page.url(), submittedUserMessageId,
          disclosure.owningUserMessageId, disclosure.activityRef, disclosure.name, disclosure.expanded, disclosure.state, disclosure.controls, disclosure.appActivity, disclosure.containedApp])).digest('hex') : null })) };
}

/** An explicit inspection can reveal one freshly selected owned activity, never grant a tool. */
export async function revealHostSpanActivity(page: Page, submittedUserMessageId: string,
  retainedAcknowledgements: ReadonlySet<string>, appName: string, evidenceHash: string) {
  if (!/^hostspan(?:-[a-z0-9_-]+)?$/i.test(appName)) throw unavailable('Only HostSpan activity inspection is supported');
  const observed = await inspectHostSpanActivity(page, submittedUserMessageId, retainedAcknowledgements);
  if (!observed.available) throw unavailable(observed.reason);
  const matches = observed.disclosures.filter(disclosure => disclosure.activityEvidenceHash === evidenceHash);
  if (matches.length !== 1) throw unavailable('Inspect and select one fresh HostSpan activityEvidenceHash');
  const activity = matches[0]!;
  if (!new RegExp(`(^|[^\\w-])${appName}($|[^\\w-])`, 'i').test(activity.containedApp?.name ?? activity.appActivity?.name ?? activity.name)) throw unavailable('The selected activity belongs to a different app');
  const buttons = page.getByRole('button', { name: activity.name, exact: true });
  const selected = await buttons.evaluateAll((elements, expected) => elements.flatMap((element, index) =>
    Reflect.get(element, expected.property) === expected.ref ? [index] : []),
  { property: REF_PROPERTY, ref: activity.activityRef });
  if (selected.length !== 1) throw unavailable('The exact observed activity disclosure is absent or ambiguous');
  const clicked = await buttons.nth(selected[0]!).evaluate((element, expected) => {
    const root = element.getRootNode() as Document | ShadowRoot;
    const name = (node: Element) => node.getAttribute('aria-label') ||
      (node.getAttribute('aria-labelledby') ?? '').split(/\s+/).map(id => root.getElementById(id)?.textContent ?? '').join(' ').trim() ||
      (node.textContent ?? '').trim();
    const users = [...root.querySelectorAll(expected.selector)].filter(node =>
      node.getAttribute('data-message-author-role') === 'user' || node.querySelector('[data-user-message-bubble]'));
    const id = (node: Element) => (node.closest('[data-message-id], [data-turn-id], [data-dil-message-id]') ?? node).getAttribute('data-message-id') ??
      node.getAttribute('data-dil-message-id') ?? node.getAttribute('data-chatgpt-search-message-ids');
    const owner = users.filter(node => {
      const position = node.compareDocumentPosition(element);
      return !(position & Node.DOCUMENT_POSITION_DISCONNECTED) && !!(position & Node.DOCUMENT_POSITION_FOLLOWING);
    }).at(-1);
    let appActivity = null;
    if (expected.activity.appActivity !== null) {
      for (let container = element.parentElement; container; container = container.parentElement) {
        if (container.matches('body, main, [role="main"]') || container.querySelector('[data-message-author-role="user"], [data-user-message-bubble]')) break;
        const headers = container.querySelectorAll(':scope > [class~="group/activity-header"] > button[aria-expanded]');
        if (headers.length !== 1) continue;
        const header = headers[0]!;
        if (header === element || !/(^|[^\w-])hostspan(?:-[a-z0-9_-]+)?($|[^\w-])/i.test(name(header)) ||
            !header.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true }) || header.getAttribute('aria-expanded') !== 'true') continue;
        const headerOwner = users.filter(node => {
          const position = node.compareDocumentPosition(header);
          return !(position & Node.DOCUMENT_POSITION_DISCONNECTED) && !!(position & Node.DOCUMENT_POSITION_FOLLOWING);
        }).at(-1);
        if (!headerOwner || !owner || id(headerOwner) !== id(owner)) continue;
        appActivity = { ref: Reflect.get(header, expected.refProperty), name: name(header), expanded: header.getAttribute('aria-expanded'), state: header.getAttribute('data-state') };
        break;
      }
    }
    let containedApp = null;
    if (expected.activity.containedApp !== null && /^(이전 활동|Previous activity)$/i.test(name(element))) {
      const container = element.closest('[class~="group/activity-header"]')?.parentElement ?? element.parentElement;
      if (container && !container.matches('body, main, [role="main"]') &&
          !container.querySelector('[data-message-author-role="user"], [data-user-message-bubble]')) {
        const openers = [...container.querySelectorAll('button[aria-expanded]')].filter(button => /^(이전 활동|Previous activity)$/i.test(name(button)));
        const headers = [...container.querySelectorAll('button[aria-expanded]')].filter(header =>
          header !== element && /(^|[^\w-])hostspan(?:-[a-z0-9_-]+)?($|[^\w-])/i.test(name(header)));
        const header = headers[0];
        const headerOwner = header && users.filter(node => {
          const position = node.compareDocumentPosition(header);
          return !(position & Node.DOCUMENT_POSITION_DISCONNECTED) && !!(position & Node.DOCUMENT_POSITION_FOLLOWING);
        }).at(-1);
        if (openers.length === 1 && openers[0] === element && headers.length === 1 && header && headerOwner && owner && id(headerOwner) === id(owner))
          containedApp = { containerRef: Reflect.get(container, expected.refProperty), ref: Reflect.get(header, expected.refProperty),
            name: name(header), expanded: header.getAttribute('aria-expanded'), state: header.getAttribute('data-state') };
      }
    }
    if (!(element instanceof HTMLButtonElement) || location.href !== expected.url ||
        Reflect.get(element, expected.refProperty) !== expected.activity.activityRef ||
        (!element.closest('[class~="group/activity-header"]') && containedApp === null) || element.closest('nav, aside, [role="navigation"]') ||
        !element.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true }) || element.disabled || element.getAttribute('aria-disabled') === 'true' ||
        JSON.stringify(appActivity) !== JSON.stringify(expected.activity.appActivity) ||
        JSON.stringify(containedApp) !== JSON.stringify(expected.activity.containedApp) ||
        name(element) !== expected.activity.name || element.getAttribute('aria-expanded') !== expected.activity.expanded ||
        element.getAttribute('data-state') !== expected.activity.state ||
        JSON.stringify((element.getAttribute('aria-controls') ?? '').split(/\s+/).filter(Boolean)) !== JSON.stringify(expected.activity.controls) ||
        users.filter(node => id(node) === expected.currentAck).length !== 1 || id(users.at(-1)!) !== expected.currentAck ||
        !owner || id(owner) !== expected.activity.owningUserMessageId) return false;
    element.click();
    return true;
  }, { url: page.url(), selector: CHATGPT_SELECTORS.messages, currentAck: submittedUserMessageId, activity, refProperty: REF_PROPERTY });
  if (!clicked) throw unavailable('The selected activity or ACK boundary changed before inspection');
  return { outcome: 'activity-revealed' as const, activityUserMessageId: activity.owningUserMessageId,
    activityEvidenceHash: evidenceHash, revealClicked: true, grantAttempted: false,
    activity: await inspectHostSpanActivity(page, submittedUserMessageId, retainedAcknowledgements) };
}

/** Only an explicitly selected HostSpan tool permission, never a generic UI click. */
export async function controlHostSpanPermission(page: Page, input: HostSpanPermissionInput, submittedUserMessageId: string) {
  if (!/^hostspan(?:-[a-z0-9_-]+)?$/i.test(input.appName)) throw unavailable('Only HostSpan permissions are supported');
  const allowMode = input.allowMode ?? 'once';
  const allow = allowMode === 'always' ? always : once;
  if (input.action === 'allow' && !input.toolName) throw unavailable('Select the observed tool name before allowing it');
  if (input.action === 'allow' && !input.evidenceHash) throw unavailable(
    'Inspect the exact tool with the same allowMode, then pass its evidenceHash to allow');
  const users = (await readChatGptMessages(page, true)).filter(message => message.role === 'user');
  if (users.at(-1)?.messageId !== submittedUserMessageId ||
      users.filter(message => message.messageId === submittedUserMessageId).length !== 1) {
    throw unavailable('The exact current user anchor is no longer mounted');
  }
  // A permission may precede literal Continues, but never another work question.
  let start = users.length - 1;
  while (start > 0 && users[start]!.text.trim() === '계속' && users[start - 1]!.rootIndex === users[start]!.rootIndex) start--;
  const inWork = async (scope: ReturnType<Page['locator']>) => {
    if (users[start]!.elementIndex === undefined) return false;
    const anchor = await page.locator(CHATGPT_SELECTORS.messages).nth(users[start]!.elementIndex!).elementHandle();
    if (!anchor) throw unavailable('The original work anchor is no longer mounted');
    return await scope.evaluate((element, user) => {
      const position = user.compareDocumentPosition(element);
      return !(position & Node.DOCUMENT_POSITION_DISCONNECTED) && !!(position & Node.DOCUMENT_POSITION_FOLLOWING);
    }, anchor).finally(() => anchor.dispose());
  };
  const app = new RegExp(`(^|[^\\w-])${input.appName}($|[^\\w-])`, 'i');
  const scopes = page.locator('[role="dialog"], [role="alertdialog"], [role="alert"]');
  const matching = async (includeHidden = false) => {
    const matches = [];
    for (const scope of await scopes.all()) {
      if (!includeHidden && !await scope.isVisible()) continue;
      const text = (await scope.textContent() ?? '').trim();
      if (app.test(text) && (input.toolName === undefined || text.includes(input.toolName)) && await inWork(scope)) matches.push(scope);
    }
    return matches;
  };
  const disclosures = page.locator('button[aria-expanded], button[data-state="closed"], button[data-state="open"]');
  const linkedDisclosures = async () => {
    const indices = new Set<number>();
    for (const scope of await matching(true)) {
      if (await scope.getAttribute('role') !== 'alert') continue;
      const card = await scope.elementHandle();
      if (!card) continue;
      const linked = await disclosures.evaluateAll((buttons, target) => buttons.flatMap((button, index) => {
        const root = button.getRootNode() as Document | ShadowRoot;
        const controlled = (button.getAttribute('aria-controls') ?? '').split(/\s+/).filter(Boolean)
          .map(id => root.getElementById(id));
        const activity = button.closest('[class~="group/activity-header"]')?.parentElement;
        const ownsCard = controlled.some(panel => panel?.contains(target)) || (activity?.contains(target) &&
          !activity.querySelector('[data-message-author-role="user"], [data-user-message-bubble]') &&
          activity.querySelectorAll(':scope > [class~="group/activity-header"] > button[aria-expanded]').length === 1);
        return ownsCard ? [index] : [];
      }), card).finally(() => card.dispose());
      for (const index of linked) if (await inWork(disclosures.nth(index))) indices.add(index);
    }
    return [...indices];
  };
  const disclosureDetails = async (index: number) => await disclosures.nth(index).evaluate(element => ({
    name: element.getAttribute('aria-label') || (element.getAttribute('aria-labelledby') ?? '').split(/\s+/)
      .map(id => (element.getRootNode() as Document | ShadowRoot).getElementById(id)?.textContent ?? '').join(' ') || element.textContent || '',
    expanded: element.getAttribute('aria-expanded'), state: element.getAttribute('data-state'),
    visible: element.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true }),
  }));
  let workDisclosure: string | null = null;
  const hiddenAlerts = [];
  if ((await matching()).length === 0) {
    for (const scope of await matching(true)) if (await scope.getAttribute('role') === 'alert') hiddenAlerts.push(scope);
  }
  if (hiddenAlerts.length === 1) {
    const indices = await linkedDisclosures();
    if (indices.length === 1) {
      const button = disclosures.nth(indices[0]!);
      const details = await disclosureDetails(indices[0]!);
      if ((details.expanded === 'false' || details.state === 'closed') && details.visible && await button.isEnabled()) {
        workDisclosure = details.name;
        await button.click({ timeout: 5_000 });
      }
    }
  }
  const permissionAnchor = async (scope: ReturnType<Page['locator']>) => {
    const users = (await readChatGptMessages(page, true)).filter(message => message.role === 'user');
    for (const user of users.toReversed()) {
      if (user.elementIndex === undefined) continue;
      const element = await page.locator(CHATGPT_SELECTORS.messages).nth(user.elementIndex).elementHandle();
      if (element && await scope.evaluate((card, node) =>
          !!(node.compareDocumentPosition(card) & Node.DOCUMENT_POSITION_FOLLOWING), element).finally(() => element.dispose())) return user.messageId;
    }
    return null;
  };
  if (input.action === 'inspect' && input.toolName === undefined) {
    const cards = [];
    for (const scope of await matching()) cards.push({ permissionText: (await scope.innerText()).trim(),
      submittedUserMessageId: await permissionAnchor(scope),
      buttons: await scope.getByRole('button').allTextContents() });
    return { outcome: 'discovered', allowMode, appName: input.appName, cards, workDisclosure,
      workDisclosures: await Promise.all((await linkedDisclosures()).map(disclosureDetails)) };
  }
  // ChatGPT opens command details in a separate modal over the permission alert.
  // Inspect and close only that exact modal, then act on the original permission.
  const closeDetails = async () => {
    const dialogs = await matching();
    let command = '';
    for (const dialog of dialogs) {
      if (!['dialog', 'alertdialog'].includes(await dialog.getAttribute('role') ?? '')) continue;
      const close = dialog.getByRole('button', { name: /^(?:대화 상자 닫기|Close dialog)$/i });
      if (await close.count() !== 1 || await dialog.getByRole('button', { name: allow }).count() !== 0) continue;
      if (command) throw unavailable('The exact HostSpan command details are ambiguous');
      command = (await dialog.innerText()).trim();
      await close.click({ timeout: 5_000 });
      await dialog.waitFor({ state: 'hidden', timeout: 5_000 });
    }
    return command;
  };
  const find = async () => {
    let matches = await matching();
    if (matches.length === 2) {
      // Details can expose the exact grant in a modal over its original alert.
      const grants = [];
      for (const match of matches) if (['dialog', 'alertdialog'].includes(await match.getAttribute('role') ?? '') &&
          await match.getByRole('button', { name: allow }).count() === 1) grants.push(match);
      if (grants.length === 1) matches = grants;
    }
    if (matches.length !== 1) throw unavailable('The exact HostSpan tool permission is absent or ambiguous');
    let scope = matches[0]!;
    // The permission's action row can be a sibling of its ARIA alert.
    // Use only the nearest card with this single alert, never the page/main.
    while (await scope.getByRole('button', { name: allow }).count() === 0) {
      const parent = scope.locator('..');
      if (await parent.evaluate(element => element.matches('body, main, [role="main"]') ||
          element.querySelector('[data-message-author-role="user"]') !== null) ||
          await parent.locator('[role="alert"], [role="alertdialog"], [role="dialog"]').count() !== 1) break;
      scope = parent;
    }
    if (await scope.getByRole('button', { name: allow }).count() !== 1) {
      throw unavailable('The exact permission card must have one selected Allow control');
    }
    return scope;
  };
  let command = await closeDetails();
  const cards = await matching();
  if (cards.length === 1) {
    const details = cards[0]!.getByRole('button', { name: /^(?:자세히 보기|View details|See details)$/i });
    if (await details.count() === 1 && await details.getAttribute('aria-expanded') !== 'true') {
      // The current permission may expose only Details until its actions open.
      await details.click({ timeout: 5_000 });
      command = await closeDetails() || command;
    }
  }
  const scope = await find();
  const text = (await scope.innerText()).trim();
  const alertText = (await (await matching())[0]!.innerText()).trim();
  const buttons = await scope.getByRole('button').evaluateAll(elements => elements.map(element =>
    element.getAttribute('aria-label') ?? element.textContent ?? ''));
  const permissionText = command ? `${text}\n${command}` : text;
  const permissionUserMessageId = await permissionAnchor(scope);
  const evidenceHash = createHash('sha256').update(JSON.stringify([page.url(), input.appName, input.toolName, allowMode, permissionUserMessageId, permissionText])).digest('hex');
  if (input.action === 'inspect') return { outcome: 'inspected', allowMode, appName: input.appName, toolName: input.toolName,
    evidenceHash, permissionUserMessageId, permissionText, workDisclosure, buttons: buttons.map(name => name.trim()) };
  if (input.evidenceHash !== evidenceHash) throw unavailable('Inspect the current exact permission before allowing it');
  // Recheck the command/details and explicitly selected button in the same DOM operation.
  const clicked = await scope.evaluate((element, expected) => {
    if (!(element instanceof HTMLElement) || element.innerText.trim() !== expected.text) return false;
    const buttons = [...element.querySelectorAll('button, [role="button"]')].filter(button =>
      button instanceof HTMLElement && button.getClientRects().length > 0 &&
      !button.hasAttribute('disabled') && button.getAttribute('aria-disabled') !== 'true' &&
      new RegExp(expected.allow, 'i').test((button.getAttribute('aria-label') ?? button.textContent ?? '').trim()));
    if (buttons.length !== 1) return false;
    (buttons[0] as HTMLElement).click();
    return true;
  }, { text, allow: allow.source });
  if (!clicked) throw unavailable('The exact selected Allow control changed or is unavailable');
  await page.waitForFunction(expected => ![...document.querySelectorAll('[role="dialog"], [role="alertdialog"], [role="alert"]')]
    .some(element => element instanceof HTMLElement && element.getClientRects().length > 0 &&
      element.innerText.trim() === expected), alertText, { timeout: 5_000 }).catch(() => undefined);
  return { outcome: 'clicked', allowMode, appName: input.appName, toolName: input.toolName, evidenceHash, permissionUserMessageId, workDisclosure,
    permissionStillVisible: await scopes.evaluateAll((elements, expected) => elements.some(element =>
      element instanceof HTMLElement && element.getClientRects().length > 0 && element.innerText.trim() === expected), alertText) };
}

function unavailable(message: string) { return new SessionPlaneDomainError('provider.permission-unverified', message); }
