import { createHash } from 'node:crypto';

import type { BrowserOwner } from '../browser/browser-owner.ts';
import type { PageRegistry } from '../browser/page-registry.ts';
import type { ActorScheduler } from '../scheduler/actor-scheduler.ts';
import type { TaskKernelRepository } from '../storage/task-kernel-repository.ts';
import type { TeamDirectory } from './team-directory.ts';

export interface PreparationReport {
  readonly kind: 'none' | 'waiting' | 'prepared';
  readonly taskId: string | null;
}

/**
 * Browser preparation is deliberately separate from the irreversible send.
 * A root ChatGPT page is only a reserved session target; it never establishes
 * a provider conversation or an acknowledged Task turn by itself.
 *
 * The one Core timer owns invocation. This class creates no new scheduler,
 * browser context, actor, task state machine, or persistent data store.
 */
export class PublicTaskPreparationService {
  readonly #repository: TaskKernelRepository;
  readonly #teams: TeamDirectory;
  readonly #scheduler: ActorScheduler;
  readonly #browserOwner: BrowserOwner | null;
  readonly #pages: PageRegistry;
  readonly #chatgptUrl: string;
  #lastScannedTaskId: string | null = null;

  constructor(input: {
    repository: TaskKernelRepository;
    teams: TeamDirectory;
    scheduler: ActorScheduler;
    browserOwner: BrowserOwner | null;
    pages: PageRegistry;
    chatgptUrl: string;
  }) {
    this.#repository = input.repository;
    this.#teams = input.teams;
    this.#scheduler = input.scheduler;
    this.#browserOwner = input.browserOwner;
    this.#pages = input.pages;
    this.#chatgptUrl = input.chatgptUrl;
  }

  /** One Task maximum per tick, after due sends and FINAL reads. */
  async prepareNext(): Promise<PreparationReport> {
    if (this.#browserOwner === null || this.#browserOwner.status.state !== 'ready') {
      return { kind: 'waiting', taskId: null };
    }
    // Keyset rotation is fair to other projects even if an earlier Task
    // remains on its already reserved root. The cursor owns no lifecycle.
    let pending = this.#repository.listPendingPublicPreparations(
      1, this.#lastScannedTaskId)[0];
    if (!pending) pending = this.#repository.listPendingPublicPreparations(1)[0];
    if (!pending) return { kind: 'none', taskId: null };
    this.#lastScannedTaskId = pending.taskId;
    if (pending.providerKey !== 'chatgpt') {
      return { kind: 'waiting', taskId: pending.taskId };
    }
    const { taskId, clientId, attemptId } = pending;
    const full = this.#repository.getFullTask(taskId, clientId);
    const slot = this.#repository.getSlot(full.task.projectId, full.task.slotId, clientId);
    if (slot.providerConversationId !== null || slot.activeTaskId !== taskId ||
        full.task.cancelRequested || full.task.state !== 'working' ||
        !full.attempts.some(attempt => attempt.attemptId === attemptId &&
          attempt.kind === 'initial' && attempt.state === 'planned')) {
      return { kind: 'waiting', taskId };
    }
    const root = new URL(this.#chatgptUrl);
    if (root.protocol !== 'https:' || root.username || root.password || root.search || root.hash ||
        root.pathname !== '/' || root.port !== '' || !root.hostname) {
      throw new Error('Public root preparation requires a canonical HTTPS provider origin');
    }
    const original = this.#teams.getCurrentSession(full.task.projectId, full.task.slotId);
    if (original.provider !== 'chatgpt' || original.terminal ||
        original.conversationId !== null || original.submittedUserMessageId !== null ||
        original.promptSubmitted) {
      return { kind: 'waiting', taskId };
    }

    // Record the exact initial generation once before any page allocation.
    // Existing generations, reservations and page keys survive reconnection.
    const session = original.generation === 0
      ? await this.#scheduler.startGeneration({
        sessionId: original.sessionId, expectedGeneration: 0, teamBriefVersion: 0,
        promptHash: createHash('sha256').update(full.task.originalPrompt).digest('hex'),
      })
      : original;
    if (session.generation < 1) return { kind: 'waiting', taskId };

    let pageKey = session.pageKey;
    if (pageKey === null) {
      const retained = this.#pages.listBindings({ includeClosed: false }).filter(binding =>
        binding.sessionId === session.sessionId &&
        binding.generation === session.generation &&
        binding.expectedConversationId === null &&
        binding.conversationId === null && binding.state === 'reserved');
      if (retained.length > 1) {
        throw new Error('Ambiguous previously reserved root page: never allocate a second target');
      }
      if (retained.length === 1) {
        pageKey = retained[0]!.pageKey;
      } else {
        const current = this.#repository.getTask(taskId, clientId);
        if (current.state !== 'working' || current.cancelRequested) {
          return { kind: 'waiting', taskId };
        }
        // This uses the existing dedicated owner; createPage starts a
        // background CDP target and never activates the foreground.
        const created = await this.#browserOwner.createPage();
        try {
          this.#pages.reservePage(created.binding.pageKey, {
            sessionId: session.sessionId, generation: session.generation,
            conversationId: null,
          });
        } catch (error) {
          await created.page.close().catch(() => undefined);
          throw error;
        }
        pageKey = created.binding.pageKey;
      }
      await this.#scheduler.updateGeneration(session.sessionId, session.generation,
        { pageKey }, 'public.task.root-page-reserved');
    }
    const bound = this.#pages.refreshPage(pageKey);
    if (bound.sessionId !== session.sessionId ||
        bound.generation !== session.generation ||
        bound.expectedConversationId !== null || bound.conversationId !== null ||
        bound.state !== 'reserved') {
      return { kind: 'waiting', taskId };
    }
    const page = this.#pages.requireSessionPage(pageKey, {
      sessionId: session.sessionId, generation: session.generation,
      conversationId: null,
    });
    if (page.url() === 'about:blank') {
      await page.goto(root.href, { waitUntil: 'commit', timeout: 8_000 });
      this.#pages.refreshPage(pageKey);
    }
    const final = this.#pages.getBinding(pageKey);
    const atRoot = final.url === root.href &&
      final.state === 'reserved' && final.conversationId === null &&
      final.sessionId === session.sessionId &&
      final.generation === session.generation;
    if (atRoot) {
      const latest = this.#teams.getSession(session.sessionId);
      if (latest.sessionState !== 'ready' || latest.pageKey !== pageKey) {
        await this.#scheduler.updateGeneration(session.sessionId, session.generation,
          { sessionState: 'ready', providerState: 'unknown' },
          'public.task.root-page-observed');
      }
      return { kind: 'prepared', taskId };
    }
    // Login redirect or a provider-chosen conversation requires independent
    // evidence; merely seeing a new URL must not bind the user's Task.
    return { kind: 'waiting', taskId };
  }
}
