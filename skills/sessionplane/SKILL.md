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
   fresh evidence and recorded choices. `sessionplane_decide` takes the requestRef,
   fresh snapshotId/ref, purpose and `choose` or `reveal`. Model/effort reveal opens
   observed related options, including nested menu items. Reveal a submenu before
   choosing its options; opening it is not a model selection. Slider choices also
   take a numeric value, interpreted from the observed labels and range. Core
   executes the choice and continues the same request; there is no resume tool.
   Choose composer and submit controls, and model/effort when requested. New UI
   evidence can require another choice. Never reuse stale UI refs.
   A recorded choice is not proof that it remains selected: another choice may
   change the same control. Reopen the related chooser and choose fresh evidence
   satisfying the original intent. Model and effort may share one control;
   do not assume they are independent or that a version option establishes Pro.
   Keep the same requestRef through preparation; cancelling and sending again
   does not resolve a selection mismatch.
5. `sessionplane_wait` takes one or several requestRefs from this team. It returns
   exact answers and captures generated files; outputDir exports stored bytes.
   Inspect each result and file failure. Old requests can capture files from their
   exact answer even after a newer send; unavailable provider content is a file error. A timeout does not stop provider work.
   When terminal:false, backend-http-429, probe pacing and waitExpired are
   observation delays, not failed generation. Respect nextCheckAt and continue
   waiting on the same requestRef. Do not ask the user to copy the answer merely
   because observation is deferred. After an interrupted caller resumes, fetch
   that request again: the core keeps observing and may already have its answer.

The caller chooses experts and context; SessionPlane does not automatically fan
out prompts, infer consensus, or inject answers into other roles.

## Recovery and cleanup

- Preserve semantic model intent such as Pro, regardless of visible version labels.
  Use Chat only, never Work. Do not change model/provider as an error fallback.
- `submission_unknown` means acknowledgement is ambiguous. Use team_get with the
  same requestRef for read-only recovery; never automatically resend it.
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
