import type { ElementHandle, Page } from 'playwright-core';

import { PageRegistry, PageRegistryError } from '../browser/page-registry.ts';
import { BrowserRefSnapshotStore, BrowserSnapshotError, hasPreparationSelectionEvidence, sameSnapshotSemantics, type BrowserSnapshotNode } from '../browser/ref-snapshot.ts';
import type { SessionSnapshot } from '../domain/session.ts';
import { SessionPlaneDomainError } from '../domain/errors.ts';
import type { PreparationPurpose, PreparationTarget } from '../providers/provider-adapter.ts';
import type { SubmissionService } from './submission-service.ts';

export class SessionUiService {
  readonly #submissions: SubmissionService;
  readonly #registry: PageRegistry;
  readonly #chatgptOrigin: string;
  readonly #refs = new BrowserRefSnapshotStore();

  constructor(input: { submissions: SubmissionService; registry: PageRegistry; chatgptUrl: string }) {
    this.#submissions = input.submissions;
    this.#registry = input.registry;
    this.#chatgptOrigin = new URL(input.chatgptUrl).origin;
  }

  async inspect(input: PreparationOwner & { readonly maxNodes?: number | undefined }) {
    return await this.#submissions.withPendingPreparation(input,
      async (session) => await this.#capture(session, input.maxNodes));
  }

  async inspectSubmission(input: PreparationOwner & { readonly maxNodes?: number | undefined }) {
    return await this.#submissions.inspectSubmission(input,
      async (session) => await this.#capture(session, input.maxNodes));
  }

  async #capture(session: SessionSnapshot, maxNodes?: number) {
    const page = this.#requirePage(session);
    const binding = this.#registry.refreshPage(session.pageKey!);
    return await this.#refs.capture({
      pageKey: session.pageKey!, bindingEpoch: binding.bindingEpoch, page,
      interactive: false, maxNodes: Math.max(1, Math.min(5_000, maxNodes ?? 1_000)),
    });
  }

  async decide(input: PreparationOwner & {
    readonly decisionId: string;
    readonly decision: 'choose' | 'reveal' | 'cancel';
    readonly purpose?: PreparationPurpose;
    readonly snapshotId?: string;
    readonly ref?: string;
    readonly value?: number | undefined;
  }) {
      return await this.#submissions.decidePreparation(input, async (session, requested) => {
      const purpose = input.purpose;
      const snapshotId = input.snapshotId;
      const ref = input.ref;
      if (purpose === undefined || snapshotId === undefined || ref === undefined || session.pageKey === null) {
        throw new SessionPlaneDomainError('input.invalid', 'A choice needs purpose, snapshotId, and ref');
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
          page, interactive: false, maxNodes: 5_000,
        });
        const currentNode = await this.#refs.nodeForElement({
          pageKey: session.pageKey, snapshotId: currentObservation.snapshotId, element,
        });
        if (!sameSnapshotSemantics(node, currentNode)) {
          throw new BrowserSnapshotError('browser.snapshot-stale', 'Selected control changed since it was inspected');
        }
        validatePurposeTarget(purpose, currentNode, reveal);
        if (input.value !== undefined && currentNode.role !== 'slider') {
          throw new SessionPlaneDomainError('input.invalid', 'A numeric value is only valid for a model or effort slider');
        }
        if (reveal) {
          if (input.value !== undefined) throw new SessionPlaneDomainError('input.invalid', 'A reveal cannot include a selected value');
          await element.evaluate((target) => {
            if ((target instanceof HTMLButtonElement && target.type === 'submit') ||
                (target instanceof HTMLInputElement && target.type === 'submit') ||
                target.getAttribute('aria-disabled') === 'true' || ('disabled' in target && Boolean(target.disabled))) {
              throw new Error('Only an enabled non-submit chooser can reveal choices');
            }
          });
          await element.click({ timeout: 5_000 });
          await page.waitForTimeout(100);
        }
        if (!reveal && (purpose === 'model' || purpose === 'effort') && currentNode.role !== 'slider' && currentNode.selected !== true && currentNode.checked !== true) {
          if (input.value !== undefined) throw new SessionPlaneDomainError('input.invalid', 'A value is only valid when choosing a slider value');
          await element.click({ timeout: 5_000 });
          await page.waitForTimeout(100);
        }
        if (!reveal && currentNode.role === 'slider') {
          const value = input.value;
          if (!['model', 'effort'].includes(purpose) || value === undefined || !Number.isFinite(value) || currentNode.ariaValueMin === null || currentNode.ariaValueMax === null || value < Number(currentNode.ariaValueMin) || value > Number(currentNode.ariaValueMax)) {
            throw new SessionPlaneDomainError('input.invalid', 'A model or effort slider choice needs an explicit value within its observed range');
          }
          const adjustment = await element.evaluate((target, requested) => {
            const nativeRange = target instanceof HTMLInputElement && target.type === 'range';
            const min = Number(target.getAttribute('aria-valuemin') ?? (nativeRange ? target.min || 0 : NaN));
            const max = Number(target.getAttribute('aria-valuemax') ?? (nativeRange ? target.max || 100 : NaN));
            const step = nativeRange ? (target.step === '' ? 1 : Number(target.step)) : 1;
            const current = Number(target.getAttribute('aria-valuenow') ?? (nativeRange ? target.value : NaN));
            const count = (requested - current) / step;
            if (!Number.isFinite(step) || step <= 0 || requested < min || requested > max ||
                !Number.isFinite(current) || Math.abs(count - Math.round(count)) > 1e-7 || Math.abs(count) > 1_000) return null;
            return { key: count < 0 ? 'ArrowLeft' as const : 'ArrowRight' as const, count: Math.abs(count) };
          }, value);
          if (adjustment === null) throw new SessionPlaneDomainError('input.invalid', 'Slider value must match a supported native range step');
          await element.focus();
          for (let step = 0; step < adjustment.count; step += 1) await element.press(adjustment.key);
        }
        const after = await this.#refs.capture({
          pageKey: session.pageKey, bindingEpoch: this.#registry.refreshPage(session.pageKey).bindingEpoch,
          page, interactive: false, maxNodes: 1_000,
        });
        if (purpose === 'model' || purpose === 'effort') {
          const intent = purpose === 'model' ? requested.model : requested.effort;
          if (reveal ? !hasRevealedChoices(after.nodes, currentNode) : !hasPreparationSelectionEvidence(after.nodes, toPreparationTarget(purpose, currentNode, input.value), intent)) {
            throw new SessionPlaneDomainError('provider.action-unknown', 'The chosen control did not show a verified selection or related choice list');
          }
        }
        return { choice: reveal ? null : toPreparationTarget(purpose, currentNode, input.value), result: after };
      } catch (error) {
        throw typedUiError(error);
      } finally {
        await element?.dispose();
      }
    });
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

function validatePurposeTarget(purpose: PreparationPurpose, node: BrowserSnapshotNode, reveal: boolean): void {
  if (reveal && !['model', 'effort'].includes(purpose)) {
    throw new SessionPlaneDomainError('input.invalid', 'Only model and effort controls can reveal choices');
  }
  if ((purpose === 'model' || purpose === 'effort') && node.disabled) {
    throw new SessionPlaneDomainError('input.invalid', 'Disabled choices cannot be selected');
  }
  if (node.role === 'slider' && (!['model', 'effort'].includes(purpose) || reveal)) {
    throw new SessionPlaneDomainError('input.invalid', 'Sliders can only set an explicit model or effort value');
  }
  const selectableRole = ['menuitemradio', 'option', 'radio'];
  if (reveal && (node.role !== 'button' || node.controls.length === 0)) {
    throw new SessionPlaneDomainError('input.invalid', 'A chooser reveal must target a button with related choices');
  }
  if ((purpose === 'model' || purpose === 'effort') && !reveal && node.role !== 'slider' && !selectableRole.includes(node.role)) {
    throw new SessionPlaneDomainError('input.invalid', 'Model and effort choices must target an option, radio, or menuitemradio');
  }
  if (purpose === 'composer' && !(node.editable && node.role === 'textbox')) {
    throw new SessionPlaneDomainError('input.invalid', 'Composer choice must target an editable textbox');
  }
  if (purpose === 'submit' && !(node.role === 'button' && ['button', 'input'].includes(node.tag))) {
    throw new SessionPlaneDomainError('input.invalid', 'Submit choice must target an observed button control');
  }
}

function hasRevealedChoices(nodes: readonly BrowserSnapshotNode[], opener: BrowserSnapshotNode): boolean {
  return nodes.some((node) => ['option', 'menuitem', 'menuitemradio', 'radio', 'slider'].includes(node.role) &&
    (node.ancestorIds.some((id) => opener.controls.includes(id)) ||
      opener.ancestorIds.includes(node.id) || opener.controls.includes(node.id)));
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
