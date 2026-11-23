import type { DecisionServices, ResumeDecisionInput } from './decision-services.ts';

/** Only invoked after the exact one-shot Decision effect is durably recorded.
 * A callback failure leaves the same Task eligible for the Core scan; it never
 * retries the provider action or invents another authorization.
 */
export async function resumeTaskAfterVerifiedDecision(
  services: DecisionServices,
  input: ResumeDecisionInput & { decisionId: string; recoveryReason: string },
): Promise<void> {
  if (!services.onTaskResumed) return;
  try {
    await services.onTaskResumed({
      taskId: input.taskId, clientId: input.clientId,
      attemptId: input.attemptId, mode: input.mode,
    });
  } catch {
    try {
      services.repository.tasks.recordObservationDeferred(
        input.taskId, input.clientId,
        'decision:' + input.decisionId + ':' + input.recoveryReason,
      );
    } catch {
      // The already-committed Decision receipt remains authoritative.
      return;
    }
  }
}
