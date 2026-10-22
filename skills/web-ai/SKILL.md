---
name: web-ai
description: Use durable SessionPlane teams for ChatGPT, Gemini and Grok conversations and file results.
---

# Web AI

Follow the bundled `sessionplane` skill for the team-centered native MCP workflow.
Keep teamId, select returned role references, send, choose an observed configurationCatalog option by ID,
choose composer/submit from fresh evidence, then keep one managed wait on the returned request chain.
For user-approved normal continuation, include MCP `continuationApproved: true` or CLI
`--continuation-approved`; without it collection only observes. The existing long wait owns paced
literal `계속` and successor collection; do not add manual sends or competing collectors.
Return recovery decisions/send failures promptly. If refresh or human review is needed, focus the
exact tab and report the current error and one user action; never refresh automatically.
A final answer is read before a separate contextual next-work follow-up. Providers require
operator enablement; never silently switch model/provider or resend ambiguous work.
When `conversationUsage.handoffRecommended` becomes true at 10 confirmed user turns,
finish the current request, retrieve outputs, write a concise handoff, and use
`sessionplane_session_replace` with the same stable role, provider and fresh roleRef.
Keep the role ID/key; do not create dated continuation roles for the same work.
Carry the handoff into the returned successor with fresh preparation. Provider
conversation deletion is best effort; verify idle old-tab closure independently.
Preserve active/UNKNOWN work, uncollected results and drafts; the count is not a cutoff.
