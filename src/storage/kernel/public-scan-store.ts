import type { KernelTransactionContext } from './transaction-context.ts';

export class PublicScanStore {
  readonly #context: KernelTransactionContext;

  constructor(context: KernelTransactionContext) {
    this.#context = context;
  }

  scanCurrentPublicPageOwners(providerKey: string): readonly {
    taskId: string; projectId: string; slotId: string;
    slotRevision: number; providerConversationId: string | null;
  }[] {
    return this.#context.database.raw.prepare(
      `SELECT t.task_id AS taskId,t.project_id AS projectId,t.slot_id AS slotId,
          t.slot_revision AS slotRevision,
          s.provider_conversation_id AS providerConversationId
        FROM kernel_tasks t
        JOIN kernel_public_task_policies p ON p.task_id=t.task_id
        JOIN kernel_slots s ON s.project_id=t.project_id AND s.slot_id=t.slot_id
          AND s.revision=t.slot_revision AND s.active_task_id=t.task_id
        WHERE t.cancel_requested=0 AND t.state IN
          ('working','uncertain','agent_input_required')
          AND s.provider_key=?
        ORDER BY t.created_at,t.task_id`,
    ).all(providerKey) as Array<{
      taskId: string; projectId: string; slotId: string;
      slotRevision: number; providerConversationId: string | null;
    }>;
  }

  scanPendingPreparations(limit = 4): readonly {
    taskId: string; clientId: string; attemptId: string;
    providerKey: string;
  }[] {
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
      throw new Error('Invalid public preparation scan limit');
    }
    return this.#nextPublicScanBatch('root_prepare', cursor =>
      this.#context.database.raw.prepare(
        `SELECT t.task_id AS taskId,t.client_id AS clientId,
            a.attempt_id AS attemptId,s.provider_key AS providerKey
          FROM kernel_tasks t
          JOIN kernel_public_task_policies p ON p.task_id=t.task_id
          JOIN kernel_attempts a ON a.task_id=t.task_id
          JOIN kernel_slots s ON s.project_id=t.project_id AND s.slot_id=t.slot_id
            AND s.revision=t.slot_revision AND s.active_task_id=t.task_id
          WHERE t.cancel_requested=0 AND t.state='working'
            AND t.pending_decision_id IS NULL AND s.provider_conversation_id IS NULL
            AND a.kind='initial' AND a.state='planned'
          ORDER BY CASE WHEN t.task_id > ? THEN 0 ELSE 1 END, t.task_id LIMIT ?`,
      ).all(cursor.taskId, limit) as Array<{
        taskId: string; clientId: string; attemptId: string; providerKey: string;
      }>);
  }

  scanPendingRootAttempts(limit = 16): readonly {
    taskId: string; clientId: string; attemptId: string; modelIntent: string | null;
  }[] {
    if (!Number.isInteger(limit) || limit < 1 || limit > 500) {
      throw new Error('Invalid public root initial scan limit');
    }
    return this.#nextPublicScanBatch('root_initial', cursor =>
      this.#context.database.raw.prepare(
        `SELECT t.task_id AS taskId,t.client_id AS clientId,
            a.attempt_id AS attemptId,i.model_intent AS modelIntent
          FROM kernel_tasks t
          JOIN kernel_public_task_policies p ON p.task_id=t.task_id
          JOIN kernel_attempts a ON a.task_id=t.task_id
          JOIN kernel_slots s ON s.project_id=t.project_id AND s.slot_id=t.slot_id
            AND s.revision=t.slot_revision AND s.active_task_id=t.task_id
          LEFT JOIN kernel_public_project_intents i ON i.project_id=t.project_id
          LEFT JOIN kernel_root_dispatch_evidence r ON r.attempt_id=a.attempt_id
          WHERE t.cancel_requested=0 AND t.state='working'
            AND t.pending_decision_id IS NULL AND s.provider_conversation_id IS NULL
            AND a.kind='initial' AND a.state='planned' AND r.attempt_id IS NULL
          ORDER BY CASE WHEN t.task_id > ? THEN 0 ELSE 1 END, t.task_id LIMIT ?`,
      ).all(cursor.taskId, limit) as Array<{
        taskId: string; clientId: string; attemptId: string; modelIntent: string | null;
      }>);
  }

  scanPendingRootReconciliations(limit = 32): readonly {
    taskId: string; clientId: string; attemptId: string;
    canonicalConversationId: string | null;
  }[] {
    if (!Number.isInteger(limit) || limit < 1 || limit > 500) {
      throw new Error('Invalid public root reconciliation scan limit');
    }
    return this.#nextPublicScanBatch('root_reconcile', cursor =>
      this.#context.database.raw.prepare(
        `SELECT t.task_id AS taskId,t.client_id AS clientId,
            a.attempt_id AS attemptId,
            r.canonical_conversation_id AS canonicalConversationId
          FROM kernel_tasks t
          JOIN kernel_public_task_policies p ON p.task_id=t.task_id
          JOIN kernel_attempts a ON a.task_id=t.task_id
          JOIN kernel_root_dispatch_evidence r ON r.attempt_id=a.attempt_id
          JOIN kernel_slots s ON s.project_id=t.project_id AND s.slot_id=t.slot_id
            AND s.revision=t.slot_revision AND s.active_task_id=t.task_id
          WHERE t.state IN ('working','uncertain','canceled') AND a.kind='initial'
            AND ((r.canonical_conversation_id IS NULL
                  AND a.state IN ('dispatched','uncertain'))
              OR (r.canonical_conversation_id IS NOT NULL
                  AND a.state='acknowledged'))
          ORDER BY CASE WHEN t.task_id > ? THEN 0 ELSE 1 END, t.task_id LIMIT ?`,
      ).all(cursor.taskId, limit) as Array<{
        taskId: string; clientId: string; attemptId: string;
        canonicalConversationId: string | null;
      }>);
  }

  scanPendingAcknowledgements(limit = 16): readonly {
    taskId: string; clientId: string; attemptId: string;
  }[] {
    if (!Number.isInteger(limit) || limit < 1 || limit > 500) {
      throw new Error('Invalid public acknowledgement scan limit');
    }
    return this.#nextPublicScanBatch('ack_reconcile', cursor =>
      this.#context.database.raw.prepare(
        `SELECT t.task_id AS taskId,t.client_id AS clientId,a.attempt_id AS attemptId
          FROM kernel_tasks t
          JOIN kernel_public_task_policies p ON p.task_id=t.task_id
          JOIN kernel_attempts a ON a.task_id=t.task_id
          LEFT JOIN kernel_dispatch_evidence e ON e.attempt_id=a.attempt_id AND e.task_id=t.task_id
          JOIN kernel_slots s ON s.project_id=t.project_id AND s.slot_id=t.slot_id
            AND s.revision=t.slot_revision AND s.active_task_id=t.task_id
          WHERE t.cancel_requested=0 AND t.state IN ('working','uncertain')
            AND t.pending_decision_id IS NULL
            AND a.kind!='stop' AND a.state IN ('dispatched','uncertain')
            AND s.provider_conversation_id IS NOT NULL
            AND (e.attempt_id IS NOT NULL OR a.kind='continuation')
            AND (e.attempt_id IS NULL OR
              (e.provider_key=s.provider_key AND
               e.provider_conversation_id=s.provider_conversation_id))
            AND NOT EXISTS (SELECT 1 FROM kernel_root_dispatch_evidence r
              WHERE r.attempt_id=a.attempt_id)
            AND NOT EXISTS (SELECT 1 FROM kernel_attempts newer
              WHERE newer.task_id=t.task_id AND newer.kind!='stop'
                AND newer.sequence>a.sequence)
          ORDER BY CASE WHEN t.task_id > ? THEN 0 ELSE 1 END, t.task_id,a.sequence LIMIT ?`,
      ).all(cursor.taskId, limit) as Array<{
        taskId: string; clientId: string; attemptId: string;
      }>);
  }

  scanPendingInitials(limit = 16): readonly {
    taskId: string; clientId: string; attemptId: string; modelIntent: string | null;
  }[] {
    return this.#scanPendingPublicInitials(limit, 'initial');
  }

  scanPendingBoundPreparations(limit = 8): readonly {
    taskId: string; clientId: string; attemptId: string; modelIntent: string | null;
  }[] {
    return this.#scanPendingPublicInitials(limit, 'bound_prepare');
  }

  #scanPendingPublicInitials(limit: number, scanKind: 'initial' | 'bound_prepare'): readonly {
    taskId: string; clientId: string; attemptId: string; modelIntent: string | null;
  }[] {
    if (!Number.isInteger(limit) || limit < 1 || limit > 500) {
      throw new Error('Invalid public initial scan limit');
    }
    return this.#nextPublicScanBatch(scanKind, cursor =>
      this.#context.database.raw.prepare(
        `SELECT t.task_id AS taskId,t.client_id AS clientId,
            a.attempt_id AS attemptId,i.model_intent AS modelIntent
          FROM kernel_tasks t
          JOIN kernel_public_task_policies p ON p.task_id=t.task_id
          JOIN kernel_attempts a ON a.task_id=t.task_id
          JOIN kernel_slots s ON s.project_id=t.project_id AND s.slot_id=t.slot_id
            AND s.revision=t.slot_revision AND s.active_task_id=t.task_id
          LEFT JOIN kernel_public_project_intents i ON i.project_id=t.project_id
          WHERE t.cancel_requested=0 AND t.state='working'
            AND t.pending_decision_id IS NULL AND s.provider_conversation_id IS NOT NULL
            AND a.kind='initial' AND a.state='planned'
          ORDER BY CASE WHEN t.task_id > ? THEN 0 ELSE 1 END, t.task_id LIMIT ?`,
      ).all(cursor.taskId, limit) as Array<{
        taskId: string; clientId: string; attemptId: string; modelIntent: string | null;
      }>);
  }

  scanPendingFinals(limit = 32): readonly {
    taskId: string; clientId: string; attemptId: string;
    attemptSequence: number; policyJson: string;
  }[] {
    if (!Number.isInteger(limit) || limit < 1 || limit > 500) {
      throw new Error('Invalid public final scan limit');
    }
    // A bounded observer must not order only by task.updated_at: identical
    // pacing/FINAL deferrals are intentionally event-deduplicated and leave
    // that timestamp unchanged, starving every Task past LIMIT indefinitely.
    // Rotate by immutable task + attempt sequence, wrapping in one query.
    return this.#nextPublicScanBatch('final', cursor =>
      this.#context.database.raw.prepare(
        `SELECT t.task_id AS taskId,t.client_id AS clientId,
            a.attempt_id AS attemptId,a.sequence AS attemptSequence,
            p.policy_json AS policyJson
          FROM kernel_tasks t JOIN kernel_public_task_policies p ON p.task_id=t.task_id
          JOIN kernel_attempts a ON a.task_id=t.task_id
          LEFT JOIN kernel_results r ON r.attempt_id=a.attempt_id
          WHERE t.cancel_requested=0
            AND t.state IN ('working','agent_input_required','human_input_required')
            AND a.kind!='stop' AND a.state='acknowledged' AND r.result_id IS NULL
          ORDER BY CASE WHEN t.task_id > ? OR (t.task_id=? AND a.sequence>?)
            THEN 0 ELSE 1 END, t.task_id,a.sequence LIMIT ?`,
      ).all(cursor.taskId, cursor.taskId, cursor.attemptSequence, limit) as Array<{
        taskId: string; clientId: string; attemptId: string;
        attemptSequence: number; policyJson: string;
      }>, row => row.attemptSequence);
  }

  claimPreparationPrefersBound(): boolean {
    return this.#context.database.transaction(() => {
      const row = this.#context.database.raw.prepare(
        'SELECT next_kind AS nextKind FROM kernel_public_preparation_phase' +
        ' WHERE singleton=1',
      ).get() as { nextKind: 'root' | 'bound' } | undefined;
      const preferred = row?.nextKind ?? 'root';
      // A new schema must remain empty until first use; migration never
      // creates operational scheduler activity in an offline candidate.
      this.#context.database.raw.prepare(
        'INSERT INTO kernel_public_preparation_phase(singleton,next_kind)' +
        ' VALUES(1,?) ON CONFLICT(singleton) DO UPDATE' +
        ' SET next_kind=excluded.next_kind',
      ).run(preferred === 'root' ? 'bound' : 'root');
      return preferred === 'bound';
    });
  }

  #nextPublicScanBatch<RowType extends { readonly taskId: string }>(
    scanKind: 'root_prepare' | 'root_initial' | 'initial' | 'bound_prepare' |
      'root_reconcile' | 'ack_reconcile' | 'final',
    load: (cursor: { taskId: string; attemptSequence: number }) => readonly RowType[],
    sequenceOf: (row: RowType) => number = () => 0,
  ): readonly RowType[] {
    return this.#context.database.transaction(() => {
      const previous = this.#context.database.raw.prepare(
        'SELECT last_task_id AS taskId,last_attempt_sequence AS attemptSequence' +
        ' FROM kernel_public_scan_cursors WHERE scan_kind=?',
      ).get(scanKind) as { taskId: string; attemptSequence: number } | undefined;
      const selected = load(previous ?? { taskId: '', attemptSequence: 0 });
      const last = selected.at(-1);
      const sequence = last === undefined ? 0 : sequenceOf(last);
      // A single permanently paced Task must not generate a WAL write on
      // every poll merely to persist the identical ordering marker.
      if (last !== undefined && (last.taskId !== previous?.taskId ||
          sequence !== previous.attemptSequence)) {
        this.#context.database.raw.prepare(
          `INSERT INTO kernel_public_scan_cursors(
             scan_kind,last_task_id,last_attempt_sequence) VALUES(?,?,?)
           ON CONFLICT(scan_kind) DO UPDATE SET
             last_task_id=excluded.last_task_id,
             last_attempt_sequence=excluded.last_attempt_sequence`,
        ).run(scanKind, last.taskId, sequence);
      }
      return selected;
    });
  }

  scanApprovedContinuationPolicies(): readonly {
    taskId: string; clientId: string; policyJson: string;
  }[] {
    return this.#context.database.raw.prepare(
      `SELECT t.task_id AS taskId,t.client_id AS clientId,
          p.policy_json AS policyJson
        FROM kernel_tasks t JOIN kernel_public_task_policies p ON p.task_id=t.task_id
        WHERE t.cancel_requested=0 AND t.state='working'
        ORDER BY t.created_at,t.task_id`,
    ).all() as Array<{ taskId: string; clientId: string; policyJson: string }>;
  }

  scanApprovedContinuationOwners(): readonly { taskId: string; clientId: string }[] {
    return this.#context.database.raw.prepare(
      `SELECT DISTINCT t.task_id AS taskId,t.client_id AS clientId
        FROM kernel_tasks t JOIN kernel_timers timer ON timer.task_id=t.task_id
        WHERE timer.kind='continuation_due' AND t.cancel_requested=0
          AND t.state NOT IN ('completed','failed','canceled')
        ORDER BY t.task_id`,
    ).all() as Array<{ taskId: string; clientId: string }>;
  }
}
