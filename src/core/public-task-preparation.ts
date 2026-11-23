import { createHash } from 'node:crypto';

import type { BrowserOwner } from '../browser/browser-owner.ts';
import type { PageRegistry } from '../browser/page-registry.ts';
import type { ActorScheduler } from '../scheduler/actor-scheduler.ts';
import type { PageBindingRepository } from '../storage/page-binding-repository.ts';
import type { KernelStores } from '../storage/kernel/create-kernel-stores.ts';
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
  readonly #repository: Pick<KernelStores, 'projects' | 'tasks' | 'attempts' | 'scans'>;
  readonly #teams: TeamDirectory;
  readonly #scheduler: ActorScheduler;
  readonly #browserOwner: BrowserOwner | null;
  readonly #pages: PageRegistry;
  readonly #pageBindings: PageBindingRepository | undefined;
  readonly #chatgptUrl: string;

  constructor(input: {
    repository: Pick<KernelStores, 'projects' | 'tasks' | 'attempts' | 'scans'>;
    teams: TeamDirectory;
    scheduler: ActorScheduler;
    browserOwner: BrowserOwner | null;
    pages: PageRegistry;
    pageBindings?: PageBindingRepository;
    chatgptUrl: string;
  }) {
    this.#repository = input.repository;
    this.#teams = input.teams;
    this.#scheduler = input.scheduler;
    this.#browserOwner = input.browserOwner;
    this.#pages = input.pages;
    this.#pageBindings = input.pageBindings;
    this.#chatgptUrl = input.chatgptUrl;
  }

  /** One Task maximum per tick, after due sends and FINAL reads. */
  async prepareNext(): Promise<PreparationReport> {
    if (this.#browserOwner === null || this.#browserOwner.status.state !== 'ready') {
      return { kind: 'waiting', taskId: null };
    }
    // An existing canonical Main requires a safely owned page just as a new
    // root does. Alternate preparation classes to avoid starving either one.
    const preferBoundTask = this.#repository.scans.claimPreparationPrefersBound();
    if (preferBoundTask) {
      const bound = await this.#prepareBoundConversation();
      if (bound.kind !== 'none') return bound;
    }
    // The root cursor survives Core restart. Selecting one candidate does
    // not allocate a tab, POST or authorize a provider action.
    const pending = this.#repository.scans.scanPendingPreparations(1)[0];
    if (!pending) return await this.#prepareBoundConversation();
    if (pending.providerKey !== 'chatgpt') {
      return { kind: 'waiting', taskId: pending.taskId };
    }
    const { taskId, clientId, attemptId } = pending;
    const full = this.#repository.tasks.readTaskAggregate(taskId, clientId);
    const slot = this.#repository.projects.getConversationSlot(full.task.projectId, full.task.slotId, clientId);
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
        const current = this.#repository.tasks.getTask(taskId, clientId);
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

  /**
   * A completed Main can retain its exact canonical slot after its former tab
   * was closed. Reopen that same conversation in the adopted Chrome only for a
   * PLANNED initial Task. Never create another project, Core, browser, or POST.
   * A live foreign/ambiguous target is held rather than adopted or navigated.
   */
  async #prepareBoundConversation(): Promise<PreparationReport> {
    for (const planned of this.#repository.scans.scanPendingBoundPreparations(8)) {
      const { taskId, clientId, attemptId } = planned;
      const task = this.#repository.tasks.getTask(taskId, clientId);
      const slot = this.#repository.projects.getConversationSlot(task.projectId, task.slotId, clientId);
      if (slot.providerKey !== 'chatgpt' || slot.providerConversationId === null) continue;
      if (slot.activeTaskId !== taskId || slot.revision !== task.slotRevision ||
          task.state !== 'working' || task.cancelRequested) {
        return { kind: 'waiting', taskId };
      }
      const conversationId = slot.providerConversationId;
      if (conversationId.startsWith('WEB:')) return { kind: 'waiting', taskId };
      const session = this.#teams.getCurrentSession(task.projectId, task.slotId);
      if (session.provider !== 'chatgpt' || session.terminal ||
          session.conversationId !== conversationId || session.generation < 1) {
        return { kind: 'waiting', taskId };
      }
      const root = new URL(this.#chatgptUrl);
      if (root.protocol !== 'https:' || root.username || root.password ||
          root.search || root.hash || root.pathname !== '/' ||
          root.port !== '' || !root.hostname) {
        throw new Error('Bound conversation requires a canonical HTTPS provider origin');
      }
      const exactUrl = root.origin + '/c/' + encodeURIComponent(conversationId);
      const existing = this.#liveConversationPages(conversationId, exactUrl);
      if (existing.length > 1) return { kind: 'waiting', taskId };
      const prior = session.pageKey === null
        ? null : this.#pageBindings?.get(session.pageKey) ?? null;
      if (existing.length === 1) {
        const page = existing[0]!;
        if (page.url !== exactUrl || page.targetId === null) {
          return { kind: 'waiting', taskId };
        }
        const alreadyOwned = page.state === 'owned' &&
          page.sessionId === session.sessionId &&
          page.generation === session.generation;
        const retainedOwner = page.state === 'unbound' &&
          page.sessionId === null && page.generation === null &&
          prior !== null && prior.targetId === page.targetId &&
          prior.sessionId === session.sessionId &&
          prior.generation === session.generation &&
          prior.conversationId === conversationId;
        if (!alreadyOwned && !retainedOwner) return { kind: 'waiting', taskId };
        if (retainedOwner) {
          this.#pages.bindPage(page.pageKey, {
            sessionId: session.sessionId, generation: session.generation,
            conversationId,
          });
        }
        if (session.pageKey !== page.pageKey) {
          await this.#scheduler.updateGeneration(
            session.sessionId, session.generation, { pageKey: page.pageKey },
            'public.task.exact-main-target-rebound',
          );
        }
        return { kind: 'prepared', taskId };
      }
      // A retained target at another URL may now belong to the user. Do not
      // navigate or silently replace it; the Task remains safely unsubmitted.
      if (prior?.targetId && this.#pages.listBindings({ includeClosed: false })
        .some(page => page.targetId === prior.targetId)) {
        return { kind: 'waiting', taskId };
      }
      const browserOwner = this.#browserOwner;
      if (browserOwner === null) return { kind: 'waiting', taskId };
      const latest = this.#repository.tasks.readTaskAggregate(taskId, clientId);
      if (latest.task.cancelRequested || latest.task.state !== 'working' ||
          !latest.attempts.some(attempt => attempt.attemptId === attemptId &&
            attempt.kind === 'initial' && attempt.state === 'planned')) {
        return { kind: 'waiting', taskId };
      }
      const created = await browserOwner.createPage();
      let bound = false;
      try {
        await created.page.goto(exactUrl, { waitUntil: 'commit', timeout: 8_000 });
        const page = this.#pages.refreshPage(created.binding.pageKey);
        const candidates = this.#liveConversationPages(conversationId, exactUrl);
        if (page.url !== exactUrl || page.conversationId !== conversationId ||
            page.state !== 'unbound' || page.sessionId !== null ||
            page.generation !== null || page.targetId === null ||
            candidates.length !== 1 || candidates[0]!.pageKey !== page.pageKey) {
          return { kind: 'waiting', taskId };
        }
        const currentTask = this.#repository.tasks.getTask(taskId, clientId);
        const currentSlot = this.#repository.projects.getConversationSlot(task.projectId, task.slotId, clientId);
        const currentSession = this.#teams.getCurrentSession(task.projectId, task.slotId);
        if (currentTask.state !== 'working' || currentTask.cancelRequested ||
            currentSlot.activeTaskId !== taskId ||
            currentSlot.providerConversationId !== conversationId ||
            currentSlot.revision !== currentTask.slotRevision ||
            currentSession.sessionId !== session.sessionId ||
            currentSession.generation !== session.generation ||
            currentSession.conversationId !== conversationId) {
          return { kind: 'waiting', taskId };
        }
        this.#pages.bindPage(page.pageKey, {
          sessionId: session.sessionId, generation: session.generation,
          conversationId,
        });
        bound = true;
        await this.#scheduler.updateGeneration(
          session.sessionId, session.generation, { pageKey: page.pageKey },
          'public.task.exact-main-page-reopened',
        );
        return { kind: 'prepared', taskId };
      } finally {
        if (!bound) await created.page.close().catch(() => undefined);
      }
    }
    return { kind: 'none', taskId: null };
  }

  /**
   * A navigation event can lag behind page.goto(). Inspect live URLs before
   * allocating a target, without rewriting unrelated tabs' bindings each tick.
   */
  #liveConversationPages(
    conversationId: string,
    exactUrl: string,
  ): ReturnType<PageRegistry['listBindings']> {
    const canonical = new URL(exactUrl);
    const matches = new Map<string, ReturnType<PageRegistry['listBindings']>[number]>();
    for (const cached of this.#pages.findByConversation(conversationId)) {
      matches.set(cached.pageKey, cached);
    }
    for (const binding of this.#pages.listBindings({ includeClosed: false })) {
      let actualUrl: string;
      try {
        actualUrl = this.#pages.pageForObservation(binding.pageKey).url();
      } catch {
        continue;
      }
      const actual = new URL(actualUrl);
      if (actual.origin !== canonical.origin || actual.pathname !== canonical.pathname) continue;
      matches.set(binding.pageKey, actualUrl !== binding.url ||
        binding.conversationId !== conversationId
        ? this.#pages.refreshPage(binding.pageKey) : binding);
    }
    return [...matches.values()];
  }
}
