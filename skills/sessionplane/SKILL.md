---
name: sessionplane
description: Route durable role-addressed AI chat sessions through the SessionPlane core using the sessplane CLI or MCP tools.
---

# SessionPlane

SessionPlane is a thin client workflow over one long-running local core. The core owns the browser profile, exact Playwright Pages, SQLite state, session actors, observers, recovery probes, and mutation serialization. Do not create competing browser, database, actor, or observer state in the agent process.

## Required identity workflow

1. Preserve the durable `teamId` in task state.
2. At task start or resume, call `sessionplane_team_get` or `sessplane team show <teamId> --json` before selecting a role or session.
3. Address role operations with exact `teamId + roleKey`. For generation-specific reads and waits, preserve the returned `sessionId + generation`.
4. Never infer identity from browser focus, active tab, title, recency, page index, display name, or a remembered “last session.”
5. Use a stable `clientId`. Every mutation also requires a stable `requestId`; reuse it only to retry the exact same operation and payload.

## Send and wait

- Submit with `sessionplane_send` or `sessplane send <teamId> <roleKey> --prompt ... --request-id ...`.
- Keep the returned `sessionId` and `generation` and use them for `sessionplane_wait` or `sessplane wait --session <sessionId> --generation <generation>`.
- `waitExpired: true` is a successful nonterminal response. It ends only the client wait; the core actor and provider generation continue.
- `observationTransport: "deferred"` with a backend 429 reason is a successful nonterminal observation state, not provider blocking and not a reason to resend.
- `providerState: "blocked"` is accepted only when returned as structured core state from verified visible provider evidence.
- `submission_unknown` means a submit may have occurred. Never issue a new requestId automatically to resend it.

## Team coordination

- A team contains one primary role and directly attached expert, reviewer, or custom roles.
- SessionPlane does not select experts, fan out prompts, synthesize answers, or inject one role’s answer into another role’s prompt. The caller owns explicit coordination and context selection.
- `sessionplane_team_wait` observes existing actors only. A wait does not create provider work.

## MCP examples

```json
{
  "name": "sessionplane_team_get",
  "arguments": {
    "clientId": "codex-main",
    "teamId": "<team-uuid>"
  }
}
```

```json
{
  "name": "sessionplane_send",
  "arguments": {
    "clientId": "codex-main",
    "requestId": "task-123-expert-backend-generation-1",
    "teamId": "<team-uuid>",
    "roleKey": "expert.backend",
    "prompt": "Review the backend failure path.",
    "sessionDeadlineSec": 5400
  }
}
```

## CLI examples

```bash
sessplane team show "$TEAM_ID" --client-id codex-main --json
sessplane role add "$TEAM_ID" expert.backend --type expert \
  --client-id codex-main --request-id task-123-role-backend --json
sessplane session create "$TEAM_ID" expert.backend --provider chatgpt \
  --client-id codex-main --request-id task-123-session-backend --json
sessplane send "$TEAM_ID" expert.backend --prompt "Review the backend failure path." \
  --client-id codex-main --request-id task-123-backend-generation-1 --json
sessplane wait --session "$SESSION_ID" --generation "$GENERATION" \
  --client-id codex-main --json
```

Treat CLI JSON and MCP `structuredContent` as the canonical core schema. Do not reclassify nonterminal states into client errors.
