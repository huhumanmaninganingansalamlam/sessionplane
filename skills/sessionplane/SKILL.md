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
   same requestRef. Incomplete discovery does not establish model unavailability.
   Then choose the composer and submit from fresh evidence with `decision: "choose"`,
   purpose and snapshotId/ref. Choose submit last. Raw choose/reveal remain available
   for diagnostics; do not reconstruct model combinations from partial menus.
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
   Escalate persisting failures instead of polling indefinitely. A Retry control
   alone does not imply human verification; Retry/resend is not read-only recovery.
   Provider completion is not task completion. If a completed answer stops at a
   checkpoint or leaves authorized work unfinished, read it and send a contextual
   continuation to the same role with a fresh roleRef/requestId. Preserve the prior
   result. Elapsed time alone does not justify a continuation while work is active.

The caller chooses experts and context; SessionPlane does not automatically fan
out prompts, infer consensus, or inject answers into other roles.

## Recovery and cleanup

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
- `sessionplane_session_replace` attempts to permanently delete the previous provider
  conversation once, closes its tab and ends observation, then creates its successor.
  Retrieve required outputs and write the handoff first. Local stored answers/files
  remain. Deletion failure or unknown conversation identity does not block replacement;
  there is no automatic cleanup retry. Old observation stays stopped across restarts.
  It never replays unresolved work.
  Read `conversationUsage`: at 10 confirmed user turns, `handoffRecommended:true`
  recommends finishing the current request, retrieving outputs, and writing a
  handoff with the objective, decisions, evidence/files, unresolved work, next step,
  and model/effort. Then replace the session and send that handoff in the new chat.
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
