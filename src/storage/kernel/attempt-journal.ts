import type { Row } from './row-codecs.ts';
import { createHash } from 'node:crypto';
import type { AttemptKind } from '../../domain/durable-task.ts';
import type { TaskRecord, AttemptRecord, AttemptState, AttemptSessionBindingRecord, DispatchEvidenceRecord, RootDispatchEvidenceRecord } from './records.ts';
import { ATTEMPT_COLUMNS, decodeAttemptRow, requireNonempty } from './row-codecs.ts';
import type { KernelTransactionContext } from './transaction-context.ts';
import type { ProjectSlotStore } from './project-slot-store.ts';

export class AttemptJournal {
  readonly #context: KernelTransactionContext;
  readonly #slots: ProjectSlotStore;

  constructor(context: KernelTransactionContext, slots: ProjectSlotStore) {
    this.#context = context;
    this.#slots = slots;
  }

  bindAttemptSessionGeneration(input: {
    taskId: string; clientId: string; attemptId: string;
    sessionId: string; generation: number; conversationId: string;
  }): AttemptSessionBindingRecord {
    for (const name of ['taskId', 'clientId', 'attemptId', 'sessionId', 'conversationId'] as const) {
      requireNonempty(input[name], name);
    }
    if (!Number.isSafeInteger(input.generation) || input.generation < 1) {
      throw new Error('Attempt session generation must be a positive integer');
    }
    return this.#context.database.transaction(() => {
      const task = this.#context.requireTask(input.taskId, input.clientId);
      const attempt = this.#context.requireAttempt(input.attemptId, input.taskId);
      const slot = this.#context.requireSlot(task.projectId, task.slotId);
      const immutable = this.#slots.getSlotBindingAtRevision(task.projectId, task.slotId,
        task.slotRevision, input.clientId);
      if (slot.activeTaskId !== task.taskId || slot.revision !== task.slotRevision ||
          immutable.providerConversationId !== input.conversationId ||
          slot.providerConversationId !== input.conversationId) {
        throw new Error('Attempt lost its exact active conversation lease');
      }
      const old = this.getAttemptSessionBinding(input);
      if (old !== null) {
        if (old.sessionId !== input.sessionId || old.generation !== input.generation ||
            old.conversationId !== input.conversationId) {
          throw new Error('Attempt session generation cannot be rebound');
        }
        return old;
      }
      if (attempt.state !== 'planned') {
        throw new Error('Only a planned attempt can bind its session generation');
      }
      this.#context.database.raw.prepare(
        'INSERT INTO kernel_attempt_session_bindings(attempt_id,task_id,session_id,' +
        ' generation,provider_conversation_id,bound_at) VALUES(?,?,?,?,?,?)',
      ).run(input.attemptId, input.taskId, input.sessionId, input.generation,
        input.conversationId, this.#context.now());
      return this.getAttemptSessionBinding(input)!;
    });
  }

  getAttemptSessionBinding(input: {
    taskId: string; clientId: string; attemptId: string;
  }): AttemptSessionBindingRecord | null {
    this.#context.requireTask(input.taskId, input.clientId);
    this.#context.requireAttempt(input.attemptId, input.taskId);
    const row = this.#context.database.raw.prepare(
      'SELECT attempt_id AS attemptId, task_id AS taskId, session_id AS sessionId,' +
      ' generation, provider_conversation_id AS conversationId, bound_at AS boundAt' +
      ' FROM kernel_attempt_session_bindings WHERE attempt_id=? AND task_id=?',
    ).get(input.attemptId, input.taskId) as Row | undefined;
    return row ? {
      attemptId: String(row.attemptId), taskId: String(row.taskId),
      sessionId: String(row.sessionId), generation: Number(row.generation),
      conversationId: String(row.conversationId), boundAt: String(row.boundAt),
    } : null;
  }

  planAttempt(input: {
    taskId: string;
    clientId: string;
    attemptId: string;
    kind: AttemptKind;
    turnKey: string;
    content: string;
  }): AttemptRecord {
    for (const name of ['attemptId', 'turnKey'] as const) requireNonempty(input[name], name);
    return this.#context.database.transaction(() => {
      const task = this.#context.requireTask(input.taskId, input.clientId);
      const existing = this.#context.database.raw.prepare(
        `SELECT ${ATTEMPT_COLUMNS} FROM kernel_attempts WHERE task_id=? AND turn_key=?`,
      ).get(input.taskId, input.turnKey) as Row | undefined;
      if (existing) {
        const attempt = decodeAttemptRow(existing);
        if (attempt.attemptId !== input.attemptId || attempt.kind !== input.kind ||
          attempt.content !== input.content) throw new Error('Attempt turn key conflict');
        return attempt; // Re-fetch is safe; beginDispatch still enforces at-most-once.
      }
      if (input.kind === 'initial') {
        if (input.content !== task.originalPrompt) throw new Error('Initial prompt identity mismatch');
        const first = this.#context.database.raw.prepare(
          "SELECT attempt_id FROM kernel_attempts WHERE task_id=? AND kind='initial' LIMIT 1",
        ).get(task.taskId);
        if (first) throw new Error('Original attempt already exists; no prompt replay');
      } else if (input.kind === 'continuation') {
        // The approved timer may fire while the exact acknowledged answer is
        // still pending. A FINAL is a reason to finish, not to grant Continue.
        const latest = this.#context.database.raw.prepare(
          `SELECT attempt_id AS attemptId,state,external_turn_id AS externalTurnId
            FROM kernel_attempts WHERE task_id=? AND kind!='stop'
            ORDER BY sequence DESC LIMIT 1`,
        ).get(task.taskId) as {
          attemptId: string; state: AttemptState; externalTurnId: string | null;
        } | undefined;
        if (!latest || latest.state !== 'acknowledged' || latest.externalTurnId === null) {
          throw new Error('Continuation requires a prior exact ACK');
        }
      }
      if (input.kind !== 'stop') {
        const latest = input.kind === 'continuation' ? this.#context.database.raw.prepare(
          `SELECT attempt_id AS attemptId FROM kernel_attempts
            WHERE task_id=? AND kind!='stop' ORDER BY sequence DESC LIMIT 1`,
        ).get(task.taskId) as { attemptId: string } : null;
        const unresolved = this.#context.database.raw.prepare(
          `SELECT a.attempt_id FROM kernel_attempts a
             LEFT JOIN kernel_results r ON r.attempt_id=a.attempt_id
             WHERE a.task_id=? AND a.kind!='stop'
               AND a.state!='failed_before_dispatch' AND r.result_id IS NULL
               ${latest
                 ? "AND a.attempt_id!=? AND (a.state!='acknowledged' OR a.external_turn_id IS NULL)"
                 : ''} LIMIT 1`,
        ).get(task.taskId, ...(latest ? [latest.attemptId] : []));
        if (unresolved) throw new Error('Another exact attempt is unresolved');
        const slot = this.#context.requireSlot(task.projectId, task.slotId);
        if (slot.activeTaskId !== task.taskId || slot.revision !== task.slotRevision) {
          throw new Error('Task lost its exact conversation lease');
        }
      } else {
        const earlierStop = this.#context.database.raw.prepare(
          "SELECT attempt_id FROM kernel_attempts WHERE task_id=? AND kind='stop' LIMIT 1",
        ).get(task.taskId);
        if (earlierStop) throw new Error('Stop already attempted; do not replay');
      }
      this.#context.appendEvent(task, { type: 'attempt.planned', attemptId: input.attemptId, kind: input.kind });
      const seq = Number((this.#context.database.raw.prepare(
        'SELECT COALESCE(MAX(sequence),0)+1 AS next FROM kernel_attempts WHERE task_id=?',
      ).get(task.taskId) as { next: number }).next);
      this.#context.database.raw.prepare(
        `INSERT INTO kernel_attempts(attempt_id,task_id,sequence,kind,turn_key,
          content,state,external_turn_id,dispatched_at,acknowledged_at,
          uncertain_reason,created_at)
          VALUES(?,?,?,?,?,?,'planned',NULL,NULL,NULL,NULL,?)`,
      ).run(input.attemptId, task.taskId, seq, input.kind,
        input.turnKey, input.content, this.#context.now());
      return this.#context.requireAttempt(input.attemptId, input.taskId);
    });
  }

  reserveAttemptDispatch(taskId: string, clientId: string, attemptId: string): AttemptRecord {
    return this.#context.database.transaction(() => {
      const task = this.#context.requireTask(taskId, clientId);
      const attempt = this.#context.requireAttempt(attemptId, taskId);
      if (attempt.state !== 'planned') throw new Error('Dispatch already consumed; never replay');
      const slot = this.#context.requireSlot(task.projectId, task.slotId);
      if (slot.revision !== task.slotRevision || slot.activeTaskId !== task.taskId) {
        throw new Error('Exact task lease lost before dispatch');
      }
      this.#context.appendEvent(task, {
        type: 'attempt.dispatched', attemptId, kind: attempt.kind,
      });
      this.#context.database.raw.prepare(
        "UPDATE kernel_attempts SET state='dispatched',dispatched_at=? WHERE attempt_id=? AND state='planned'",
      ).run(this.#context.now(), attemptId);
      return this.#context.requireAttempt(attemptId, taskId);
    });
  }

  recordDispatchEvidence(input: {
    taskId: string; clientId: string; attemptId: string;
    evidence: DispatchEvidenceRecord;
  }): DispatchEvidenceRecord {
    return this.#context.database.transaction(() => {
      const task = this.#context.requireTask(input.taskId, input.clientId);
      const attempt = this.#context.requireAttempt(input.attemptId, input.taskId);
      if (!['dispatched', 'uncertain', 'acknowledged'].includes(attempt.state)) {
        throw new Error('Dispatch evidence requires a previously dispatched attempt');
      }
      const binding = this.#slots.getSlotBindingAtRevision(task.projectId, task.slotId,
        task.slotRevision, input.clientId);
      const evidence = input.evidence;
      for (const [label, value] of Object.entries(evidence)) {
        if (typeof value !== 'string' || value.length === 0 || value.length > 512) {
          throw new Error(`Invalid dispatch evidence ${label}`);
        }
      }
      if (evidence.conversationId !== binding.providerConversationId) {
        throw new Error('Dispatch evidence conversation is not the immutable slot binding');
      }
      const contentHash = createHash('sha256')
        .update(attempt.content.replaceAll('\r\n', '\n')).digest('hex');
      if (!/^[a-f0-9]{64}$/.test(evidence.textHash) || evidence.textHash !== contentHash) {
        throw new Error('Dispatch evidence text does not match the journaled attempt');
      }
      if (Number.isNaN(Date.parse(evidence.observedAt))) {
        throw new Error('Dispatch evidence timestamp is invalid');
      }
      const row = this.#context.database.raw.prepare(
        `SELECT provider_key AS providerKey,provider_conversation_id AS conversationId,
          message_id AS messageId,parent_message_id AS parentMessageId,
          text_hash AS textHash,observed_at AS observedAt
          FROM kernel_dispatch_evidence WHERE attempt_id=?`,
      ).get(input.attemptId) as (DispatchEvidenceRecord & { providerKey: string }) | undefined;
      if (row !== undefined) {
        if (row.providerKey !== binding.providerKey ||
          row.conversationId !== evidence.conversationId || row.messageId !== evidence.messageId ||
          row.parentMessageId !== evidence.parentMessageId || row.textHash !== evidence.textHash ||
          row.observedAt !== evidence.observedAt) {
          throw new Error('Conflicting dispatch evidence for the same attempt');
        }
        return evidence;
      }
      this.#context.database.raw.prepare(
        `INSERT INTO kernel_dispatch_evidence(
          attempt_id,task_id,provider_key,provider_conversation_id,message_id,
          parent_message_id,text_hash,observed_at
        ) VALUES(?,?,?,?,?,?,?,?)`,
      ).run(input.attemptId, input.taskId, binding.providerKey, evidence.conversationId,
        evidence.messageId, evidence.parentMessageId, evidence.textHash,
        evidence.observedAt);
      this.#context.appendEvent(task, {
        type: 'attempt.dispatch_evidence_recorded', attemptId: input.attemptId,
      });
      return evidence;
    });
  }

  recordRootDispatchEvidence(input: {
    taskId: string; clientId: string; attemptId: string;
    evidence: Omit<RootDispatchEvidenceRecord,
      'canonicalConversationId' | 'observationCount' | 'ambiguous'>;
  }): RootDispatchEvidenceRecord {
    let conflict = false;
    const recorded = this.#context.database.transaction(() => {
      const task = this.#context.requireTask(input.taskId, input.clientId);
      const attempt = this.#context.requireAttempt(input.attemptId, input.taskId);
      const e = input.evidence;
      if (attempt.kind !== 'initial' ||
          !['dispatched', 'uncertain', 'acknowledged'].includes(attempt.state)) {
        throw new Error('Root POST requires a previously dispatched initial');
      }
      for (const value of [e.pageKey, e.targetId, e.sessionId, e.messageId,
        e.parentMessageId]) {
        if (!value || Buffer.byteLength(value, 'utf8') > 512) {
          throw new Error('Invalid root POST identity');
        }
      }
      if (!Number.isSafeInteger(e.bindingEpoch) || e.bindingEpoch < 1 ||
          !Number.isSafeInteger(e.generation) || e.generation < 1 ||
          Number.isNaN(Date.parse(e.observedAt)) ||
          (e.requestConversationId !== null &&
            !/^[A-Za-z0-9_-]{1,160}$/.test(e.requestConversationId))) {
        throw new Error('Invalid root POST epoch, timestamp or conversation');
      }
      const textHash = createHash('sha256').update(
        attempt.content.replaceAll('\r\n', '\n')).digest('hex');
      if (textHash !== e.textHash) throw new Error('Root POST exact content hash differs');
      const old = this.getRootDispatchEvidence(input);
      if (old) {
        const same = old.sessionId === e.sessionId && old.generation === e.generation &&
          old.pageKey === e.pageKey && old.targetId === e.targetId &&
          old.bindingEpoch === e.bindingEpoch && old.messageId === e.messageId &&
          old.parentMessageId === e.parentMessageId && old.textHash === e.textHash &&
          old.observedAt === e.observedAt &&
          old.requestConversationId === e.requestConversationId;
        if (!same && old.canonicalConversationId === null && !old.ambiguous) {
          this.#context.database.raw.prepare(
            'UPDATE kernel_root_dispatch_evidence' +
            ' SET observation_count=observation_count+1,ambiguous=1' +
            ' WHERE attempt_id=? AND canonical_conversation_id IS NULL',
          ).run(input.attemptId);
        }
        if (!same || old.ambiguous) {
          conflict = true;
          return this.getRootDispatchEvidence(input)!;
        }
        return old;
      }
      const slot = this.#context.requireSlot(task.projectId, task.slotId);
      const binding = this.#slots.getSlotBindingAtRevision(task.projectId, task.slotId,
        task.slotRevision, input.clientId);
      if (attempt.state !== 'dispatched' ||
          slot.activeTaskId !== task.taskId || slot.revision !== task.slotRevision ||
          slot.providerConversationId !== null || binding.providerConversationId !== null) {
        throw new Error('Root POST requires an exact active unbound dispatched initial');
      }
      this.#context.database.raw.prepare(
        'INSERT INTO kernel_root_dispatch_evidence' +
        '(attempt_id,task_id,provider_key,page_key,target_id,session_id,generation,' +
        'binding_epoch,observation_count,ambiguous,message_id,parent_message_id,' +
        'text_hash,observed_at,request_conversation_id,canonical_conversation_id)' +
        ' VALUES(?,?,?,?,?,?,?,?,1,0,?,?,?,?,?,NULL)',
      ).run(input.attemptId, task.taskId, binding.providerKey,
        e.pageKey, e.targetId, e.sessionId, e.generation, e.bindingEpoch,
        e.messageId, e.parentMessageId, e.textHash, e.observedAt, e.requestConversationId);
      this.#context.appendEvent(task, { type: 'attempt.root_post_recorded', attemptId: input.attemptId });
      return this.getRootDispatchEvidence(input)!;
    });
    if (conflict) throw new Error('Conflicting root POST evidence');
    return recorded;
  }

  getRootDispatchEvidence(input: {
    taskId: string; clientId: string; attemptId: string;
  }): RootDispatchEvidenceRecord | null {
    const task = this.#context.requireTask(input.taskId, input.clientId);
    this.#context.requireAttempt(input.attemptId, input.taskId);
    const row = this.#context.database.raw.prepare(
      'SELECT provider_key AS providerKey,page_key AS pageKey,target_id AS targetId,' +
      'session_id AS sessionId,generation,binding_epoch AS bindingEpoch,' +
      'observation_count AS observationCount,ambiguous,' +
      'message_id AS messageId,parent_message_id AS parentMessageId,' +
      'text_hash AS textHash,observed_at AS observedAt,' +
      'request_conversation_id AS requestConversationId,' +
      'canonical_conversation_id AS canonicalConversationId' +
      ' FROM kernel_root_dispatch_evidence WHERE attempt_id=? AND task_id=?',
    ).get(input.attemptId, input.taskId) as Row | undefined;
    if (!row) return null;
    const binding = this.#slots.getSlotBindingAtRevision(task.projectId, task.slotId,
      task.slotRevision, input.clientId);
    if (binding.providerKey !== String(row.providerKey)) {
      throw new Error('Root POST provider conflict');
    }
    return {
      sessionId: String(row.sessionId), generation: Number(row.generation),
      pageKey: String(row.pageKey), targetId: String(row.targetId),
      bindingEpoch: Number(row.bindingEpoch),
      observationCount: Number(row.observationCount),
      ambiguous: Number(row.ambiguous) === 1,
      messageId: String(row.messageId), parentMessageId: String(row.parentMessageId),
      textHash: String(row.textHash), observedAt: String(row.observedAt),
      requestConversationId: row.requestConversationId === null
        ? null : String(row.requestConversationId),
      canonicalConversationId: row.canonicalConversationId === null
        ? null : String(row.canonicalConversationId),
    };
  }

  promoteRootDispatchEvidence(input: {
    taskId: string; clientId: string; attemptId: string;
    conversationId: string; messageId: string; externalTurnId: string;
  }): AttemptRecord {
    if (!/^[A-Za-z0-9_-]{1,160}$/.test(input.conversationId) ||
        !input.messageId || !input.externalTurnId ||
        input.messageId.length > 512 || input.externalTurnId.length > 512) {
      throw new Error('Invalid canonical root ACK identity');
    }
    return this.#context.database.transaction(() => {
      const task = this.#context.requireTask(input.taskId, input.clientId);
      const attempt = this.#context.requireAttempt(input.attemptId, input.taskId);
      const root = this.getRootDispatchEvidence(input);
      if (!root || root.messageId !== input.messageId) {
        throw new Error('Canonical root ACK does not match the recorded POST');
      }
      if (root.ambiguous || root.observationCount !== 1) {
        throw new Error('Canonical root ACK requires one unambiguous observed POST');
      }
      if (root.requestConversationId !== null &&
          root.requestConversationId !== input.conversationId) {
        throw new Error('Root request used a different conversation');
      }
      if (root.canonicalConversationId !== null) {
        if (root.canonicalConversationId !== input.conversationId ||
            attempt.externalTurnId !== input.externalTurnId ||
            attempt.state !== 'acknowledged') {
          throw new Error('Conflicting prior root canonical ACK');
        }
        return attempt;
      }
      if (attempt.kind !== 'initial' ||
          !['dispatched', 'uncertain'].includes(attempt.state)) {
        throw new Error('Canonical root ACK requires an attempted initial');
      }
      const slot = this.#context.requireSlot(task.projectId, task.slotId);
      const binding = this.#slots.getSlotBindingAtRevision(task.projectId, task.slotId,
        task.slotRevision, input.clientId);
      if (slot.revision !== task.slotRevision || slot.activeTaskId !== task.taskId ||
          slot.providerConversationId !== null || binding.providerConversationId !== null) {
        throw new Error('Root Task lost its unbound conversation lease');
      }
      const at = this.#context.now();
      const slotChanged = this.#context.database.raw.prepare(
        'UPDATE kernel_slots SET provider_conversation_id=?,updated_at=?' +
        ' WHERE project_id=? AND slot_id=? AND revision=?' +
        ' AND active_task_id=? AND provider_conversation_id IS NULL',
      ).run(input.conversationId, at, task.projectId, task.slotId,
        task.slotRevision, task.taskId);
      const historyChanged = this.#context.database.raw.prepare(
        'UPDATE kernel_slot_bindings SET provider_conversation_id=?,observed_at=?' +
        ' WHERE project_id=? AND slot_id=? AND revision=?' +
        ' AND provider_conversation_id IS NULL',
      ).run(input.conversationId, at, task.projectId, task.slotId, task.slotRevision);
      if (slotChanged.changes !== 1 || historyChanged.changes !== 1) {
        throw new Error('Concurrent canonical root conversation binding changed');
      }
      this.#context.database.raw.prepare(
        'INSERT INTO kernel_dispatch_evidence' +
        '(attempt_id,task_id,provider_key,provider_conversation_id,message_id,' +
        'parent_message_id,text_hash,observed_at) VALUES(?,?,?,?,?,?,?,?)',
      ).run(input.attemptId, task.taskId, binding.providerKey,
        input.conversationId, root.messageId, root.parentMessageId,
        root.textHash, root.observedAt);
      this.#context.database.raw.prepare(
        'INSERT INTO kernel_attempt_session_bindings' +
        '(attempt_id,task_id,session_id,generation,provider_conversation_id,bound_at)' +
        ' VALUES(?,?,?,?,?,?)',
      ).run(input.attemptId, task.taskId, root.sessionId, root.generation,
        input.conversationId, at);
      this.#context.database.raw.prepare(
        'UPDATE kernel_root_dispatch_evidence SET canonical_conversation_id=?' +
        ' WHERE attempt_id=? AND canonical_conversation_id IS NULL',
      ).run(input.conversationId, input.attemptId);
      const afterEvidence = this.#context.appendEvent(task, {
        type: 'attempt.dispatch_evidence_recorded', attemptId: input.attemptId,
      });
      this.#context.appendEvent(afterEvidence, {
        type: 'attempt.acknowledged', attemptId: input.attemptId, kind: attempt.kind,
      });
      this.#context.database.raw.prepare(
        "UPDATE kernel_attempts SET state='acknowledged'," +
        'external_turn_id=?,acknowledged_at=? WHERE attempt_id=?',
      ).run(input.externalTurnId, at, input.attemptId);
      return this.#context.requireAttempt(input.attemptId, input.taskId);
    });
  }

  getDispatchEvidence(input: {
    taskId: string; clientId: string; attemptId: string;
  }): DispatchEvidenceRecord | null {
    const task = this.#context.requireTask(input.taskId, input.clientId);
    this.#context.requireAttempt(input.attemptId, input.taskId);
    const row = this.#context.database.raw.prepare(
      `SELECT provider_key AS providerKey,provider_conversation_id AS conversationId,
        message_id AS messageId,parent_message_id AS parentMessageId,
        text_hash AS textHash,observed_at AS observedAt
        FROM kernel_dispatch_evidence WHERE attempt_id=?`,
    ).get(input.attemptId) as (DispatchEvidenceRecord & { providerKey: string }) | undefined;
    if (row === undefined) return null;
    const binding = this.#slots.getSlotBindingAtRevision(task.projectId, task.slotId,
      task.slotRevision, input.clientId);
    if (row.providerKey !== binding.providerKey ||
      row.conversationId !== binding.providerConversationId) {
      throw new Error('Stored dispatch evidence no longer matches the slot binding');
    }
    return { conversationId: row.conversationId, messageId: row.messageId,
      parentMessageId: row.parentMessageId, textHash: row.textHash, observedAt: row.observedAt };
  }

  acknowledgeAttempt(input: {
    taskId: string;
    clientId: string;
    attemptId: string;
    externalTurnId: string;
  }): AttemptRecord {
    requireNonempty(input.externalTurnId, 'externalTurnId');
    return this.#context.database.transaction(() => {
      const task = this.#context.requireTask(input.taskId, input.clientId);
      const attempt = this.#context.requireAttempt(input.attemptId, task.taskId);
      if (attempt.state === 'acknowledged') {
        if (attempt.externalTurnId !== input.externalTurnId) throw new Error('ACK turn mismatch');
        return attempt;
      }
      if (attempt.state !== 'dispatched' && attempt.state !== 'uncertain') {
        throw new Error('ACK requires exact dispatched/uncertain attempt');
      }
      this.#context.appendEvent(task, {
        type: 'attempt.acknowledged', attemptId: input.attemptId, kind: attempt.kind,
      });
      this.#context.database.raw.prepare(
        `UPDATE kernel_attempts SET state='acknowledged',
          external_turn_id=?,acknowledged_at=? WHERE attempt_id=?`,
      ).run(input.externalTurnId, this.#context.now(), input.attemptId);
      return this.#context.requireAttempt(input.attemptId, task.taskId);
    });
  }

  markAttemptUncertain(taskId: string, clientId: string, attemptId: string, reason: string): TaskRecord {
    requireNonempty(reason, 'reason');
    return this.#context.database.transaction(() => {
      const task = this.#context.requireTask(taskId, clientId);
      const attempt = this.#context.requireAttempt(attemptId, taskId);
      if (attempt.state === 'uncertain') return task;
      if (attempt.state !== 'dispatched') throw new Error('Only dispatched attempt may become uncertain');
      const changed = this.#context.appendEvent(task, { type: 'attempt.uncertain', attemptId, reason });
      this.#context.database.raw.prepare(
        "UPDATE kernel_attempts SET state='uncertain', uncertain_reason=? WHERE attempt_id=?",
      ).run(reason, attemptId);
      return changed;
    });
  }

  recordAttemptFailedBeforeDispatch(taskId: string, clientId: string, attemptId: string, reason: string): TaskRecord {
    requireNonempty(reason, 'reason');
    return this.#context.database.transaction(() => {
      const task = this.#context.requireTask(taskId, clientId);
      const attempt = this.#context.requireAttempt(attemptId, taskId);
      if (attempt.state !== 'planned') throw new Error('May have dispatched: cannot label as never attempted');
      const next = this.#context.appendEvent(task, {
        type: 'attempt.failed_before_dispatch', attemptId, reason,
      });
      this.#context.database.raw.prepare(
        "UPDATE kernel_attempts SET state='failed_before_dispatch' WHERE attempt_id=?",
      ).run(attemptId);
      return next;
    });
  }

  recoverInterruptedDispatches(reason = 'core_restarted_before_exact_ack'): number {
    const rows = this.#context.database.raw.prepare(
      `SELECT a.attempt_id AS attemptId,a.task_id AS taskId,t.client_id AS clientId
        FROM kernel_attempts a JOIN kernel_tasks t ON t.task_id=a.task_id
        WHERE a.state='dispatched' ORDER BY a.created_at,a.attempt_id`,
    ).all() as Array<{ attemptId: string; taskId: string; clientId: string }>;
    for (const row of rows) {
      this.markAttemptUncertain(row.taskId, row.clientId, row.attemptId, reason);
    }
    return rows.length;
  }
}
