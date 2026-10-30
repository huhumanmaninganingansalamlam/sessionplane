# Team-centered MCP contract

The agent retains `teamId`. `sessionplane_team_get` returns roles with `roleRef`
and requests with `requestRef`. Copy these references; do not reconstruct them.
A role reference binds the current session and generation. A request reference
is the durable outbox UUID, valid across client/core restarts and role replacement.
References are identity handles, not authentication tokens; the owner-only local
socket remains the trust boundary.

The catalog has eleven tools: `team_create`, `team_get`, `team_delete`, `role_create`, `role_retire`,
`send`, `decide`, `wait`, `stop`, `session_replace`, `session_delete`, all prefixed
`sessionplane_`. Creation includes the initial provider session. Provider defaults
to ChatGPT; explicitly disabled providers fail before creating team/role state.

Ordinary flow: team_get → send → decide when needed → wait.

Team roles and exact request responses include `conversationUsage` with
`confirmedTurnCount` and `handoffRecommended`. Ten distinct acknowledged user
turns in the provider conversation trigger a recommendation to finish the current
request, retrieve outputs, write a handoff, and use `session_replace` before
continuing. The count survives restarts and excludes preparation failures,
unacknowledged attempts, duplicate replays, and messages sent outside SessionPlane.
Replacement starts a fresh count; it never automatically summarizes or resends work.

The caller chooses model/mode from live evidence; the core verifies recorded controls
remain selected. Honor explicit versions, otherwise use the latest matching option.
Account badges and role names do not establish selection. Inspect nested choices
and confirm the final active controls; unavailable intent requires a user decision.

- Mutations require a caller-generated stable `requestId` for delivery deduplication.
  Reuse it only with identical arguments. IDs are scoped to the team; team creation
  needs a globally unique ID. The core derives the team request namespace;
  callers do not supply another client identity on every operation.
- `send` accepts a `roleRef` and checks its generation inside the session actor
  before creating work. An exact duplicate replays the original request even if
  the role has advanced. Concurrent new sends from an old role reference fail.
- `needs_decision` is a successful intermediate result. It contains fresh evidence,
  recorded choices and requested intent. Evidence omits scripts, decorative SVG and empty DOM wrappers while retaining
  controls, selection states and visible explanatory text. The agent selects observed refs; core
  validates freshness and performs the action. `decide` then advances that same
  request. A reveal returns fresh choices without submitting. There is no separate
  resume tool and no model/version/menu-label inference inside the workflow layer.
  Reveal also accepts an observed menu item for nested model/effort lists. It
  verifies newly exposed choices in the related menu even when the opener is
  replaced. Opening a list never records a model selection or submits the prompt.
  The preparation message identifies the remaining failed verification; use it
  with the current evidence instead of repeating an already recorded choice.
- `decide` with `decision:"focus"`, teamId, requestRef and a stable requestId
  activates the exact currently connected tab for explicit human viewing or control.
  Success verifies the native selected tab and focused Chrome window; renderer
  visibility or focus emulation alone cannot establish activation. A denied or
  unverified activation returns an error rather than `activated:true`.
  It works for pending and completed current requests, without navigation, reload,
  submission, model changes or new tabs. Missing, mismatched, replaced or superseded
  targets fail instead of selecting another tab. Replaying a completed requestId
  returns its receipt without stealing focus again; a new user action uses a fresh ID.
  Background observation never selects the native tab or window. Opening an exact
  owned observer restores its per-page rendering emulation after Core adoption;
  this allows pending animation-frame updates without changing drafts or ACKs.
- `decide` with `decision:"refresh"`, teamId, requestRef and a stable requestId
  reloads only that request's currently owned ChatGPT page. No UI ref is needed.
  Use when the user requests refresh or visible provider recovery failure warrants
  it, not as an automatic timer during normal thinking. It never submits a prompt,
  presses Retry/Continue, or changes generation. Repeating the same requestId never
  reloads twice. A failed/uncertain refresh requires inspection before a new decision.
  Preparation selections are cleared because reload can reset provider defaults;
  inspect and reconfirm the original model/effort intent. Historical generations
  cannot refresh a page now owned by a newer request.
- `team_get` with `requestRef` inspects that exact request, including read-only
  acknowledgement recovery. The selected request appears first with only its role; unrelated request lists and the team objective are omitted. Explicit history remains available. Ordinary team reads return compact current-request summaries. With `history:true`,
  team_get lists all generations newest first in pages of 50 requests; pass the
  returned `nextRequestRef` as `beforeRequestRef` to continue until it is null.
  Historical references can therefore be rediscovered using only teamId.
- `wait` accepts exact request references in one team. It observes existing actors,
  returns answers, and captures generated files in the durable artifact store.
  An optional output directory materializes those files. No prompts are fanned out.
  Preparation waits return decisions immediately; ambiguous requests are observed,
  never resent. Each request's result/failure is reported independently, including invalid or
  cross-team references in a mixed batch. Historical file retrieval uses the stored
  response message identity and the current page ownership generation separately;
  newer answers cannot substitute for the requested answer. Downloaded files remain
  available offline. Missing exact provider answers return a file error, not an
  empty successful file list.
  After restart, uncached files reopen the exact conversation on demand without
  resending. Page recovery preserves the completed answer and terminal reason.
- An ambiguous request with neither its owned page nor a durable conversation ID
  returns `status:"recovery_required"`, `recovery.state:"unavailable"` and
  `recovery.nextAction:"sessionplane_session_replace"`. Wait returns immediately;
  refresh fails with `session.recovery-unavailable` and the same guidance.
  Its submission outcome remains unknown, not completed or definitely unsent.
  `promptSubmitted:true` in this state records an attempt, not provider acceptance.
  Replacement skips provider deletion when the exact conversation identity is unknown.
  Replacement cannot claim deletion of an unidentified conversation and never
  replays the prompt; the old request remains inspectable. A provider outage
  or slow answer alone does not meet this lost-page condition.
- `stop` cancels preparation or stops the exact generating request. It cannot stop
  a newer generation. An absent control returns `provider.stop-unavailable`
  (`outcome:"not_attempted"`); an unacknowledged mutation returns
  `provider.stop-unknown` and get/wait expose `stopOutcome.state:"unknown"`.
  A browser click alone never confirms cancellation. The request remains unresolved
  and an uncertain stop is not repeated, even with a new ID or after restart.
  `provider.actionable-alert` is a visible provider error; inspect
  `evidence.providerAlerts` rather than treating it as browser read failure or 429.
  By default, `session_replace` attempts to permanently delete the previous
  provider conversation once, closes its owned tab and ends observation, then creates
  the new session. Deletion failure, unsupported deletion or unknown conversation
  identity does not block replacement; there is no automatic cleanup retry.
  The existing team fields remain unchanged. The replacement response adds
  `replacement.requestId`, `replacement.sessionId` and `replacement.cleanup`.
  Cleanup records the exact predecessor session/generation/conversation,
  `deletionRequestId`, the actual `deletionReceipt` client/request/status when one
  exists, `outcome` and `errorCode`. Outcomes are `confirmed` (provider deletion
  confirmed), `refused`, `uncertain`, or `not-attempted`; historical replacement
  receipts without cleanup evidence return `unknown` without rewriting history
  or retrying deletion. Routing `requestOk:true` never establishes provider deletion.
  Retrieve needed outputs and write the handoff first. Stored local answers/files
  remain available. The old session stays retired across restarts even when deletion
  fails. Raw `session.create` for an occupied role uses the same replacement path.
  `role_retire` prevents new work on a finished expert.
  If a role has no current session, session_replace accepts its observed roleKey
  instead of roleRef and creates its first session (ChatGPT by default). A roleKey
  cannot replace an occupied role; that still requires its fresh roleRef.
  `session_delete` separately requires an exact request and `outputsRetrieved:true`;
  existing cleanup checks reject unresolved/shared conversations. Provider deletion and
  owned-tab closure are independent outcomes: inspect `pageCleanup` on the result
  or on typed error `details` (including verification HTTP 429). Provider errors
  and Retry-After remain unchanged; closing a verified idle tab does not claim
  provider deletion. Drafts, active generation controls and changed page ownership
  prevent closure. Retained local answers and request identities are not deleted.
  Recover an uncertain deletion acknowledgement with the same request identity;
  cleanup never automatically repeats a provider DELETE.

For explicitly authorized nondeleting context renewal, use `session_replace` with
`preserveConversation:true`, a fresh `roleRef`, and a distinct stable `requestId`.
This keeps the **same role ID/key and provider**, creates an empty successor session
with `predecessorSessionId`, and returns `replacement.cleanup.outcome:"preserved"`.
The old session's routing is displaced; its generation/outbox draft,
request IDs, conversation, page bindings, answers and evidence remain retained.
No provider deletion, tab close, Stop, refresh or prompt replay occurs. Old requests
remain readable but cannot be submitted after routing has moved. Confirm the new
session/roleRef, then separately prepare current work and verify model/effort; the
replacement itself does not send or adopt the old draft.

An unreadable bound prepared/unsubmitted request retains its existing recovery path.
An acknowledged submitted request also permits renewal after fresh exact-page
verification: its ACK is mounted without a later user turn, activity is absent,
and no draft, permission or human-verification control is pending. This covers
an exhausted provider conversation without fabricating a final answer. Retrieve
available outputs and preserve the handoff before renewal; unresolved generation
evidence remains unresolved and independently readable on the predecessor.
UNKNOWN delivery, inconsistent outbox evidence, prior deletion attempts, changed
provider and stale roleRefs remain rejected. The actor queue and page lock guard
the observation and routing change. This is an explicit coordinator decision,
not automatic error recovery or an access/security bypass.

For normal authorized context renewal, keep the same stable role ID/key and
provider. Resolve the current request, retrieve required answers/files, save the
handoff, and call `session_replace` with that role's fresh `roleRef`. Carry the
handoff into the returned successor using fresh preparation. Do not create a new
custom or dated continuation role for the same responsibility; `role_create` is
for a distinct responsibility. Default replacement makes one best-effort provider
deletion attempt and independently closes verified idle owned tabs. Check
`replacement.cleanup.pageCleanup` even when provider deletion fails; confirm the
old target is closed without claiming deletion succeeded. Use existing cleanup
authorization; the 10-turn cue grants no new authority. Preserve active/UNKNOWN
work, uncollected results, shared pages and drafts. Raw occupied-role
`session.create` uses the same default replacement path; select
`preserveConversation:true` explicitly when the old conversation must remain.

An explicit user-approved, duplicate-risk-accepted resend of a legacy unresolved
ChatGPT submission uses `decide` with the **original** `requestRef`,
`decision:"prepare_resend"`, a stable new `requestId`, `approvalRef` identifying
that approval, and `duplicateRiskAccepted:true`. This reserves exactly one
successor generation in the same session/conversation and returns its new
`requestRef`/`roleRef`; it does **not send**. The original generation/outbox,
anchors, answers and failure evidence remain unchanged and unresolved. Its
observation routing moves to the successor; this is not proof of non-submission,
failure, completion or provider cancellation. Reusing the exact approval returns
the reservation; a different approval/request ID cannot reserve another resend
for that original. Only the original coordinator prepares fresh configuration
and submits the successor through ordinary `decide` choices. Do not use ordinary
`send` to dispatch that reservation.

This narrow path requires stored exact-conversation missing-anchor evidence,
current role/page ownership and a passive usable conversation surface. Before
preparation and immediately before dispatch, original message/answer discovery,
activity, alerts, selection, another draft or service cooldown pauses the prepared
successor. Only its exact staged prompt is allowed after composer preparation.
An ambiguous irreversible attempt is never repeated. No attachments, automatic
continuation, browser navigation, refresh, Stop, deletion or safety bypass is
introduced. Ordinary `send` still refuses every unrelated active generation.

General search/research, context packaging, project-source management and code ZIP
orchestration are outside the agent chat workflow. They are not optional MCP profiles
or hidden commands behind a generic execute tool. Generated file retrieval remains
available. Attachment uploads default to disabled; operators can opt in with
SESSIONPLANE_UPLOADS_ENABLED=true. Team snapshots report capabilities.uploadsEnabled.

Unchanged invariants: semantic model intent, Chat-only surface, no provider fallback,
no automatic ambiguous resend, exact answer ancestry, one mutation owner per page,
dedicated profile, human-only verification, durable restart observation.

While a submitted request remains nonterminal, human messages in that same
conversation continue its active generation. Observation keeps the original user
anchor and follows the current branch through human follow-ups, clearing an older
answer candidate at every user turn. Only the answer after the latest user turn can
complete the request. No continuation keyword, special acknowledgement or resend
is needed. For an idle exact Thinking failed, explicit `decide/reconcile_failure` can preserve
the original submission as terminal failed without provider mutation. After that,
an authorized native follow-up starts the next generation in the same conversation;
it does not replay the failed operation. See `provider-preparation.md`.
Automatic literal `계속` follow-ups are default off. Only an explicitly authorized
new ChatGPT request with `send(thinkingFailureRecovery:true)` hands this chain's
sender ownership to the core. Do not send in parallel; use the returned
`thinkingFailureRecovery.successorRequestRef` to collect each successor. Exact
failure/configuration guards, original deadline, durable idempotency and backoff
apply. A normal final ends automation; a pause returns a reason and owner control
without retrying. Original failed receipts and answers retain separate identities.
A new SessionPlane send starts the next generation; completed results
remain immutable and cannot be overwritten by later conversation activity.

For an existing collector with `continuationApproved:true`, native broad review
defaults to 20 minutes (1200000ms). This is review eligibility, not a guaranteed
send: live work, permission/hold, original ACK, draft, single-owner and provider
Retry-After guards still apply. Explicit wait durations and approval choices
remain unchanged. Normal Core handover applies the default to existing approved
original chains; retained ordinary exact-followup reviews use the current default
without rewriting receipts. Earlier explicit rearming and real backend deferrals
retain their deadlines. Held, unapproved and terminal requests are not resumed.

`team_delete` removes the entire team, its roles, sessions, requests, events and
artifact references. It retires roles before cleanup, stops owned work and closes
owned tabs. Provider conversation deletion is attempted once; failure does not
block local deletion and is reported per session. Retrieve needed outputs first.
Shared content blobs, exported files and idempotency receipts remain. Retry with
the same requestId to receive the deletion result without repeating provider actions.

## Human terminal client

The same guarded workflow is available through `sessplane request`: send, show,
configure, choose/reveal, wait, stop, refresh, focus, latest, delete and replace.
Run `sessplane --help` for arguments. Default output separates preparation,
unconfirmed/confirmed delivery, provider observation, collected answer/files and
cleanup outcomes, and prints commands for the exact request. `--json` preserves
the machine contract. CLI decisions do not weaken core ownership, generation,
draft, cooldown or explicit-submission checks. No automatic resend is provided.
