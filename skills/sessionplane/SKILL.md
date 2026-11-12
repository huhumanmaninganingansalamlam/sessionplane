---
name: sessionplane
description: Run durable ChatGPT project/task conversations using the six-tool SessionPlane MCP interface.
---

# SessionPlane

Use the connected SessionPlane Core, not a second browser or task runner.
Keep stable clientId ownership. The normal public interface has only
project.open and task.start/get/wait/decide/cancel, plus system.health.

## Agent work

1. Call sessionplane_project_open with stable projectKey and requestId.
   Retain projectId, mainConversationSlotId and conversationRevision.
   ChatGPT uses verified Pro intent by default.
2. Call sessionplane_task_start with that projectId, the current
   expectedConversationRevision, original prompt and a fresh requestId.
   Omitting conversationSlotId targets Main. A continuation policy requires
   a real standing approvalRef, 1200000ms interval and exact 계속 message.
3. Call sessionplane_task_get or a single bounded sessionplane_task_wait
   from afterRevision. Neither call owns provider execution.
4. If a pending decision is returned, choose its current semantic actionRef
   using sessionplane_task_decide with its decisionId and unique requestId.
   Input is accepted only when the action advertises its bounded schema.
   Stale decisions are reobserved, never replaced with arbitrary selectors.
5. On completed, request view=result for the entire exact answer. Evidence
   view is bounded provenance. Start the next substantive question as a
   separate Task on the same Main conversation using its new revision.
6. sessionplane_task_cancel records intent and revokes future Continue.
   An attempted external mutation may remain uncertain until verified.

## Evidence rules

The first POST is persisted before ACK with exact session, page, target,
generation, user message ID, parent and text hash. A browser URL change is
only a candidate conversation. Canonical GET must prove the exact message
and user turn before binding. A missing or ambiguous POST or late HTTP 429
never permits a second POST. Core owns pacing and read-only restart recovery.
Permission prompts and provider questions remain real decisions, not
proof of external work completion.

Use sessplane mcp for the six public tools. Operator login and doctor are
separate commands. Old team/role/request/workflow commands are not part
of the public runtime. For remote Core, use the configured SSH transport
with the same clientId and requestId identities.
