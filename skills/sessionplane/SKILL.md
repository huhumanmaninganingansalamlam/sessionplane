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
- The core may recover a unique exact-prompt acknowledgement read-only and resume observation on the same generation; keep waiting on its exact `sessionId + generation` and never resend it.

Every ChatGPT send requires caller-directed preparation. There is no automatic
selection/send compatibility path and no `assistedPreparation` input. A `structuredContent.errorCode` of
`provider.preparation-required` has `isError: true` but keeps the original
generation pending; `details` carries its `requestId`, `sessionId`,
`generation`, and nonterminal `snapshot`. Inspect with that exact identity, then
use `sessionplane_preparation_decide` with a fresh `snapshotId` and observed
`ref`. Inspect again before each decision. A slider choice needs an explicit
numeric `value`. Composer and send choices only identify controls; core fills
and submits on `sessionplane_preparation_resume`. Resume the original request
once, then wait on the same session and generation. Cancel with a
`sessionplane_preparation_decide` call using `decision: "cancel"` if the
requested intent cannot be matched to evidence. Use MCP preparation tools to continue; CLI send begins the same preparation wait.

## Provider continuity and ChatGPT Pro

- Provider availability is controlled by the running core. ChatGPT is the default enabled provider; Gemini or Grok require explicit operator enablement. Read `system.health.providers.enabled` when provider choice matters. Never create or switch to a provider that is not enabled; a typed `provider.disabled` result is authoritative until the operator changes the core allowlist.

- Provider is part of durable session identity. Preserve the current provider when reconstructing or replacing a session. Never switch providers as recovery for `waitExpired`, `submission_unknown`, model unavailability, consent/interstitial UI, rate limits, or observation failure. Use another provider only when the user or caller explicitly requested that provider.
- Do not hard-code labels such as `6 Pro`, `5.6 Pro`, or future version numbers into agent logic. Preserve the `Pro` intent across fresh sessions and generations.
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

## Literal prompt transport and ambiguous submissions

Prefer `sessionplane_send` with structured JSON arguments. For CLI bodies from
files use `--prompt-file PATH`; for piped text use `--prompt-stdin`. Choose exactly
one of these or `--prompt`. Never interpolate arbitrary prompt text into shell
command strings. Keep the original request ID and exact payload for idempotent
replay; missing output or shell failure is not evidence of non-submission.

When a generation remains `submission_unknown`, call
`sessionplane_submission_inspect` with its original `clientId`, `requestId`,
`sessionId`, and `generation`. This explicitly attempts read-only acknowledgement
recovery and returns the current snapshot, requested prompt/model/effort, and
live page evidence, including after automatic recovery has expired. It also handles existing ambiguous records. If it recovers the exact user identity, wait on
the same generation for the answer. Otherwise report what the evidence shows;
do not keep claiming an answer is generating merely because wait is nonterminal.
A draft or absent message does not authorize retry. Obtain an explicit operator
decision before replacement/resubmission; do not use preparation resume to resend.

## Mandatory ChatGPT preparation

Every `sessionplane_send` starts preparation before filling or submitting. Preserve
`model=Pro` when requested. Inspect current UI, choose matching model and effort
when requested, and choose composer/send controls from fresh observed refs. Use
`sessionplane_preparation_decide` and then `sessionplane_preparation_resume` on
the original request and generation. No old automatic selector or opt-in flag
exists. CLI send is also a preparation request, not an immediate browser submit.
If intent cannot be satisfied, cancel preparation; do not silently change intent.
