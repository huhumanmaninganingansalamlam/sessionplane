import type { DatabaseSync } from 'node:sqlite';

import type { PageBindingSnapshot } from '../browser/page-binding.ts';

export interface StoredPageBinding {
  readonly pageKey: string;
  readonly bindingEpoch: number;
  readonly teamId: string | null;
  readonly roleId: string | null;
  readonly sessionId: string | null;
  readonly generation: number | null;
  readonly conversationId: string | null;
  readonly bindingState: string;
  readonly url: string;
  readonly lastSeenAt: string;
}

interface SessionOwnerRow {
  readonly teamId: string;
  readonly roleId: string;
}

export class PageBindingRepository {
  readonly #database: DatabaseSync;

  constructor(database: DatabaseSync) {
    this.#database = database;
  }

  upsert(binding: PageBindingSnapshot): void {
    const owner =
      binding.sessionId === null
        ? null
        : (this.#database
            .prepare(`
              SELECT team_id AS teamId, role_id AS roleId
              FROM sessions
              WHERE session_id = ?
            `)
            .get(binding.sessionId) as SessionOwnerRow | undefined) ?? null;
    this.#database
      .prepare(`
        INSERT INTO page_bindings(
          page_key, binding_epoch, team_id, role_id, session_id, generation,
          conversation_id, binding_state, url, last_seen_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(page_key) DO UPDATE SET
          binding_epoch = excluded.binding_epoch,
          team_id = excluded.team_id,
          role_id = excluded.role_id,
          session_id = excluded.session_id,
          generation = excluded.generation,
          conversation_id = excluded.conversation_id,
          binding_state = excluded.binding_state,
          url = excluded.url,
          last_seen_at = excluded.last_seen_at
      `)
      .run(
        binding.pageKey,
        binding.bindingEpoch,
        owner?.teamId ?? null,
        owner?.roleId ?? null,
        binding.sessionId,
        binding.generation,
        binding.conversationId,
        binding.state,
        binding.url,
        binding.lastSeenAt,
      );
  }

  get(pageKey: string): StoredPageBinding | null {
    const row = this.#database
      .prepare(`
        SELECT
          page_key AS pageKey,
          binding_epoch AS bindingEpoch,
          team_id AS teamId,
          role_id AS roleId,
          session_id AS sessionId,
          generation,
          conversation_id AS conversationId,
          binding_state AS bindingState,
          url,
          last_seen_at AS lastSeenAt
        FROM page_bindings
        WHERE page_key = ?
      `)
      .get(pageKey) as StoredPageBinding | undefined;
    return row === undefined
      ? null
      : {
          ...row,
          bindingEpoch: Number(row.bindingEpoch),
          generation: row.generation === null ? null : Number(row.generation),
        };
  }

  listForSession(sessionId: string): readonly StoredPageBinding[] {
    const rows = this.#database
      .prepare(`
        SELECT
          page_key AS pageKey,
          binding_epoch AS bindingEpoch,
          team_id AS teamId,
          role_id AS roleId,
          session_id AS sessionId,
          generation,
          conversation_id AS conversationId,
          binding_state AS bindingState,
          url,
          last_seen_at AS lastSeenAt
        FROM page_bindings
        WHERE session_id = ?
        ORDER BY last_seen_at, page_key
      `)
      .all(sessionId) as unknown as StoredPageBinding[];
    return rows.map((row) => ({
      ...row,
      bindingEpoch: Number(row.bindingEpoch),
      generation: row.generation === null ? null : Number(row.generation),
    }));
  }
}
