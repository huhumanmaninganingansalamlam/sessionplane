import path from 'node:path';
import { SessionPlaneDomainError } from '../domain/errors.ts';
import type { SessionSnapshot } from '../domain/session.ts';
import { ProviderSubmissionError, type ProviderName } from '../providers/provider-adapter.ts';
import type { ActorScheduler } from '../scheduler/actor-scheduler.ts';
import { OutboxRepository, type OutboxRecord } from '../storage/outbox-repository.ts';
import { hashCanonical, type ReceiptRepository } from '../storage/receipt-repository.ts';
import { SessionRepository } from '../storage/session-repository.ts';
import type { SessionPlaneDatabase } from '../storage/database.ts';
import type { ArtifactService } from './artifact-service.ts';
import type { ConversationCleanupService } from './conversation-cleanup-service.ts';
import type { SessionUiService } from './session-ui-service.ts';
import type { StopService } from './stop-service.ts';
import type { SubmissionService } from './submission-service.ts';
import type { TeamDirectory } from './team-directory.ts';

type Identity = { teamId: string; requestRef: string };
type Mutation = { teamId: string; requestId: string };
type RoleInput = Mutation & { roleRef: string };

export class TeamWorkflow {
  readonly #outbox: OutboxRepository;
  readonly #sessions: SessionRepository;
  readonly services: {
    database: SessionPlaneDatabase; directory: TeamDirectory; receipts: ReceiptRepository;
    submissions: SubmissionService; ui: SessionUiService; scheduler: ActorScheduler;
    artifacts: ArtifactService; stops: StopService; cleanup: ConversationCleanupService;
    enabledProviders: readonly ProviderName[];
    ensurePage: (sessionId: string, generation: number) => Promise<void>;
  };
  constructor(services: TeamWorkflow['services']) {
    this.services = services;
    this.#outbox = new OutboxRepository(services.database);
    this.#sessions = new SessionRepository(services.database.raw);
  }

  createTeam(input: { requestId: string; name?: string | undefined; objective?: string | undefined; provider: ProviderName }) {
    this.#provider(input.provider);
    const team = this.services.receipts.execute({
      clientId: 'sessionplane-mcp', requestId: input.requestId, method: 'workflow.team_create', payload: input,
      operation: () => {
        const team = this.services.directory.createTeam({ clientId: 'sessionplane-mcp', ...(input.name === undefined ? {} : { name: input.name }), ...(input.objective === undefined ? {} : { objective: input.objective }) });
        this.services.directory.createSession({ teamId: team.teamId, roleKey: team.primaryRoleKey, provider: input.provider });
        return team;
      },
    });
    return this.getTeam({ teamId: team.teamId });
  }

  async getTeam(input: { teamId: string; requestRef?: string | undefined; maxNodes?: number | undefined; history?: boolean | undefined; beforeRequestRef?: string | undefined }) {
    const team = this.services.directory.getTeam(input.teamId);
    const before = input.beforeRequestRef === undefined ? undefined : this.#request({ teamId: input.teamId, requestRef: input.beforeRequestRef });
    const history = input.history === true || before !== undefined
      ? this.#outbox.historyForTeam(team.teamId, before)
      : { requests: this.#outbox.listForTeam(team.teamId), nextRequestRef: null };
    return {
      ...team,
      capabilities: { uploadsEnabled: this.services.submissions.uploadsEnabled, downloadsEnabled: true },
      roles: team.roles.map((r) => ({ ...r, roleRef: r.currentSessionId === null ? null : `${r.currentSessionId}:${r.generation}`,
        conversationUsage: this.#conversationUsage(r.currentSessionId) })),
      ...history,
      ...(input.requestRef === undefined ? {} : { request: await this.#observe(this.#request({ teamId: input.teamId, requestRef: input.requestRef }), input.maxNodes, true) }),
    };
  }

  async deleteTeam(input: Mutation) {
    return await this.services.cleanup.deleteTeam({ ...input, clientId: `team:${input.teamId}` }, this.services.stops);
  }

  createRole(input: Mutation & { roleKey: string; roleType: 'expert' | 'reviewer' | 'custom'; provider: ProviderName; displayName?: string | undefined }) {
    this.#provider(input.provider);
    this.#mutate(input, 'role_create', () => {
      this.services.directory.createRole({ teamId: input.teamId, roleKey: input.roleKey, roleType: input.roleType, ...(input.displayName === undefined ? {} : { displayName: input.displayName }) });
      this.services.directory.createSession(input);
      return true;
    });
    return this.getTeam(input);
  }

  retireRole(input: RoleInput) {
    this.#mutate(input, 'role_retire', () => {
      const session = this.#role(input);
      return this.services.directory.retireRole(input.teamId, session.roleKey);
    });
    return this.getTeam(input);
  }

  async replaceSession(input: Mutation & { roleRef?: string | undefined; roleKey?: string | undefined; provider?: ProviderName | undefined; preserveConversation?: true | undefined }) {
    if ((input.roleRef === undefined) === (input.roleKey === undefined) || (input.roleRef !== undefined && input.provider !== undefined)) {
      throw new SessionPlaneDomainError('input.invalid', 'Use either a fresh roleRef, or an empty roleKey with an optional provider');
    }
    const identity = input.roleRef === undefined ? null : parseRoleRef(input.roleRef);
    const session = identity === null ? null : this.services.directory.getSession(identity[0]);
    if (session !== null && session.teamId !== input.teamId) {
      throw new SessionPlaneDomainError('input.invalid', 'Role reference belongs to another team');
    }
    const replacement = await this.services.cleanup.replace({ clientId: `team:${input.teamId}`, requestId: input.requestId,
      method: 'workflow.session_replace', payload: input, teamId: input.teamId,
      roleKey: session?.roleKey ?? input.roleKey!, provider: session?.provider ?? input.provider ?? 'chatgpt',
      expectedSessionId: session?.sessionId ?? null,
      ...(identity === null ? {} : { expectedGeneration: identity[1] }),
      ...(input.preserveConversation === true ? { preserveConversation: true as const } : {}),
    });
    return { ...await this.getTeam(input), replacement: {
      requestId: input.requestId, sessionId: replacement.sessionId, cleanup: replacement.cleanup,
    } };
  }

  async send(input: RoleInput & { prompt: string; model?: string | undefined; effort?: string | undefined; files?: string[] | undefined; thinkingFailureRecovery?: true | undefined; sessionDeadlineSec: number }) {
    this.services.directory.getTeam(input.teamId);
    const clientId = `team:${input.teamId}`;
    const existing = this.#outbox.getByRequest(clientId, input.requestId);
    const [sessionId, generation] = parseRoleRef(input.roleRef);
    if (existing === null) this.#role(input);
    else if (existing.teamId !== input.teamId || existing.sessionId !== sessionId || existing.generation !== generation + 1) {
      throw new SessionPlaneDomainError('input.idempotency-conflict', 'Request ID belongs to another role revision');
    }
    try {
      await this.services.submissions.send({
        clientId, requestId: input.requestId, sessionId,
        expectedGeneration: generation, prompt: input.prompt, sessionDeadlineSec: input.sessionDeadlineSec,
        ...(input.model === undefined ? {} : { model: input.model }),
        ...(input.effort === undefined ? {} : { effort: input.effort }),
        ...(input.files === undefined ? {} : { files: input.files }),
        ...(input.thinkingFailureRecovery === undefined ? {} : { thinkingFailureRecovery: input.thinkingFailureRecovery }),
      });
    } catch (error) {
      if (!(error instanceof SessionPlaneDomainError)) throw error;
      if (error.errorCode !== 'provider.preparation-required') {
        const accepted = this.#outbox.getByRequest(clientId, input.requestId);
        if (accepted === null) throw error;
        throw new SessionPlaneDomainError(error.errorCode, error.message,
          { ...(error.details !== null && typeof error.details === 'object' ? error.details : { cause: error.details }), requestRef: accepted.outboxId, teamId: input.teamId });
      }
    }
    const request = this.#outbox.getByRequest(clientId, input.requestId);
    if (request === null) throw new SessionPlaneDomainError('internal.invariant-violation', 'Accepted request has no outbox identity');
    if (needsDecision(this.services.directory.getSession(request.sessionId)) && this.services.ui.configurationCatalog === null) {
      await this.services.ui.discover({ ...ownerOf(request), decisionId: `catalog:${request.outboxId}` });
    }
    return await this.#observe(request);
  }

  async decide(input: Identity & ({ requestId: string; decision: 'discover' } | { requestId: string; decision: 'configure'; configurationId: string } | { requestId: string; decision: 'acknowledge'; messageId: string; evidenceHash: string } | { requestId: string; decision: 'refresh' } | { requestId: string; decision: 'focus' } | { requestId: string; decision: 'reconcile_failure' } | { requestId: string; decision: 'choose' | 'reveal'; purpose: 'model' | 'effort' | 'composer' | 'submit'; snapshotId: string; ref: string; value?: number | undefined })) {
    const request = this.#request(input);
    const owner = ownerOf(request);
    if (input.decision === 'focus') {
      return await this.services.scheduler.actorFor(request.sessionId).enqueue(async () => {
        const method = 'workflow.focus';
        const requestHash = hashCanonical({ method, payload: input });
        const receipt = { clientId: request.clientId, requestId: input.requestId, method, requestHash };
        const prior = this.services.receipts.get(receipt.clientId, receipt.requestId);
        if (prior !== null) {
          if (prior.method !== method || prior.requestHash !== requestHash) {
            throw new SessionPlaneDomainError('input.idempotency-conflict', 'Focus request identity was reused with different arguments');
          }
          if (prior.status === 'complete') return JSON.parse(prior.resultJson) as Record<string, unknown>;
        }
        const session = this.#role({ teamId: input.teamId, roleRef: `${request.sessionId}:${request.generation}` });
        this.services.receipts.record({ ...receipt, status: 'attempted', result: { requestRef: input.requestRef } });
        const page = await this.services.ui.focus(session);
        const result = { requestOk: true, activated: true, requestRef: input.requestRef,
          sessionId: session.sessionId, generation: session.generation, ...page };
        this.services.receipts.record({ ...receipt, status: 'complete', result });
        return result;
      });
    }
    if (input.decision === 'reconcile_failure') {
      const reconciliation = await this.services.ui.reconcileFailure({ ...owner, decisionId: input.requestId });
      return { ...await this.#observe(request), reconciliation };
    }
    if (input.decision === 'discover') {
      await this.services.ui.inspect(owner);
      await this.services.ui.discover({ ...owner, decisionId: input.requestId });
      return await this.#observe(this.#request(input));
    }
    if (input.decision === 'configure') {
      await this.services.ui.configure({ ...owner, decisionId: input.requestId, configurationId: input.configurationId });
      return await this.#observe(this.#request(input));
    }
    if (input.decision === 'acknowledge') {
      await this.services.submissions.acknowledgeSubmission({ ...owner, decisionId: input.requestId, messageId: input.messageId, evidenceHash: input.evidenceHash });
      return await this.#observe(this.#request(input));
    }
    if (input.decision === 'refresh') {
      const current = this.services.directory.getSession(request.sessionId);
      const prior = this.services.receipts.get(request.clientId, input.requestId);
      const recovery = this.#lostSubmission(current);
      if (prior === null && current.generation === request.generation && recovery !== null) {
        throw new SessionPlaneDomainError('session.recovery-unavailable', recovery.message, {
          requestRef: request.outboxId, roleRef: roleRef(current), ...recovery,
        });
      }
      if (current.conversationId !== null && prior === null) {
        await this.services.ensurePage(request.sessionId, request.generation);
      }
      await this.services.ui.refresh({ ...owner, decisionId: input.requestId });
      return await this.#observe(this.#request(input), undefined, true);
    }
    await this.services.ui.decide({ ...owner, decisionId: input.requestId, decision: input.decision,
      purpose: input.purpose, snapshotId: input.snapshotId, ref: input.ref,
      ...(input.value === undefined ? {} : { value: input.value }),
    });
    if (input.decision === 'choose' && Number(input.ref.slice(2)) <= 5000) {
      try { await this.services.ui.resume(owner); }
      catch (error) {
        if (!(error instanceof SessionPlaneDomainError) || error.errorCode !== 'provider.preparation-required') throw error;
      }
    }
    return await this.#observe(this.#request(input));
  }

  async wait(input: { teamId: string; requestRefs: string[]; waitMs: number; outputDir?: string | undefined }) {
    const requestRefs = [...new Set(input.requestRefs)];
    // Actor waits share one deadline. File capture remains sequential to bound network and memory use.
    const observed = await Promise.all(requestRefs.map(async (requestRef) => {
      try {
        const request = this.#request({ teamId: input.teamId, requestRef });
        const current = this.services.directory.getSession(request.sessionId);
        let waitExpired = false;
        if (current.generation === request.generation && !needsDecision(current) && this.#lostSubmission(current) === null) {
          const waited = await this.services.scheduler.waitSession(request.sessionId, { expectedGeneration: request.generation, waitMs: input.waitMs });
          waitExpired = waited.waitExpired;
        }
        return { request, result: { ...await this.#observe(request), waitExpired } };
      } catch (error) { return { request: null, result: failure(error, requestRef) }; }
    }));
    const results = [];
    for (const { request, result } of observed) {
      if (request === null) { results.push(result); continue; }
      let files: Record<string, unknown> | undefined;
      const current = this.services.directory.getSession(request.sessionId);
      if ((current.generation === request.generation && current.sessionState === 'complete') ||
          (current.generation !== request.generation && this.#sessions.getGenerationResult(request.sessionId, request.generation)?.responseMessageId != null)) {
        try {
          files = await this.services.artifacts.capture({ sessionId: request.sessionId, generation: request.generation });
        } catch (error) { files = failure(error, request.outboxId); }
      }
      if (input.outputDir !== undefined && files !== undefined) {
        try {
          const artifacts = this.services.artifacts.list({ sessionId: request.sessionId, generation: request.generation }).artifacts;
          const outputDir = input.outputDir;
          files = { ...files, exports: artifacts.filter((a) => a.artifactState === 'downloaded').map((a) =>
            this.services.artifacts.export({ artifactId: a.artifactId, outputPath: path.join(outputDir, request.outboxId, a.artifactId, path.basename(a.name)) })) };
        } catch (error) { files = { ...files, exportError: failure(error, request.outboxId) }; }
      }
      results.push({ ...result, ...(files === undefined ? {} : { files }) });
    }
    return { requestOk: true, teamId: input.teamId, results };
  }

  async stop(input: Identity & { requestId: string }) {
    const request = this.#request(input);
    const current = this.services.directory.getSession(request.sessionId);
    const previous = this.services.receipts.get(request.clientId, input.requestId);
    if (previous?.method === 'session.preparation.decide' || (needsDecision(current) && current.generation === request.generation)) {
      await this.services.ui.decide({ ...ownerOf(request), decisionId: input.requestId, decision: 'cancel' });
    } else {
      await this.services.stops.stop({ clientId: request.clientId, requestId: input.requestId,
        sessionId: request.sessionId, expectedGeneration: request.generation });
    }
    return await this.#observe(request);
  }

  async deleteSession(input: Identity & { requestId: string; outputsRetrieved: true }) {
    const request = this.#request(input);
    const session = this.services.directory.getSession(request.sessionId);
    if (session.conversationId === null) throw new SessionPlaneDomainError('session.cleanup-not-ready', 'No bound provider conversation exists');
    return await this.services.cleanup.delete({ ...ownerOf(request), requestId: input.requestId,
      conversationId: session.conversationId, outputsRetrieved: input.outputsRetrieved });
  }

  #request(input: Identity) {
    const request = this.#outbox.getById(input.requestRef);
    if (request === null || request.teamId !== input.teamId) throw new SessionPlaneDomainError('input.invalid', 'Request reference does not belong to this team');
    return request;
  }

  #role(input: { teamId: string; roleRef: string }) {
    const [sessionId, generation] = parseRoleRef(input.roleRef);
    const session = this.services.directory.getSession(sessionId);
    if (session.teamId !== input.teamId || session.generation !== generation ||
        this.services.directory.getCurrentSession(input.teamId, session.roleKey).sessionId !== sessionId) {
      throw new SessionPlaneDomainError('session.generation-superseded', 'Role reference is stale; refresh the team');
    }
    return session;
  }

  #mutate<Result>(input: Mutation, method: string, operation: () => Result) {
    this.services.directory.getTeam(input.teamId);
    return this.services.receipts.execute({ clientId: `team:${input.teamId}`, requestId: input.requestId,
      method: 'workflow.' + method, payload: input, operation });
  }

  #provider(provider: ProviderName) {
    if (!this.services.enabledProviders.includes(provider)) throw new SessionPlaneDomainError('provider.disabled', 'Provider is disabled: ' + provider);
  }

  #lostSubmission(snapshot: SessionSnapshot) {
    if (!this.services.ui.isSubmissionPageLost(snapshot)) return null;
    return {
      status: 'recovery_required',
      recovery: { state: 'unavailable', reason: 'page-lost-without-conversation', nextAction: 'sessionplane_session_replace' },
      message: 'Submission acknowledgement is unknown and neither an owned page nor a durable conversation ID remains. Waiting or refreshing cannot recover this request. promptSubmitted records an attempt, not confirmed provider acceptance. Explicitly decide whether to replace the role session and continue with new work, accounting for possible duplicate processing. Replacement does not resend or delete this request.',
    };
  }

  async #observe(request: OutboxRecord, maxNodes?: number, inspectCurrent = false): Promise<Record<string, unknown>> {
    const result = await this.#observeRequest(request, maxNodes, inspectCurrent);
    const payload = JSON.parse(request.payloadJson);
    const optedIn = payload.thinkingFailureRecovery === true;
    const rootRequestRef = payload.failureContinuation?.rootRequestRef ?? request.outboxId;
    const paused = optedIn ? this.services.receipts.get(request.clientId, `thinking-failure-paused:${rootRequestRef}`) : null;
    const successor = optedIn ? this.#outbox.getByRequest(request.clientId, `thinking-failure-continue:${request.outboxId}`) : null;
    let tail = request;
    if (optedIn) {
      for (let child = successor; child !== null; child = this.#outbox.getByRequest(request.clientId, `thinking-failure-continue:${tail.outboxId}`)) tail = child;
    }
    const current = this.#sessions.getSnapshot(request.sessionId)!;
    const tailResult = this.#sessions.getGenerationResult(tail.sessionId, tail.generation);
    const complete = current.generation === tail.generation ? current.sessionState === 'complete'
      : tailResult?.completedAt != null && tailResult.errorCode === null && tailResult.responseMessageId !== null;
    const stopped = current.generation > tail.generation ||
      (current.generation === tail.generation && current.terminal && !complete && current.reason !== 'thinking-failed-reconciled');
    return { ...result, ...(optedIn ? { thinkingFailureRecovery: {
      enabled: paused === null && !complete && !stopped, sender: paused || complete || stopped ? 'coordinator' : 'core',
      ...(paused ? JSON.parse(paused.resultJson) : { state: complete ? 'complete' : stopped ? 'stopped' : 'observing' }),
      successorRequestRef: successor?.outboxId ?? null } } : {}), conversationUsage: this.#conversationUsage(request.sessionId),
      ...(this.services.stops.hasUnconfirmedStop(request.sessionId, request.generation)
        ? { stopOutcome: { state: 'unknown', automaticRetry: false } } : {}) };
  }

  #conversationUsage(sessionId: string | null) {
    const confirmedTurnCount = sessionId === null ? 0 : this.#sessions.confirmedConversationTurns(sessionId);
    return { confirmedTurnCount, handoffRecommended: confirmedTurnCount >= 10,
      ...(confirmedTurnCount < 10 ? {} : {
        recommendation: 'This conversation has at least 10 confirmed user turns. After resolving the current request and retrieving its answer/files, write a handoff with the objective, decisions, evidence/artifact references, unresolved work, next step, and requested model/effort. For a nondeleting continuation, use sessionplane_role_create with a unique custom role in the same team. sessionplane_session_replace attempts permanent deletion of the old conversation and requires specific deletion confirmation; this turn-count recommendation is not confirmation. Do not copy the entire transcript or replay unresolved submissions.',
      }) };
  }

  async #observeRequest(request: OutboxRecord, maxNodes?: number, inspectCurrent = false): Promise<Record<string, unknown>> {
    let snapshot = this.services.directory.getSession(request.sessionId);
    const failureMessage = request.submissionState === 'failed_pre_submit'
      ? JSON.parse(request.resultJson ?? '{}').message as string | undefined : undefined;
    if (snapshot.generation !== request.generation) {
      return { requestOk: true, requestRef: request.outboxId, sessionId: request.sessionId, generation: request.generation,
        ...this.#sessions.getGenerationResult(request.sessionId, request.generation), historical: true, terminal: true, waitExpired: false,
        ...(failureMessage === undefined ? {} : { message: failureMessage }) };
    }
    const recovery = this.#lostSubmission(snapshot);
    if (recovery !== null) return { ...snapshot, requestRef: request.outboxId, roleRef: roleRef(snapshot), ...recovery };
    if (needsDecision(snapshot)) {
      const { configurationCatalog, ...evidence } = await this.services.ui.inspect({ ...ownerOf(request), ...(maxNodes === undefined ? {} : { maxNodes }) });
      snapshot = this.services.directory.getSession(request.sessionId);
      const stored = this.#outbox.requireById(request.outboxId);
      const payload = JSON.parse(stored.payloadJson) as Record<string, unknown>;
      const preparation = JSON.parse(stored.resultJson ?? '{}') as Record<string, unknown>;
      return { ...snapshot, status: 'needs_decision', requestRef: request.outboxId, evidence,
        configurationCatalog,
        requested: { model: payload.model, effort: payload.effort, surface: payload.surface }, choices: preparation.choices,
        message: evidence.preparationAvailability.available ? preparation.message
          : 'The exact provider page has no usable composer. This request remains prepared and was not submitted. Read the same request after the provider page becomes usable; do not treat Retry or another ordinary button as submit.' };
    }
    if ((!snapshot.terminal && snapshot.submissionState === 'submission_unknown' && snapshot.provider === 'chatgpt') ||
        (snapshot.provider === 'chatgpt' && !snapshot.terminal && snapshot.submissionState === 'submitted' &&
          (inspectCurrent || snapshot.reason === 'provider-actionable-alert'))) {
      try {
        if (snapshot.conversationId !== null) await this.services.ensurePage(snapshot.sessionId, snapshot.generation);
        const inspected = await this.services.ui.inspectSubmission({ ...ownerOf(request), ...(maxNodes === undefined ? {} : { maxNodes }) });
        return { ...inspected.snapshot, requestRef: request.outboxId, roleRef: roleRef(inspected.snapshot),
          ...((inspected.evidence?.submissionCandidates?.length ?? 0) > 0 ? { status: 'needs_decision' } : {}),
          evidence: inspected.evidence, requested: inspected.requested };
      } catch (error) {
        if (!(error instanceof SessionPlaneDomainError) ||
            (!error.errorCode.startsWith('browser.') && error.errorCode !== 'session.page-identity-unverified')) throw error;
        return { ...snapshot, requestRef: request.outboxId, roleRef: roleRef(snapshot), evidence: null,
          inspectionError: { errorCode: error.errorCode, message: error.message } };
      }
    }
    if (!snapshot.terminal && snapshot.submissionState === 'submission_unknown') {
      snapshot = await this.services.submissions.recoverAcknowledgement(snapshot);
    }
    return { ...snapshot, requestRef: request.outboxId, roleRef: roleRef(snapshot),
      ...(failureMessage === undefined ? {} : { message: failureMessage }) };
  }
}

function roleRef(snapshot: SessionSnapshot) { return `${snapshot.sessionId}:${snapshot.generation}`; }
function parseRoleRef(value: string): [string, number] {
  const match = /^([0-9a-f-]{36}):(\d+)$/.exec(value);
  if (match === null || !Number.isSafeInteger(Number(match[2]))) throw new SessionPlaneDomainError('input.invalid', 'Invalid role reference');
  return [match[1]!, Number(match[2])];
}
function ownerOf(request: OutboxRecord) {
  return { clientId: request.clientId, requestId: request.requestId, sessionId: request.sessionId, generation: request.generation };
}
function needsDecision(snapshot: SessionSnapshot) { return !snapshot.terminal && snapshot.submissionState === 'prepared' && snapshot.errorCode === 'provider.preparation-required'; }
function failure(error: unknown, requestRef: string) {
  if (!(error instanceof SessionPlaneDomainError) && !(error instanceof ProviderSubmissionError)) throw error;
  return { requestOk: false, requestRef, errorCode: error.errorCode, message: error.message, ...(error instanceof SessionPlaneDomainError ? { details: error.details } : {}) };
}
