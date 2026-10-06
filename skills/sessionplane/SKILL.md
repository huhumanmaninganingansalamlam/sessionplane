---
name: sessionplane
description: Converse with main and expert AI roles through a durable SessionPlane team using native MCP.
---

# SessionPlane

Use the registered SessionPlane MCP tools. Keep `teamId`; start or resume with
`sessionplane_team_get`. The core owns the dedicated browser, durable requests,
observation and recovery. Do not launch another core or control its pages with
external browser tools. General website work belongs to separate browser tools.

If native tools are absent, configure the stdio server as `sessplane mcp` and
reload the client's MCP connection. Installing a skill alone does not register
MCP. Do not replace missing MCP with shell-generated prompts or raw JSON-RPC.

## Conversation

1. `sessionplane_team_create` creates the team and main conversation.
   `sessionplane_role_create` adds an expert and its conversation.
2. `sessionplane_team_get` returns roleRefs and requestRefs. Copy references from
   results; do not reconstruct them. Include a requestRef for its exact result or
   fresh UI evidence. Retired/replaced conversations remain individually addressable.
   To rediscover older requestRefs, use history:true and continue with nextRequestRef
   as beforeRequestRef until null.
3. `sessionplane_send` takes teamId, a fresh roleRef, prompt and intended model/
   effort. Every mutation needs a distinct stable requestId; retry that ID only
   with identical arguments. A stale roleRef requires refreshing team_get.
4. `status: needs_decision` is a normal handoff, not a failed send.
   The first send returns `configurationCatalog.options`: combined configuration
   labels observed by SessionPlane in the provider UI, each with an `id`.
   Choose the option matching the requested model/effort: copy `option.selection`
   into `sessionplane_decide` with teamId, requestRef and a stable requestId. This
   uses the existing choose/model/snapshotId/ref tool schema. Updated clients may
   also use `decision: "configure", configurationId: option.id`. Neither path needs
   menu navigation, selectors or numeric power inference. Configure verifies the result and never submits.
   Later requests reuse the catalog; each selection is revalidated on its own page.
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
   `team_get` on the same requestRef and check `promptSubmitted`, submissionState
   and terminal. Submitted, ambiguous or terminal requests are not preparation work.
   If still prepared/unsubmitted, use fresh exact-page evidence: when the current
   combined model/version/effort summary matches the user's intent, record that
   observed summary with native choose/model and its snapshotId/ref instead of
   repeating the failed catalog click. Preserve the actual version; generic Pro
   does not require switching an already intended 5.5 Pro to 5.6 Pro. Reinspect
   after menu/composer changes and use the current summary, never an old menu ref,
   account badge or inferred slider power. Missing or mismatching evidence is not
   readiness. A saved Submit choice can resume after any later raw choose, so
   only the original Coordinator performs this recovery; readiness-only work must
   have no saved Submit choice. Recheck current status before each such choose.
   Follow explicit user corrections when request hints conflict. Keep the same requestRef.
   When the user requests a page refresh, or visible stream/history recovery
   failure warrants one, call `sessionplane_decide` with decision `refresh`,
   teamId, requestRef and a stable requestId. No snapshotId/ref/purpose is needed.
   It reloads only the exact owned page, never resends the prompt or presses Retry.
   Reinspect afterward; preparation requires fresh model/effort confirmation.
   Do not refresh healthy long-running thinking on a timer or bypass verification.
5. `sessionplane_wait` takes one or several requestRefs from this team. It returns
   exact answers and captures generated files; outputDir exports stored bytes.
   Inspect each result and file failure. Old requests can capture files from their
   exact answer even after a newer send; unavailable provider content is a file error. A timeout does not stop provider work.
   When terminal:false, backend-http-429, probe pacing and waitExpired are
   observation delays, not failed generation. Continue bounded `sessionplane_wait`
   calls on the same requestRef with positive `waitMs`, including before `nextCheckAt`.
   `nextCheckAt` schedules the core's backend probes only, not result collection.
   Do not sleep until it: DOM observation continues and `wait` can return completion
   earlier. The core enforces probe cooldowns; do not bypass them with refresh or resend.
   Do not ask the user to copy the answer merely
   because observation is deferred. After an interrupted caller resumes, fetch
   that request again: the core keeps observing and may already have its answer.
   For provider-actionable-alert, inspect evidence or team_get on the same requestRef
   and report the visible error. Active thinking/streaming needs waiting; a visible
   stream/history recovery failure may need scoped refresh, then reinspection.
   For an idle current-turn Thinking failed, the original Coordinator can use
   decide with decision `reconcile_failure`, the same teamId/requestRef and a
   stable requestId. The core freshly verifies the original submitted anchor,
   actual failure header and composer, rejecting later user turns, answer candidates,
   Stop/thinking/streaming, stale/missing evidence, generic alerts and refusals.
   Success records failed/terminal with provider.execution-failed while keeping
   submitted:true, original evidence and conversation; no Stop, deletion or replay
   occurs. Only then may the original Coordinator send an explicitly authorized
   follow-up as the next generation in the same chat. This does not authorize tool
   reexecution. For an explicitly recovery-authorized task, a **new** ChatGPT send
   may set `thinkingFailureRecovery:true` to hand follow-up sending to the core.
   Default is off; existing requests stay manual. While enabled, do not send in
   parallel: the core reconciles only an exact idle Thinking failed, preserves the
   actual combined model/effort and original deadline, and sends literal `계속`
   once per failed generation with backoff. Follow
   `thinkingFailureRecovery.successorRequestRef` to collect the successor; the
   original failure remains separate. Normal final stops the chain. `state:paused`
   returns its saved requestRef/reason and owner control; inspect it without
   blindly resending. Missing/stale configuration, manual draft/follow-up, active
   generation, ambiguous submit, other alerts or auth/refusal never auto-retry.
   A later genuine Thinking failed in manual mode needs its own fresh reconciliation;
   never repeat a live send or treat timeout/refusal as this failure.
   Escalate persisting failures instead of polling indefinitely. A Retry control
   alone does not imply human verification; Retry/resend is not read-only recovery.
   Provider completion is not task completion. If a completed answer stops at a
   checkpoint or leaves authorized work unfinished, read it and send a contextual
   continuation to the same role with a fresh roleRef/requestId. Preserve the prior
   result. Elapsed time alone does not justify a continuation while work is active.

The caller chooses experts and context; SessionPlane does not automatically fan
out prompts, infer consensus, or inject answers into other roles.

## Recovery and cleanup

- If get/wait returns `recovery.state: "exhausted"`, automatic conversation-load
  clicks stopped at100. Report its `notification.message` and original URL to the
  user once per stable notification ID, then await manual review of that original
  conversation. Team get also exposes pending notices in `notifications`.
  Preserve submitted/UNKNOWN identities and stored results; do not reset the
  counter, resend, replace or delete as a substitute. No terminal generation is
  implied. Existing waits wake on this notice; offline clients see it on next
  get/wait. `notifiedAt` is notice creation, not a human read acknowledgement.

- The core automatically recovers an exact ChatGPT **conversation-load** error
  by clicking only the page button immediately below that error (not a generation
  Retry). All owned conversations share one durable fair queue: at most one attempt
  per60s across the profile, up to100 attempts per conversation without resetting
  on restart/rebind. Existing longer account cooldowns and Retry-After win; unknown
  429/visible service limits wait15min. Drafts, generation, verification/permissions,
  missing/ambiguous buttons and changed binding/surface hold the attempt. Each click
  rechecks those guards atomically; this never submits, stops or terminalizes work.
  Normal loaded history/composer ends recovery, including manual recovery. Inspect
  `conversationLoadRecovery` in exact team_get and health for attempts, outcome,
  holds, nextAllowedAt and the deduplicated exhaustion notice. Preserve UNKNOWN
  submission and original anchors; do not start a competing refresh loop or replay.
  This does not recover screenshot/compositor failures merely because DOM responds.

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

- Select the requested combined model/effort label from the observed catalog.
  Preserve requested model/mode through cancellation and replacement. Honor exact
  versions; do not substitute or infer Pro from an account badge or High effort.
  Use Chat only, never Work. Do not bypass access controls.
- `submission_unknown` means acknowledgement is ambiguous. Use team_get with the
  same requestRef for read-only recovery; never automatically resend it.
  If `evidence.submissionCandidates` contains the matching submitted message,
  compare it with `requested.prompt` and call decide with `decision: "acknowledge"`,
  its `messageId` and `evidenceHash`. This connects the existing answer without
  sending. Do not guess from incomplete or ambiguous candidate text; ask the user
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
- For an explicitly authorized recovery of an unreadable bound conversation with
  a current prepared/unsubmitted request, use `sessionplane_session_replace` with
  `preserveConversation:true`, its fresh roleRef and a distinct stable requestId.
  It keeps the same role ID/key and provider; preserves the old chat/pages,
  request/draft and evidence; and creates an empty successor with predecessorSessionId.
  Only predecessor routing becomes superseded. Inspect cleanup.outcome `preserved`,
  then use the successor's fresh roleRef for separately authorized current work,
  with fresh model/effort and once-only submission. No original stop is needed.
  Submitted/UNKNOWN states, anchors, inconsistent evidence, stale references and
  prior deletion attempts are rejected. This is not an access/security bypass or
  automatic recovery; do not duplicate or migrate an active continuation without
  its current coordinator's routing decision.
- By default, `sessionplane_session_replace` attempts to permanently delete the previous provider
  conversation once, closes its tab and ends observation, then creates its successor.
  Retrieve required outputs and write the handoff first. Local stored answers/files
  remain. Deletion failure or unknown conversation identity does not block replacement;
  there is no automatic cleanup retry. Old observation stays stopped across restarts.
  It never replays unresolved work.
  Routing success is separate from `replacement.cleanup`: inspect its exact
  predecessor session/generation/conversation, deletion request ID and actual
  deletion receipt client/request/status. Outcomes are `confirmed`, `refused`,
  `uncertain`, `not-attempted`; historical missing results stay `unknown` without
  cleanup retry. Obtain required specific deletion confirmation before replacement;
  a handoff or turn-count recommendation is not confirmation.
  Read `conversationUsage`: at 10 confirmed user turns, `handoffRecommended:true`
  recommends finishing the current request, retrieving outputs, and writing a
  handoff with the objective, decisions, evidence/files, unresolved work, next step,
  and model/effort. For a nondeleting handoff, use `sessionplane_role_create` with
  a unique roleKey and roleType `custom` in the same team, then continue through
  that role's fresh roleRef. The old role/session stays available; this does not
  repoint the primary role. For the narrow prepared/unsubmitted same-role case,
  use preserving replacement above. Default deleting replacement still requires
  specific deletion confirmation.
  This recommendation does not authorize replaying an unresolved submission.
  If team_get shows an existing role with no session/roleRef, initialize it with
  session_replace using its roleKey instead. Do not recreate that role.
- `sessionplane_team_delete` deletes an entire team, its roles and request history,
  stops owned work and closes owned tabs. Retrieve needed outputs first. Provider
  deletion is attempted once; per-session failures do not block local deletion.
  Pass teamId and a stable requestId; exported files remain.
- `sessionplane_role_retire` ends a non-primary role without deleting provider history.
- `sessionplane_session_delete` permanently removes a completed provider conversation
  after retrieving required outputs. Pass its exact requestRef and outputsRetrieved:true.
  Never delete active, ambiguous or shared work.
- ChatGPT is enabled by default. Gemini/Grok require explicit operator enablement.
  Human verification must be completed by a human; never solve or bypass it.

Search, context packaging, project-source management and special code ZIP flows
are not SessionPlane tools. Use the agent's existing file/search tools and include
needed text in the prompt. Uploads are disabled by default; send files only when
the team's capabilities.uploadsEnabled is true. Downloads remain available.
