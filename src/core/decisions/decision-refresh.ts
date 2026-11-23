import { SessionPlaneDomainError } from '../../domain/errors.ts';
import type { AgentDecisionPacket, AgentDecisionOutcome } from '../semantic-decision-gateway.ts';
import { parseDecisionEnvelope, reconcilePendingDecisionV1 } from './decision-envelope.ts';
import { parseDecisionReceiptRecord } from './decision-result-receipt.ts';
import type { DecisionServices } from './decision-services.ts';

export async function refreshDecision(services: DecisionServices, input: {
    taskId: string; clientId: string; attemptId: string; decisionId: string;
    modelChoice?: boolean; requestId?: string;
  }): Promise<AgentDecisionPacket | null> {
    const full = services.repository.tasks.readTaskAggregate(input.taskId, input.clientId);
    if (full.task.pendingDecisionId !== input.decisionId) {
      throw new Error('Only the current pending decision may be refreshed');
    }
    const current = full.decisions.find(row => row.decisionId === input.decisionId);
    if (!current) throw new Error('Missing exact decision for refresh');
    const original = parseDecisionEnvelope(current.contextJson);
    if (original.attemptId !== input.attemptId) {
      throw new Error('Decision refresh belongs to another exact attempt');
    }
    const requestedModel = original.packet.requestedModel ??
      (input.modelChoice === true ? original.context.requiredModel ?? null : null);
    services.repository.decisions.resolveDecision({
      taskId: input.taskId, clientId: input.clientId, decisionId: input.decisionId,
      resolutionJson: JSON.stringify({ kind: 'read_only_refresh',
        ...(input.requestId ? { requestId: input.requestId } : {}) }),
    });
    if (requestedModel && original.packet.kind === 'model_choice') {
      // An externally selected, exact model/effort can clear a stale pending
      // chooser without replaying a prior uncertain pointer click. This does
      // not approve a send: the Core dispatch port will independently observe
      // the model again before spending the originally planned attempt.
      try {
        if (await services.verifyModelIntent({
          taskId: input.taskId, clientId: input.clientId,
          attemptId: input.attemptId, modelIntent: requestedModel,
        })) return null;
      } catch {
        const pending = services.get(input.taskId, input.clientId);
        if (pending !== null) return pending;
      }
      const existing = services.get(input.taskId, input.clientId);
      if (existing !== null) return existing;
    }
    return await services.inspect({ taskId: input.taskId, clientId: input.clientId,
      attemptId: input.attemptId,
      modelChoice: original.packet.kind === 'model_choice' || input.modelChoice === true,
      ...(requestedModel ? { modelIntent: requestedModel } : {}) });
  }

export async function refreshCurrentDecision(services: DecisionServices, input: {
    taskId: string; clientId: string; decisionId: string; requestId: string;
  }): Promise<AgentDecisionOutcome> {
    const full = services.repository.tasks.readTaskAggregate(input.taskId, input.clientId);
    const row = full.decisions.find(decision => decision.decisionId === input.decisionId);
    if (!row) throw new SessionPlaneDomainError('stale_decision', 'Unknown decision identity');
    const original = parseDecisionEnvelope(row.contextJson);
    const originalAttempt = full.attempts.find(
      attempt => attempt.attemptId === original.attemptId);
    if (!original.attemptId || !originalAttempt) {
      throw new SessionPlaneDomainError('stale_decision', 'Decision lost its exact attempt');
    }
    if (row.status === 'pending' &&
        reconcilePendingDecisionV1(input.taskId, input.decisionId, original) ===
          'read_only_refresh_required') {
      if (full.task.pendingDecisionId !== input.decisionId || full.task.cancelRequested) {
        throw new SessionPlaneDomainError('stale_decision',
          'Historical pending decision no longer owns this Task');
      }
      const replacement = await services.refresh({
        ...input, attemptId: original.attemptId,
        modelChoice: original.packet.kind === 'model_choice',
      });
      return { kind: 'refresh_required', packet: replacement };
    }
    // Explicitly refresh only bounded, unsubmitted, exact page observations.
    // A page-load error is not permission to send or navigate again.
    const stalledContinuation =
      original.packet.kind === 'recovery_choice' &&
      original.packet.options.length === 0 && !original.packet.humanOnly &&
      (((original.packet.reason === 'managed-continuation-no-final-after-approved-continue' ||
         original.packet.reason === 'managed-continuation-no-progress-policy-reached') &&
        originalAttempt.kind === 'continuation' && originalAttempt.state === 'acknowledged') ||
       (original.packet.reason === 'managed-continuation-safe-send-unavailable' &&
        originalAttempt.kind === 'continuation' && originalAttempt.state === 'planned') ||
       (original.packet.reason === 'managed-continuation-later-user-boundary' &&
        originalAttempt.kind === 'initial' && originalAttempt.state === 'acknowledged') ||
       // A policy-authorized persistent 429 review has no provider mutation.
       // Only an explicit read-only agent refresh releases its durable hold.
       (original.packet.reason === 'canonical-final-rate-limit-persistent' &&
        (originalAttempt.kind === 'initial' || originalAttempt.kind === 'continuation') &&
        originalAttempt.state === 'acknowledged'));
    // A cold owned Pro root can be unverified before its Chat composer hydrates.
    // Refresh only that exact unsent root; an actual Work surface stays blocked.
    const transientRootObservation =
      original.packet.kind === 'adapter_unsupported' &&
      (original.packet.reason === 'semantic-observation-superseded-by-page-operation' ||
       original.packet.reason === 'chat-surface-unverified') &&
      original.packet.options.length === 0 && !original.packet.humanOnly &&
      original.context.requiredModel === 'Pro' &&
      original.context.providerConversationId === null &&
      original.context.submittedUserMessageId === null &&
      original.context.submittedUserTurnId === null &&
      original.context.pageLease !== null &&
      originalAttempt.kind === 'initial' && originalAttempt.state === 'planned';
    const transientBoundSurface =
      original.packet.kind === 'adapter_unsupported' &&
      original.packet.reason === 'chat-surface-unverified' &&
      original.packet.options.length === 0 && !original.packet.humanOnly &&
      original.context.providerConversationId !== null &&
      original.context.pageLease !== null &&
      original.context.submittedUserMessageId === null &&
      original.context.submittedUserTurnId === null &&
      originalAttempt.kind === 'initial' && originalAttempt.state === 'planned';
    const receipt = row.resolutionJson === null ? null
      : parseDecisionReceiptRecord(row.resolutionJson);
    if (row.status === 'resolved') {
      if (receipt?.kind !== 'read_only_refresh' || receipt.requestId !== input.requestId) {
        throw new SessionPlaneDomainError('stale_decision', 'Decision refreshed by a different request');
      }
      // A crash after the durable receipt but before reinspection cannot strand
      // this Task. A replay can only observe, never perform a provider action.
      let next = services.get(input.taskId, input.clientId);
      if (next === null && full.task.state === 'working' &&
          !full.task.cancelRequested &&
          (originalAttempt.state === 'planned' || stalledContinuation)) {
        if (original.packet.kind === 'model_choice' && original.packet.requestedModel) {
          try {
            if (await services.verifyModelIntent({
              taskId: input.taskId, clientId: input.clientId,
              attemptId: original.attemptId, modelIntent: original.packet.requestedModel,
            })) return { kind: 'refresh_required', packet: null };
          } catch {
            next = services.get(input.taskId, input.clientId);
          }
          next = services.get(input.taskId, input.clientId);
        }
        if (next === null) next = await services.inspect({
          taskId: input.taskId, clientId: input.clientId, attemptId: original.attemptId,
          modelChoice: original.packet.kind === 'model_choice' || transientRootObservation,
          ...(original.packet.requestedModel || (transientRootObservation ? original.context.requiredModel : null)
            ? { modelIntent: (original.packet.requestedModel ??
              original.context.requiredModel)! } : {}),
        });
      }
      if (next === null && original.packet.reason === 'managed-continuation-safe-send-unavailable') {
        services.scheduleUnsentContinuationReview(input.taskId, input.clientId, input.decisionId);
      }
      return { kind: 'refresh_required', packet: next };
    }
    const packet = original.packet;
    const option = packet.options[0];
    if (row.status !== 'pending' || full.task.pendingDecisionId !== input.decisionId ||
        full.task.cancelRequested ||
        (packet.kind !== 'model_choice' && !transientRootObservation &&
         !transientBoundSurface && !stalledContinuation) ||
        packet.humanOnly ||
        (packet.kind === 'model_choice' && !packet.requestedModel) ||
        packet.options.length > 1 ||
        (option !== undefined &&
          (!Number.isFinite(Date.parse(option.expiresAt)) ||
           Date.now() <= Date.parse(option.expiresAt)))) {
      throw new SessionPlaneDomainError('stale_decision', 'Current decision is not refreshable');
    }
    const slot = services.repository.projects.getConversationSlot(full.task.projectId, full.task.slotId, input.clientId);
    if (slot.activeTaskId !== input.taskId || slot.revision !== full.task.slotRevision) {
      throw new SessionPlaneDomainError('stale_decision', 'Decision lost its active slot');
    }
    try {
      const next = await services.refresh({ ...input, attemptId: original.attemptId,
        modelChoice: transientRootObservation });
      if (next === null && original.packet.reason === 'managed-continuation-safe-send-unavailable') {
        services.scheduleUnsentContinuationReview(input.taskId, input.clientId, input.decisionId);
      }
      return { kind: 'refresh_required', packet: next };
    } catch (error) {
      // Concurrent identical refreshes may race the SQLite reservation. Only
      // the winning exact request may retrieve the newly observed decision.
      const latest = services.repository.tasks.readTaskAggregate(input.taskId, input.clientId)
        .decisions.find(decision => decision.decisionId === input.decisionId);
      const resolved = latest?.resolutionJson
        ? (parseDecisionReceiptRecord(latest.resolutionJson)) : null;
      if (latest?.status === 'resolved' &&
          resolved?.kind === 'read_only_refresh' && resolved.requestId === input.requestId) {
        return { kind: 'refresh_required', packet: services.get(input.taskId, input.clientId) };
      }
      throw error;
    }
  }

export function scheduleUnsentContinuationReview(services: DecisionServices, taskId: string, clientId: string, decisionId: string): void {
    const full = services.repository.tasks.readTaskAggregate(taskId, clientId);
    if (full.task.cancelRequested || full.task.state !== 'working' ||
        full.task.pendingDecisionId !== null) return;
    const latest = full.attempts.filter(attempt => attempt.kind !== 'stop').at(-1);
    if (latest?.kind !== 'continuation' || latest.state !== 'planned' ||
        latest.dispatchedAt !== null) return;
    const source = full.attempts.find(row => row.sequence === latest.sequence - 1);
    if (source?.state !== 'acknowledged' || source.externalTurnId === null ||
        full.results.some(row => row.attemptId === source.attemptId)) return;
    const timerId = 'continuation-agent-resume:' + decisionId;
    if (full.timers.some(row => row.timerId === timerId)) return;
    const original = full.timers.find(timer => {
      if (timer.kind !== 'continuation_due') return false;
      try {
        const context: unknown = JSON.parse(timer.contextJson);
        return context !== null && typeof context === 'object' &&
          (context as { contract?: unknown; sourceAttemptId?: unknown }).contract ===
            'approved_continuation_v1' &&
          (context as { sourceAttemptId?: unknown }).sourceAttemptId === source.attemptId;
      } catch { return false; }
    });
    if (!original) return; // A packet alone does not invent authorization.
    services.repository.timers.scheduleTaskTimer({
      taskId, clientId, timerId, kind: 'continuation_due',
      dueAt: new Date(Date.now() + 30_000).toISOString(),
      contextJson: original.contextJson,
    });
  }
