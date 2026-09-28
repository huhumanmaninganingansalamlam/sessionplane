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
4. `status: needs_decision` is a normal handoff, not a failed send. Interpret the
   fresh evidence and recorded choices.
   Each preparation node lists supported purposes in `actions.choose` and
   `actions.reveal`. Select by its observed meaning and requested intent;
   these are supported operations, not recommendations. `evidence.interactive`
   only describes snapshot filtering, not permission or page capability.
   `sessionplane_decide` takes the requestRef,
   fresh snapshotId/ref, purpose and `choose` or `reveal`. Model/effort reveal opens
   observed related options, including nested menu items. Reveal a submenu before
   choosing its options; opening it is not a model selection. Slider choices also
   take a numeric value, interpreted from the observed labels and range. Core
   executes the choice and continues the same request; there is no resume tool.
   Choose the composer, requested configuration and submit controls. New UI
   evidence can require another choice. Never reuse stale UI refs.
   Choose the composer first to authorize replacing its restored draft with this
   request's prompt. Model and effort describe intent, not required UI dimensions.
   Configure any independent controls needed, then confirm the final configuration
   once using model or effort and choose submit last. A newer configuration choice
   replaces the prior confirmation. A displayed summary can confirm without clicking.
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
   observation delays, not failed generation. Respect nextCheckAt and continue
   waiting on the same requestRef. Do not ask the user to copy the answer merely
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

- A requested model can combine a family/version with a reasoning tier. Select
  those dimensions through the observed controls and confirm the final summary;
  do not require the entire requested name to appear as one menu item. Truncated
  evidence cannot establish that an option is unavailable.
- Preserve requested model/mode through cancellation and replacement. Confirm active
  model/effort controls: an account badge, High or Extra High does not establish Pro.
  Inspect nested options, ranges and actual enabled state; nearby access hints alone
  do not prove unavailability. Honor explicit versions; otherwise choose the latest
  matching option. If unavailable, return evidence for a user decision.
  Use Chat only, never Work. Do not substitute models/providers or bypass access controls.
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
  decide whether to use session_replace and continue with new work, considering
  possible duplicate processing and the user's authorization. Ask the user when
  that decision exceeds your authority; do not silently replay the old prompt.
  Keep the original requestRef and uncertainty; replacement does not delete it.
- A definite pre-submit failure with promptSubmitted:false permits corrected new
  work with a new requestId. Refresh the roleRef first. Waiting cannot fix bad input.
- After restart, team_get returns pending requests. Observe fresh evidence before
  making decisions on the same request. Do not create replacement sends to resume.
- `sessionplane_stop` cancels preparation or stops exactly that request.
- `sessionplane_session_replace` explicitly rotates a broken/long conversation;
  carry forward necessary context yourself. It never replays unresolved work.
  If team_get shows an existing role with no session/roleRef, initialize it with
  session_replace using its roleKey instead. Do not recreate that role.
- `sessionplane_role_retire` ends a non-primary role without deleting provider history.
- `sessionplane_session_delete` permanently removes a completed provider conversation
  after retrieving required outputs. Pass its exact requestRef and outputsRetrieved:true.
  Never delete active, ambiguous or shared work.
- ChatGPT is enabled by default. Gemini/Grok require explicit operator enablement.
  Human verification must be completed by a human; never solve or bypass it.

Search, context packaging, project-source management and special code ZIP flows
are not SessionPlane tools. Use the agent's existing file/search tools and attach
needed files to ordinary sends.
