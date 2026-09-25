---
name: sessionplane
description: Route durable role-addressed AI chat sessions through the SessionPlane MCP tools, including agent-directed preparation and exact-generation answers.
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

Use the registered SessionPlane MCP tools for the complete ChatGPT workflow.
Before sending, discover `sessionplane_preparation_inspect`,
`sessionplane_preparation_decide`, and `sessionplane_preparation_resume` in the
client's tool catalog. MCP resources are not the tool catalog: an empty resource
list or an unknown CLI command does not establish that an MCP tool is absent.
If the server is missing, configure the client's stdio MCP server as `sessplane
mcp` (Codex: `codex mcp add sessionplane -- sessplane mcp`) and load that
configuration. Skills installation alone does not register the server.
Use the client's MCP connection rather than manually managing JSON-RPC through
a shell subprocess. After reconnect or compaction, inspect the same pending
request using its original four-part identity and fresh evidence; no new send
is needed. `wait` does not advance a preparation request.

1. Preserve the durable `teamId` in task state.
2. At task start or resume, call `sessionplane_team_get` or `sessplane team show <teamId> --json` before selecting a role or session.
3. Address role operations with exact `teamId + roleKey`. For generation-specific reads and waits, preserve the returned `sessionId + generation`.
4. Never infer identity from browser focus, active tab, title, recency, page index, display name, or a remembered “last session.”
5. Use a stable `clientId`. Every mutation also requires a stable `requestId`; reuse it only to retry the exact same operation and payload.

## Send and wait

- Start the request with `sessionplane_send`, then complete its preparation workflow below.
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
and submits on `sessionplane_preparation_resume`. Resume the original request until submission is acknowledged, then wait on the same session and generation. Cancel with a
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

If no send button exists before typing, choose model/effort and composer first,
then resume. A preparation-required response can mean the prompt is filled but
not submitted: inspect again, choose the newly visible send control, and resume
the same request/generation. A collapsed model/effort chooser can confirm the
current displayed selection without clicking. Interpret slider values using the
full observed popup text; core verifies the chosen value, not model-name guesses.

## Conversation replacement and cleanup

- `provider.conversation-unavailable` means a failed conversation fetch and absent
  conversation surface, not ongoing generation or proof of non-submission. Inspect
  the exact request with `sessionplane_submission_inspect`; it returns live evidence
  and original prompt/model/effort/surface/attachment identities/deadline. Respect
  `nextCheckAt`; a backend 429 alone does not justify replacement.
- For an unreadable conversation or a completed long conversation the caller decides
  to rotate, use `sessionplane_session_create` with the same team, role and provider.
  It changes current role routing and records `predecessorSessionId`. Carry a concise
  role handoff, required artifacts and unchanged model intent into fresh preparation.
  Do not rotate at an arbitrary message count or blindly replay unresolved work.
  Apply an existing operator instruction to replace and continue; do not ask again.
- Replacement does not delete provider history. Cleanup requires completed role work
  and retrieval of required answers/artifacts. Never delete active, unacknowledged
  or unrecovered conversations merely because a successor exists.

Use `sessionplane_session_delete` to delete the provider conversation history itself,
not just its browser tab. Pass the exact `sessionId`, `generation`, `conversationId`,
a stable `requestId`, and `outputsRetrieved: true` only after retrieving required
answers/artifacts. Local answers remain available. `provider.deletion-unknown`
is reconciled by calling the same tool with the same request ID: it reads provider state
without repeating deletion. Never create a fresh request ID to force another deletion.

Role replacement and role retirement prevent new submissions to the old route;
already submitted generations keep observing, including after restart. Retrieve
their exact session/generation outputs before deleting completed history.

For `provider.observation-unavailable`, inspect `reason`:
- `dom-observation-timeout`: the browser read did not finish; paced server recovery continues.
- `provider-actionable-alert`: an actionable alert follows the exact submitted turn.
  Call `sessionplane_submission_inspect` and interpret the live evidence. Partial
  text is not a verified final. Do not repeat waits as if generation were progressing.

Neither condition proves non-submission. Apply the caller's explicit recovery
intent when choosing replacement; inspection never authorizes an automatic resend.
