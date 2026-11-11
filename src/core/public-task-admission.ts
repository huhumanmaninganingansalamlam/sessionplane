import { createHash, randomUUID } from 'node:crypto';

import type { TeamDirectory } from './team-directory.ts';
import type { SessionPlaneDatabase } from '../storage/database.ts';
import type {
  SlotRecord, TaskKernelRepository, TaskRecord,
} from '../storage/task-kernel-repository.ts';

const MAIN_SLOT = 'main';
const INTERVAL_MS = 20 * 60_000;

export interface PublicProjectInput {
  readonly clientId: string;
  readonly requestId: string;
  readonly projectKey: string;
  readonly displayName: string;
  readonly provider: string;
  readonly surfaceIntent: 'chat';
  readonly modelIntent?: string | undefined;
}
export interface PublicProjectMapping {
  readonly projectId: string;
  readonly projectKey: string;
  readonly displayName: string;
  readonly mainConversationSlotId: string;
  readonly conversationRevision: number;
  readonly currentTaskId: string | null;
  readonly provider: string;
  readonly surfaceIntent: string;
  readonly modelIntent: string | null;
}
export type PublicContinuationPolicy =
  | { readonly enabled: false }
  | { readonly enabled: true; readonly approvalRef: string;
      readonly intervalMs: 1200000; readonly message: string };
export interface PublicTaskStartInput {
  readonly clientId: string;
  readonly requestId: string;
  readonly projectId: string;
  readonly conversationSlotId?: string | undefined;
  readonly expectedConversationRevision: number;
  readonly prompt: string;
  readonly continuationPolicy?: PublicContinuationPolicy | undefined;
}
export interface PublicTaskAdmission {
  readonly taskId: string;
  readonly projectId: string;
  readonly conversationSlotId: string;
  readonly conversationRevision: number;
  readonly state: string;
  readonly preparation: 'not_bound' | 'conversation_bound';
  readonly submission: { readonly attempted: boolean; readonly acknowledged: boolean };
}
interface PublicProjectRow {
  projectId: string; ownerClientId: string; publicProjectKey: string;
  providerKey: string; surfaceIntent: string; modelIntent: string | null;
  mainSlotId: string; displayName: string;
}
interface RequestRow {
  projectId: string; inputSha256: string;
}
interface AdmissionRow {
  inputSha256: string; acceptedRevision: number; policyJson: string;
}

function hash(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}
function normalizedKey(value: string): string {
  const key = value.normalize('NFKC').trim().replace(/\s+/g, ' ').toLowerCase();
  if (key.length === 0) throw new Error('Public project key must be nonempty');
  return key;
}

/**
 * Durable Task admission, never a second workflow or a direct provider
 * sender. New projects have no page and no external conversation ID:
 * admission creates an exact planned attempt, not a fabricated send receipt.
 */
export class PublicTaskAdmissionService {
  readonly #db: SessionPlaneDatabase;
  readonly #store: TaskKernelRepository;
  readonly #teams: TeamDirectory;
  constructor(input: {
    database: SessionPlaneDatabase;
    repository: TaskKernelRepository;
    teamDirectory: TeamDirectory;
  }) {
    this.#db = input.database;
    this.#store = input.repository;
    this.#teams = input.teamDirectory;
  }

  openProject(input: PublicProjectInput): PublicProjectMapping {
    const key = normalizedKey(input.projectKey);
    // The public product contract defaults ChatGPT projects to Pro, not an
    // unspecified model which could silently inherit another UI selection.
    const requested = input.modelIntent?.trim() || null;
    const model = requested === null
      ? (input.provider === 'chatgpt' ? 'Pro' : null)
      : requested.toLowerCase() === 'pro' ? 'Pro' : requested;
    const payloadHash = hash([
      key, input.displayName, input.provider, input.surfaceIntent, model,
    ]);
    return this.#db.transaction(() => {
      const previous = this.#db.raw.prepare(
        'SELECT project_id AS projectId,input_sha256 AS inputSha256' +
        ' FROM kernel_public_project_open_requests WHERE owner_client_id=? AND request_id=?',
      ).get(input.clientId, input.requestId) as RequestRow | undefined;
      if (previous && previous.inputSha256 !== payloadHash) {
        throw new Error('Project open request identity conflict');
      }
      const prior = this.#db.raw.prepare(
        'SELECT i.project_id AS projectId,i.owner_client_id AS ownerClientId,' +
        ' i.public_project_key AS publicProjectKey,i.provider_key AS providerKey,' +
        ' i.surface_intent AS surfaceIntent,i.model_intent AS modelIntent,' +
        ' i.main_slot_id AS mainSlotId,p.display_name AS displayName' +
        ' FROM kernel_public_project_intents i JOIN kernel_projects p' +
        ' ON p.project_id=i.project_id' +
        ' WHERE i.owner_client_id=? AND i.public_project_key=?',
      ).get(input.clientId, key) as PublicProjectRow | undefined;

      let projectId: string;
      if (prior) {
        if (prior.providerKey !== input.provider ||
            prior.surfaceIntent !== input.surfaceIntent ||
            prior.modelIntent !== model) {
          throw new Error('Project intent conflict; explicit revision is required');
        }
        projectId = prior.projectId;
      } else {
        this.#teams.requireEnabledProvider(input.provider);
        const team = this.#teams.createTeam({
          clientId: input.clientId, name: input.displayName,
          primaryRoleKey: MAIN_SLOT,
        });
        projectId = team.teamId;
        const scopedKey = 'public:' + hash([input.clientId, key]);
        this.#store.openProject({
          projectId, projectKey: scopedKey,
          displayName: input.displayName, clientId: input.clientId,
        });
        this.#store.openSlot({
          projectId, clientId: input.clientId, slotId: MAIN_SLOT,
          roleKey: MAIN_SLOT, providerKey: input.provider,
        });
        this.#db.raw.prepare(
          'INSERT INTO kernel_public_project_intents' +
          '(project_id,owner_client_id,public_project_key,provider_key,' +
          ' surface_intent,model_intent,main_slot_id,created_at)' +
          ' VALUES(?,?,?,?,?,?,?,?)',
        ).run(projectId, input.clientId, key, input.provider,
          input.surfaceIntent, model, MAIN_SLOT, new Date().toISOString());
        this.#db.raw.prepare(
          'INSERT INTO kernel_public_slot_revisions(project_id,slot_id,revision)' +
          ' VALUES(?,?,1)',
        ).run(projectId, MAIN_SLOT);
      }
      if (!previous) {
        this.#db.raw.prepare(
          'INSERT INTO kernel_public_project_open_requests' +
          '(owner_client_id,request_id,project_id,input_sha256,created_at)' +
          ' VALUES(?,?,?,?,?)',
        ).run(input.clientId, input.requestId, projectId,
          payloadHash, new Date().toISOString());
      } else if (previous.projectId !== projectId) {
        throw new Error('Project open request belongs to another project');
      }
      const row = this.#db.raw.prepare(
        'SELECT i.project_id AS projectId,i.owner_client_id AS ownerClientId,' +
        ' i.public_project_key AS publicProjectKey,i.provider_key AS providerKey,' +
        ' i.surface_intent AS surfaceIntent,i.model_intent AS modelIntent,' +
        ' i.main_slot_id AS mainSlotId,p.display_name AS displayName' +
        ' FROM kernel_public_project_intents i JOIN kernel_projects p' +
        ' ON p.project_id=i.project_id WHERE i.project_id=?',
      ).get(projectId) as unknown as PublicProjectRow;
      const slot = this.#store.getSlot(projectId, row.mainSlotId, input.clientId);
      return this.#mapping(row, slot, input.clientId);
    });
  }

  startTask(input: PublicTaskStartInput): PublicTaskAdmission {
    const policy: PublicContinuationPolicy = input.continuationPolicy ?? { enabled: false };
    if (policy.enabled && (policy.intervalMs !== INTERVAL_MS ||
        policy.approvalRef.trim().length === 0 ||
        policy.message.trim().length === 0)) {
      throw new Error('Continuation approval requires exact interval, text and delegation');
    }
    return this.#db.transaction(() => {
      const publicProject = this.#db.raw.prepare(
        'SELECT main_slot_id AS mainSlotId,provider_key AS providerKey' +
        ' FROM kernel_public_project_intents WHERE project_id=?',
      ).get(input.projectId) as { mainSlotId: string; providerKey: string } | undefined;
      if (!publicProject) throw new Error('Unknown public project identity');
      const slotId = input.conversationSlotId ?? publicProject.mainSlotId;
      const slot = this.#store.getSlot(input.projectId, slotId, input.clientId);
      if (slot.providerKey === 'chatgpt' && policy.enabled && policy.message !== '계속') {
        throw new Error('ChatGPT managed continuation requires the exact literal 계속');
      }
      const exactInputHash = hash([
        input.projectId, slotId, input.expectedConversationRevision,
        input.prompt, policy,
      ]);
      const prior = this.#db.raw.prepare(
        'SELECT task_id AS taskId FROM kernel_tasks' +
        ' WHERE project_id=? AND client_id=? AND request_id=?',
      ).get(input.projectId, input.clientId, input.requestId) as
        { taskId: string } | undefined;
      if (prior) {
        const recorded = this.#db.raw.prepare(
          'SELECT input_sha256 AS inputSha256,accepted_revision AS acceptedRevision,' +
          ' policy_json AS policyJson FROM kernel_public_task_policies WHERE task_id=?',
        ).get(prior.taskId) as AdmissionRow | undefined;
        if (!recorded || recorded.inputSha256 !== exactInputHash) {
          throw new Error('Task start request identity conflict');
        }
        const task = this.#store.getTask(prior.taskId, input.clientId);
        return this.#taskReceipt(task, slot, recorded.acceptedRevision);
      }
      const revision = this.#store.getConversationRevision(
        input.projectId, slotId, input.clientId);
      if (revision !== input.expectedConversationRevision) {
        throw new Error('Conversation revision conflict; re-read the current slot');
      }
      if (slot.activeTaskId !== null) {
        throw new Error('Conversation busy; prior Task still owns the slot');
      }
      const taskId = cryptoRandomUuid();
      const task = this.#store.startTask({
        taskId, projectId: input.projectId, slotId,
        expectedSlotRevision: slot.revision,
        clientId: input.clientId, requestId: input.requestId, prompt: input.prompt,
      });
      this.#store.planAttempt({
        taskId, clientId: input.clientId, attemptId: cryptoRandomUuid(),
        kind: 'initial', turnKey: 'initial', content: input.prompt,
      });
      this.#db.raw.prepare(
        'INSERT INTO kernel_public_task_policies' +
        '(task_id,policy_json,input_sha256,accepted_revision,created_at)' +
        ' VALUES(?,?,?,?,?)',
      ).run(taskId, JSON.stringify(policy), exactInputHash, revision + 1,
        new Date().toISOString());
      const advanced = this.#db.raw.prepare(
        'UPDATE kernel_public_slot_revisions SET revision=revision+1' +
        ' WHERE project_id=? AND slot_id=? AND revision=?',
      ).run(input.projectId, slotId, revision);
      if (advanced.changes !== 1) {
        throw new Error('Concurrent conversation revision conflict');
      }
      // This is a storage-only session shell; provider-specific preparation
      // and exact page/conversation binding remain Core work, never inferred
      // from task admission or a successful client call.
      const team = this.#teams.getTeam(input.projectId);
      const role = team.roles.find(row => row.roleKey === slot.roleKey);
      if (!role) throw new Error('Missing stable project conversation role');
      if (role.currentSessionId === null) {
        this.#teams.createSession({
          teamId: input.projectId, roleKey: slot.roleKey, provider: slot.providerKey,
        });
      }
      return this.#taskReceipt(this.#store.getTask(task.taskId, input.clientId),
        slot, revision + 1);
    });
  }

  #mapping(
    row: PublicProjectRow, slot: SlotRecord, clientId: string,
  ): PublicProjectMapping {
    return {
      projectId: row.projectId,
      projectKey: row.publicProjectKey,
      displayName: row.displayName,
      mainConversationSlotId: row.mainSlotId,
      conversationRevision: this.#store.getConversationRevision(
        row.projectId, row.mainSlotId, clientId),
      currentTaskId: slot.activeTaskId,
      provider: row.providerKey,
      surfaceIntent: row.surfaceIntent,
      modelIntent: row.modelIntent,
    };
  }

  #taskReceipt(
    task: TaskRecord, slot: SlotRecord, acceptedRevision: number,
  ): PublicTaskAdmission {
    const attempted = this.#store.getFullTask(task.taskId, task.clientId).attempts;
    return {
      taskId: task.taskId,
      projectId: task.projectId,
      conversationSlotId: task.slotId,
      conversationRevision: acceptedRevision,
      state: task.state,
      preparation: slot.providerConversationId === null ? 'not_bound' : 'conversation_bound',
      submission: {
        attempted: attempted.some(row => row.state !== 'planned'),
        acknowledged: attempted.some(row => row.state === 'acknowledged'),
      },
    };
  }
}

function cryptoRandomUuid(): string {
  // Deliberately nonpredictable task/attempt identities. SQLite's unique
  // (project, client, request) receipt, not a deterministic ID, provides replay.
  return randomUUID();
}
