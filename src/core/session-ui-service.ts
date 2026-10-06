import { ChatGptConfigurationMenu, type ConfigurationCatalog } from '../providers/chatgpt/configuration-catalog.ts';
import { errors, type ElementHandle, type Page } from 'playwright-core';

import { PageRegistry, PageRegistryError } from '../browser/page-registry.ts';
import { BrowserRefSnapshotStore, BrowserSnapshotError, hasPreparationSelectionEvidence, isPreparationSummary, matchesPreparationTarget, sameSnapshotSemantics, type BrowserSnapshot, type BrowserSnapshotNode } from '../browser/ref-snapshot.ts';
import type { SessionSnapshot } from '../domain/session.ts';
import { SessionPlaneDomainError } from '../domain/errors.ts';
import type { PreparationPurpose, PreparationTarget } from '../providers/provider-adapter.ts';
import { CHATGPT_PREPARATION_SNAPSHOT } from '../providers/chatgpt/selectors.ts';
import { inspectChatGptSubmissionCandidates, prepareChatGptObservation } from '../providers/chatgpt/submission.ts';
import { observeChatGptActivity } from '../providers/chatgpt/activity-observer.ts';
import { observeChatGptDom, observeChatGptAlerts } from '../providers/chatgpt/dom-observer.ts';
import type { SubmissionService } from './submission-service.ts';

export class SessionUiService {
  readonly #submissions: SubmissionService;
  readonly #registry: PageRegistry;
  readonly #chatgptOrigin: string;
  readonly #refs = new BrowserRefSnapshotStore();
  #catalog: ConfigurationCatalog | null = null;
  readonly #discoveryFailures = new Map<string, ConfigurationCatalog>();
  readonly #configurationRefs = new Map<string, { snapshotId: string; ids: readonly string[] }>();

  get configurationCatalog() { return this.#catalog; }

  async discover(input: PreparationOwner & { decisionId: string }) {
    const result = await this.#submissions.decidePreparation({ ...input, decision: 'discover', purpose: 'model' }, async session => {
      try {
        return { choice: null, result: await new ChatGptConfigurationMenu(this.#requirePage(session), session.pageKey!).discover() };
      } catch (error) {
        const result: ConfigurationCatalog = { status: 'unavailable', observedAt: new Date().toISOString(), options: [], unavailableVersions: [],
          message: error instanceof Error ? error.message : String(error) };
        return { choice: null, result };
      }
    });
    // A receipt replay restores the observation without repeating UI mutations.
    if ('options' in result) {
      const key = `${input.sessionId}:${input.generation}`;
      if (result.status === 'available') {
        this.#catalog = result;
        this.#discoveryFailures.delete(key);
      } else this.#discoveryFailures.set(key, result);
    }
    return result;
  }

  async configure(input: PreparationOwner & { decisionId: string; configurationId: string }) {
    return await this.#submissions.decidePreparation({ ...input, decision: 'configure', purpose: 'model' },
      session => this.#selectConfiguration(session, input.configurationId));
  }

  async #selectConfiguration(session: SessionSnapshot, configurationId: string) {
      const current = await this.#capture(session, 5_000);
      if (!current.nodes.some(node => node.role === 'textbox' && node.editable && !node.disabled)) {
        throw new SessionPlaneDomainError('provider.preparation-unavailable',
          'The exact page has no usable composer; configuration selection was not attempted');
      }
      const option = this.#catalog?.options.find(option => option.id === configurationId);
      if (!option) throw new SessionPlaneDomainError('provider.configuration-stale', 'Discover current configurations and choose an observed configurationId');
      try {
        const summary = await new ChatGptConfigurationMenu(this.#requirePage(session), session.pageKey!).select(option);
        return { choice: toPreparationTarget('model', summary), result: { configurationId: option.id, label: option.label } };
      } catch (error) {
        if (error instanceof SessionPlaneDomainError &&
            ['provider.configuration-stale', 'provider.model-unavailable'].includes(error.errorCode)) this.#catalog = null;
        throw typedUiError(error);
      }
  }

  constructor(input: { submissions: SubmissionService; registry: PageRegistry; chatgptUrl: string }) {
    this.#submissions = input.submissions;
    this.#registry = input.registry;
    this.#chatgptOrigin = new URL(input.chatgptUrl).origin;
  }

  isSubmissionPageLost(session: SessionSnapshot): boolean {
    if (session.terminal || session.submissionState !== 'submission_unknown' || session.conversationId !== null) return false;
    if (session.pageKey === null) return true;
    try {
      this.#registry.requireSessionPage(session.pageKey, session);
      return false;
    } catch (error) {
      if (error instanceof PageRegistryError) return error.errorCode === 'browser.unavailable';
      throw error;
    }
  }

  async inspect(input: PreparationOwner & { readonly maxNodes?: number | undefined }) {
    return await this.#submissions.withPendingPreparation(input,
      async (session) => {
        await prepareChatGptObservation(this.#requirePage(session), session.pageKey!);
        const snapshot = await this.#capture(session, input.maxNodes);
        const composerAvailable = snapshot.nodes.some(node => node.role === 'textbox' && node.editable && !node.disabled);
        const catalog = this.#discoveryFailures.get(`${session.sessionId}:${session.generation}`) ?? this.#catalog;
        const menuIds = new Set(snapshot.nodes.filter((node) => node.role === 'menu' && node.id !== '').map((node) => node.id));
        this.#configurationRefs.set(snapshot.pageKey, { snapshotId: snapshot.snapshotId,
          ids: composerAvailable ? catalog?.options.map(option => option.id) ?? [] : [] });
        return { ...snapshot, nodes: snapshot.nodes.map((node) => ({ ...node, actions: preparationActions(node, menuIds) })),
          preparationAvailability: { available: composerAvailable,
            ...(composerAvailable ? {} : { reason: 'composer-unavailable' as const }) },
          configurationCatalog: catalog === null ? null : { ...catalog,
            selectionAvailable: composerAvailable,
            instruction: composerAvailable
              ? 'Select the desired combined label. Call sessionplane_decide with option.selection plus teamId, requestRef and a new requestId. No menu exploration is required.'
              : 'These cached model options are not selectable on this page. Read the same request again after the exact provider page has a usable composer; no configuration or submit action is available.',
            options: catalog.options.map((option, index) => ({ ...option,
              // DOM snapshots contain at most 5000 refs. Configuration refs use
              // the existing decision shape without pretending to be DOM nodes.
              ...(composerAvailable ? { selection: { decision: 'choose' as const, purpose: 'model' as const,
                snapshotId: snapshot.snapshotId, ref: `@e${5001 + index}` } } : {}) })) } };
      });
  }

  async inspectSubmission(input: PreparationOwner & { readonly maxNodes?: number | undefined }) {
    return await this.#submissions.inspectSubmission(input,
      async (session, submittedMessageIds) => {
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          const evidence = await Promise.race([
            (async () => ({
              ...await this.#capture(session, input.maxNodes),
              providerAlerts: await observeChatGptAlerts(this.#requirePage(session), session),
              ...(session.submissionState !== 'submitted' ? {} : {
                submissionVerification: {
                  observedAt: new Date().toISOString(), pageKey: session.pageKey,
                  conversationId: session.conversationId,
                  submittedUserMessageId: session.submittedUserMessageId,
                  submittedUserTurnId: session.submittedUserTurnId,
                  anchorPresent: (await observeChatGptDom(this.#requirePage(session), session)).submittedUserFound,
                  scope: 'mounted-dom' as const,
                },
              }),
              ...(session.submissionState !== 'submission_unknown' || session.conversationId === null ? {} : {
                submissionCandidates: (await inspectChatGptSubmissionCandidates(this.#requirePage(session), session.conversationId))
                  .filter((candidate) => !submittedMessageIds.has(candidate.messageId)),
              }),
            }))(),
            new Promise<never>((_, reject) => {
              timer = setTimeout(() => reject(new BrowserSnapshotError('browser.snapshot-timeout',
                'The provider page did not respond to request inspection; submission and stop outcomes remain unchanged.')), 5_000);
            }),
          ]);
          this.#requirePage(session);
          return evidence;
        } catch (error) { throw typedUiError(error); }
        finally { clearTimeout(timer); }
      });
  }

  async reconcileFailure(input: PreparationOwner & { readonly decisionId: string }) {
    return await this.#submissions.reconcileFailure(input, session => this.#failureEvidence(session, session));
  }

  async #failureEvidence(session: SessionSnapshot, anchor: SessionSnapshot) {
    const page = this.#requirePage(session);
    const binding = this.#registry.refreshPage(session.pageKey!);
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const evidence = await Promise.race([
        (async () => {
          const controls = await this.#capture(session);
          const dom = await observeChatGptDom(page, anchor);
          const activity = await observeChatGptActivity(page, dom);
          const alerts = await observeChatGptAlerts(page, anchor, true);
          this.#requirePage(session);
          const after = this.#registry.refreshPage(session.pageKey!);
          if (binding.bindingEpoch !== after.bindingEpoch || !dom.submittedUserFound || dom.laterUserFound ||
              dom.candidate !== null || activity.strength !== 'none' || alerts.length === 0 ||
              dom.providerAlerts.some(alert => !alerts.includes(alert)) ||
              controls.nodes.some(node => node.role === 'dialog' || node.role === 'alertdialog') ||
              !controls.nodes.some(node => node.role === 'textbox' && node.editable && !node.disabled)) {
            throw new SessionPlaneDomainError('provider.failure-unverified',
              'No exact idle current-turn Thinking failed surface; preserve this submitted request and observe it');
          }
          return { kind: 'thinking-failed' as const, pageKey: session.pageKey!, bindingEpoch: after.bindingEpoch,
            conversationId: session.conversationId!, submittedUserMessageId: anchor.submittedUserMessageId,
            submittedUserTurnId: anchor.submittedUserTurnId, observedAt: controls.capturedAt, providerAlerts: alerts };
        })(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new SessionPlaneDomainError('provider.failure-unverified',
            'Failure inspection timed out; this submitted request remains unchanged')), 5_000);
        }),
      ]);
      return evidence;
    } finally { clearTimeout(timer); }
  }

  async verifyFailureContinuation(session: SessionSnapshot, failed: SessionSnapshot, model: PreparationTarget) {
    await this.#failureEvidence(session, failed);
    const snapshot = await this.#capture(session, 5_000);
    const composers = snapshot.nodes.filter(node => node.role === 'textbox' && node.editable && !node.disabled);
    const combinedSummary = model.role === 'menuitem' && model.name.trim() !== '' &&
      model.text.trim() !== '' && model.text.trim() !== model.name.trim();
    if (!combinedSummary || snapshot.nodesTruncated || composers.length !== 1 || !hasPreparationSelectionEvidence(snapshot.nodes, model)) {
      throw new SessionPlaneDomainError('provider.failure-unverified', 'Exact configured model/effort or sole composer is unavailable');
    }
    const element = await this.#refs.resolve({ pageKey: session.pageKey!, bindingEpoch: snapshot.bindingEpoch,
      page: this.#requirePage(session), snapshotId: snapshot.snapshotId, ref: composers[0]!.ref });
    try {
      const draft = await element.evaluate(node => node instanceof HTMLInputElement || node instanceof HTMLTextAreaElement
        ? node.value : node.textContent ?? '');
      if (draft.trim() !== '' && (session.generation === failed.generation || draft !== '계속')) throw new SessionPlaneDomainError(
        'provider.failure-unverified', 'A separate composer draft is present; automatic continuation is paused');
    } finally { await element.dispose(); }
  }

  async prepareFailureContinuation(input: PreparationOwner, model: PreparationTarget) {
    // These are ordinary durable preparation choices; provider mutation stays in resumePreparation.
    await this.inspect(input);
    for (const purpose of ['model', 'composer'] as const) {
      await this.#submissions.decidePreparation({ ...input, decisionId: `thinking-failure-${purpose}:${input.requestId}`,
        decision: 'configure', purpose }, async session => {
        const snapshot = await this.#capture(session, 5_000);
        if (snapshot.nodesTruncated || !hasPreparationSelectionEvidence(snapshot.nodes, model)) throw new SessionPlaneDomainError(
          'provider.failure-unverified', 'Fresh configured model/version/effort evidence is missing');
        const composers = snapshot.nodes.filter(node => node.role === 'textbox' && node.editable && !node.disabled);
        if (composers.length !== 1) throw new SessionPlaneDomainError('provider.failure-unverified', 'No unique usable composer');
        return { choice: purpose === 'model' ? { ...model, purpose } : toPreparationTarget(purpose, composers[0]!), result: { purpose } };
      });
    }
    try {
      const result = await this.#submissions.resumePreparation(input);
      if (result.submissionState === 'submitted') return result;
      if (result.submissionState !== 'prepared') throw new SessionPlaneDomainError(
        result.errorCode ?? 'provider.failure-unverified', 'Continuation is not confirmed; inspect the saved request without resending');
    } catch (error) {
      if (!(error instanceof SessionPlaneDomainError) || error.errorCode !== 'provider.preparation-required') throw error;
    }
    await this.#submissions.decidePreparation({ ...input, decisionId: `thinking-failure-submit:${input.requestId}`,
      decision: 'configure', purpose: 'submit' }, async session => {
      const snapshot = await this.#capture(session, 5_000);
      const submits = snapshot.nodes.filter(node => node.submitControl === true && !node.disabled);
      if (snapshot.nodesTruncated || submits.length !== 1 || !hasPreparationSelectionEvidence(snapshot.nodes, model)) throw new SessionPlaneDomainError(
        'provider.failure-unverified', 'Fresh configuration or unique enabled submit evidence is missing');
      return { choice: toPreparationTarget('submit', submits[0]!), result: { purpose: 'submit' } };
    });
    const result = await this.#submissions.resumePreparation(input);
    if (result.submissionState !== 'submitted') throw new SessionPlaneDomainError(
      result.errorCode ?? 'provider.failure-unverified', 'Continuation is not confirmed; inspect the saved request without resending');
    return result;
  }

  async #capture(session: SessionSnapshot, maxNodes?: number) {
    const page = this.#requirePage(session);
    const binding = this.#registry.refreshPage(session.pageKey!);
    try {
      return await this.#refs.capture({
        pageKey: session.pageKey!, bindingEpoch: binding.bindingEpoch, page,
        ...CHATGPT_PREPARATION_SNAPSHOT, maxNodes: Math.max(1, Math.min(5_000, maxNodes ?? 1_000)),
      });
    } catch (error) {
      throw typedUiError(error);
    }
  }

  async decide(input: PreparationOwner & {
    readonly decisionId: string;
    readonly decision: 'choose' | 'reveal' | 'cancel';
    readonly purpose?: PreparationPurpose;
    readonly snapshotId?: string;
    readonly ref?: string;
    readonly value?: number | undefined;
  }) {
      return await this.#submissions.decidePreparation<BrowserSnapshot | { configurationId: string; label: string }>(input, async (session) => {
      const purpose = input.purpose;
      const snapshotId = input.snapshotId;
      const ref = input.ref;
      if (purpose === undefined || snapshotId === undefined || ref === undefined || session.pageKey === null) {
        throw new SessionPlaneDomainError('input.invalid', 'A choice needs purpose, snapshotId, and ref');
      }
      if (Number(ref.slice(2)) > 5000) {
        const catalog = this.#configurationRefs.get(session.pageKey);
        const configurationId = catalog?.ids[Number(ref.slice(2)) - 5001];
        if (catalog?.snapshotId !== snapshotId || configurationId === undefined) {
          throw new BrowserSnapshotError('browser.snapshot-stale', 'Inspect the current configuration catalog before choosing');
        }
        if (input.decision !== 'choose' || purpose !== 'model' || input.value !== undefined) {
          throw new SessionPlaneDomainError('input.invalid', 'Use the configuration option selection exactly as returned');
        }
        return await this.#selectConfiguration(session, configurationId);
      }
      const page = this.#requirePage(session);
      const binding = this.#registry.refreshPage(session.pageKey);
      let element: ElementHandle<Element> | null = null;
      try {
        const node = this.#refs.node({ pageKey: session.pageKey, snapshotId, ref });
        element = await this.#refs.resolve({ pageKey: session.pageKey, bindingEpoch: binding.bindingEpoch, page, ref, snapshotId });
        const reveal = input.decision === 'reveal';
        const currentObservation = await this.#refs.capture({
          pageKey: session.pageKey, bindingEpoch: this.#registry.refreshPage(session.pageKey).bindingEpoch,
          page, ...CHATGPT_PREPARATION_SNAPSHOT, maxNodes: 5_000,
        });
        const currentNode = await this.#refs.nodeForElement({
          pageKey: session.pageKey, snapshotId: currentObservation.snapshotId, element,
        });
        if (!sameSnapshotSemantics(node, currentNode)) {
          throw new BrowserSnapshotError('browser.snapshot-stale', 'Selected control changed since it was inspected');
        }
        const menuIds = new Set(currentObservation.nodes.filter((node) => node.role === 'menu' && node.id !== '').map((node) => node.id));
        const actions = preparationActions(currentNode, menuIds);
        if (!actions[reveal ? 'reveal' : 'choose'].includes(purpose)) {
          throw new SessionPlaneDomainError('input.invalid', `The observed control does not support ${input.decision} for ${purpose}`);
        }
        if (input.value !== undefined && currentNode.role !== 'slider') {
          throw new SessionPlaneDomainError('input.invalid', 'A numeric value is only valid for a model or effort slider');
        }
        let actionTimeout: Error | undefined;
        try {
          if (reveal && ['button', 'menuitem'].includes(currentNode.role)) {
            await element.evaluate((target) => {
              if ((target instanceof HTMLButtonElement && target.type === 'submit') ||
                  (target instanceof HTMLInputElement && target.type === 'submit') ||
                  target.getAttribute('aria-disabled') === 'true' || ('disabled' in target && Boolean(target.disabled))) {
                throw new Error('Only an enabled non-submit chooser can reveal choices');
              }
            });
            await element.click({ timeout: 5_000 });
          }
          if ((purpose === 'model' || purpose === 'effort') && !['slider', 'button', 'menuitem'].includes(currentNode.role) && currentNode.selected !== true && currentNode.checked !== true) {
            if (input.value !== undefined) throw new SessionPlaneDomainError('input.invalid', 'A value is only valid when choosing a slider value');
            await element.click({ timeout: 5_000 });
          }
          if (currentNode.role === 'slider') {
            const value = input.value;
            if (!['model', 'effort'].includes(purpose) || value === undefined || !Number.isFinite(value) || currentNode.ariaValueMin === null || currentNode.ariaValueMax === null || value < Number(currentNode.ariaValueMin) || value > Number(currentNode.ariaValueMax)) {
              throw new SessionPlaneDomainError('input.invalid', 'A model or effort slider choice needs an explicit value within its observed range');
            }
            const adjustment = await element.evaluate((target, { requested, min, max, current }) => {
              const nativeRange = target instanceof HTMLInputElement && target.type === 'range';
              const step = nativeRange ? (target.step === '' ? 1 : Number(target.step)) : 1;
              const count = (requested - current) / step;
              if (!Number.isFinite(step) || step <= 0 || requested < min || requested > max ||
                  !Number.isFinite(current) || Math.abs(count - Math.round(count)) > 1e-7 || Math.abs(count) > 1_000) return null;
              return { key: count < 0 ? 'ArrowLeft' as const : 'ArrowRight' as const, count: Math.abs(count) };
            }, { requested: value, min: Number(currentNode.ariaValueMin), max: Number(currentNode.ariaValueMax),
              current: Number(currentNode.ariaValueNow ?? currentNode.value ?? NaN) });
            if (adjustment === null) throw new SessionPlaneDomainError('input.invalid', 'Slider value must match a supported native range step');
            await element.focus();
            for (let step = 0; step < adjustment.count; step += 1) await element.press(adjustment.key);
          }
        } catch (error) {
          if (!(error instanceof errors.TimeoutError)) throw error;
          actionTimeout = error;
        }
        let after: BrowserSnapshot;
        const target = toPreparationTarget(purpose, currentNode, input.value);
        const evidenceDeadline = performance.now() + 5_000;
        // Mutate once; wait for observable UI evidence rather than an animation delay.
        while (true) {
          after = await this.#refs.capture({
            pageKey: session.pageKey, bindingEpoch: this.#registry.refreshPage(session.pageKey).bindingEpoch,
            page, ...CHATGPT_PREPARATION_SNAPSHOT, maxNodes: 5_000,
          });
          if (purpose !== 'model' && purpose !== 'effort') break;
          const transitioned = ['menuitemradio', 'option', 'radio'].includes(currentNode.role) &&
            !after.nodes.some((node) => matchesPreparationTarget(node, target)) &&
            hasRevealedChoices(after.nodes, currentNode, currentObservation.nodes);
          const verified = reveal && ['button', 'menuitem'].includes(currentNode.role)
            ? hasNavigationEvidence(after.nodes, currentNode, currentObservation.nodes)
            : hasPreparationSelectionEvidence(after.nodes, target) || transitioned;
          if (verified) break;
          if (performance.now() >= evidenceDeadline) {
            throw actionTimeout ?? new SessionPlaneDomainError('provider.action-unknown', 'The chosen control did not show a verified selection or related choice list');
          }
          await page.waitForTimeout(100);
        }
        let choice = reveal ? null : target;
        if (currentNode.role === 'slider') {
          const openers = after.nodes.filter((node) => node.role === 'button' && node.expanded === true &&
            node.controls.some((id) => currentNode.ancestorIds.includes(id)));
          if (openers.length === 1 && after.nodes.some((node) => node.role === 'menu' && currentNode.ancestorIds.includes(node.id))) {
            await element.press('Escape');
            after = await this.#refs.capture({ pageKey: session.pageKey, bindingEpoch: binding.bindingEpoch, page, ...CHATGPT_PREPARATION_SNAPSHOT, maxNodes: 5_000 });
            const summary = after.nodes.find((node) => node.id === openers[0]!.id && node.role === 'button' && node.expanded === false);
            if (!reveal && summary !== undefined && summary.id !== '') choice = toPreparationTarget(purpose, summary);
          }
        }
        return { choice, result: after };
      } catch (error) {
        throw typedUiError(error);
      } finally {
        await element?.dispose();
      }
    });
  }

  async focus(session: SessionSnapshot) {
    if (session.pageKey === null) throw new SessionPlaneDomainError('browser.unavailable', 'No connected tab exists for this request');
    try {
      const page = this.#registry.requireSessionPage(session.pageKey, session);
      await page.bringToFront();
      return { pageKey: session.pageKey, url: page.url() };
    } catch (error) {
      throw typedUiError(error);
    }
  }

  async refresh(input: PreparationOwner & { readonly decisionId: string }): Promise<void> {
    try {
      await this.#submissions.refreshPage(input, async (session) => {
        const page = this.#requirePage(session);
        await page.reload({ waitUntil: 'domcontentloaded', timeout: 30_000 });
        this.#requirePage(session);
        this.#refs.clear(session.pageKey!);
      });
    } catch (error) {
      throw typedUiError(error);
    }
  }

  async resume(input: PreparationOwner) {
    return await this.#submissions.resumePreparation(input);
  }

  #requirePage(session: { readonly sessionId: string; readonly generation: number; readonly pageKey: string | null; readonly conversationId: string | null }): Page {
    if (session.pageKey === null) throw new SessionPlaneDomainError('browser.unavailable', 'Exact preparation page is unavailable');
    try {
      const page = this.#registry.requireSessionPage(session.pageKey, {
        sessionId: session.sessionId, generation: session.generation, conversationId: session.conversationId,
      });
      if (new URL(page.url()).origin !== this.#chatgptOrigin) {
        throw new SessionPlaneDomainError('session.page-identity-unverified', 'Page left the ChatGPT origin');
      }
      return page;
    } catch (error) {
      throw typedUiError(error);
    }
  }
}

export interface PreparationOwner {
  readonly clientId: string;
  readonly requestId: string;
  readonly sessionId: string;
  readonly generation: number;
}

function preparationActions(node: BrowserSnapshotNode, menuIds: ReadonlySet<string>) {
  const choose: PreparationPurpose[] = [];
  const reveal: PreparationPurpose[] = [];
  if (node.disabled) return { choose, reveal };
  if (node.editable && node.role === 'textbox') choose.push('composer');
  if (node.role === 'button' && node.submitControl === true) choose.push('submit');
  const insideMenu = node.ancestorIds.some((id) => menuIds.has(id));
  if (!node.disabled) {
    if (node.role === 'slider' || (node.role === 'button' && node.hasPopup !== null) ||
        ['menuitemradio', 'option', 'radio'].includes(node.role) || isPreparationSummary(node, insideMenu)) {
      choose.push('model', 'effort');
    }
    if (['slider', 'menuitemradio', 'option', 'radio'].includes(node.role) || (node.role === 'menuitem' && insideMenu) || (node.role === 'button' &&
        (node.controls.length > 0 || ['menu', 'listbox', 'dialog', 'true'].includes(node.hasPopup ?? '')))) {
      reveal.push('model', 'effort');
    }
  }
  return { choose, reveal };
}

function hasRevealedChoices(nodes: readonly BrowserSnapshotNode[], opener: BrowserSnapshotNode, before: readonly BrowserSnapshotNode[]): boolean {
  // A nested menu may replace its opener. Verify fresh choices in that menu,
  // rather than requiring the clicked element to survive the transition.
  const scopes = new Set([
    ...opener.controls,
    ...before.filter((node) => node.id !== '' && node.role === 'menu' && opener.ancestorIds.includes(node.id)).map((node) => node.id),
    ...nodes.filter((node) => node.id !== '' && node.id === opener.id).flatMap((node) => node.controls),
  ]);
  return nodes.some((node) => ['option', 'menuitem', 'menuitemradio', 'radio', 'slider'].includes(node.role) &&
    node.ancestorIds.some((id) => scopes.has(id)) &&
    !before.some((previous) => sameSnapshotSemantics(previous, node)));
}

function hasNavigationEvidence(nodes: readonly BrowserSnapshotNode[], opener: BrowserSnapshotNode, before: readonly BrowserSnapshotNode[]): boolean {
  // Exploration can return from a submenu by closing its expanded chooser.
  // Verify the control transition and closed scope, without confirming a value.
  const collapsed = opener.expanded === true && opener.id !== '' &&
    nodes.some(node => node.id === opener.id && node.expanded === false) &&
    !nodes.some(node => opener.controls.includes(node.id));
  return collapsed || hasRevealedChoices(nodes, opener, before);
}

function toPreparationTarget(purpose: PreparationPurpose, node: BrowserSnapshotNode, selectedValue?: number): PreparationTarget {
  return {
    purpose, id: node.id, ancestorIds: node.ancestorIds, role: node.role, name: node.name, tag: node.tag, text: node.text, placeholder: node.placeholder,
    selected: node.selected, checked: node.checked, disabled: node.disabled, editable: node.editable,
    ariaValueText: node.ariaValueText, ariaValueNow: node.ariaValueNow, ariaValueMin: node.ariaValueMin,
    ariaValueMax: node.ariaValueMax, selectedValue: selectedValue ?? null, description: node.description, controls: node.controls,
    describedBy: node.describedBy, labelledBy: node.labelledBy,
  };
}

function typedUiError(error: unknown): SessionPlaneDomainError {
  if (error instanceof SessionPlaneDomainError) return error;
  if (error instanceof PageRegistryError || error instanceof BrowserSnapshotError) {
    return new SessionPlaneDomainError(error.errorCode, error.message);
  }
  return new SessionPlaneDomainError('browser.unavailable', error instanceof Error ? error.message : 'Exact preparation page is unavailable');
}
