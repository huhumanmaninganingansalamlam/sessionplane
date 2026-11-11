import { createHash } from 'node:crypto';
import { z } from 'zod';

import type { SemanticDecisionGateway } from '../../core/semantic-decision-gateway.ts';
import { waitForTaskRevision } from '../../core/task-wait.ts';
import type { TaskKernelRepository } from '../../storage/task-kernel-repository.ts';
import type { RpcRouter } from '../router.ts';

const clientId = z.string().trim().min(1).max(200);
const taskId = z.string().uuid();
const requestId = z.string().trim().min(1).max(300);
const decisionId = z.string().uuid();
const actionRef = z.string().trim().min(1).max(512);
const view = z.enum(['summary', 'result', 'evidence']).default('summary');

/** Source-of-truth public task surface. MCP and CLI derive schemas from here;
 * they are transport clients, never lifecycle or timer owners.
 */
export const taskSchemas = {
  get: z.object({
    clientId, taskId, view,
  }).strict(),
  wait: z.object({
    clientId, taskId,
    afterRevision: z.number().int().nonnegative(),
    waitMs: z.number().int().min(0).max(120_000).default(30_000),
    view,
  }).strict(),
  decide: z.object({
    clientId, taskId, decisionId, requestId, actionRef,
    input: z.string().min(1).max(2_000).optional(),
  }).strict(),
  cancel: z.object({
    clientId, taskId, requestId,
  }).strict(),
} as const;

export type TaskView = z.infer<typeof view>;

export function readTaskSummary(
  store: TaskKernelRepository, gateway: SemanticDecisionGateway,
  taskIdValue: string, clientIdValue: string, selectedView: TaskView = 'summary',
) {
  const full = store.getFullTask(taskIdValue, clientIdValue);
  const pending = full.timers.filter(timer => timer.status === 'pending')
    .map(timer => timer.dueAt).sort()[0] ?? null;
  const lastAck = full.attempts.filter(attempt => attempt.acknowledgedAt !== null)
    .map(attempt => attempt.acknowledgedAt!).sort().at(-1) ?? null;
  const result = full.results.at(-1) ?? null;
  const summary = {
    taskId: full.task.taskId,
    projectId: full.task.projectId,
    conversationSlotId: full.task.slotId,
    conversationRevision: full.task.slotRevision,
    revision: full.task.revision,
    state: full.task.state,
    cancelRequested: full.task.cancelRequested,
    submission: {
      attempted: full.attempts.some(attempt =>
        ['dispatched', 'uncertain', 'acknowledged'].includes(attempt.state)),
      acknowledged: full.attempts.some(attempt => attempt.state === 'acknowledged'),
    },
    lastExactProgressAt: lastAck,
    nextAutomaticActionAt: pending,
    decision: gateway.get(taskIdValue, clientIdValue),
    result: result && selectedView === 'result' ? {
      resultId: result.resultId,
      externalTurnId: result.externalTurnId,
      answerText: result.answerText,
      answerBytes: Buffer.byteLength(result.answerText, 'utf8'),
      answerSha256: createHash('sha256').update(result.answerText).digest('hex'),
      completesTask: result.completesTask,
    } : null,
    resultAvailable: result !== null,
  };
  if (selectedView !== 'evidence') return summary;
  return {
    ...summary,
    evidence: {
      attempts: full.attempts.map(attempt => ({
        attemptId: attempt.attemptId, kind: attempt.kind, state: attempt.state,
        externalTurnId: attempt.externalTurnId,
        dispatchedAt: attempt.dispatchedAt,
        acknowledgedAt: attempt.acknowledgedAt,
      })),
      results: full.results.map(item => ({
        resultId: item.resultId, externalTurnId: item.externalTurnId,
        completesTask: item.completesTask, observedAt: item.observedAt,
        answerBytes: Buffer.byteLength(item.answerText, 'utf8'),
        answerSha256: createHash('sha256').update(item.answerText).digest('hex'),
      })),
      timers: full.timers.map(timer => ({
        timerId: timer.timerId, kind: timer.kind, dueAt: timer.dueAt,
        status: timer.status,
      })),
    },
  };
}

export function registerTaskMethods(
  router: RpcRouter,
  input: { readonly repository: TaskKernelRepository;
    readonly gateway: SemanticDecisionGateway },
): void {
  const { repository, gateway } = input;

  router.register('task.get', taskSchemas.get, params =>
    readTaskSummary(repository, gateway, params.taskId, params.clientId, params.view));

  router.register('task.wait', taskSchemas.wait, async (params, context) => {
    await waitForTaskRevision(repository, {
      taskId: params.taskId, clientId: params.clientId,
      afterRevision: params.afterRevision, waitMs: params.waitMs,
      ...(context.signal ? { signal: context.signal } : {}),
    });
    return readTaskSummary(repository, gateway, params.taskId, params.clientId, params.view);
  });

  router.register('task.decide', taskSchemas.decide, async params => {
    return await gateway.decideCurrent({
      taskId: params.taskId, clientId: params.clientId,
      decisionId: params.decisionId, requestId: params.requestId,
      actionRef: params.actionRef,
      ...(params.input === undefined ? {} : { input: params.input }),
    });
  });

  router.register('task.cancel', taskSchemas.cancel, params => {
    const before = repository.getFullTask(params.taskId, params.clientId);
    if (!['completed', 'failed', 'canceled'].includes(before.task.state) &&
        !before.task.cancelRequested) {
      repository.requestCancel(params.taskId, params.clientId);
    }
    const current = repository.getFullTask(params.taskId, params.clientId);
    const externalAttempted = current.attempts.some(attempt =>
      ['dispatched', 'uncertain', 'acknowledged'].includes(attempt.state));
    if (!externalAttempted && current.task.cancelRequested && current.task.state !== 'canceled') {
      repository.confirmCancel(params.taskId, params.clientId);
    }
    const snapshot = readTaskSummary(repository, gateway, params.taskId, params.clientId);
    return {
      ...snapshot,
      cancelOutcome: snapshot.state === 'canceled'
        ? 'not_submitted'
        : snapshot.cancelRequested
          ? 'external_stop_unverified'
          : 'already_terminal',
    };
  });
}
