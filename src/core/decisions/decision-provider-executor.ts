import { resumeTaskAfterVerifiedDecision } from './decision-resume.ts';
import { SessionPlaneDomainError } from '../../domain/errors.ts';
import type { SemanticActResult } from '../../providers/semantic-adapter.ts';
import type { AgentDecisionOutcome } from '../semantic-decision-gateway.ts';
import { parseDecisionEnvelope } from './decision-envelope.ts';
import { boundedReason, selectionIsValid } from './decision-packet-builder.ts';
import { priorUncertainReasoningEffort } from './decision-reason.ts';
import { replayDecisionOutcome } from './decision-result-receipt.ts';
import type { DecisionServices } from './decision-services.ts';

export async function decideCurrentAction(services: DecisionServices, input: {
    taskId: string; clientId: string; decisionId: string;
    requestId: string; actionRef: string; input?: string;
  }): Promise<AgentDecisionOutcome> {
    const full = services.repository.tasks.readTaskAggregate(input.taskId, input.clientId);
    const row = full.decisions.find(decision => decision.decisionId === input.decisionId);
    if (!row) throw new SessionPlaneDomainError('stale_decision', 'Unknown decision identity');
    const bound = parseDecisionEnvelope(row.contextJson);
    if (typeof bound.attemptId !== 'string' || bound.attemptId.length === 0) {
      throw new Error('Decision has no exact durable attempt binding');
    }
    return await services.decide({ ...input, attemptId: bound.attemptId });
  }

export async function executeProviderDecisionAction(services: DecisionServices, input: {
    taskId: string; clientId: string; attemptId: string; decisionId: string;
    requestId: string; actionRef: string; input?: string;
  }): Promise<AgentDecisionOutcome> {
    if (!input.requestId || !input.actionRef) throw new SessionPlaneDomainError('invalid_request', 'Exact decision input required');
    const full = services.repository.tasks.readTaskAggregate(input.taskId, input.clientId);
    const decision = full.decisions.find(row => row.decisionId === input.decisionId);
    if (!decision) throw new SessionPlaneDomainError('stale_decision', 'Unknown decision identity');
    const stored = parseDecisionEnvelope(decision.contextJson);
    if (stored.attemptId !== input.attemptId ||
        !full.attempts.some(attempt => attempt.attemptId === input.attemptId)) {
      throw new SessionPlaneDomainError('stale_decision', 'Decision belongs to another exact attempt');
    }
    const normalized = input.input ?? null;
    if (decision.status === 'resolved') {
      return replayDecisionOutcome(decision.resolutionJson, {
        requestId: input.requestId, actionRef: input.actionRef, inputValue: normalized,
      });
    }
    if (stored.schemaVersion === 1) {
      throw new SessionPlaneDomainError('stale_decision',
        'Historical pending action is read-only; use an exact decision refresh');
    }
    if (decision.status !== 'pending' || full.task.pendingDecisionId !== input.decisionId ||
        full.task.cancelRequested) throw new SessionPlaneDomainError('stale_decision', 'Decision is not pending on this Task');
    const option = (stored.allOptions ?? stored.packet.options)
      .find(candidate => candidate.actionRef === input.actionRef);
    const control = stored.packet.controls?.find(candidate => candidate.actionRef === input.actionRef);
    if ((option ? 1 : 0) + (control ? 1 : 0) !== 1) {
      throw new SessionPlaneDomainError('stale_decision', 'Decision does not authorize the selected action');
    }
    if (control) {
      if (input.input !== undefined) {
        throw new SessionPlaneDomainError('invalid_request', 'Task controls do not accept provider input');
      }
      return await services.decideControl({ ...input, stored, control });
    }
    if (!option || (option.purpose === 'grant_permission' &&
        stored.packet.permission?.canGrant !== true)) {
      throw new SessionPlaneDomainError('stale_decision', 'Decision does not authorize the selected action');
    }
    const boundAction = stored.actions?.find(candidate =>
      candidate.actionRef === option.actionRef && candidate.purpose === option.purpose &&
      candidate.evidenceHash === option.evidenceHash) ??
      (stored.actionRef === option.actionRef && stored.purpose === option.purpose &&
       stored.evidenceHash === option.evidenceHash && stored.snapshotId !== null
        ? { purpose: option.purpose, snapshotId: stored.snapshotId,
          actionRef: option.actionRef, evidenceHash: option.evidenceHash } : null);
    if (!boundAction) {
      throw new SessionPlaneDomainError('stale_decision', 'Decision action lost its durable evidence binding');
    }
    if (!selectionIsValid(option.inputSchema, input.input)) {
      throw new SessionPlaneDomainError('invalid_request', 'Selected input does not match the enabled decision schema');
    }
    // Cover previously published decisions too, including pending packets
    // created by an older Core before this barrier existed. Checking only the
    // read-only inspection path is insufficient: another client can call
    // task.decide directly with an old exact actionRef.
    if (option.purpose === 'choose_reasoning_effort' &&
        priorUncertainReasoningEffort(full.decisions) &&
        stored.reconcilesUncertainReasoningEffort !== true) {
      throw new SessionPlaneDomainError('stale_decision',
        'A stale reasoning effort action cannot bypass current-state reobservation');
    }
    if (!Number.isFinite(Date.parse(option.expiresAt)) ||
        Date.now() > Date.parse(option.expiresAt)) {
      throw new SessionPlaneDomainError('stale_decision', 'Decision action expired; refresh before selecting');
    }
    const slot = services.repository.projects.getConversationSlot(full.task.projectId, full.task.slotId, input.clientId);
    if (slot.activeTaskId !== input.taskId || slot.revision !== full.task.slotRevision) {
      throw new SessionPlaneDomainError('stale_decision', 'Decision lost its exact active slot');
    }
    const binding = services.repository.projects.getSlotBindingAtRevision(
      full.task.projectId, full.task.slotId, full.task.slotRevision, input.clientId);
    const provider = services.providers.resolve(binding.providerKey, 'conversation');
    if (provider.kind !== 'available' ||
        (provider.adapter.capabilities.browserRequired && stored.context.pageLease === null)) {
      throw new SessionPlaneDomainError('adapter_unsupported', 'Executable decision provider/page is unavailable');
    }
    try {
      services.repository.decisions.resolveDecision({
        taskId: input.taskId, clientId: input.clientId, decisionId: input.decisionId,
        resolutionJson: JSON.stringify({
          kind: 'semantic_action', requestId: input.requestId,
          actionRef: input.actionRef, input: normalized,
        }),
      });
    } catch (error) {
      // Concurrent matching callers may race at this exact SQLite reservation.
      // The loser can only replay/read the committed receipt, never act again.
      const current = services.repository.tasks.readTaskAggregate(input.taskId, input.clientId)
        .decisions.find(row => row.decisionId === input.decisionId);
      if (current?.status === 'resolved') {
        return replayDecisionOutcome(current.resolutionJson, {
          requestId: input.requestId, actionRef: input.actionRef, inputValue: normalized,
        });
      }
      throw error;
    }
    let result: SemanticActResult;
    try {
      result = await provider.adapter.act({
        context: stored.context, snapshotId: boundAction.snapshotId,
        actionRef: option.actionRef, evidenceHash: option.evidenceHash,
        authorizedDecisionId: input.decisionId,
        ...(input.input === undefined ? {} : { input: input.input }),
      });
    } catch {
      result = { kind: 'uncertain', reason: 'semantic-decision-effect-unverified' };
    }
    const accepted = services.repository.tasks.readTaskAggregate(input.taskId, input.clientId)
      .decisions.find(row => row.decisionId === input.decisionId);
    let outcome: AgentDecisionOutcome;
    if (result.kind === 'performed' && accepted?.actionConsumed) {
      outcome = { kind: 'performed', effect: result.effect };
    } else if (accepted?.actionConsumed || result.kind === 'uncertain' ||
        result.kind === 'dispatched_unverified') {
      const reason = result.kind === 'uncertain' ? boundedReason(result.reason) :
        'semantic-decision-effect-unverified';
      outcome = { kind: 'uncertain', reason };
    } else {
      // No durable consumption: never replay this action. The new snapshot
      // receives a distinct decisionId and a fresh provider action reference.
      try {
        const packet = await services.inspect({
          taskId: input.taskId, clientId: input.clientId, attemptId: input.attemptId,
          modelChoice: stored.packet.kind === 'model_choice',
          ...(stored.packet.requestedModel
            ? { modelIntent: stored.packet.requestedModel } : {}),
        });
        outcome = { kind: 'refresh_required', packet };
      } catch {
        outcome = { kind: 'uncertain', reason: 'decision-refresh-unavailable' };
      }
    }
    return await finalizeProviderDecisionOutcome(services, input, outcome);

  }


async function finalizeProviderDecisionOutcome(
  services: DecisionServices,
  input: { taskId: string; clientId: string; attemptId: string; decisionId: string;
    requestId: string; actionRef: string; input?: string },
  outcome: AgentDecisionOutcome,
): Promise<AgentDecisionOutcome> {
    try {
      services.repository.decisions.recordDecisionOutcome({
        taskId: input.taskId, clientId: input.clientId, decisionId: input.decisionId,
        requestId: input.requestId, actionRef: input.actionRef, inputValue: input.input ?? null,
        outcomeJson: JSON.stringify(outcome),
      });
    } catch {
      // The external effect might have happened even if this final SQLite
      // receipt could not commit. Never fabricate a success or repeat it.
      return { kind: 'uncertain', reason: 'decision-outcome-receipt-unavailable' };
    }
    if (outcome.kind === 'uncertain') {
      try {
        services.repository.tasks.recordObservationDeferred(input.taskId, input.clientId,
          'decision:' + input.decisionId + ':uncertain:' + outcome.reason);
      } catch { return outcome; }
    } else if (outcome.kind === 'performed') {
      await resumeTaskAfterVerifiedDecision(services, {
        taskId: input.taskId, clientId: input.clientId,
        attemptId: input.attemptId, decisionId: input.decisionId,
        mode: 'provider_effect',
        recoveryReason: 'provider-effect-resume-scheduled-for-core-retry',
      });
    }
    return outcome;
}
