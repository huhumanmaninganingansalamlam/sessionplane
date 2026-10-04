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
  It works for pending and completed current requests, without navigation, reload,
  submission, model changes or new tabs. Missing, mismatched, replaced or superseded
  targets fail instead of selecting another tab. Replaying a completed requestId
  returns its receipt without stealing focus again; a new user action uses a fresh ID.
  Automatic observation and recovery remain independent of foreground focus.
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
  acknowledgement recovery. Ordinary team reads return compact current-request summaries. With `history:true`,
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
  `session_replace` attempts to permanently delete the previous
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
  existing cleanup checks reject unresolved/shared conversations.

For a handoff that preserves the old provider conversation, use `role_create`
with a unique `roleKey` and `roleType:"custom"` in the same team, then carry the
handoff into that role under its own fresh roleRef. This keeps the old role/session
and does not repoint the primary role. `session_replace` has no preserve-old option;
raw occupied-role `session.create` has the same deleting behavior. Obtain the
required specific deletion confirmation before choosing that path. A 10-turn
recommendation is only a handoff cue, never deletion confirmation. This is a
caller authorization requirement, not a new confirmation field in the API.

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
A new SessionPlane send starts the next generation; completed results
remain immutable and cannot be overwritten by later conversation activity.

`team_delete` removes the entire team, its roles, sessions, requests, events and
artifact references. It retires roles before cleanup, stops owned work and closes
owned tabs. Provider conversation deletion is attempted once; failure does not
block local deletion and is reported per session. Retrieve needed outputs first.
Shared content blobs, exported files and idempotency receipts remain. Retry with
the same requestId to receive the deletion result without repeating provider actions.
