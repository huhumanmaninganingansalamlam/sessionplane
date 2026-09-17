---
name: web-ai
description: Run durable ChatGPT, Gemini, and Grok sessions through SessionPlane teams, roles, generations, uploads, waits, and artifacts.
---

# SessionPlane Web AI

The core owns provider Pages and continues observation after the calling shell
or MCP subprocess exits. Preserve `teamId`, `roleKey`, `sessionId`, and
`generation`; never select a chat by active tab or title.

```bash
sessplane team create --name issue-123 --request-id issue-123-team --json
sessplane role add "$TEAM_ID" expert.backend --type expert \
  --request-id issue-123-backend-role --json
sessplane session create "$TEAM_ID" expert.backend --provider chatgpt \
  --request-id issue-123-backend-session --json
sessplane send "$TEAM_ID" expert.backend --prompt "Review this" \
  --file ./context.md --request-id issue-123-backend-1 --json
sessplane wait --session "$SESSION_ID" --generation "$GENERATION" --json
```

`waitExpired` and backend observation deferral are nonterminal success states.
`submission_unknown` must never be automatically resent. Use a stable
`requestId` only for an exact retry of the same mutation.

Provider-created files are durable:

```bash
sessplane artifact discover --session "$SESSION_ID" --json
sessplane artifact capture --session "$SESSION_ID" --json
sessplane artifact export "$ARTIFACT_ID" --out ./result.zip
```

Use `sessplane context dry-run` before a large submission and either upload the
generated package or select inline transport.

