---
name: sessionplane
description: Converse with main and expert AI roles through a durable SessionPlane team using native MCP.
---

# SessionPlane

Use the registered SessionPlane MCP tools. Keep `teamId`; start or resume with
`sessionplane_team_get`. The core owns the dedicated browser, durable requests,
observation and recovery. Do not launch another core or control its pages with
external browser tools. General website work belongs to separate browser tools.

If the client's cached wait schema lacks continuationApproved, reconnect that client's
MCP after updating the installed package; do not silently omit approval. Preserve
any current CLI wait owner while reconnecting. The existing CLI option is equivalent.

If native tools are absent, configure the stdio server as `sessplane mcp` and
reload the client's MCP connection. Installing a skill alone does not register
MCP. Do not replace missing MCP with shell-generated prompts or raw JSON-RPC.

## Conversation

1. `sessionplane_team_create` creates the team and main conversation.
   `sessionplane_role_create` adds an expert and its conversation.
2. `sessionplane_team_get` returns roleRefs and requestRefs. Copy references from
   results; do not reconstruct them. Include a requestRef for compact stored status without a provider probe or bodies.
   Use view:result to recover its exact answer and view:evidence for fresh UI,
   original prompt/candidates and controls. CLI: request show TEAM REF --view result
   or --view evidence. Summary collection reports connected Core calls, not OS PID
   survival or product execution; managedContinuation.nextReviewAt is a review
   eligibility time, not a promise to submit. Backend nextCheckAt is separate. Retired/replaced conversations remain individually addressable.
   Evidence hostspanActivity.disclosures[].containedActivity reads an already-expanded,
   exact owned HostSpan body when mounted; it never executes or grants. Missing or
   truncated tool output leaves process/resource state UNKNOWN, not available.
   For an OUTPUT file-list panel, use decide `decision:"output_panel", action:"inspect"`
   on the same current submitted request. It returns structural state, inert/aria-hidden,
   exact external toggle eligibility and evidenceHash without reading file bodies.
   To close only that open nonmodal panel, use `action:"close"` with the fresh hash and
   a distinct stable requestId. CLI: `request output_panel TEAM REQUEST --action inspect|close
   [--evidence-hash HASH]`. Inactive/absent panels are no-ops; real dialogs, alerts and
   review holds remain guarded. Preserve the existing collector; this never Retry/send/Stop.
   After an ambiguous toggle inspect without repeating it under another ID.
   For pending arguments, decide hostspan_permission action:inspect may reveal/close
   details but never grants permission or executes the tool. Unknown arguments are
   inspected before approval; action:allow is a separate authorized grant using
   fresh matching evidence and may resume execution. action:decline rejects only the exact
   pending tool with its observed toolName and fresh inspection evidenceHash; it never
   grants/executes that tool, sends a prompt or stops a process. An external review refusal
   remains blocked; do not retry or route around it from this description alone.
   To rediscover older requestRefs, use history:true and continue with nextRequestRef
   as beforeRequestRef until null.
3. `sessionplane_send` takes teamId, a fresh roleRef, prompt and intended model/
   effort. Every mutation needs a distinct stable requestId; retry that ID only
   with identical arguments. A stale roleRef requires refreshing team_get.
   For implementing Experts, request GPT-6 Thinking / Extra High by default and
   verify that exact version and effort in fresh UI evidence before the next send.
   Fall back to GPT-5.6 Thinking / Extra High only when GPT-6 Extra High is actually
   unavailable; incomplete discovery is not unavailability. `Thinking` alone is
   not a version alias. Keep Main Director Pro and Coordinator GPT-6.1 Sol low.
   Do not reconfigure or replay a live request to apply this default.
4. `status: needs_decision` is a normal handoff, not a failed send.
   The first send returns `configurationCatalog.options`: combined configuration
   labels observed by SessionPlane in the provider UI, each with an `id`.
   Choose the option matching the requested model/effort: copy `option.selection`
   into `sessionplane_decide` with teamId, requestRef and a stable requestId. This
   uses the existing choose/model/snapshotId/ref tool schema. Updated clients may
   also use `decision: "configure", configurationId: option.id`. Neither path needs
   menu navigation, selectors or numeric power inference. Configure verifies the result and never submits.
   Later requests reuse the catalog; each selection is revalidated on its own page.
   To retain already-selected settings, use fresh DOM choose/model on the current
   chooser or summary. With explicit model and effort hints, Core verifies the
   checked version, effort label and Chat mode without selection clicks, then
   rechecks before submission. Verification only records evidence; it never fills
   the composer or resumes a saved Submit. Mismatch stays unverified.
   If `evidence.preparationAvailability.available` or catalog `selectionAvailable`
   is false, the exact page has no usable composer: cached labels are not current
   choices. Preserve the prepared request and inspect it again after the provider
   page becomes usable. Do not choose Retry/reset as submit or wait for an answer
   to a request with `promptSubmitted:false`. A Retry-only load error does not
   itself establish human verification. No automatic refresh or resend is implied.
   If the catalog is null, unavailable or stale, call `decision: "discover"` on the
   same requestRef, except after a click timeout: use current-summary recovery
   below first. Incomplete discovery does not establish model unavailability.
   Then choose the composer and submit from fresh evidence with `decision: "choose"`,
   purpose and snapshotId/ref. Choose submit last. Raw choose/reveal remain available
   for diagnostics; do not reconstruct model combinations from partial menus.
   After a configuration click timeout, the original Coordinator must first read
   `team_get` with view:evidence on the same requestRef and check `promptSubmitted`, submissionState
   and terminal. Submitted, ambiguous or terminal requests are not preparation work.
   If still prepared/unsubmitted, use fresh exact-page evidence: when the current
   combined model/version/effort summary matches the user's intent, record that
   observed summary with native choose/model and its snapshotId/ref instead of
   repeating the failed catalog click. Preserve the actual version; generic Pro
   does not require switching an already intended 5.5 Pro to 5.6 Pro. Reinspect
   after menu/composer changes and use the current summary, never an old menu ref,
   account badge or inferred slider power. Missing or mismatching evidence is not
   readiness. Other raw choices can resume a saved Submit, so
   only the original Coordinator performs this recovery; readiness-only work must
   have no saved Submit choice. Recheck current status before each such choose.
   Follow explicit user corrections when request hints conflict. Keep the same requestRef.
   Do not refresh automatically. When user control is needed, focus the exact
   request tab and report the current error and one required action. Use decide
   `decision:"human_review", action:"pause"` on its current requestRef to pause
   observation and Continue without stopping provider work or changing drafts.
   A human-wait report alone does not pause Core. The owner reviews actual owned
   evidence itself; a diagnostic hold, returned failure or `userActionRequired`
   alone does not prove authentication or a human-only action. After completing
   its own diagnostic review, the original owner may explicitly use `action:"resume"`
   with a new requestId under existing user authorization. Never resume blindly.
   Preserve an explicit user stop until the user authorizes resumption; an observed
   human-only action requires actual user completion. Do not invent either completion
   or a user action from the hold's generic wording. Resume the same managed chain.
5. Keep one managed wait per request chain. When the user has approved normal
   same-conversation `계속` recovery, pass `continuationApproved: true` on positive
   MCP waits, or `--continuation-approved` on the existing CLI wait. Without it,
   the wait only observes; an alive PID does not show managed continuation is enabled.

   ```json
   {"teamId":"TEAM_ID","requestRefs":["REQUEST_REF"],"waitMs":600000,"continuationApproved":true}
   ```

   ```sh
   sessplane request wait TEAM_ID REQUEST_REF --wait-ms 600000 --continuation-approved --json
   ```

   The existing client retains routine wait expiry, ACK/load delays, backend 429
   and probe pacing, follows the original request's continuation chain, and collects
   its exact answer/files. Positive waits default to `untilResult: true`; zero reads
   a snapshot. Keep the
   original requestRef and actual returned successor/ACK/result references in the
   existing task/handoff. Add `--out DIR` to export files; report capture failures.
   If a user already submitted a follow-up, collect it using
   `followupUserMessageId` (CLI `--followup-message-id`), without sending it again.

   The core reviews unresolved work at broad, default 20-minute (1200000ms) intervals and
   handles supported continuation preparation/submission itself. Do not omit an
   already approved option or delegate routine literal `계속` to the Coordinator
   or user. Do not run a competing wait or manual continue beside that owner.
   When transferring collection, retrieve the old handle/result first and end only
   its local observer before another owner attaches; never stop product execution.

   Current page activity, exact request evidence and actual new answer/tool/output
   changes distinguish generation from an interrupted turn. Elapsed time, Stop,
   ACK, PID survival or an old completed tool alone are not progress. Preserve active
   generation, drafts, uncertain delivery, model/effort and provider pacing. The core
   decides recovery from these observations; do not force a send past a refusal.
   `nextCheckAt` paces backend probes, not collection or a new polling schedule.

   A returned recovery decision, failed submission or repeated ineffective recovery
   needs immediate delivery to the supervisor/user, not another silent wait. Read
   the exact error and current controls; focus the original tab and report one
   concrete user action only when the observed boundary requires a human. The
   owner handles diagnostic review from existing evidence itself. An ambiguous or
   persistent send failure can require review even without a permission card. Never invent a
   hidden button, infer completion from an empty assistant, or set a fixed retry
   count as the sole stopping condition. Do not automatically refresh; the user
   refreshes when required. After their completion, re-read the same request and
   resume supported collection without replaying the original question.

   Keep the long wait outside the model through the existing CLI command handle
   when the MCP client's timeout cannot cover it; otherwise configure that client's
   tool timeout above the wait. Collect that same handle on completion/error and
   report it promptly. Do not poll process status in short model turns or add a
   scheduler. Task resume restores context, not delivery of an external result.

   An exact original FINAL recovered under `workResult` also ends observe-only
   collection without continuation authorization. Read that separately bound answer;
   the missing successor ACK and its UNKNOWN state remain unchanged.

   A normal final answer ends recovery. Read it and its execution/file results;
   if authorized product work remains, the owning Coordinator sends a **contextual
   next-WP follow-up** using a fresh roleRef/requestId. That is separate from the
   managed wait's literal `계속`; never restart the original question or use a
   continuation ACK as proof of a product result.

The caller chooses experts and context; SessionPlane does not automatically fan
out prompts, infer consensus, or inject answers into other roles.

## Recovery and cleanup

- `reconcile_failure` does not retry or submit. After it returns a terminal
  `message-timeout-reconciled` failure, another wait returns that stored outcome.
  For an already-authorized same-chat continuation, the original owner uses
  explicit `decide continue` with `continuationApproved:true`; it freshly validates
  the idle page and creates one literal `계속` successor. Preserve the old ACK,
  interrupted output and UNKNOWN physical command state; do not replay commands
  or click raw Retry. This is not a Retry click on the old ACK.

- Approved managed continuation also handles an exact idle acknowledged turn
  with a standalone message-stream error and enabled Retry: the core clicks that
  existing provider control once and collects the same request/ACK without sending
  another prompt. A failed or ineffective Retry returns its actual outcome for
  review; it does not authorize permission bypass or automatic refresh.
- Existing core conversation-load recovery may click the exact load-error button;
  this is not a page refresh, generation Retry or prompt replay. Let that existing
  paced recovery run and inspect `conversationLoadRecovery` holds/outcome. Do not
  create another retry/refresh loop. Returned `userActionRequired` or exhausted
  recovery must be reported with its exact URL and current screen/action. A stored
  notification event is not proof that the user received the report. Preserve
  UNKNOWN requests and anchors; never reset recovery state to avoid human review.

- When the user asks to view or manually control a conversation, call
  `sessionplane_decide` with `decision: "focus"`, its `teamId`, current `requestRef`
  and a fresh stable `requestId`. It brings the connected tab to the foreground
  without refreshing, resending or creating a tab. This also works for a current
  completed request. A missing or mismatched tab returns an error; do not focus
  an unrelated tab. Background observation never requires focus. After human
  intervention, wait on the same request: while it is nonterminal, human follow-up
  messages remain in that active request and its latest answer is collected
  automatically. Do not resend or require a separate adoption decision. Completed
  results remain unchanged; new SessionPlane sends start the next generation.

- If the original conversation tab is missing, explicitly decide `decision:"reopen"`
  on its exact current requestRef (CLI `request reopen TEAM_ID REQUEST_REF`). This
  opens only the stored original URL or rebinds its unique existing tab. It keeps
  human hold, ACK, drafts and results; it never reloads, clicks, submits or starts
  observation. Use focus separately when the user asks to see the recovered tab.

- Select the requested combined model/effort label from the observed catalog.
  Verify selection from supported provider UI/preparation/submission evidence when
  needed. Never ask the answering assistant to identify or confirm its model, or
  treat its self-report as verification. Missing response fields alone require
  neither an identity prompt nor user confirmation.
  Preserve requested model/mode through cancellation and replacement. Honor exact
  versions; do not substitute or infer Pro from an account badge or High effort.
  Chat is the only supported mode and the default. Work controls are not configuration
  choices; legacy Work activation is rejected. A usable composer without the optional
  mode selector uses `source:chat-default`, so ordinary same-chat follow-ups continue
  normally without fresh selected controls or historical proof records. Explicit Work,
  incomplete/conflicting controls and unavailable composers remain guarded. Model labels
  and inherited false composer flags are not selected-control proof.
  Normal unsubmitted preparation may materialize the owned successor UI for that read.
  If mode is unknown, only an advertised exact model-picker reveal may inspect it;
  this selects nothing, preserves the draft and never resumes saved Submit.
  Preserve wrong-mode work and use the authorized same-role replacement; never replay it.
  Do not bypass access controls.
- `submission_unknown` means acknowledgement is ambiguous. Use team_get with the
  same requestRef and view:evidence for read-only recovery; never automatically resend it.
  If `evidence.submissionCandidates` contains the matching submitted message,
  compare it with `requested.prompt` and call decide with `decision: "acknowledge"`,
  its `messageId` and `evidenceHash`. This connects the existing answer without
  sending. CLI/MCP acknowledge keeps valid provider deferrals inside that one call,
  retaining the same requestId/messageId/evidenceHash and honoring nextCheckAt.
  Every retry revalidates fresh evidence; stale/unverified evidence returns for
  reconciliation. Do not start another acknowledge or collector while it is pending.
  Do not guess from incomplete or ambiguous candidate text; ask the user
  when the available evidence cannot establish which message belongs to the request.
  If the result has status `recovery_required` and recovery.state `unavailable`,
  stop polling/refreshing: the owned page and durable conversation ID are both absent.
  `promptSubmitted:true` here is an attempt, not confirmed acceptance. Explicitly
  decide whether to replace the session and continue new work; deletion is skipped
  for an unidentified conversation. Ask the user when
  that decision exceeds your authority; do not silently replay the old prompt.
  Keep the original requestRef and uncertainty; replacement does not delete it.
- A definite pre-submit failure with promptSubmitted:false permits corrected new
  work with a new requestId. Refresh the roleRef first. Waiting cannot fix bad input.
- After restart, team_get returns pending requests. Observe fresh evidence before
  making decisions on the same request. Do not create replacement sends to resume.
- `sessionplane_stop` cancels preparation or stops exactly that request.
  A `provider.stop-unavailable` result means no mutation was attempted;
  `provider.stop-unknown` means an attempt without provider acknowledgement.
  Neither proves cancellation. Read the same request; do not repeat an uncertain
  stop with another ID. Get/wait retain `stopOutcome.state:"unknown"` across restart.
  `provider.actionable-alert` identifies a visible provider error separately from
  conversation/read unavailability and backend 429. Inspect `evidence.providerAlerts`.
- For explicitly authorized context renewal that must retain the old conversation,
  use `sessionplane_session_replace` with
  `preserveConversation:true`, its fresh roleRef and a distinct stable requestId.
  It keeps the same role ID/key and provider; preserves the old chat/pages,
  request/draft and evidence; and creates an empty successor with predecessorSessionId.
  Only role routing moves to the successor. Inspect cleanup.outcome `preserved`,
  then use the successor's fresh roleRef for separately authorized current work,
  with fresh model/effort and once-only submission. No original stop is needed.
  A bound prepared/unsubmitted request may retain an unreadable page. A submitted
  request requires its exact ACK mounted on an idle owned page with no later user,
  draft, active generation, permission or human verification. This also supports
  actual conversation-length exhaustion without claiming a final answer; retrieve
  available results and preserve the handoff first. UNKNOWN delivery, inconsistent
  evidence, stale references and prior deletion attempts remain rejected. When the
  user explicitly requests a new context despite unresolved work, add
  `unresolvedHandoff:{requestRef,approvalRef}` to preserving replacement after
  holding that exact request and transferring its collectors. This moves only
  same-role routing; the original request/ACK/draft/hold and nonterminal or UNKNOWN
  state remain available. No idle-page claim, stop, replay or completion is implied.
  CLI: add `--unresolved-handoff FILE` containing those two fields. This is
  not automatic recovery or an access/security bypass. The original Coordinator
  owns the routing decision and the separately authorized next prompt.
- An empty successor needs no invented product prompt to show its Chat page:
  `sessionplane_session_open` takes teamId, its fresh roleRef and requestId
  (CLI: `request open TEAM_ID ROLE_REF`). It creates no generation, fills nothing,
  submits nothing and starts no collector. Use returned actual mode evidence;
  configuration/submission still require verified Chat.
- When the user explicitly orders disposal of an obsolete conversation with UNKNOWN
  children, preserve their references in the existing agent-handoff, hold the exact
  old observation and consume its collector before replacing the same role. After
  displacement, decide `retire_observation` with `discardUnresolved:true` and that
  existing evidenceRef; omit workComplete. This disposes local tracking only and
  preserves all original generation, ACK, draft, result and command uncertainty.
  The same explicit route accepts a displaced, held prepared/unsubmitted obsolete
  draft with no ACK and no collectors; it never submits that draft or asserts completion.
  Then session_delete may use `outputsRetrieved:true` for the available preserved
  outputs plus `discardRetiredObservation:{conversationId,evidenceRef}`. This never
  asserts a missing final or child END. CLI exposes `request retire_observation
  TEAM_ID REQUEST_REF --discard-unresolved --evidence-ref REF`, and `request delete
  TEAM_ID REQUEST_REF --outputs-retrieved --discard-retired-observation FILE`.
  Deletion failure does not block the existing successor. Inspect deletion and
  pageCleanup separately; shared work, active pages and drafts remain guarded.
- For authorized context renewal, use `sessionplane_session_replace` on the same
  stable role with its fresh `roleRef` and the same provider. Keep the role ID/key;
  do not create dated continuation roles for the same responsibility.
  Resolve the current request, retrieve required answers/files and save a concise
  handoff first: objective, decisions, evidence/artifacts, unresolved work, next
  step and model/effort. Carry it into the returned successor's fresh roleRef with
  fresh preparation. Replacement itself never sends or replays a prompt.
  `conversationUsage.handoffRecommended` at 10 confirmed turns is a cue to prepare
  this handoff, not a cutoff or permission to interrupt active/UNKNOWN work.
  Default replacement makes one authorized best-effort provider conversation
  deletion attempt, ends old observation and independently closes verified idle
  owned tabs. Deletion failure does not block routing or safe tab closure. Preserve
  active work, uncollected results, shared pages and drafts; never bypass a guard.
  Local stored answers/files and original request identities remain available.
  Inspect `replacement.cleanup` for the exact predecessor and deletion receipt:
  outcomes are `confirmed`, `refused`, `uncertain`, `not-attempted`, or historical
  `unknown`. Check `pageCleanup.closedPages` and `pageErrors` separately and confirm
  the old target is closed; tab closure does not prove provider deletion. Do not
  blindly retry a provider DELETE. Use already granted cleanup authorization;
  a turn count alone grants none. The preserving recovery mode above deliberately
  retains old pages and is not the completed-context renewal path.
  If team_get shows an existing role with no session/roleRef, initialize it with
  session_replace using its roleKey instead. Do not recreate that role.
- `sessionplane_team_delete` deletes an entire team, its roles and request history,
  stops owned work and closes owned tabs. Retrieve needed outputs first. Provider
  deletion is attempted once; per-session failures do not block local deletion.
  Pass teamId and a stable requestId; exported files remain.
- `sessionplane_role_retire` ends a non-primary role without deleting provider history.
- `sessionplane_session_delete` attempts deletion of the exact completed provider
  conversation after retrieving required outputs. Pass its exact requestRef and
  outputsRetrieved:true. Check provider deletion separately from
  `pageCleanup.closedPages`/`pageErrors`, including typed error details: deletion
  failure does not block safe idle-tab closure. Replaying a confirmed deletion
  receipt can resume tab closure without repeating the provider DELETE. Preserve
  drafts, active generation and ambiguous/shared work. Role retirement or creating
  another role is not cleanup; normal context renewal uses the same stable role.
- ChatGPT is enabled by default. Gemini/Grok require explicit operator enablement.
  Human verification must be completed by a human; never solve or bypass it.

Search, context packaging, project-source management and special code ZIP flows
are not SessionPlane tools. Use the agent's existing file/search tools and include
needed text in the prompt. Uploads are disabled by default; send files only when
the team's capabilities.uploadsEnabled is true. Downloads remain available.
