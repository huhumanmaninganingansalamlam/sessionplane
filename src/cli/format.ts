import { RpcClientError } from './client.ts';
import { BrowserOwnerError } from '../browser/browser-owner.ts';

export interface CliIo {
  readonly stdin: NodeJS.ReadableStream;
  readonly stdout: NodeJS.WritableStream;
  readonly stderr: NodeJS.WritableStream;
}

export interface CliErrorShape {
  readonly requestOk: false;
  readonly errorCode: string;
  readonly message: string;
  readonly details?: unknown;
}

export function writeCliResult(io: CliIo, json: boolean, result: unknown): void {
  io.stdout.write(
    json ? `${JSON.stringify(result)}\n` : `${humanResult(result)}\n`,
  );
}

export function writeCliError(io: CliIo, json: boolean, error: unknown): CliErrorShape {
  const shape = normalizeCliError(error);
  io.stderr.write(
    json
      ? `${JSON.stringify(shape)}\n`
      : `Failed: ${shape.message}\n${recoveryAdvice(shape.errorCode)}\nError: ${shape.errorCode}${
          isRecord(shape.details) && shape.details.pageCleanup !== undefined
            ? `\n${cleanupSummary(shape.details)}` : ''
        }${isRecord(shape.details) && typeof shape.details.retryAfterMs === 'number' ? `\nRetry-After: ${shape.details.retryAfterMs} ms; do not bypass this cooldown.` : ''}${
          isRecord(shape.details) && typeof shape.details.teamId === 'string' && typeof shape.details.requestRef === 'string'
            ? `\nInspect: sessplane request show ${shape.details.teamId} ${shape.details.requestRef}` : ''
        }\n`,
  );
  return shape;
}

export function normalizeCliError(error: unknown): CliErrorShape {
  if (error instanceof BrowserOwnerError) {
    return { requestOk: false, errorCode: error.errorCode, message: error.message };
  }
  if (error instanceof RpcClientError) {
    const data = isRecord(error.data) ? error.data : {};
    return {
      requestOk: false,
      errorCode:
        typeof data.errorCode === 'string'
          ? data.errorCode
          : 'internal.invariant-violation',
      message: error.message,
      ...(data.details === undefined ? {} : { details: data.details }),
    };
  }
  return {
    requestOk: false,
    errorCode: 'input.invalid',
    message: error instanceof Error ? error.message : String(error),
  };
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function recoveryAdvice(code: string): string {
  if (code === 'session.submission-unknown') return 'Delivery is unconfirmed. Inspect the same request; do not send it again.';
  if (code.startsWith('core.')) return 'Check sessplane health. Recover the same request after service recovery; do not resend.';
  if (code === 'provider.preparation-required') return 'The request is not sent. Use request show to inspect its preparation choices.';
  if (code === 'provider.unavailable') return 'Provider access failed. Keep the request and respect Retry-After before another observation.';
  return 'Inspect the same request before retrying. Use --json for diagnostic details.';
}

function records(value: unknown): Readonly<Record<string, unknown>>[] {
  return Array.isArray(value) ? value.filter(isRecord) : [];
}

function cleanupSummary(result: Readonly<Record<string, unknown>>): string {
  const rows = Array.isArray(result.sessions) ? records(result.sessions) : [result];
  const deletionConfirmed = (r: Readonly<Record<string, unknown>>) => r.providerDeleted === true ||
    r.deleted === true && !Array.isArray(r.sessions) || r.outcome === 'confirmed';
  const confirmed = rows.filter(deletionConfirmed).length;
  const failed = rows.filter(r => !deletionConfirmed(r) && (r.providerError || r.errorCode)).length;
  const pages = rows.map(r => isRecord(r.pageCleanup) ? r.pageCleanup : r);
  const closed = pages.reduce((n, r) => n + (typeof r.closedPages === 'number' ? r.closedPages : 0), 0);
  const errors = pages.reduce((n, r) => n + (Array.isArray(r.pageErrors) ? r.pageErrors.length : 0), 0);
  const stopErrors = rows.filter(r => r.stopError).length;
  return `Chats: ${confirmed} deletion confirmed; ${failed} failed; ${rows.length - confirmed - failed} unconfirmed.\nTabs: ${closed} closed by this operation; ${errors} cleanup errors. Stop errors: ${stopErrors}.\nZero closed tabs does not prove that old tabs are absent.`;
}

function humanResult(value: unknown): string {
  if (!isRecord(value)) return JSON.stringify(value, null, 2) ?? '';
  const r = isRecord(value.request) ? { ...value.request, teamId: value.teamId ?? value.request.teamId } : value;
  if (isRecord(r.replacement)) return `Replacement completed; no prompt was resent.\n${humanResult(r.replacement)}\n${humanResult({ ...r, replacement: undefined })}`;
  if (r.deleted !== undefined || r.pageCleanup !== undefined) {
    return `${Array.isArray(r.sessions) ? 'Team' : 'Conversation'}: ${r.deleted === true ? 'deleted' : 'deletion not confirmed'}.\n${cleanupSummary(r)}`;
  }
  if (isRecord(r.cleanup)) {
    const c = r.cleanup;
    const next = r.submissionState === null ? humanResult({ ...r, cleanup: undefined }) : `Session: ${String(r.sessionId ?? '')}`;
    return `Session ready; this does not resend an old request.\n${c.predecessorSessionId === null ? 'No previous session to clean up.' : `Previous chat: ${String(c.outcome ?? 'unconfirmed')}.\n${cleanupSummary(c)}`}\n${next}`;
  }
  if (Array.isArray(r.results)) return records(r.results).map(row => humanResult({ teamId: r.teamId, ...row })).join('\n\n');
  if (r.requestOk === false && typeof r.errorCode === 'string') return `Failed: ${String(r.message ?? r.errorCode)}\n${recoveryAdvice(r.errorCode)}\nError: ${r.errorCode}${typeof r.teamId === 'string' && typeof r.requestRef === 'string' ? `\nInspect: sessplane request show ${r.teamId} ${r.requestRef}` : ''}`;
  if (r.submissionState === null && (r.sessionState === 'created' || r.sessionState === 'ready')) return `${String(r.roleKey ?? 'Session')}: ready for a new request. Nothing has been submitted.\nStart: sessplane request send ${String(r.teamId)} ${String(r.sessionId)}:${String(r.generation)} --prompt-file FILE`;
  if (r.submissionState !== undefined || r.requestRef !== undefined && r.terminal !== undefined) {
    const state = r.submissionState;
    const answer = typeof r.answerText === 'string' ? r.answerText : null;
    const input = state === 'prepared' || state === 'composer_filled';
    const unknown = state === 'submission_unknown' || state === 'submit_attempted';
    const collected = !unknown && (answer !== null || isRecord(r.answer)) && (typeof r.completedAt === 'string' ||
      r.sessionState === 'complete' || r.providerState === 'complete' && typeof r.responseMessageId === 'string');
    const delivery = unknown ? 'Unconfirmed — do not resend' : state === 'submitted' ? 'Confirmed' : 'Not confirmed sent';
    const phase = collected ? 'Answer collected' : unknown ? 'Delivery needs recovery' : input ? 'Waiting for your preparation choice' : r.terminal === true ? 'Ended without a collected answer' : 'Waiting for provider / observing';
    const lines = [`${String(r.roleKey ?? 'Request')}: ${phase}`, `Input: ${input ? 'prepared' : state === 'failed_pre_submit' ? 'failed before submission' : 'retained'}. Delivery: ${delivery}.`, `Provider: ${String(r.providerState ?? "not observed")}. Collection: ${collected ? 'answer available' : 'no final answer collected'}.`];
    if (r.waitExpired === true) lines.push('This wait ended; the request itself has not been canceled.');
    if (r.sessionState === 'superseded') lines.push('This session is no longer current. Any collected answer below is the retained original result.');
    if (r.message) lines.push(String(r.message));
    if (r.errorCode) lines.push(`Error: ${String(r.errorCode)}`);
    if (isRecord(r.inspectionError)) lines.push(`Current page could not be inspected: ${String(r.inspectionError.message ?? r.inspectionError.errorCode)}. Stored state is not proof of the current screen.`);
    if (r.nextCheckAt) lines.push(`Provider probe cooldown until ${String(r.nextCheckAt)}. Waiting for this same request remains safe.`);
    const command = typeof r.teamId === 'string' && typeof r.requestRef === 'string'
      ? `sessplane request` : null;
    const identity = `${String(r.teamId)} ${String(r.requestRef)}`;
    if (command) {
      lines.push(`Inspect: ${command} show ${identity} --view evidence`);
      if (collected && answer === null) lines.push(`Read answer: ${command} show ${identity} --view result`);
      if (isRecord(r.collection)) lines.push(`Connected collection calls: ${records(r.collection.waits).length} (not provider execution).`);
      if (isRecord(r.managedContinuation) && r.managedContinuation.nextReviewAt)
        lines.push(`Managed review: ${String(r.managedContinuation.nextReviewAt)}; submission still requires current evidence.`);
      const observed = isRecord(r.evidence) ? r.evidence : {};
      if (observed.providerAlerts) lines.push(`Provider notice: ${JSON.stringify(observed.providerAlerts)}`);
      const candidates = records(observed.submissionCandidates);
      if (unknown && candidates.length) {
        lines.push('Compare the original prompt and the entire observed message before confirming. Multiple candidates are not an automatic match.');
        if (isRecord(r.requested) && typeof r.requested.prompt === 'string') lines.push(`Original input:\n${r.requested.prompt}`);
        for (const candidate of candidates) lines.push(`Observed user message:\n${String(candidate.text ?? '')}\nIf this is the exact original submission: ${command} acknowledge ${identity} --message-id ${String(candidate.messageId)} --evidence-hash ${String(candidate.evidenceHash)}`);
      }
      if (!collected && !input && !unknown && r.terminal !== true) lines.push(`Collect: ${command} wait ${identity}`);
      if (input) {
        const catalog = isRecord(r.configurationCatalog) ? r.configurationCatalog : {};
        if (catalog.selectionAvailable !== false) for (const option of records(catalog.options)) lines.push(`Model: ${String(option.label ?? option.id)}\n  ${command} configure ${identity} ${String(option.id)}`);
        const evidence = isRecord(r.evidence) ? r.evidence : {};
        const actions = isRecord(evidence.actions) ? evidence.actions : {};
        lines.push('Inspect fresh choices before submitting; selecting a model does not submit.');
        for (const node of records(evidence.nodes)) {
          const actions = isRecord(node.actions) ? node.actions : {};
          for (const action of ['choose', 'reveal']) {
            if (!Array.isArray(actions[action]) || node.disabled === true) continue;
            for (const purpose of actions[action] as unknown[]) lines.push(`Control: ${String(node.name ?? node.text ?? node.role ?? '')} (${String(purpose)})\n  ${command} ${action} ${identity} ${String(purpose)} ${String(node.ref)} --snapshot-id ${String(evidence.snapshotId)}`);
          }
        }
        if (evidence.snapshotId) lines.push(`Snapshot: ${String(evidence.snapshotId)}\nChoose: ${command} choose ${identity} PURPOSE REF --snapshot-id ${String(evidence.snapshotId)}`);
        if (Object.keys(actions).length) lines.push(`Supported choices: ${JSON.stringify(actions)}`);
        lines.push('If choices are unavailable: inspect this same request again; do not send a new prompt.');
      }
    }
    if (collected && answer !== null) lines.push(`\nAnswer\n${answer}`);
    if (isRecord(r.files)) {
      lines.push(`File collection: ${r.files.requestOk === false ? 'failed' : 'result available'}.`);
      if (r.files.errorCode) lines.push(`File error: ${String(r.files.errorCode)}`);
      if (r.files.exportError) lines.push('File export failed; the collected answer is still retained. Inspect --json for the error.');
      for (const file of records(r.files.exports)) lines.push(`Saved file: ${String(file.outputPath ?? file.path ?? 'see --json')}`);
    }
    return lines.join('\n');
  }
  if (Array.isArray(r.teams)) return records(r.teams).map(t => `${String(t.name ?? 'Unnamed team')} — ${String(t.teamState ?? 'available')}\n  sessplane team show ${String(t.teamId)}`).join('\n') || 'No teams for this caller. For existing native MCP work: sessplane team list --client-id sessionplane-mcp\nCreate a team only for new work: sessplane team create --name NAME';
  if (Array.isArray(r.roles)) return [`Team: ${String(r.name ?? r.teamId)}`, ...records(r.roles).map(role => `${String(role.roleKey)}: ${String(role.sessionState ?? 'no session')}\n  Role: ${String(role.roleRef ?? (role.currentSessionId && role.generation !== null ? `${role.currentSessionId}:${role.generation}` : 'not initialized'))}`), ...records(r.requests).map(req => `Request (${String(req.submissionState)}): sessplane request show ${String(r.teamId)} ${String(req.requestRef)}`), `Prepare: sessplane request send ${String(r.teamId)} ROLE_REF --prompt-file FILE\nFor a role without a session: sessplane session create ${String(r.teamId)} ROLE_KEY`].join('\n');
  if (r.version && isRecord(r.browser) && isRecord(r.database)) return `SessionPlane ${String(r.version)}\nBrowser: ${String(r.browser.state)}. Database: ${r.database.integrity === null ? 'readable (integrity: run doctor)' : String(r.database.integrity)}.\nFind work: sessplane team list\nUse --json for runtime diagnostics.`;
  return JSON.stringify(value, null, 2);
}
