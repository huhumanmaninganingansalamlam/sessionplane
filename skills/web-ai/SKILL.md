---
name: web-ai
description: Use SessionPlane project/task MCP for durable ChatGPT conversations.
---

# Web AI

Follow the bundled sessionplane skill. Open the owner-scoped project with
sessionplane_project_open, then start exactly one prompt through
sessionplane_task_start. Get/wait reads the persisted revision, decide takes
only an advertised actionRef, and result view returns the exact answer.

Core alone owns browser actions, canonical ACK/FINAL recovery and delegated
continuation. Never retry an uncertain send, infer an ACK from a URL, or
treat generated assistant text as proof of external tool completion. The
next substantive question is a new Task on the same Main conversation.
