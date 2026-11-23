import type { ContinuationServices, ContinuationReviewReport } from './continuation-services.ts';
import { CONTINUATION_TIMER_KIND, parseContinuationPolicy, parsePublicContinuationPolicy } from './continuation-policy.ts';
import { activateContinuation, executeDueContinuationTimer } from './continuation-effects.ts';
import { upcomingDueRead, reconcileOwner, rearmReview, scheduleFreshFinalReview } from './continuation-timers.ts';

/** A failed observation receipt is not evidence of a failed or safe POST.
 * The next Core scan recovers the same Task; no caller owns another send loop.
 */
function recordDeferred(
  services: ContinuationServices, taskId: string, clientId: string, reason: string,
): boolean {
  try {
    services.repository.tasks.recordObservationDeferred(taskId, clientId, reason);
    return true;
  } catch {
    return false;
  }
}

async function dispatchPublicInitials(services: ContinuationServices): Promise<void> {
  for (const planned of services.repository.scans.scanPendingRootAttempts(8)) {
    try {
      if (planned.modelIntent !== null) {
        const verified = await services.inspectModelIntent?.({
          taskId: planned.taskId, clientId: planned.clientId,
          attemptId: planned.attemptId, modelIntent: planned.modelIntent,
        });
        if (verified !== true) {
          recordDeferred(services, planned.taskId, planned.clientId,
            'public-root-initial-model-intent-unverified');
          continue;
        }
      }
      await services.kernel.dispatch(planned.taskId, planned.clientId, planned.attemptId);
    } catch {
      recordDeferred(services, planned.taskId, planned.clientId,
        'public-root-initial-exact-preparation-unavailable');
    }
  }
  for (const planned of services.repository.scans.scanPendingInitials(8)) {
    try {
      await services.bindInitialAttempt?.(planned);
      if (planned.modelIntent !== null) {
        const verified = await services.inspectModelIntent?.({
          taskId: planned.taskId, clientId: planned.clientId,
          attemptId: planned.attemptId, modelIntent: planned.modelIntent,
        });
        if (verified !== true) {
          recordDeferred(services, planned.taskId, planned.clientId,
            'public-initial-model-intent-unverified');
          continue;
        }
      }
      await services.kernel.dispatch(planned.taskId, planned.clientId, planned.attemptId);
    } catch {
      recordDeferred(services, planned.taskId, planned.clientId,
        'public-initial-exact-preparation-unavailable');
    }
  }
}

async function reconcileExactAcknowledgements(services: ContinuationServices): Promise<void> {
  // Root POST evidence is read-only until a canonical ACK proves its conversation.
  for (const pending of services.repository.scans.scanPendingRootReconciliations(16)) {
    try {
      let full = services.repository.tasks.readTaskAggregate(pending.taskId, pending.clientId);
      let attempt = full.attempts.find(row => row.attemptId === pending.attemptId);
      let root = services.repository.attempts.getRootDispatchEvidence(pending);
      if (!attempt || !root) continue;
      if (root.canonicalConversationId === null &&
          (attempt.state === 'dispatched' || attempt.state === 'uncertain')) {
        await services.kernel.recoverAck(pending.taskId, pending.clientId, pending.attemptId);
        full = services.repository.tasks.readTaskAggregate(pending.taskId, pending.clientId);
        attempt = full.attempts.find(row => row.attemptId === pending.attemptId);
        root = services.repository.attempts.getRootDispatchEvidence(pending);
      }
      if (attempt?.state === 'acknowledged' && root?.canonicalConversationId !== null) {
        await services.bindRootAttempt?.(pending);
      }
    } catch {
      recordDeferred(services, pending.taskId, pending.clientId,
        'public-root-canonical-reconciliation-unavailable');
    }
  }
  for (const pending of services.repository.scans.scanPendingAcknowledgements(8)) {
    try {
      await services.kernel.recoverAck(pending.taskId, pending.clientId, pending.attemptId);
    } catch {
      recordDeferred(services, pending.taskId, pending.clientId,
        'public-exact-ack-reconciliation-unavailable');
    }
  }
}

export function scanContinuationOwners(services: ContinuationServices) {
  return services.repository.scans.scanApprovedContinuationOwners();
}

export async function restoreContinuationSchedules(
  services: ContinuationServices, now: string,
): Promise<void> {
  // Public approval is admitted before send; only a persisted exact ACK
  // arms the first 20-minute Core timer.
  for (const candidate of services.repository.scans.scanApprovedContinuationPolicies()) {
    const approved = parsePublicContinuationPolicy(candidate.policyJson);
    if (!approved) continue;
    try {
      const full = services.repository.tasks.readTaskAggregate(candidate.taskId, candidate.clientId);
      const latest = full.attempts.filter(row => row.kind !== 'stop').at(-1);
      if (latest?.state !== 'acknowledged') continue;
      activateContinuation(services, {
        taskId: candidate.taskId, clientId: candidate.clientId,
        sourceAttemptId: latest.attemptId, approvalRef: approved.approvalRef,
        message: approved.message,
        ...(approved.agentReviewAfterMs === undefined ? {} : {
          agentReviewAfterMs: approved.agentReviewAfterMs,
        }),
      });
    } catch {
      recordDeferred(services, candidate.taskId, candidate.clientId,
        'managed-continuation-policy-activation-deferred');
    }
  }
  const owners = scanContinuationOwners(services);
  for (const owner of owners) {
    try { reconcileOwner(services, owner.taskId, owner.clientId, now); }
    catch {
      recordDeferred(services, owner.taskId, owner.clientId,
        'managed-continuation-owner-reconciliation-deferred');
    }
  }
  // Reserve the upcoming exact final read without licensing a POST.
  for (const owner of owners) {
    const reservation = upcomingDueRead(services, owner.taskId, owner.clientId, now);
    if (reservation === null) continue;
    try {
      await services.kernel.reserveFinalRead({
        taskId: owner.taskId, clientId: owner.clientId,
        attemptId: reservation.attemptId, notBefore: reservation.dueAt,
      });
    } catch {
      // Reservation is advisory. The Core will still reread exact FINAL at due.
      continue;
    }
  }
}

async function claimAndHandleDue(services: ContinuationServices, now: string) {
  const claimed = services.repository.timers.claimDueTaskTimers(now, 50, CONTINUATION_TIMER_KIND);
  let dispatchesAttempted = 0;
  let deferred = 0;
  for (const timer of claimed) {
    try {
      const status = await executeDueContinuationTimer(services, timer, now);
      if (status === 'attempted') dispatchesAttempted++;
      else if (status === 'deferred') deferred++;
    } catch {
      deferred++;
      const clientId = services.repository.tasks.findDispatchClientId(timer.taskId);
      if (!clientId) continue;
      recordDeferred(services, timer.taskId, clientId,
        'managed-continuation-review-unverified');
      const policy = parseContinuationPolicy(timer.contextJson);
      if (!policy) continue;
      try { rearmReview(services, timer, clientId, policy, now); }
      catch { continue; }
    }
  }
  return { timersClaimed: claimed.length, dispatchesAttempted, deferred };
}

async function scanExactFinalsAndPrepare(
  services: ContinuationServices, now: string,
): Promise<number> {
  for (const pending of services.repository.scans.scanPendingFinals(8)) {
    try {
      const observed = await services.kernel.probeFinal({
        taskId: pending.taskId, clientId: pending.clientId,
        attemptId: pending.attemptId, resultId: 'public-final:' + pending.attemptId,
        completeTask: true,
      });
      if (observed.kind === 'pending' &&
          (observed.reason === 'backend-assistant-missing' ||
           observed.reason === 'backend-assistant-not-final')) {
        scheduleFreshFinalReview(services, pending.taskId, pending.clientId,
          pending.attemptId, now);
      }
    } catch {
      recordDeferred(services, pending.taskId, pending.clientId,
        'public-exact-final-observation-unavailable');
    }
  }
  if (services.preparePublicTask) {
    try { await services.preparePublicTask(); }
    catch { return 1; }
  }
  return 0;
}

export async function runContinuationTick(
  services: ContinuationServices,
): Promise<ContinuationReviewReport> {
  const now = services.now().toISOString();
  await dispatchPublicInitials(services);
  await reconcileExactAcknowledgements(services);
  await restoreContinuationSchedules(services, now);
  const due = await claimAndHandleDue(services, now);
  const deferredPrepares = await scanExactFinalsAndPrepare(services, now);
  return { ...due, deferred: due.deferred + deferredPrepares };
}
