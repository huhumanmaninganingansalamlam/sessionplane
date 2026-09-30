# Observed ChatGPT configuration and submission

## One execution path

Every ChatGPT send begins a durable preparation request. The core opens the exact
owned page, checks authentication, human verification and Chat-only boundaries,
and returns `provider.preparation-required` before filling or submitting.
The first workflow send discovers available model/power combinations on its exact
preparation page and returns `configurationCatalog`. Discovery reads actual version
options and bounded power values, records the displayed combined labels, and restores
the original configuration without touching the prompt or submitting. Disabled versions
are reported separately. No model-name/version table is embedded in SessionPlane.

The core caches the catalog for its browser runtime. Later requests choose an option ID
through `decide configure`; core applies the observed version and power and verifies
that the combined label still matches on the request's own page. Drift invalidates the
catalog and requires `decide discover`. A core restart also requires fresh discovery.
Each returned option also includes a snapshot-bound `selection` using the existing
choose/model/ref schema, so connected clients can select without restarting their MCP
transport for the new configure schema. Both forms call the same selection implementation.
Read-only team_get exposes the available catalog and never traverses menus itself.
Discovery failure is explicit and does not claim that a model is unavailable.

Preparation evidence excludes provider message subtrees and history navigation.
Composer content stays in the accepted request, not the UI evidence. Controls,
current values, menus, related explanations and provider alerts remain observable.
The same scope is used for inspection, decisions and pre-submit verification;
answer text is read only by the provider observation path. Parent labels and
accessibility descriptions cannot reintroduce excluded content. Hidden editors do
not suppress load-failure evidence.
Attachment acknowledgement is scoped to the chosen composer: its form, or its
nearest attachment container when no form exists. It compares complete file names,
excluding other forms, editable content and the transcript. Providers share this
check; unrelated or partially matching names cannot acknowledge a new upload. Exact prompt recovery binds
its content lookup to the observed message identity rather than a second DOM list's
position.

## MCP flow

The public contract is [team-centered MCP](team-workflow.md). Start with
`sessionplane_team_get`, then `sessionplane_send` using the returned roleRef.
A pending preparation is a successful `status: needs_decision` result with a durable
requestRef, requested model/effort, recorded choices and fresh evidence.
Preparation nodes include `actions.choose` and `actions.reveal`: supported
purposes derived from the same semantic rules used to validate decisions.
These capabilities do not classify a button's meaning or authorize submission;
the agent selects by observed labels, values and requested intent. Freshness,
ownership and operation-specific checks still run at execution. Submitted
request observations do not advertise preparation actions.

## Configuration selection

Preparation evidence exposes `preparationAvailability`. Without a visible,
enabled editable composer, `available:false` preserves the prepared request and
does not offer submit. Ordinary Retry/reset buttons are not submit controls.
Submit requires a native submission control associated with a usable composer
or the provider's observed send marker; current decisions and provider preparation
verify the same semantics. Disabled controls are not offered as actions.

A cached configuration catalog is an inventory, not proof that this page can
select a model. `selectionAvailable:false` omits option selections and rejects
configuration mutation while the composer is unavailable. Read the same
requestRef after the exact provider page becomes usable. Then select configuration
and composer from fresh evidence before choosing submit. Inspection does not
click Retry, reload, replace, resend, terminalize, or claim that the conversation
was deleted. A Retry-only load error does not itself establish human verification.

The normal model-selection flow is `send → configurationCatalog.options → decide
configure(configurationId)`. The agent chooses a displayed combined label matching
its intent; it does not derive a model from separate partial menus. Configure records
one verified configuration and does not fill or submit. Choose composer and submit
from fresh evidence afterward. Explicit user corrections take precedence over old
request hints. No substitution is implicit.

Use `decide discover` to rebuild an unavailable or invalidated catalog on the exact
pending request. The returned version labels, numeric values and combined labels are
observations, not a promise about future availability. Selection revalidates them.
Raw choose/reveal remains available for diagnostics and composer/submit selection.
The existing freshness, page ownership, idempotency and pre-submit checks still apply.

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

During submission, outgoing user-message IDs are correlated with observed provider
messages. Prompt text matching is a fallback, not a requirement for an ID-confirmed
submission. Provider formatting differences do not discard that identity.

If automatic recovery cannot establish identity, inspection returns
`submissionCandidates`, excluding messages already bound to a generation. Compare
the candidate with the requested prompt and use `decide` with
`decision: "acknowledge"`, its `messageId` and `evidenceHash`. This read-only provider
action binds the existing message and starts answer observation; it never sends.
The owned conversation, current generation and unchanged message evidence are
rechecked. Unclear or truncated candidates require further inspection or user
judgment, not guessing.

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
literal prompt transport coverage, and catalog discovery/selection with UI drift.
Discovery must preserve drafts and submission counts; selection must verify the current combined label.
Live provider evidence must be reported separately from browser fixtures.

## Unreadable or long conversations

Workflow responses and team roles expose `conversationUsage.confirmedTurnCount`.
This counts distinct provider-acknowledged user messages recorded by SessionPlane
in the same provider conversation, across restarts and any sessions sharing it.
Failed preparation, unacknowledged attempts, and duplicate request replays do not
increase it. Manually sent browser messages are not included in this durable count.
At 10 turns, `handoffRecommended:true` recommends preparing a concise handoff and
continuing in a new conversation after resolving the current request. Include the
objective, decisions, evidence/artifact references, unresolved work, next step,
and requested model/effort. This is advisory; it neither interrupts nor replaces
a conversation automatically. A fresh conversation starts at zero.

A successful health check only proves that the core and browser are available.
For each operation, inspect the exact session and generation. If wait reports
`provider.conversation-unavailable`, its message/composer surface is absent.
DOM availability is determined from the page, independently of backend HTTP
status or whether a particular fetch appears in resource timings. This is not evidence of ongoing generation,
permanent deletion, or non-submission. A 429 remains transport deferral: respect
`nextCheckAt`, and do not replace a healthy conversation because of 429 alone.
Use `sessionplane_team_get` with `requestRef` to inspect the live page and retrieve the
original prompt, model, effort, surface, attachments (path/hash), and deadline.
Do not endlessly repeat wait on a page that cannot display the conversation.

`provider.actionable-alert` means a visible provider error, not a failed browser
read. `reason: "provider-actionable-alert"` causes get/wait to include fresh
`evidence.providerAlerts`, even for errors excluded from the compact control
snapshot. Global alerts and current-turn errors need no action button. Historical
turn errors do not block a later human follow-up. A backend 429 cannot erase this
page evidence; fresh observation or an exact backend final can clear it.

`sessionplane_stop` cancels unsubmitted preparation, or attempts one exact provider
stop. `provider.stop-unavailable` with `outcome: "not_attempted"` means no control
was available. `provider.stop-unknown` means a mutation was attempted without a
provider acknowledgement, including a successful browser click. Neither confirms
cancellation. The request stays nonterminal; get/wait expose `stopOutcome.state:
"unknown"`. The attempted receipt survives restart and blocks repeat stop under
another request ID. Continue read-only observation, never resend the prompt.

When the caller decides the conversation must be replaced, or a completed long
conversation needs a fresh context, use `sessionplane_session_replace` for the
same `teamId`, `roleKey`, and provider with a new stable request ID. The new session records `predecessorSessionId` and becomes the current role route.
Replacement attempts provider conversation deletion once, closes the predecessor's
owned tabs, and ends its observation, including after restart. Retrieve required
answers/files and write the handoff before replacing. Deletion failure or unknown
conversation identity does not block the successor; there is no automatic retry.
Preserve completed answers and required artifacts, then carry only the relevant
role brief, current objective, decisions, and unresolved work into the new send.
Keep requested model/effort and verify attachment identity. Do not copy an entire
long transcript. The 10-turn recommendation is a handoff cue, not an automatic cutoff. New sends still require
fresh preparation decisions. A new session does not imply permission to repeat
an unresolved submission; follow the caller/operator's explicit recovery intent.
An existing instruction to replace and continue is authorization; do not ask again.

Replacement deliberately discards the predecessor's unresolved observation; it
does not prove an uncertain submission was never accepted, nor that provider
deletion succeeded. Stored local answers/files remain readable. An unreadable page
alone does not authorize replacement or deletion. Explicit completed-conversation
cleanup is also available through `sessionplane_session_delete`.

Call `sessionplane_session_delete` with teamId, the exact requestRef, a stable
requestId and `outputsRetrieved: true`. Core resolves the bound session, generation
and conversation ID.
This deletes ChatGPT history itself and closes its owned page while retaining
local durable answers. The core rejects unresolved generations and shared
conversation identities. It records the attempt before contacting the provider;
`provider.deletion-unknown` survives restart and cannot be retried under another
request ID. Successful replay returns the original deletion receipt.

Role retirement alone does not cancel submitted generations. Continue exact
requestRef waits to retrieve its result, then delete its completed history.
Session replacement instead ends predecessor observation as described above.
New submissions require the current session of an active role, checked again after
provider preparation. Unsubmitted retired sessions wake existing waiters with a
terminal snapshot. Submitted work on retired roles continues observation across restart, and answers
remain readable after routing retirement.
An uncertain deletion can be reconciled through the same deletion request: the core
checks exact provider absence read-only and never repeats the uncertain mutation.

If observation reports `provider.observation-unavailable` with reason
`dom-observation-timeout`, the browser read did not finish within its I/O deadline. The generation is still unresolved: core
continues paced server observation independently, with only one outstanding DOM
read. Inspect exact state; do not infer that the prompt was not submitted.

A visible provider alert does not establish completion, non-submission, or
permission to click retry. Inspect the exact request and its `providerAlerts`.
Read-only recovery continues; backend cooldown cannot hide the alert.

Composite keyboard range controls expose one semantic slider ref on the visible
keyboard receiver. Bounds and current value come from its unique descendant
range, even when that visual thumb is accessibility-hidden. Actions use the
receiver and freshly observed values; model names and tier ordering remain agent
decisions. Hidden or inert menu views do not become actionable.
