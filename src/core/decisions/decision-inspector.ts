import { randomUUID } from 'node:crypto';
import { semanticConfigurationMatches } from '../../providers/semantic-adapter.ts';
import type { SemanticActionPurpose, SemanticObservation, SemanticTaskContext } from '../../providers/semantic-adapter.ts';
import type { ExactSendIntent } from '../durable-task-kernel.ts';
import type { AgentDecisionOption, AgentDecisionPacket } from '../semantic-decision-gateway.ts';
import type { StoredDecisionEvidence, StoredProviderAction } from './decision-envelope.ts';
import { buildDecisionEnvelopeV2 } from './decision-envelope.ts';
import { preview, evidenceSections, packetOptions, compactObservedControls, boundedPacket, decisionControls, boundedReason } from './decision-packet-builder.ts';
import { priorUncertainReasoningEffort, matchingActions, decisionKind } from './decision-reason.ts';
import type { DecisionServices } from './decision-services.ts';

export async function requireNoProgressReview(services: DecisionServices, input: {
    taskId: string; clientId: string; attemptId: string;
    cause?: 'persistent_backend_read_throttle' | 'repeated_no_progress';
  }): Promise<AgentDecisionPacket | null> {
    const full = services.repository.tasks.readTaskAggregate(input.taskId, input.clientId);
    if (full.task.pendingDecisionId !== null) return services.get(input.taskId, input.clientId);
    if (full.task.cancelRequested || full.task.state !== 'working') return null;
    const attempt = full.attempts.find(row => row.attemptId === input.attemptId);
    const latest = full.attempts.filter(row => row.kind !== 'stop').at(-1);
    if (!attempt || latest?.attemptId !== attempt.attemptId ||
        full.results.some(row => row.attemptId === attempt.attemptId)) {
      throw new Error('Agent review requires the current unanswered exact attempt');
    }
    const previous = full.attempts.find(row => row.sequence === attempt.sequence - 1);
    const acknowledged = attempt.state === 'acknowledged' &&
      attempt.externalTurnId !== null &&
      (attempt.kind === 'continuation' || attempt.kind === 'initial');
    const unableToSend = attempt.kind === 'continuation' &&
      attempt.state === 'planned' && attempt.dispatchedAt === null &&
      previous?.state === 'acknowledged' && previous.externalTurnId !== null &&
      previous.kind !== 'stop' &&
      !full.results.some(row => row.attemptId === previous.attemptId);
    if (!acknowledged && !unableToSend) {
      throw new Error('Agent review requires an unanswered ACK or an unsent approved Continue');
    }
    const slot = services.repository.projects.getConversationSlot(full.task.projectId, full.task.slotId, input.clientId);
    if (slot.activeTaskId !== input.taskId || slot.revision !== full.task.slotRevision) {
      throw new Error('Agent review lost the exact Task slot');
    }
    const binding = services.repository.projects.getSlotBindingAtRevision(
      full.task.projectId, full.task.slotId, full.task.slotRevision, input.clientId);
    const intent: ExactSendIntent = {
      taskId: input.taskId, clientId: input.clientId,
      projectId: full.task.projectId, slotId: full.task.slotId,
      slotRevision: full.task.slotRevision,
      providerConversationId: binding.providerConversationId,
      attemptId: attempt.attemptId, kind: attempt.kind, content: attempt.content,
    };
    let context: SemanticTaskContext;
    try { context = await services.resolveContext(intent); }
    catch {
      // A lost tab must not prevent a durable agent handoff. Only immutable
      // Task/ACK facts are retained; the packet has no executable action.
      context = {
        projectId: full.task.projectId, slotId: full.task.slotId,
        slotRevision: full.task.slotRevision, taskId: input.taskId,
        providerConversationId: binding.providerConversationId,
        submittedUserMessageId: null,
        submittedUserTurnId: attempt.externalTurnId ?? previous?.externalTurnId ?? null,
        pageLease: null,
      };
    }
    if (context.taskId !== input.taskId || context.projectId !== full.task.projectId ||
        context.slotId !== full.task.slotId ||
        context.slotRevision !== full.task.slotRevision ||
        context.providerConversationId !== binding.providerConversationId) {
      throw new Error('No-progress review context changed its canonical identity');
    }
    const now = new Date().toISOString();
    const decisionId = randomUUID();
    const reason = input.cause === 'persistent_backend_read_throttle'
      ? 'canonical-final-rate-limit-persistent'
      : input.cause === 'repeated_no_progress'
        ? 'managed-continuation-no-progress-policy-reached'
        : attempt.kind === 'initial' ? 'managed-continuation-later-user-boundary'
      : unableToSend ? 'managed-continuation-safe-send-unavailable'
        : 'managed-continuation-no-final-after-approved-continue';
    const evidence: StoredDecisionEvidence = {
      original_request: full.task.originalPrompt,
      current_attempt: JSON.stringify({
        attemptId: attempt.attemptId, sequence: attempt.sequence, kind: attempt.kind,
        state: attempt.state, content: attempt.content,
        dispatchedAt: attempt.dispatchedAt, acknowledgedAt: attempt.acknowledgedAt,
        previousAttemptId: previous?.attemptId ?? null,
        attemptHistory: full.attempts.filter(row => row.kind !== 'stop').map(row => ({
          attemptId: row.attemptId, sequence: row.sequence, kind: row.kind,
          state: row.state, dispatchedAt: row.dispatchedAt,
          acknowledgedAt: row.acknowledgedAt, externalTurnId: row.externalTurnId,
          hasFinal: full.results.some(result => result.attemptId === row.attemptId),
        })),
      }, null, 2),
      provider_question: '', permission: '', partial_answer: '', capability_issues: '',
      provider_controls: '', decision_options: '[]',
    };
    const packet = boundedPacket({
      taskId: input.taskId, taskRevision: full.task.revision + 1, decisionId,
      kind: 'recovery_choice', reason,
      humanOnly: false, observedAt: now,
      expiresAt: new Date(Date.now() + 24 * 60 * 60_000).toISOString(),
      snapshotId: null, questionText: null, permission: null,
      requestedModel: null, options: [], optionCount: 0,
      controls: decisionControls(decisionId, reason, false),
      evidenceSections: evidenceSections(evidence),
      observedControls: [], observedControlCount: 0,
      resumePoint: unableToSend
        ? 'retry the existing planned continuation through the Core-owned due path'
        : 'observe the same exact acknowledged turn and continue this task',
      evidenceBytes: 0,
    });
    const envelope = buildDecisionEnvelopeV2({
      taskContext: context, attemptId: attempt.attemptId,
      providerActions: [], evidence, packet,
    });
    try {
      services.repository.decisions.createDecision({
        taskId: input.taskId, clientId: input.clientId, decisionId,
        audience: 'agent', contextJson: JSON.stringify(envelope),
      });
    } catch (error) {
      const current = services.get(input.taskId, input.clientId);
      if (current !== null) return current;
      throw error;
    }
    return services.get(input.taskId, input.clientId);
  }

export async function verifyModelIntent(services: DecisionServices, input: {
    taskId: string; clientId: string; attemptId: string; modelIntent: string;
  }): Promise<boolean> {
    const full = services.repository.tasks.readTaskAggregate(input.taskId, input.clientId);
    if (full.task.state !== 'working' || full.task.cancelRequested ||
        full.task.pendingDecisionId !== null) return false;
    const attempt = full.attempts.find(a => a.attemptId === input.attemptId);
    const slot = services.repository.projects.getConversationSlot(full.task.projectId, full.task.slotId, input.clientId);
    if (!attempt || attempt.kind !== 'initial' || attempt.state !== 'planned' ||
        slot.activeTaskId !== input.taskId || slot.revision !== full.task.slotRevision) return false;
    const provider = services.providers.resolve(slot.providerKey, 'conversation');
    if (provider.kind !== 'available') return false;
    const context = await services.resolveContext({
      taskId: input.taskId, clientId: input.clientId,
      projectId: full.task.projectId, slotId: full.task.slotId,
      slotRevision: full.task.slotRevision,
      providerConversationId: slot.providerConversationId,
      attemptId: attempt.attemptId, kind: attempt.kind, content: attempt.content,
    });
    if (context.requiredModel !== input.modelIntent || context.pageLease === null) {
      return false;
    }
    try {
      const observed = await provider.adapter.observe(context);
      if (observed.providerKey === provider.adapter.providerKey &&
          observed.surface === 'chat' && observed.blocker === 'none' &&
          observed.progress !== 'streaming' &&
          semanticConfigurationMatches(
            provider.adapter.providerKey, input.modelIntent, observed)) return true;
    } catch {
      await services.inspect({ ...input, modelChoice: true });
      return false;
    }
    await services.inspect({ ...input, modelChoice: true });
    return false;
  }

export async function inspectCurrentDecisionNeed(services: DecisionServices, input: {
    taskId: string; clientId: string; attemptId: string;
    modelChoice?: boolean;
    modelIntent?: string;
  }): Promise<AgentDecisionPacket | null> {
    if (input.modelIntent !== undefined &&
        (input.modelChoice !== true ||
         input.modelIntent.trim().length === 0 || input.modelIntent.length > 200)) {
      throw new Error('Invalid bounded model intent');
    }
    const full = services.repository.tasks.readTaskAggregate(input.taskId, input.clientId);
    if (full.task.pendingDecisionId !== null) return services.get(input.taskId, input.clientId);
    if (full.task.state !== 'working' || full.task.cancelRequested) return null;
    const attempt = full.attempts.find(row => row.attemptId === input.attemptId);
    if (!attempt || attempt.kind === 'stop') throw new Error('Exact active attempt required');
    const slot = services.repository.projects.getConversationSlot(full.task.projectId, full.task.slotId, input.clientId);
    if (slot.activeTaskId !== input.taskId || slot.revision !== full.task.slotRevision) {
      return null;
    }
    const binding = services.repository.projects.getSlotBindingAtRevision(
      full.task.projectId, full.task.slotId, full.task.slotRevision, input.clientId);
    const intent: ExactSendIntent = {
      taskId: full.task.taskId, projectId: full.task.projectId,
      slotId: full.task.slotId, slotRevision: full.task.slotRevision,
      providerConversationId: binding.providerConversationId, clientId: input.clientId,
      attemptId: attempt.attemptId, kind: attempt.kind, content: attempt.content,
    };
    const context = await services.resolveContext(intent);
    if (context.taskId !== input.taskId || context.projectId !== full.task.projectId ||
        context.slotId !== full.task.slotId || context.slotRevision !== full.task.slotRevision ||
        context.providerConversationId !== binding.providerConversationId) {
      throw new Error('Semantic decision context does not belong to the active Task');
    }
    const provider = services.providers.resolve(binding.providerKey, 'conversation');
    if (provider.kind === 'available' &&
        provider.adapter.capabilities.browserRequired && context.pageLease === null) {
      return null; // Preparation, not a human-only barrier.
    }
    let observation: SemanticObservation | null = null;
    if (provider.kind === 'available') {
      try { observation = await provider.adapter.observe(context); }
      catch { observation = null; }
    }
    if (observation && (observation.providerKey !== binding.providerKey ||
        observation.capabilityManifest.providerKey !== binding.providerKey ||
        observation.capabilityManifest.contractVersion !== 1)) {
      observation = null;
    }
    const kind = observation ? decisionKind(observation, input.modelChoice === true)
      : 'adapter_unsupported';
    if (kind === null) return null;
    const purposes: SemanticActionPurpose[] = kind === 'provider_question'
      ? ['answer_question'] : kind === 'model_choice'
        ? ['open_model_chooser', 'close_model_chooser',
          'choose_model', 'choose_reasoning_effort'] : kind === 'tool_permission'
          ? ['grant_permission', 'decline_permission'] : kind === 'provider_control'
            ? ['activate_control', 'set_control_value'] : kind === 'recovery_choice'
            ? ['retry'] : [];
    const uncertainEffort = kind === 'model_choice' &&
      priorUncertainReasoningEffort(full.decisions);
    const actions = observation ? matchingActions(observation, purposes) : [];
    const reconcilesUncertainReasoningEffort = uncertainEffort &&
      actions.some(action => action.purpose === 'choose_reasoning_effort');
    const now = new Date().toISOString();
    const decisionId = randomUUID();
    const options: AgentDecisionOption[] = actions.map(action => ({
      actionRef: action.actionRef, purpose: action.purpose, effect: action.effect,
      risk: action.risk, evidenceHash: action.evidenceHash,
      expiresAt: action.expiresAt, inputSchema: action.input,
      ...(action.control ? { control: { ...action.control,
        contextSummary: preview(action.control.contextSummary).text } } : {}),
    }));
    const reason = reconcilesUncertainReasoningEffort
      ? 'reasoning-effort-current-state-reobserved'
      : observation ? boundedReason(observation.reason) :
        provider.kind === 'unsupported' ? provider.reason : 'semantic-observation-unavailable';
    const humanOnly = kind === 'human_verification';
    const permissionPreview = observation?.permission ? {
      ...observation.permission,
      visibleSummary: preview(observation.permission.visibleSummary).text,
      argumentsSummary: observation.permission.argumentsSummary === null ? null
        : preview(observation.permission.argumentsSummary).text,
    } : null;
    const observedControlPreviews = (observation?.controls ?? []).map(control => ({
      ...control, contextSummary: preview(control.contextSummary).text,
    }));
    const evidence: StoredDecisionEvidence = {
      original_request: full.task.originalPrompt,
      current_attempt: JSON.stringify({
        attemptId: attempt.attemptId, sequence: attempt.sequence, kind: attempt.kind,
        state: attempt.state, content: attempt.content,
        dispatchedAt: attempt.dispatchedAt, acknowledgedAt: attempt.acknowledgedAt,
      }, null, 2),
      provider_question: observation?.questionText ?? '',
      permission: observation?.permission ? JSON.stringify(observation.permission, null, 2) : '',
      partial_answer: observation?.turn.partialAnswer ?? '',
      capability_issues: observation?.capabilityIssues
        ? JSON.stringify(observation.capabilityIssues, null, 2) : '',
      provider_controls: observation?.controls?.length
        ? JSON.stringify(observation.controls, null, 2) : '',
      decision_options: JSON.stringify(options, null, 2),
    };
    const sections = evidenceSections(evidence);
    const questionPage = preview(evidence.provider_question);
    const packetOptionPage = packetOptions(options);
    const controlPage = compactObservedControls(observation?.controls ?? []);
    let packet: AgentDecisionPacket = {
      taskId: input.taskId, taskRevision: full.task.revision + 1, decisionId,
      kind, reason, humanOnly,
      observedAt: observation?.observedAt ?? now,
      expiresAt: options.length > 0
        ? options.map(option => option.expiresAt).sort()[0]!
        : new Date(Date.now() + 24 * 60 * 60_000).toISOString(),
      snapshotId: observation?.snapshotId ?? null,
      questionText: kind === 'provider_question' ? questionPage.text || null : null,
      permission: kind === 'tool_permission' ? permissionPreview : null,
      requestedModel: kind === 'model_choice' ? input.modelIntent ?? null : null,
      options: packetOptionPage, optionCount: options.length,
      controls: decisionControls(decisionId, reason, humanOnly),
      evidenceSections: sections, observedControls: controlPage,
      observedControlCount: observation?.controls?.length ?? 0,
      resumePoint: 'return to the same task, exact conversation and current attempt after the selected effect',
      evidenceBytes: 0,
    };
    packet = boundedPacket(packet);
    const storedActions: StoredProviderAction[] = options.map(option => ({
      purpose: option.purpose, snapshotId: packet.snapshotId!,
      actionRef: option.actionRef, evidenceHash: option.evidenceHash,
    }));
    const envelope = buildDecisionEnvelopeV2({
      taskContext: context, attemptId: input.attemptId,
      providerActions: storedActions, evidence, packet,
    });
    try {
      services.repository.decisions.createDecision({
        taskId: input.taskId, clientId: input.clientId, decisionId,
        audience: packet.humanOnly ? 'human' : 'agent',
        contextJson: JSON.stringify(envelope),
      });
    } catch (error) {
      // Parallel inspectors must not issue a second packet for one Task.
      const current = services.get(input.taskId, input.clientId);
      if (current !== null) return current;
      throw error;
    }
    return { ...packet, taskRevision: services.repository.tasks.getTask(input.taskId, input.clientId).revision };
  }
