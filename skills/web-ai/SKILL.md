---
name: web-ai
description: Run durable ChatGPT, Gemini, and Grok sessions through SessionPlane teams, roles, generations, uploads, waits, and artifacts.
---

# SessionPlane Web AI

The core owns provider Pages and continues observation after the calling shell
or MCP subprocess exits. Preserve `teamId`, `roleKey`, `sessionId`, and
`generation`; never select a chat by active tab or title.

Use SessionPlane only for ChatGPT, Gemini, and Grok provider workflows. General
browser automation belongs to Playwright/the general browser skill. Do not
start another SessionPlane core, do not pass --state-dir, and do not use
SessionPlane to log into or manipulate unrelated websites.

```bash
sessplane team create --name issue-123 --request-id issue-123-team --json
sessplane role add "$TEAM_ID" expert.backend --type expert \
  --request-id issue-123-backend-role --json
sessplane session create "$TEAM_ID" expert.backend --provider chatgpt \
  --request-id issue-123-backend-session --json
sessplane send "$TEAM_ID" expert.backend --prompt "Review this" \
  --file ./context.md --request-id issue-123-backend-1 --json
sessplane wait --session "$SESSION_ID" --generation "$GENERATION" --json
```

`waitExpired` and backend observation deferral are nonterminal success states.
`submission_unknown` must never be automatically resent. Use a stable
`requestId` only for an exact retry of the same mutation.
The core may recover a unique exact-prompt acknowledgement read-only and resume
observation on the same generation; keep waiting on its exact `sessionId` and
`generation`.

Every ChatGPT send begins caller-directed preparation. The automatic selection
path and `assistedPreparation` flag have been removed. A `provider.preparation-required` MCP result has
`isError: true` and `structuredContent.details` with the original `requestId`,
`sessionId`, `generation`, and pending `snapshot`. Call
`sessionplane_preparation_inspect` with that identity, then
`sessionplane_preparation_decide` using a candidate ref from the latest
`snapshotId`; inspect again before each decision. Slider choices require an
explicit numeric `value`. Composer and send choices identify controls only.
Call `sessionplane_preparation_resume` with the original identity to let core
fill the composer and submit once, then continue waiting on the same
generation. Use `decision: "cancel"` when evidence cannot support the
requested intent. These preparation tools are available through MCP and their
RPC methods; CLI send also begins preparation without submitting.

## Provider continuity and model families

Provider availability is an operator-owned core setting. ChatGPT is enabled by default; Gemini and Grok require explicit operator enablement. Check `system.health.providers.enabled` when choosing a provider. Do not create a session for a disabled provider and do not reinterpret `provider.disabled` as a reason to fall back to another provider.

Keep a role on its current provider when a generation must be reconstructed or
replaced. Never use Gemini or Grok as an implicit fallback for ChatGPT because
of `submission_unknown`, model unavailability, a consent/interstitial page,
rate limiting, wait expiry, or observation trouble. Change provider only when
the user or caller explicitly requested a different provider.

For ChatGPT preserve semantic `model=Pro`. Inspect the current choices and choose
an available Pro-family model using the live evidence. Do not encode version
labels, infer availability from a partial catalog, or switch to another family.
Core no longer chooses a model or effort on the agent's behalf.

Provider-created files are durable:

```bash
sessplane artifact discover --session "$SESSION_ID" --json
sessplane artifact capture --session "$SESSION_ID" --json
sessplane artifact export "$ARTIFACT_ID" --out ./result.zip
```

Use `sessplane context dry-run` before a large submission and either upload the
generated package or select inline transport.

## ChatGPT Chat only

SessionPlane never submits through ChatGPT Work and never silently changes a
Work composer back to Chat. An explicit `surface=work` request or a visibly
active Work composer fails before the irreversible submit. Use ordinary Chat
model/reasoning selection through the preparation workflow. Named-mode automatic switching is not supported.

## ChatGPT Project Sources

Always pass the exact `https://chatgpt.com/g/<project-id>` URL. Inspect the
files first with `--dry-run`; actual additions are append-only by visible file
name and concurrent mutations to one project are serialized.

```bash
sessplane chatgpt project-sources add \
  --project-url "$PROJECT_URL" \
  --file ./context.md --dry-run --json

sessplane chatgpt project-sources add \
  --project-url "$PROJECT_URL" \
  --file ./context.md --request-id project-source-1 --json
```

## ChatGPT code mode

`code generate` is a normal durable generation followed by exact artifact
recovery. It never scans the active tab. New code ZIPs must contain a nonempty
root `PLAN.md` or `00_plan.md`; unsafe or malformed archives are rejected.

ChatGPT code generation first returns the same preparation handoff. Complete
inspect/decide/resume with its original request identity, then repeat the exact
`code generate` request to wait and export artifacts without another submit.

```bash
sessplane code generate --session "$SESSION_ID" \
  --prompt "Build a minimal TypeScript CLI" \
  --output-zip ./result.zip \
  --request-id code-1 --json

sessplane code generate --session "$SESSION_ID" \
  --prompt "Build frontend and backend archives" \
  --multi-zip --output-dir ./artifacts \
  --request-id code-2 --json
```

`code extract` is read-only provider recovery. Prefer an exact durable session;
an explicit conversation ID or URL is also accepted. Omit `--require-plan`
only when recovering legacy archives created before the plan contract.

```bash
sessplane code extract --session "$SESSION_ID" \
  --output-zip ./recovered.zip --require-plan --json
```

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
  It supersedes the old session and records `predecessorSessionId`. Carry a concise
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

Role replacement does not cancel a submitted predecessor generation. Continue exact
session/generation waits to retrieve its result, then delete its completed history.
New submissions use the current role session; predecessor answers remain readable.
An uncertain deletion can be reconciled through the same deletion request: the core
checks exact provider absence read-only and never repeats the uncertain mutation.

`provider.observation-unavailable` means the browser read timed out. Core still
observes the exact server turn; use its result and retry timing, not a new send.
