import type { ElementHandle, Page } from 'playwright-core';

import { PageMutationMutex } from '../browser/page-mutex.ts';
import { PageRegistry, PageRegistryError } from '../browser/page-registry.ts';
import { BrowserRefSnapshotStore, BrowserSnapshotError } from '../browser/ref-snapshot.ts';
import { SessionPlaneDomainError } from '../domain/errors.ts';
import { ActorScheduler } from '../scheduler/actor-scheduler.ts';
import type { SessionPlaneDatabase } from '../storage/database.ts';
import { hashCanonical, ReceiptRepository } from '../storage/receipt-repository.ts';
import { SessionRepository } from '../storage/session-repository.ts';

const MODEL_UI_ROOTS =
  'form button[aria-haspopup="menu"], [role="menu"]:has([role="slider"], [role="menuitemradio"], [role="option"])';

export class SessionUiService {
  readonly #database: SessionPlaneDatabase;
  readonly #sessions: SessionRepository;
  readonly #registry: PageRegistry;
  readonly #scheduler: ActorScheduler;
  readonly #mutex: PageMutationMutex;
  readonly #receipts: ReceiptRepository;
  readonly #chatgptOrigin: string;
  readonly #refs = new BrowserRefSnapshotStore();

  constructor(input: {
    database: SessionPlaneDatabase;
    registry: PageRegistry;
    scheduler: ActorScheduler;
    mutex: PageMutationMutex;
    receipts: ReceiptRepository;
    chatgptUrl: string;
  }) {
    this.#database = input.database;
    this.#sessions = new SessionRepository(input.database.raw);
    this.#registry = input.registry;
    this.#scheduler = input.scheduler;
    this.#mutex = input.mutex;
    this.#receipts = input.receipts;
    this.#chatgptOrigin = new URL(input.chatgptUrl).origin;
  }

  async inspect(sessionId: string, generation: number) {
    return await this.#scheduler.actorFor(sessionId).enqueue(async () => {
      const { pageKey } = this.#requirePreSubmit(sessionId, generation);
      return await this.#mutex.runExclusive(pageKey, async () => {
        const page = this.#requirePage(sessionId, generation, pageKey);
        return await this.#snapshot(pageKey, page);
      });
    });
  }

  async action(input: {
    clientId: string;
    requestId: string;
    sessionId: string;
    generation: number;
    snapshotId: string;
    ref: string;
    action: 'click' | 'press';
    key?: 'ArrowLeft' | 'ArrowRight' | 'ArrowUp' | 'ArrowDown' | 'Home' | 'End' | 'Enter' | 'Space' | undefined;
  }) {
    return await this.#scheduler.actorFor(input.sessionId).enqueue(async () => {
      const payload = {
        sessionId: input.sessionId,
        generation: input.generation,
        snapshotId: input.snapshotId,
        ref: input.ref,
        action: input.action,
        key: input.key ?? null,
      };
      const requestHash = hashCanonical({ method: 'session.ui.action', payload });
      const previous = this.#receipts.get(input.clientId, input.requestId);
      if (previous !== null) {
        if (previous.method !== 'session.ui.action' || previous.requestHash !== requestHash) {
          throw new SessionPlaneDomainError('input.idempotency-conflict', 'Request ID was already used with different input');
        }
        if (previous.status !== 'complete') {
          throw new SessionPlaneDomainError('provider.action-unknown', 'Model UI action may have occurred; inspect before another action');
        }
        return JSON.parse(previous.resultJson) as unknown;
      }
      const { pageKey } = this.#requirePreSubmit(input.sessionId, input.generation);
      return await this.#mutex.runExclusive(pageKey, async () => {
        const page = this.#requirePage(input.sessionId, input.generation, pageKey);
        const binding = this.#registry.refreshPage(pageKey);
        let element: ElementHandle<Element>;
        try {
          element = await this.#refs.resolve({
            pageKey,
            bindingEpoch: binding.bindingEpoch,
            page,
            ref: input.ref,
            snapshotId: input.snapshotId,
          });
        } catch (error) {
          throw typedUiError(error);
        }
        try {
          if (!(await isModelUiActionTarget(element, page))) {
            throw new SessionPlaneDomainError('capability.unsupported', 'Only model-menu controls can be changed');
          }
          if (input.action === 'press' && input.key === undefined) {
            throw new SessionPlaneDomainError('input.invalid', 'Press requires a key');
          }
          const now = new Date().toISOString();
          this.#database.raw.prepare(`
            INSERT INTO request_receipts(
              client_id, request_id, method, result_json, created_at,
              request_hash, status, updated_at
            ) VALUES (?, ?, 'session.ui.action', '{}', ?, ?, 'attempted', ?)
          `).run(input.clientId, input.requestId, now, requestHash, now);
          if (input.action === 'click') {
            await element.click();
          } else {
            await element.press(input.key ?? '');
          }
        } finally {
          await element.dispose();
        }
        this.#requirePreSubmit(input.sessionId, input.generation);
        this.#requirePage(input.sessionId, input.generation, pageKey);
        const result = await this.#snapshot(pageKey, page);
        this.#database.raw.prepare(`
          UPDATE request_receipts SET result_json = ?, status = 'complete', updated_at = ?
          WHERE client_id = ? AND request_id = ? AND status = 'attempted'
        `).run(JSON.stringify(result), new Date().toISOString(), input.clientId, input.requestId);
        return result;
      });
    });
  }

  #requirePreSubmit(sessionId: string, generation: number): {
    pageKey: string;
    conversationId: string | null;
  } {
    const snapshot = this.#sessions.getSnapshot(sessionId);
    if (snapshot === null || snapshot.generation !== generation) {
      throw new SessionPlaneDomainError('session.generation-superseded', 'Exact session generation is unavailable');
    }
    if (snapshot.provider !== 'chatgpt' || snapshot.promptSubmitted ||
        (snapshot.submissionState !== null && snapshot.submissionState !== 'failed_pre_submit')) {
      throw new SessionPlaneDomainError('capability.unsupported', 'Model UI is available only before ChatGPT submission');
    }
    if (snapshot.pageKey === null) {
      throw new SessionPlaneDomainError('browser.unavailable', 'Exact session page is unavailable');
    }
    return { pageKey: snapshot.pageKey, conversationId: snapshot.conversationId };
  }

  #requirePage(sessionId: string, generation: number, pageKey: string): Page {
    try {
      const { conversationId } = this.#requirePreSubmit(sessionId, generation);
      const page = this.#registry.requireSessionPage(pageKey, {
        sessionId,
        generation,
        conversationId,
      });
      if (new URL(page.url()).origin !== this.#chatgptOrigin) {
        throw new SessionPlaneDomainError('session.page-identity-unverified', 'Page left the ChatGPT origin');
      }
      return page;
    } catch (error) {
      throw typedUiError(error);
    }
  }

  async #snapshot(pageKey: string, page: Page) {
    try {
      const binding = this.#registry.refreshPage(pageKey);
      return await this.#refs.capture({
        pageKey,
        bindingEpoch: binding.bindingEpoch,
        page,
        rootSelector: MODEL_UI_ROOTS,
        maxNodes: 150,
      });
    } catch (error) {
      throw typedUiError(error);
    }
  }
}

async function isModelUiActionTarget(element: ElementHandle<Element>, page: Page): Promise<boolean> {
  return await page.evaluate((target) => {
    if (!(target instanceof Element)) return false;
    const opener = target.closest('form button[aria-haspopup="menu"]');
    if (opener instanceof HTMLButtonElement) {
      return opener.type !== 'submit' && !opener.disabled;
    }
    const menu = target.closest('[role="menu"]');
    if (menu === null || menu.id === '') return false;
    const linked = [...document.querySelectorAll('form button[aria-controls]')]
      .some((button) => button.getAttribute('aria-controls') === menu.id);
    if (!linked) return false;
    if (menu.querySelector('[role="slider"], [role="menuitemradio"], [role="option"]') === null) {
      return false;
    }
    const role = target.getAttribute('role');
    return role === 'menuitem' || role === 'menuitemradio' || role === 'slider' || role === 'option';
  }, element).catch(() => false);
}

function typedUiError(error: unknown): SessionPlaneDomainError {
  if (error instanceof SessionPlaneDomainError) return error;
  if (error instanceof PageRegistryError || error instanceof BrowserSnapshotError) {
    return new SessionPlaneDomainError(error.errorCode, error.message);
  }
  return new SessionPlaneDomainError('browser.unavailable', 'Exact session page is unavailable');
}
