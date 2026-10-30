import type { DatabaseSync } from 'node:sqlite';

import type { PageBindingSnapshot } from '../browser/page-binding.ts';

export interface StoredPageBinding {
  readonly pageKey: string;
  readonly targetId: string | null;
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

export class PageBindingRepository {
  readonly #database: DatabaseSync;

  constructor(database: DatabaseSync) {
    this.#database = database;
  }

  /** Organization only: an exact retained target never grants page ownership. */
  uniqueTeamForTarget(targetId: string): string | null {
    const teams = this.#database.prepare('SELECT DISTINCT team_id AS teamId FROM page_bindings WHERE target_id = ? AND team_id IS NOT NULL')
      .all(targetId) as { teamId: string }[];
    return teams.length === 1 ? teams[0]!.teamId : null;
  }

  /** A retired startup target is disposable only after this session moved elsewhere. */
  isObsoleteEmptyTarget(sessionId: string, targetId: string): boolean {
    const owners = this.#database.prepare(`SELECT session_id AS sessionId, generation,
      conversation_id AS conversationId, url FROM page_bindings
      WHERE target_id=? AND session_id IS NOT NULL`).all(targetId) as
      { sessionId: string; generation: number | null; conversationId: string | null; url: string }[];
    return owners.length > 0 && owners.every(row => row.sessionId === sessionId && row.generation === 0 &&
      row.conversationId === null && row.url === 'https://chatgpt.com/') &&
      this.#database.prepare(`SELECT 1 FROM sessions s JOIN page_bindings p ON p.page_key=s.page_key
        WHERE p.target_id=? LIMIT 1`).get(targetId) === undefined;
  }

  /** Close a current empty UI without retiring its role or fabricating a conversation. */
  isUnusedCurrentEmptyTarget(sessionId: string, targetId: string): boolean {
    return this.#database.prepare(`SELECT 1 FROM sessions s
      JOIN team_roles r ON r.role_id=s.role_id AND r.current_session_id=s.session_id
      JOIN page_bindings current ON current.page_key=s.page_key
      WHERE s.session_id=? AND current.target_id=? AND s.current_generation=0 AND s.conversation_id IS NULL
        AND s.provider='chatgpt' AND s.session_state='created' AND r.role_state='active'
        AND NOT EXISTS (SELECT 1 FROM generations g WHERE g.session_id=s.session_id)
        AND NOT EXISTS (SELECT 1 FROM outbox o WHERE o.session_id=s.session_id)
        AND NOT EXISTS (SELECT 1 FROM page_bindings p WHERE p.target_id=current.target_id AND p.session_id IS NOT NULL
          AND (p.session_id<>s.session_id OR p.generation IS NOT 0 OR p.conversation_id IS NOT NULL))
        AND NOT EXISTS (SELECT 1 FROM sessions other JOIN page_bindings p ON p.page_key=other.page_key
          WHERE p.target_id=current.target_id AND other.session_id<>s.session_id)
      LIMIT 1`).get(sessionId, targetId) !== undefined;
  }

  upsert(binding: PageBindingSnapshot): void {
    this.#database
      .prepare(`
        INSERT INTO page_bindings(
          page_key, binding_epoch, team_id, role_id, session_id, generation,
          conversation_id, binding_state, url, last_seen_at, target_id
        )
        SELECT ?, ?, s.team_id, s.role_id, ?, ?, ?, ?, ?, ?, ?
        FROM (SELECT ? AS session_id) binding
        LEFT JOIN sessions s ON s.session_id = binding.session_id
        WHERE true
        ON CONFLICT(page_key) DO UPDATE SET
          target_id = excluded.target_id,
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
        binding.sessionId,
        binding.generation,
        binding.conversationId,
        binding.state,
        binding.url,
        binding.lastSeenAt,
        binding.targetId ?? null,
        binding.sessionId,
      );
  }

  get(pageKey: string): StoredPageBinding | null {
    const row = this.#database
      .prepare(`
        SELECT
          page_key AS pageKey,
          target_id AS targetId,
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
          target_id AS targetId,
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
