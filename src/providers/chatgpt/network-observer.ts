import type { Page, Request, Response, WebSocket } from 'playwright-core';

import type { ProviderWakeReason } from '../provider-adapter.ts';

export interface ChatGptNetworkSnapshot {
  readonly revision: number;
  readonly activity: boolean;
  readonly lastActivityAt: string | null;
}

interface NetworkWaiter {
  readonly afterRevision: number;
  readonly resolve: (reason: ProviderWakeReason) => void;
  readonly timer: NodeJS.Timeout;
  readonly cleanup: () => void;
}

interface WebSocketListeners {
  readonly onFrame: () => void;
  readonly onClose: () => void;
}

export class ChatGptNetworkObserver {
  readonly #page: Page;
  readonly #now: () => Date;
  readonly #waiters = new Map<number, NetworkWaiter>();
  readonly #webSockets = new Map<WebSocket, WebSocketListeners>();
  #revision = 0;
  #nextWaiterId = 1;
  #lastActivityAt: string | null = null;
  #closed = false;

  readonly #onRequest = (request: Request): void => {
    if (isRelevantRequest(request)) {
      this.#recordActivity();
    }
  };

  readonly #onResponse = (response: Response): void => {
    if (isRelevantRequest(response.request())) {
      this.#recordActivity();
    }
  };

  readonly #onWebSocket = (socket: WebSocket): void => {
    if (!isChatGptUrl(socket.url())) {
      return;
    }
    const onFrame = (): void => this.#recordActivity();
    const onClose = (): void => {
      const listeners = this.#webSockets.get(socket);
      if (listeners !== undefined) {
        socket.off('framereceived', listeners.onFrame);
        socket.off('framesent', listeners.onFrame);
        socket.off('close', listeners.onClose);
        this.#webSockets.delete(socket);
      }
    };
    this.#webSockets.set(socket, { onFrame, onClose });
    socket.on('framereceived', onFrame);
    socket.on('framesent', onFrame);
    socket.on('close', onClose);
    this.#recordActivity();
  };

  constructor(page: Page, options: { readonly now?: () => Date } = {}) {
    this.#page = page;
    this.#now = options.now ?? (() => new Date());
    page.on('request', this.#onRequest);
    page.on('response', this.#onResponse);
    page.on('websocket', this.#onWebSocket);
  }

  get revision(): number {
    return this.#revision;
  }

  snapshot(afterRevision: number): ChatGptNetworkSnapshot {
    return {
      revision: this.#revision,
      activity: this.#revision > afterRevision,
      lastActivityAt: this.#lastActivityAt,
    };
  }

  async waitForActivity(
    afterRevision: number,
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<ProviderWakeReason> {
    if (this.#closed || signal?.aborted === true) {
      return 'timer';
    }
    if (this.#revision > afterRevision) {
      return 'network';
    }

    return await new Promise<ProviderWakeReason>((resolve) => {
      const waiterId = this.#nextWaiterId;
      this.#nextWaiterId += 1;
      let settled = false;
      const finish = (reason: ProviderWakeReason): void => {
        if (settled) {
          return;
        }
        settled = true;
        const waiter = this.#waiters.get(waiterId);
        if (waiter !== undefined) {
          clearTimeout(waiter.timer);
          waiter.cleanup();
          this.#waiters.delete(waiterId);
        }
        resolve(reason);
      };
      const timer = setTimeout(() => finish('timer'), timeoutMs);
      timer.unref?.();
      const onAbort = (): void => finish('timer');
      signal?.addEventListener('abort', onAbort, { once: true });
      const cleanup = (): void => signal?.removeEventListener('abort', onAbort);
      this.#waiters.set(waiterId, {
        afterRevision,
        resolve: (reason) => finish(reason),
        timer,
        cleanup,
      });
    });
  }

  close(): void {
    if (this.#closed) {
      return;
    }
    this.#closed = true;
    this.#page.off('request', this.#onRequest);
    this.#page.off('response', this.#onResponse);
    this.#page.off('websocket', this.#onWebSocket);
    for (const [socket, listeners] of this.#webSockets) {
      socket.off('framereceived', listeners.onFrame);
      socket.off('framesent', listeners.onFrame);
      socket.off('close', listeners.onClose);
    }
    this.#webSockets.clear();
    for (const [waiterId, waiter] of this.#waiters) {
      clearTimeout(waiter.timer);
      waiter.cleanup();
      this.#waiters.delete(waiterId);
      waiter.resolve('timer');
    }
  }

  #recordActivity(): void {
    if (this.#closed) {
      return;
    }
    this.#revision += 1;
    this.#lastActivityAt = this.#now().toISOString();
    for (const [waiterId, waiter] of this.#waiters) {
      if (this.#revision <= waiter.afterRevision) {
        continue;
      }
      clearTimeout(waiter.timer);
      waiter.cleanup();
      this.#waiters.delete(waiterId);
      waiter.resolve('network');
    }
  }
}

function isRelevantRequest(request: Request): boolean {
  const resourceType = request.resourceType();
  return (
    (resourceType === 'fetch' || resourceType === 'xhr' || resourceType === 'websocket') &&
    isChatGptUrl(request.url())
  );
}

function isChatGptUrl(value: string): boolean {
  try {
    const hostname = new URL(value).hostname.toLowerCase();
    return (
      hostname === 'chatgpt.com' ||
      hostname.endsWith('.chatgpt.com') ||
      hostname === 'openai.com' ||
      hostname.endsWith('.openai.com')
    );
  } catch {
    return false;
  }
}
