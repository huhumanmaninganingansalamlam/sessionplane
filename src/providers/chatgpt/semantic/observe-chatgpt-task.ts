import { buildChatGptActionCatalog } from './build-chatgpt-action-catalog.ts';
import { readProviderBlockers } from './read-provider-blockers.ts';

import type { ChatGptSemanticRuntime } from './semantic-runtime.ts';
import { observationBytes } from "./semantic-types.ts";

import { conversationBindingProblem } from "./chatgpt-page-access.ts";


import { randomUUID } from 'node:crypto';
import type { Page } from 'playwright-core';

import type { SemanticObservation, SemanticTaskContext } from '../../semantic-adapter.ts';

import { observeChatGptDom } from '../dom-observer.ts';

import { inspectSemanticChatGptModelMenu } from '../semantic-model-menu.ts';
import { observeChatGptSurface } from '../surface.ts';


export async function observeChatGptTask(runtime: ChatGptSemanticRuntime, context: SemanticTaskContext): Promise<SemanticObservation> {
    const snapshotAtStart = context.pageLease === null ? undefined
      : runtime.latest.get(context.pageLease.pageKey);
    const revisionAtStart = context.pageLease === null ? undefined
      : runtime.revision.get(context.pageLease.pageKey);
    const { lease, page } = await runtime.resolveExactPage(context);
    const observedAt = new Date().toISOString();
    const snapshotId = randomUUID();
    const deniedObservation = (denialReason: string,
      deniedSurface: SemanticObservation['surface'] = 'unknown'): SemanticObservation => {
      const deniedTurn: SemanticObservation['turn'] = {
        submittedUserFound: false, laterUserFound: false,
        submittedUserMessageId: null, answerMessageId: null, partialAnswer: null,
      };
      const denied: SemanticObservation = {
        providerKey: runtime.providerKey, surface: deniedSurface, snapshotId, observedAt,
        capabilityManifest: runtime.capabilities, progress: 'unknown', blocker: 'unsupported',
        reason: denialReason, turn: deniedTurn, questionText: null, permission: null,
        actions: [], evidenceBytes: 0,
      };
      return { ...denied, evidenceBytes: observationBytes(denied) };
    };

    // Compare-and-revoke: a slow denied observation can invalidate only the
    // snapshot it saw at entry, never a newer observation for the same page.
    const revokeStartSnapshot = (): void => {
      if (runtime.latest.get(lease.pageKey) === snapshotAtStart &&
          runtime.latest.delete(lease.pageKey)) runtime.revision.set(lease.pageKey, {});
    };

    const conversationError = conversationBindingProblem(page, context);
    if (conversationError !== null) {
      // Page ownership alone does not prove that this tab still points to the
      // bound ChatGPT conversation. Do not inspect a foreign transcript.
      revokeStartSnapshot();
      return deniedObservation(conversationError);
    }
    const surface = await observeChatGptSurface(page);
    if (surface.mode !== 'chat') {
      revokeStartSnapshot();
      return deniedObservation(surface.mode === 'work'
        ? 'work-surface-observation-only' : 'chat-surface-unverified', surface.mode);
    }
    const scan = await readProviderBlockers(page, context);
    const { progress, turn, ui, permission, retry,
      radioQuestion, freeTextQuestion, question, genericControls, observedControls } = scan;

    const model = scan.blocker === 'none'
      ? await inspectSemanticChatGptModelMenu(page) : null;
    const catalog = buildChatGptActionCatalog({
      context, lease, scan, model, providerKey: runtime.providerKey,
      observedAtMs: Date.now(), newActionRef: randomUUID,
    });
    const { blocker, reason, verifiedModel, verifiedReasoningLevel,
      actions, capabilityIssues, cached } = catalog;

    // Every fact attributed to a previously verified user turn must still
    // belong to that turn after asynchronous inspection. A permission or a
    // blocked question has no actionRef but can still contain stale evidence.
    if (turn.submittedUserFound && !turn.laterUserFound &&
        (context.submittedUserMessageId !== null ||
         context.submittedUserTurnId !== null)) {
      const boundary = await observeChatGptDom(page, {
        submittedUserMessageId: context.submittedUserMessageId,
        submittedUserTurnId: context.submittedUserTurnId,
      });
      if (!boundary.submittedUserFound || boundary.laterUserFound) {
        revokeStartSnapshot();
        return deniedObservation('semantic-turn-boundary-changed-during-observation');
      }
    }
    // Chat-only is a property of the published packet, not just the initial
    // read. A slow question/model/permission inspection can cross a mode switch.
    const finalSurface = await observeChatGptSurface(page);
    if (finalSurface.mode !== 'chat') {
      revokeStartSnapshot();
      return deniedObservation(finalSurface.mode === 'work'
        ? 'work-surface-changed-during-observation'
        : 'chat-surface-changed-during-observation', finalSurface.mode);
    }
    // Ownership and conversation may change across asynchronous DOM reads.
    let changedBinding: string | null = null;
    if (!runtime.options.isExactLease(lease)) {
      changedBinding = 'page-lease-revoked-during-observation';
    } else {
      try {
        runtime.assertTrustedOrigin(page);
        changedBinding = conversationBindingProblem(page, context);
      } catch {
        changedBinding = 'page-origin-changed-during-observation';
      }
    }
    if (changedBinding !== null) {
      revokeStartSnapshot();
      return deniedObservation(changedBinding);
    }
    // An overlapping act consumes its old snapshot. An older observe must
    // not republish actionable evidence after that mutation.
    if (runtime.revision.get(lease.pageKey) !== revisionAtStart ||
        runtime.latest.get(lease.pageKey) !== snapshotAtStart ||
        runtime.gate.isBusy(lease.pageKey)) {
      return deniedObservation('semantic-observation-superseded-by-page-operation');
    }
    let observation: SemanticObservation = {
      providerKey: runtime.providerKey, surface: surface.mode, snapshotId, observedAt,
      capabilityManifest: runtime.capabilities, progress, blocker, reason, turn,
      questionText: blocker === 'provider_question' ? question?.text ?? null : null,
      permission, controls: observedControls,
      actions, verifiedModel, verifiedReasoningLevel, evidenceBytes: 0,
      ...(capabilityIssues.length > 0 ? { capabilityIssues } : {}),
    };
    // Size is evidence metadata, not an authorization boundary. The agent
    // gateway publishes bounded previews plus paged evidence while retaining
    // the exact current actions and full provider question in SQLite.
    observation = { ...observation, evidenceBytes: observationBytes(observation) };
    runtime.latest.set(lease.pageKey, { snapshotId, actions: cached });
    runtime.revision.set(lease.pageKey, {});
    return observation;
  }
