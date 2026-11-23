import type { KernelStores } from '../../storage/kernel/create-kernel-stores.ts';
import type { PageRegistry } from '../../browser/page-registry.ts';
import type { PageBindingRepository } from '../../storage/page-binding-repository.ts';
import type { TeamDirectory } from '../team-directory.ts';
import type { ActorScheduler } from '../../scheduler/actor-scheduler.ts';

export async function restoreSemanticPageBindings(input: {
  readonly repository: KernelStores;
  readonly teamDirectory: TeamDirectory;
  readonly pageRegistry: PageRegistry;
  readonly pageBindings: PageBindingRepository;
  readonly actorScheduler: ActorScheduler;
  readonly chatgptUrl: string;
}): Promise<{ scanned: number; rebound: number; held: number }> {
  const owners = input.repository.scans.scanCurrentPublicPageOwners('chatgpt');
  const providerOrigin = new URL(input.chatgptUrl).origin;
  let rebound = 0;
  let held = 0;
  for (const owner of owners) {
    try {
      const session = input.teamDirectory.getCurrentSession(owner.projectId, owner.slotId);
      if (session.teamId !== owner.projectId || session.roleKey !== owner.slotId ||
          session.provider !== 'chatgpt' || session.generation < 1 ||
          session.pageKey === null ||
          session.conversationId !== owner.providerConversationId) {
        held++;
        continue;
      }
      const persisted = input.pageBindings.get(session.pageKey);
      if (!persisted || persisted.targetId === null ||
          persisted.sessionId !== session.sessionId ||
          persisted.generation !== session.generation ||
          (session.conversationId !== null &&
            persisted.conversationId !== session.conversationId)) {
        held++;
        continue;
      }
      const candidates = input.pageRegistry.listBindings({ includeClosed: false })
        .filter(binding => binding.targetId === persisted.targetId);
      if (candidates.length !== 1) {
        held++;
        continue;
      }
      const page = input.pageRegistry.refreshPage(candidates[0]!.pageKey);
      if (page.state !== 'unbound' || page.sessionId !== null ||
          page.generation !== null || page.targetId !== persisted.targetId) {
        // Idempotent when this Core already restored the same exact generation.
        if (page.sessionId === session.sessionId &&
            page.generation === session.generation &&
            page.pageKey === session.pageKey &&
            page.conversationId === session.conversationId &&
            (page.state === 'owned' || page.state === 'reserved')) {
          rebound++;
          continue;
        }
        held++;
        continue;
      }
      const url = new URL(page.url);
      if (session.conversationId !== null) {
        if (page.conversationId !== session.conversationId ||
            input.pageRegistry.findByConversation(session.conversationId).length !== 1 ||
            url.origin !== providerOrigin ||
            url.pathname !== `/c/${encodeURIComponent(session.conversationId)}` ||
            url.search !== '' || url.hash !== '') {
          held++;
          continue;
        }
        input.pageRegistry.bindPage(page.pageKey, {
          sessionId: session.sessionId, generation: session.generation,
          conversationId: session.conversationId,
        });
      } else if (page.conversationId === null &&
          (page.url === 'about:blank' ||
            (url.origin === providerOrigin && url.pathname === '/' &&
              url.search === '' && url.hash === ''))) {
        input.pageRegistry.reservePage(page.pageKey, {
          sessionId: session.sessionId, generation: session.generation,
          conversationId: null,
        });
      } else if (page.conversationId !== null &&
          url.origin === providerOrigin &&
          url.pathname === `/c/${encodeURIComponent(page.conversationId)}` &&
          url.search === '' && url.hash === '') {
        // A root POST may have navigated to a conversation before exact ACK.
        // Retain target identity for read-only canonical reconciliation only.
        input.pageRegistry.reserveUnknownConversationCandidate(page.pageKey, {
          sessionId: session.sessionId, generation: session.generation,
          targetId: persisted.targetId,
        });
      } else {
        held++;
        continue;
      }
      await input.actorScheduler.updateGeneration(session.sessionId, session.generation,
        { pageKey: page.pageKey }, 'semantic.restart-exact-target-rebound');
      rebound++;
    } catch {
      // Missing or stale identity must fail closed, never become a new POST.
      held++;
    }
  }
  return { scanned: owners.length, rebound, held };
}
