---
name: sessionplane
description: Route durable role-addressed AI chat sessions through the SessionPlane core using the sessplane CLI or MCP tools.
---

# SessionPlane

SessionPlane is a thin client workflow over one long-running local core. The core owns the browser profile, exact Playwright Pages, SQLite state, session actors, observers, recovery probes, and mutation serialization. Do not create competing browser, database, actor, or observer state in the agent process.

SessionPlane is provider-only, not a general browser tool. Use it only for
durable ChatGPT, Gemini, and Grok workflows. For Notion, GitHub, arbitrary
website login/navigation, forms, screenshots, or other browser automation, use
the installed Playwright/general browser skill instead. Never start a second
SessionPlane core, never pass --state-dir, and never use SessionPlane browser
primitives as a substitute for Playwright. If the canonical core is
unavailable, surface that condition instead of creating an isolated runtime.

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

## Provider continuity and ChatGPT Pro

- Provider availability is controlled by the running core. ChatGPT is the default enabled provider; Gemini or Grok require explicit operator enablement. Read `system.health.providers.enabled` when provider choice matters. Never create or switch to a provider that is not enabled; a typed `provider.disabled` result is authoritative until the operator changes the core allowlist.

- Provider is part of durable session identity. Preserve the current provider when reconstructing or replacing a session. Never switch providers as recovery for `waitExpired`, `submission_unknown`, model unavailability, consent/interstitial UI, rate limits, or observation failure. Use another provider only when the user or caller explicitly requested that provider.
- For ChatGPT, `model=Pro` is a model-family intent, not a version string. Let SessionPlane inspect the current model menu and choose the highest enabled Pro-family option; if the highest option is unavailable or disabled before submit, use the next enabled Pro-family option.
- Do not preflight or infer Pro availability from `/backend-api/models`, a partial model list, or one visible picker snapshot. ChatGPT can expose an Instant-only capability feed while the live composer picker still offers Pro. Submit the semantic `model=Pro` request through SessionPlane and let the provider adapter reconcile capability data with the live picker.
- Do not hard-code labels such as `6 Pro`, `5.6 Pro`, or future version numbers into agent logic. Preserve the `Pro` intent across fresh sessions and generations.
- Treat Pro as unavailable only when the current SessionPlane submission itself returns the typed pre-submit `provider.model-unavailable` result after its live-picker fallback. A catalog omission alone is not a blocker and must not be used to mark the task or product blocked. Do not silently create a Gemini or Grok session.
- Do not diagnose a rate limit from missing model entries. Call it rate limiting only when SessionPlane returns structured 429/deferred evidence or verified visible provider rate-limit evidence.
- Once submit may have happened, provider/model fallback must not resend the prompt. Keep the exact `sessionId + generation` and observe or surface the ambiguity.

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
