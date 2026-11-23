import type { APIRequestContext } from "playwright-core";
import type { BackendJsonClient } from "../backend-recovery.ts";

export function chatGptBackendJsonClient(request: APIRequestContext): BackendJsonClient {
  return {
    authScope: request,
    async get(url, options) {
      const response = await request.get(url, {
        failOnStatusCode: false,
        ...(options.headers ? { headers: { ...options.headers } } : {}),
        timeout: options.timeoutMs,
      });
      try {
        return { status: response.status(), headers: response.headers(),
          body: await response.json().catch(() => null) };
      } finally { await response.dispose(); }
    },
  };
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
