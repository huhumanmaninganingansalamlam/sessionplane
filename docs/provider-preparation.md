# Agent-directed ChatGPT submission

## One execution path

Every ChatGPT send begins a durable preparation request. The core opens the exact
owned page, checks authentication, human verification and Chat-only boundaries,
and returns `provider.preparation-required` before filling or submitting.
There is no automatic model/menu/composer/send discovery path and no
`assistedPreparation` opt-in. That input is removed, not an alias for the new flow.

The agent interprets current roles, labels, descriptions, relationships and
selected state. It selects observed controls; it never sends executable
JavaScript, selectors or coordinates. Core validates fresh evidence and owns
all browser mutations, request receipts, submission attempts and answer identity.

## MCP flow

The public contract is [team-centered MCP](team-workflow.md). Start with
`sessionplane_team_get`, then `sessionplane_send` using the returned roleRef.
A pending preparation is a successful `status: needs_decision` result with a durable
requestRef, requested model/effort, recorded choices and fresh evidence.

Use `sessionplane_decide` with that requestRef, a unique requestId, fresh snapshotId,
observed ref and purpose. A reveal opens related model/effort options. A choose
verifies and records the selected control, then continues the same request.
Composer selection can fill the prompt and reveal a previously hidden submit
control. Submit selection can submit once all required choices are verified.
There is no separate public resume operation. Subsequent decisions use newly
returned evidence, or `team_get` with requestRef for a fresh inspection.

Core performs each mutation once and observes its result; unverified UI action
outcomes remain typed `provider.action-unknown`. Use `sessionplane_stop` to cancel
preparation and `sessionplane_wait` for exact answers and generated files.

Requested intent and observed selection are distinct. The agent is responsible
for choosing evidence that satisfies the intent; a selected control alone does
not prove that an unrelated option matches it. Preserve semantic `model=Pro`.
ChatGPT Work is forbidden. Named-mode automatic switching is removed.

## Identity and restart

On acceptance, core snapshots attachment bytes into owner-private
`submission-inputs` storage next to the durable database and records their upload
identities in the outbox. Preparation and restart use those bytes even if the
caller edits or removes its source files. Public inspection retains the original
paths and hashes. Cached input bytes remain with durable request state; they are
not temporary browser files. A changed or missing stored copy fails before
submission and records a terminal pre-submit failure, waking exact-generation
waiters with the same input error. Older requests without snapshots still require
their original bytes;
core cannot reconstruct old contents from a hash or silently substitute new ones.
After an input failure with `promptSubmitted:false`, the caller can correct its
inputs and start a new request on the same session. Reusing the failed request ID
replays its failure; waiting cannot repair its inputs.

MCP initialization negotiates the client version: `2025-06-18` and
`2025-11-25` use the same initialized stdio tool path. An unsupported version
receives the supported `2025-11-25` version so the client can decide compatibility.
Initialized connections retain their negotiated protocol when requests carry
ordinary `_meta` fields; metadata presence does not select a different protocol.
A successful manual connection at one version does not prove native client
compatibility; verify tool discovery through the actual client.

The MCP client owns server registration and the stdio connection. Installing
skills alone does not connect it. Preparation is core-owned, not tied to a
transport process or an agent's context window. On client reconnection or
compaction, call team_get with the teamId and select the original requestRef
before deciding. The core resolves the original owner/session/generation.
Do not create a new send, wait for an unsubmitted answer, or infer unavailable
tools from an empty MCP resource list. See the README for Codex registration.

The original caller and request own the entire preparation workflow. Each action
checks owner, generation, page binding, observation revision and live semantics.
Unrelated sessions remain independent. Replay of `session.send` reports the
existing request; it never repeats browser mutations. Restart clears transient
choices and requires fresh inspection. Terminal generations are not reopened.

Existing durable submitted/ambiguous records remain evidence, not permission to
run removed submission behavior. No DB rewrite, implicit resend, fallback or
challenge bypass is part of this change. Gemini/Grok retain their own adapters
and require explicit operator enablement.

## Submission uncertainty

`sessionplane_team_get` with `teamId + requestRef` resolves the original durable
caller/session/generation identity internally. It attempts existing
read-only exact acknowledgement recovery, then returns the current snapshot,
original prompt/model/effort and current owned-page evidence. This also works
after the automatic recovery window expires. Recovered identity starts the
existing answer observer on the same generation. Inspection never submits.

If identity remains unproven, do not repeat waits as though generation were
confirmed. A draft, absent message, missing CLI output or expired timeout does
not prove non-submission. Inspect evidence and obtain an explicit operator
decision before replacement/resubmission. Preparation decisions cannot mutate
an ambiguous submission. Final answers require exact submitted-user identity
and matching assistant ancestry; caller-provided answer text is not accepted.

## CLI transport

Prefer MCP structured arguments. CLI `send` initiates the same preparation
workflow; it is not a one-call browser submission shortcut. For long bodies use
`--prompt-file PATH` or `--prompt-stdin`, exclusively with each other and
`--prompt`. These preserve literal UTF-8 text including quotes and newlines.
Never interpolate arbitrary prompt text into shell commands.

## Verification

Keep one end-to-end MCP decision flow, exact identity/restart/no-resend checks,
and literal prompt transport coverage. Delete tests for removed automatic model
selection behavior; do not retain a second implementation to satisfy them.
Live provider evidence must be reported separately from browser fixtures.

## Unreadable or long conversations

A successful health check only proves that the core and browser are available.
For each operation, inspect the exact session and generation. If wait reports
`provider.conversation-unavailable`, the conversation fetch failed and its
message/composer surface is absent. This is not evidence of ongoing generation,
permanent deletion, or non-submission. A 429 remains transport deferral: respect
`nextCheckAt`, and do not replace a healthy conversation because of 429 alone.
Use `sessionplane_team_get` with `requestRef` to inspect the live page and retrieve the
original prompt, model, effort, surface, attachments (path/hash), and deadline.
Do not endlessly repeat wait on a page that cannot display the conversation.

When the caller decides the conversation must be replaced, or a completed long
conversation needs a fresh context, use `sessionplane_session_replace` for the
same `teamId`, `roleKey`, and provider with a new stable request ID. The new session records `predecessorSessionId` and becomes the current role route.
Already submitted predecessor generations keep observing until their results are retrieved.
Preserve completed answers and required artifacts, then carry only the relevant
role brief, current objective, decisions, and unresolved work into the new send.
Keep requested model/effort and verify attachment identity. Do not copy an entire
long transcript or rotate on an arbitrary message count. New sends still require
fresh preparation decisions. A new session does not imply permission to repeat
an unresolved submission; follow the caller/operator's explicit recovery intent.
An existing instruction to replace and continue is authorization; do not ask again.

Session replacement does not delete provider history. Cleanup is a separate
operation after the role's work is complete and required answers/artifacts have
been retrieved. Never delete active, unacknowledged, or unrecovered conversations
merely because a successor exists or the page cannot be loaded.

Call `sessionplane_session_delete` with teamId, the exact requestRef, a stable
requestId and `outputsRetrieved: true`. Core resolves the bound session, generation
and conversation ID.
This deletes ChatGPT history itself and closes its owned page while retaining
local durable answers. The core rejects unresolved generations and shared
conversation identities. It records the attempt before contacting the provider;
`provider.deletion-unknown` survives restart and cannot be retried under another
request ID. Successful replay returns the original deletion receipt.

Role replacement and role retirement do not cancel submitted generations. Continue exact
requestRef waits to retrieve its result, then delete its completed history.
New submissions require the current session of an active role, checked again after
provider preparation. Unsubmitted retired sessions wake existing waiters with a
terminal snapshot. Submitted work continues observation across restart, and answers
remain readable after routing retirement.
An uncertain deletion can be reconciled through the same deletion request: the core
checks exact provider absence read-only and never repeats the uncertain mutation.

If observation reports `provider.observation-unavailable` with reason
`dom-observation-timeout`, the browser read did not finish within its I/O deadline. The generation is still unresolved: core
continues paced server observation independently, with only one outstanding DOM
read. Inspect exact state; do not infer that the prompt was not submitted.

`provider.observation-unavailable` with reason `provider-actionable-alert` means
a visible actionable alert follows the exact submitted turn. Partial answer text
does not establish completion while that alert is present. Inspect that session and generation to interpret the current provider
evidence. This is not proof of non-submission or authorization to click retry.
Read-only recovery continues; backend cooldown cannot hide the alert.
