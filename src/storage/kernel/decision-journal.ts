import type { DecisionAudience } from '../../domain/durable-task.ts';
import type { DecisionRecord } from './records.ts';
import { DECISION_COLUMNS, decodeDecisionRow, requireNonempty } from './row-codecs.ts';
import type { KernelTransactionContext } from './transaction-context.ts';

function decodeSemanticResolutionReceipt(encoded: string): {
  readonly kind: 'semantic_action';
  readonly requestId: string;
  readonly actionRef: string;
  readonly input: string | null;
  readonly nextDecisionId?: string;
  readonly outcome?: unknown;
} {
  const parsed: unknown = JSON.parse(encoded);
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('Invalid semantic decision resolution: expected object');
  }
  const row = parsed as Record<string, unknown>;
  if (row.kind !== 'semantic_action' ||
      typeof row.requestId !== 'string' || row.requestId.length === 0 ||
      typeof row.actionRef !== 'string' || row.actionRef.length === 0 ||
      !(typeof row.input === 'string' || row.input === null) ||
      !(row.nextDecisionId === undefined || typeof row.nextDecisionId === 'string')) {
    throw new Error('Invalid semantic decision resolution identity');
  }
  return {
    kind: 'semantic_action',
    requestId: row.requestId,
    actionRef: row.actionRef,
    input: row.input,
    ...(row.nextDecisionId === undefined ? {} : { nextDecisionId: row.nextDecisionId }),
    ...(row.outcome === undefined ? {} : { outcome: row.outcome }),
  };
}

/** The database stores a version discriminator without parsing provider
 * semantics inside storage. Historical unversioned JSON stays v1. */
function envelopeVersion(raw: string): 1 | 2 {
  const value: unknown = JSON.parse(raw);
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Decision context must be a JSON object');
  }
  const version = (value as Record<string, unknown>).schemaVersion;
  if (version === undefined) return 1;
  if (version === 2) return 2;
  throw new Error('Unsupported durable decision schema version');
}

export class DecisionJournal {
  readonly #context: KernelTransactionContext;

  constructor(context: KernelTransactionContext) {
    this.#context = context;
  }

  createDecision(input: {
    taskId: string;
    clientId: string;
    decisionId: string;
    audience: DecisionAudience;
    contextJson: string;
  }): DecisionRecord {
    requireNonempty(input.decisionId, 'decisionId');
    return this.#context.database.transaction(() => {
      const task = this.#context.requireTask(input.taskId, input.clientId);
      // Validate a packet is JSON and persists exactly; interpretation belongs
      // to the decision gateway, never to this provider-neutral kernel.
      const version = envelopeVersion(input.contextJson);
      this.#context.appendEvent(task, {
        type: 'decision.required', decisionId: input.decisionId, audience: input.audience,
      });
      this.#context.database.raw.prepare(
        `INSERT INTO kernel_decisions(decision_id,task_id,audience,context_json,
          status,resolution_json,action_consumed,created_at,resolved_at,envelope_version)
          VALUES(?,?,?,?,'pending',NULL,0,?,NULL,?)`,
      ).run(input.decisionId, task.taskId, input.audience, input.contextJson, this.#context.now(), version);
      return this.#context.requireDecision(input.decisionId, task.taskId);
    });
  }

  escalateDecisionToHuman(input: {
    taskId: string; clientId: string; decisionId: string;
    requestId: string; actionRef: string; inputValue: string | null;
    nextDecisionId: string; nextContextJson: string;
  }): { source: DecisionRecord; next: DecisionRecord } {
    for (const key of ['decisionId', 'requestId', 'actionRef', 'nextDecisionId'] as const) {
      requireNonempty(input[key], key);
    }
    return this.#context.database.transaction(() => {
      let task = this.#context.requireTask(input.taskId, input.clientId);
      const nextVersion = envelopeVersion(input.nextContextJson);
      let source = this.#context.requireDecision(input.decisionId, task.taskId);
      const outcome = { kind: 'performed', effect: 'human_assistance_requested' } as const;
      const resolution = {
        kind: 'semantic_action', requestId: input.requestId,
        actionRef: input.actionRef, input: input.inputValue, outcome,
        nextDecisionId: input.nextDecisionId,
      };
      if (source.status === 'resolved') {
        const existing = source.resolutionJson === null ? null
          : decodeSemanticResolutionReceipt(source.resolutionJson);
        if (existing?.kind !== resolution.kind || existing.requestId !== input.requestId ||
            existing.actionRef !== input.actionRef || existing.input !== input.inputValue ||
            existing.nextDecisionId !== input.nextDecisionId ||
            JSON.stringify(existing.outcome) !== JSON.stringify(outcome) ||
            !source.actionConsumed) {
          throw new Error('Human escalation request identity conflict');
        }
        const next = this.#context.requireDecision(input.nextDecisionId, task.taskId);
        if (next.audience !== 'human' || next.status !== 'pending' ||
            next.contextJson !== input.nextContextJson ||
            task.pendingDecisionId !== next.decisionId || task.state !== 'human_input_required') {
          throw new Error('Human escalation durable continuation is inconsistent');
        }
        return { source, next };
      }
      if (source.status !== 'pending' || source.audience !== 'agent' ||
          source.actionConsumed || task.pendingDecisionId !== source.decisionId ||
          task.state !== 'agent_input_required' || task.cancelRequested) {
        throw new Error('Only the exact pending agent decision may escalate to a human');
      }
      const conflict = this.#context.database.raw.prepare(
        'SELECT decision_id FROM kernel_decisions WHERE decision_id=?',
      ).get(input.nextDecisionId);
      if (conflict) throw new Error('Human decision identity already exists');

      task = this.#context.appendEvent(task, {
        type: 'decision.resolved', decisionId: source.decisionId,
      });
      const changed = this.#context.database.raw.prepare(
        `UPDATE kernel_decisions SET status='resolved',resolution_json=?,
          action_consumed=1,resolved_at=? WHERE decision_id=? AND status='pending'
          AND action_consumed=0`,
      ).run(JSON.stringify(resolution), this.#context.now(), source.decisionId);
      if (changed.changes !== 1) throw new Error('Concurrent human escalation changed');
      task = this.#context.appendEvent(task, {
        type: 'decision.action_consumed', decisionId: source.decisionId,
      });
      task = this.#context.appendEvent(task, {
        type: 'decision.outcome_recorded', decisionId: source.decisionId,
      });
      task = this.#context.appendEvent(task, {
        type: 'decision.required', decisionId: input.nextDecisionId, audience: 'human',
      });
      this.#context.database.raw.prepare(
        `INSERT INTO kernel_decisions(decision_id,task_id,audience,context_json,
          status,resolution_json,action_consumed,created_at,resolved_at,envelope_version)
          VALUES(?,?, 'human', ?,'pending',NULL,0,?,NULL,?)`,
      ).run(input.nextDecisionId, task.taskId, input.nextContextJson, this.#context.now(), nextVersion);
      source = this.#context.requireDecision(source.decisionId, task.taskId);
      return { source, next: this.#context.requireDecision(input.nextDecisionId, task.taskId) };
    });
  }

  resolveDecision(input: {
    taskId: string;
    clientId: string;
    decisionId: string;
    resolutionJson: string;
  }): DecisionRecord {
    return this.#context.database.transaction(() => {
      const task = this.#context.requireTask(input.taskId, input.clientId);
      JSON.parse(input.resolutionJson);
      const decision = this.#context.requireDecision(input.decisionId, task.taskId);
      if (decision.status !== 'pending') throw new Error('Decision already consumed');
      this.#context.appendEvent(task, { type: 'decision.resolved', decisionId: input.decisionId });
      this.#context.database.raw.prepare(
        `UPDATE kernel_decisions SET status='resolved',resolution_json=?,
          resolved_at=? WHERE decision_id=? AND status='pending'`,
      ).run(input.resolutionJson, this.#context.now(), input.decisionId);
      return this.#context.requireDecision(input.decisionId, task.taskId);
    });
  }

  recordDecisionOutcome(input: {
    taskId: string; clientId: string; decisionId: string;
    requestId: string; actionRef: string; inputValue: string | null;
    outcomeJson: string;
  }): DecisionRecord {
    return this.#context.database.transaction(() => {
      const task = this.#context.requireTask(input.taskId, input.clientId);
      const decision = this.#context.requireDecision(input.decisionId, task.taskId);
      if (decision.status !== 'resolved' || decision.resolutionJson === null) {
        throw new Error('Only an exact resolved decision can record an outcome');
      }
      const receipt = decodeSemanticResolutionReceipt(decision.resolutionJson);
      if (receipt.kind !== 'semantic_action' ||
          receipt.requestId !== input.requestId ||
          receipt.actionRef !== input.actionRef ||
          receipt.input !== input.inputValue) {
        throw new Error('Decision outcome request identity conflict');
      }
      if (Buffer.byteLength(input.outcomeJson, 'utf8') > 24 * 1024) {
        throw new Error('Decision outcome receipt exceeds bound');
      }
      const outcome: unknown = JSON.parse(input.outcomeJson);
      if (!outcome || typeof outcome !== 'object' ||
          Array.isArray(outcome) ||
          !['performed', 'uncertain', 'refresh_required'].includes(
            (outcome as { kind?: unknown }).kind as string)) {
        throw new Error('Invalid decision outcome receipt');
      }
      if (receipt.outcome !== undefined) {
        if (JSON.stringify(receipt.outcome) !== JSON.stringify(outcome)) {
          throw new Error('Conflicting exact decision outcome receipt');
        }
        return decision;
      }
      if ((outcome as { kind: string }).kind === 'performed' && !decision.actionConsumed) {
        throw new Error('Unconsumed decision cannot record a performed effect');
      }
      const updated = JSON.stringify({ ...receipt, outcome });
      const result = this.#context.database.raw.prepare(
        "UPDATE kernel_decisions SET resolution_json=? WHERE decision_id=?" +
        " AND status='resolved' AND resolution_json=?",
      ).run(updated, input.decisionId, decision.resolutionJson);
      if (result.changes !== 1) {
        throw new Error('Concurrent decision outcome identity changed');
      }
      this.#context.appendEvent(task, { type: 'decision.outcome_recorded', decisionId: input.decisionId });
      return this.#context.requireDecision(input.decisionId, task.taskId);
    });
  }

  consumeDecisionAction(taskId: string, clientId: string, decisionId: string): boolean {
    return this.#context.database.transaction(() => {
      const task = this.#context.requireTask(taskId, clientId);
      const decision = this.#context.requireDecision(decisionId, taskId);
      if (decision.status !== 'resolved' || decision.actionConsumed) return false;
      const changed = this.#context.database.raw.prepare(
        `UPDATE kernel_decisions SET action_consumed=1 WHERE decision_id=?
          AND status='resolved' AND action_consumed=0`,
      ).run(decisionId);
      if (changed.changes !== 1) return false;
      this.#context.appendEvent(task, { type: 'decision.action_consumed', decisionId });
      return true;
    });
  }

  listPendingDecisions(projectId: string, clientId: string): readonly DecisionRecord[] {
    this.#context.requireAccess(projectId, clientId);
    return this.#context.database.raw.prepare(
      `SELECT ${DECISION_COLUMNS} FROM kernel_decisions
        WHERE task_id IN (SELECT task_id FROM kernel_tasks WHERE project_id=?)
          AND status='pending' ORDER BY created_at,decision_id`,
    ).all(projectId).map(decodeDecisionRow);
  }
}
