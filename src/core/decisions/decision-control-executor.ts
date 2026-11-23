import { resumeTaskAfterVerifiedDecision } from './decision-resume.ts';
import { randomUUID } from 'node:crypto';
import type { AgentDecisionControl, AgentDecisionOutcome } from '../semantic-decision-gateway.ts';
import type { ParsedDecisionEnvelope } from './decision-envelope.ts';
import { buildDecisionEnvelopeV2 } from './decision-envelope.ts';
import { boundedPacket, decisionControls } from './decision-packet-builder.ts';
import { replayDecisionOutcome } from './decision-result-receipt.ts';
import type { DecisionServices } from './decision-services.ts';

export async function executeTaskDecisionControl(services: DecisionServices, input: {
    taskId: string; clientId: string; attemptId: string; decisionId: string;
    requestId: string; actionRef: string; input?: string;
    stored: ParsedDecisionEnvelope; control: AgentDecisionControl;
  }): Promise<AgentDecisionOutcome> {
    const normalized = input.input ?? null;
    if (input.control.purpose === 'request_human') {
      const nextDecisionId = randomUUID();
      const reason = 'agent-requested-human-assistance';
      const currentRevision = services.repository.tasks.getTask(input.taskId, input.clientId).revision;
      const packet = boundedPacket({
        ...input.stored.packet,
        decisionId: nextDecisionId,
        taskRevision: currentRevision + 4,
        kind: 'human_verification', reason, humanOnly: true,
        observedAt: new Date().toISOString(), options: [], optionCount: 0,
        controls: decisionControls(nextDecisionId, reason, true),
        resumePoint: 'return to this exact task after the requested human action is confirmed',
        evidenceBytes: 0,
      });
      const envelope = buildDecisionEnvelopeV2({
        taskContext: input.stored.context, attemptId: input.stored.attemptId,
        providerActions: [],
        evidence: { ...input.stored.evidence, decision_options: '[]' },
        packet,
      });
      try {
        services.repository.decisions.escalateDecisionToHuman({
          taskId: input.taskId, clientId: input.clientId,
          decisionId: input.decisionId, requestId: input.requestId,
          actionRef: input.actionRef, inputValue: normalized,
          nextDecisionId, nextContextJson: JSON.stringify(envelope),
        });
      } catch (error) {
        const current = services.repository.tasks.readTaskAggregate(input.taskId, input.clientId)
          .decisions.find(row => row.decisionId === input.decisionId);
        if (current?.status === 'resolved') {
          return replayDecisionOutcome(current.resolutionJson, {
            requestId: input.requestId, actionRef: input.actionRef, inputValue: normalized,
          });
        }
        throw error;
      }
      return { kind: 'performed', effect: 'human_assistance_requested' };
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
      const current = services.repository.tasks.readTaskAggregate(input.taskId, input.clientId)
        .decisions.find(row => row.decisionId === input.decisionId);
      if (current?.status === 'resolved') {
        return replayDecisionOutcome(current.resolutionJson, {
          requestId: input.requestId, actionRef: input.actionRef, inputValue: normalized,
        });
      }
      throw error;
    }
    if (!services.repository.decisions.consumeDecisionAction(
      input.taskId, input.clientId, input.decisionId)) {
      return { kind: 'uncertain', reason: 'task-control-consumption-unavailable' };
    }

    let outcome: AgentDecisionOutcome;
    try {
      switch (input.control.purpose) {
        case 'reobserve': {
          if (input.stored.packet.kind === 'model_choice' &&
              input.stored.packet.requestedModel &&
              await services.verifyModelIntent({
                taskId: input.taskId, clientId: input.clientId,
                attemptId: input.attemptId,
                modelIntent: input.stored.packet.requestedModel,
              })) {
            outcome = { kind: 'refresh_required', packet: null };
            break;
          }
          const packet = await services.inspect({
            taskId: input.taskId, clientId: input.clientId, attemptId: input.attemptId,
            modelChoice: input.stored.packet.kind === 'model_choice',
            ...(input.stored.packet.requestedModel
              ? { modelIntent: input.stored.packet.requestedModel } : {}),
          });
          outcome = { kind: 'refresh_required', packet };
          break;
        }
        case 'wait':
          outcome = { kind: 'performed', effect: 'observation_resumed' };
          break;
        case 'resume':
          outcome = { kind: 'performed', effect: 'task_resumed' };
          break;
        case 'cancel':
          services.repository.tasks.requestTaskCancellation(input.taskId, input.clientId);
          outcome = { kind: 'performed', effect: 'cancel_requested' };
          break;
      }
    } catch {
      outcome = { kind: 'uncertain', reason: 'task-control-effect-unverified' };
    }

    try {
      services.repository.decisions.recordDecisionOutcome({
        taskId: input.taskId, clientId: input.clientId, decisionId: input.decisionId,
        requestId: input.requestId, actionRef: input.actionRef, inputValue: normalized,
        outcomeJson: JSON.stringify(outcome),
      });
    } catch {
      return { kind: 'uncertain', reason: 'decision-outcome-receipt-unavailable' };
    }
    if (input.control.purpose === 'wait' || input.control.purpose === 'resume') {
      await resumeTaskAfterVerifiedDecision(services, {
        taskId: input.taskId, clientId: input.clientId,
        attemptId: input.attemptId, decisionId: input.decisionId,
        mode: input.control.purpose, recoveryReason: 'resume-scheduled-for-core-retry',
      });
    }
    return outcome;
  }
