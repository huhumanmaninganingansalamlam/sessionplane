import type { Row } from './row-codecs.ts';
import type { ProjectRecord, SlotRecord, SlotBindingRecord } from './records.ts';
import { requireNonempty, decodeProjectRow, decodeSlotBindingRow } from './row-codecs.ts';
import type { KernelTransactionContext } from './transaction-context.ts';

export class ProjectSlotStore {
  readonly #context: KernelTransactionContext;

  constructor(context: KernelTransactionContext) {
    this.#context = context;
  }

  openProject(input: {
    projectId: string;
    projectKey: string;
    displayName: string;
    clientId: string;
  }): ProjectRecord {
    for (const [name, value] of Object.entries(input)) requireNonempty(value, name);
    return this.#context.database.transaction(() => {
      const row = this.#context.database.raw.prepare(
        'SELECT project_id AS projectId, project_key AS projectKey, display_name AS displayName FROM kernel_projects WHERE project_key = ?',
      ).get(input.projectKey) as Row | undefined;
      if (row) {
        const existing = decodeProjectRow(row);
        this.#context.requireAccess(existing.projectId, input.clientId);
        if (existing.projectId !== input.projectId) throw new Error('Project identity conflict');
        return existing;
      }
      this.#context.database.raw.prepare(
        'INSERT INTO kernel_projects(project_id,project_key,display_name,created_at) VALUES(?,?,?,?)',
      ).run(input.projectId, input.projectKey, input.displayName, this.#context.now());
      this.#context.database.raw.prepare(
        "INSERT INTO kernel_project_access(project_id,client_id,access_role) VALUES(?,?,'owner')",
      ).run(input.projectId, input.clientId);
      return {
        projectId: input.projectId,
        projectKey: input.projectKey,
        displayName: input.displayName,
      };
    });
  }

  grantProjectAccess(projectId: string, ownerClientId: string, clientId: string): void {
    requireNonempty(clientId, 'clientId');
    this.#context.database.transaction(() => {
      this.#context.requireAccess(projectId, ownerClientId, 'owner');
      this.#context.database.raw.prepare(
        "INSERT INTO kernel_project_access(project_id,client_id,access_role) VALUES(?,?,'member') ON CONFLICT(project_id,client_id) DO NOTHING",
      ).run(projectId, clientId);
    });
  }

  openConversationSlot(input: {
    projectId: string;
    clientId: string;
    slotId: string;
    roleKey: string;
    providerKey: string;
  }): SlotRecord {
    for (const [name, value] of Object.entries(input)) requireNonempty(value, name);
    return this.#context.database.transaction(() => {
      this.#context.requireAccess(input.projectId, input.clientId);
      const found = this.#context.findSlot(input.projectId, input.slotId);
      if (found) {
        if (found.roleKey !== input.roleKey || found.providerKey !== input.providerKey) {
          throw new Error('Slot role/provider conflict; explicit binding replacement required');
        }
        // Existing non-Main slots predate public admission. Preserve their
        // current binding revision rather than defaulting it back to Main.
        this.#context.database.raw.prepare(
          'INSERT INTO kernel_public_slot_revisions(project_id,slot_id,revision)' +
          ' VALUES(?,?,?) ON CONFLICT(project_id,slot_id) DO NOTHING',
        ).run(input.projectId, input.slotId, found.revision);
        return found;
      }
      const at = this.#context.now();
      this.#context.database.raw.prepare(
        `INSERT INTO kernel_slots(project_id,slot_id,role_key,provider_key,
          provider_conversation_id,revision,active_task_id,created_at,updated_at)
          VALUES(?,?,?,?,NULL,1,NULL,?,?)`,
      ).run(input.projectId, input.slotId, input.roleKey, input.providerKey, at, at);
      this.#context.database.raw.prepare(
        `INSERT INTO kernel_slot_bindings(project_id,slot_id,revision,provider_key,
          provider_conversation_id,observed_at) VALUES(?,?,1,?,NULL,?)`,
      ).run(input.projectId, input.slotId, input.providerKey, at);
      // Every explicitly bound logical slot, not only Main, must have an
      // independently addressable public Task revision. The FK guarantees
      // that it cannot be initialized before its own stable slot exists.
      this.#context.database.raw.prepare(
        'INSERT INTO kernel_public_slot_revisions(project_id,slot_id,revision)' +
        ' VALUES(?,?,1) ON CONFLICT(project_id,slot_id) DO NOTHING',
      ).run(input.projectId, input.slotId);
      return this.#context.requireSlot(input.projectId, input.slotId);
    });
  }

  getConversationSlot(projectId: string, slotId: string, clientId: string): SlotRecord {
    this.#context.requireAccess(projectId, clientId);
    return this.#context.requireSlot(projectId, slotId);
  }

  findAuthorizedConversationSlot(projectId: string, slotId: string, clientId: string): SlotRecord | null {
    this.#context.requireAccess(projectId, clientId);
    return this.#context.findSlot(projectId, slotId);
  }

  ensurePublicConversationRevision(projectId: string, slotId: string, clientId: string): number {
    this.#context.requireAccess(projectId, clientId);
    const slot = this.#context.requireSlot(projectId, slotId);
    this.#context.database.raw.prepare(
      'INSERT INTO kernel_public_slot_revisions(project_id,slot_id,revision)' +
      ' VALUES(?,?,?) ON CONFLICT(project_id,slot_id) DO NOTHING',
    ).run(projectId, slotId, slot.revision);
    return this.getPublicConversationRevision(projectId, slotId, clientId);
  }

  getPublicConversationRevision(projectId: string, slotId: string, clientId: string): number {
    this.#context.requireAccess(projectId, clientId);
    const row = this.#context.database.raw.prepare(
      'SELECT revision FROM kernel_public_slot_revisions WHERE project_id=? AND slot_id=?',
    ).get(projectId, slotId) as { revision: number } | undefined;
    return row?.revision ?? this.#context.requireSlot(projectId, slotId).revision;
  }

  getSlotBindingAtRevision(
    projectId: string, slotId: string, revision: number, clientId: string,
  ): SlotBindingRecord {
    this.#context.requireAccess(projectId, clientId);
    const row = this.#context.database.raw.prepare(
      `SELECT project_id AS projectId,slot_id AS slotId,revision,
        provider_key AS providerKey,provider_conversation_id AS providerConversationId
        FROM kernel_slot_bindings WHERE project_id=? AND slot_id=? AND revision=?`,
    ).get(projectId, slotId, revision) as Row | undefined;
    if (!row) throw new Error('Missing immutable historical slot binding');
    return decodeSlotBindingRow(row);
  }

  bindObservedConversation(input: {
    projectId: string;
    clientId: string;
    slotId: string;
    expectedRevision: number;
    taskId: string;
    providerConversationId: string;
  }): SlotRecord {
    requireNonempty(input.providerConversationId, 'providerConversationId');
    return this.#context.database.transaction(() => {
      this.#context.requireAccess(input.projectId, input.clientId);
      const slot = this.#context.requireSlot(input.projectId, input.slotId);
      if (slot.revision !== input.expectedRevision || slot.activeTaskId !== input.taskId) {
        throw new Error('Stale slot revision or task lease');
      }
      if (slot.providerConversationId !== null &&
        slot.providerConversationId !== input.providerConversationId) {
        throw new Error('Observed provider conversation differs from bound identity');
      }
      this.#context.database.raw.prepare(
        'UPDATE kernel_slots SET provider_conversation_id = ?, updated_at = ? WHERE project_id = ? AND slot_id = ?',
      ).run(input.providerConversationId, this.#context.now(), input.projectId, input.slotId);
      const history = this.#context.database.raw.prepare(
        `UPDATE kernel_slot_bindings SET provider_conversation_id=?,observed_at=?
          WHERE project_id=? AND slot_id=? AND revision=?
            AND (provider_conversation_id IS NULL OR provider_conversation_id=?)`,
      ).run(input.providerConversationId, this.#context.now(), input.projectId, input.slotId,
        slot.revision, input.providerConversationId);
      if (history.changes !== 1) throw new Error('Historical provider binding conflict');
      return this.#context.requireSlot(input.projectId, input.slotId);
    });
  }

  replaceConversationBinding(input: {
    projectId: string;
    clientId: string;
    slotId: string;
    expectedRevision: number;
    providerKey: string;
    providerConversationId: string | null;
  }): SlotRecord {
    requireNonempty(input.providerKey, 'providerKey');
    return this.#context.database.transaction(() => {
      this.#context.requireAccess(input.projectId, input.clientId);
      const slot = this.#context.requireSlot(input.projectId, input.slotId);
      if (slot.revision !== input.expectedRevision || slot.activeTaskId !== null) {
        throw new Error('Stale or busy slot; preserve unresolved task identity');
      }
      const changed = this.#context.database.raw.prepare(
        `UPDATE kernel_slots SET provider_key = ?, provider_conversation_id = ?,
          revision = revision + 1, updated_at = ?
          WHERE project_id = ? AND slot_id = ? AND revision = ? AND active_task_id IS NULL`,
      ).run(input.providerKey, input.providerConversationId, this.#context.now(),
        input.projectId, input.slotId, slot.revision);
      if (changed.changes !== 1) throw new Error('Concurrent slot revision conflict');
      this.#context.database.raw.prepare(
        `INSERT INTO kernel_slot_bindings(project_id,slot_id,revision,provider_key,
          provider_conversation_id,observed_at) VALUES(?,?,?,?,?,?)`,
      ).run(input.projectId, input.slotId, slot.revision + 1,
        input.providerKey, input.providerConversationId, this.#context.now());
      // A deliberate provider conversation replacement is a public
      // conversation revision even when no new Task is being admitted.
      // Otherwise a caller holding an old revision can accidentally send
      // into a different conversation. Advance this slot's admission CAS
      // atomically with its immutable binding history. Old schema-12 slots
      // without public metadata begin from the new binding revision.
      this.#context.database.raw.prepare(
        'INSERT INTO kernel_public_slot_revisions(project_id,slot_id,revision)' +
        ' VALUES(?,?,?) ON CONFLICT(project_id,slot_id)' +
        ' DO UPDATE SET revision=revision+1',
      ).run(input.projectId, input.slotId, slot.revision + 1);
      return this.#context.requireSlot(input.projectId, input.slotId);
    });
  }

  readPublicModelIntent(projectId: string, clientId: string): string | null {
    this.#context.requireAccess(projectId, clientId);
    const row = this.#context.database.raw.prepare(
      'SELECT model_intent AS modelIntent FROM kernel_public_project_intents' +
      ' WHERE project_id=?',
    ).get(projectId) as { modelIntent: string | null } | undefined;
    return row?.modelIntent ?? null;
  }
}
