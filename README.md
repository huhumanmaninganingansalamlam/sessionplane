# SessionPlane

SessionPlane is a durable project/task conversation runtime. One Core owns its
dedicated Chromium profile, SQLite journals, actor scheduler, exact ChatGPT
POST evidence, canonical ACK and FINAL recovery, and approved continuation.
The CLI and MCP use the same socket transport; they do not execute a separate
browser, scheduler, or collector.

## Public interface

The current dev interface is project/task-oriented. The former team, role,
request and workflow public commands are removed rather than translated.

    sessplane project open --key example --name Example --request-id open-1 --model Pro --json
    sessplane task start PROJECT_ID --expected-conversation-revision 1 --request-id question-1 --prompt-file question.txt --json
    sessplane task get TASK_ID --json
    sessplane task wait TASK_ID --after-revision 1 --wait-ms 30000 --json
    sessplane task get TASK_ID --view result --json
    sessplane task decide TASK_ID DECISION_ID ACTION_REF --request-id decide-1 --input "Pro" --json
    sessplane task cancel TASK_ID --request-id cancel-1 --json

Use a stable --client-id for ownership, and a unique --request-id for each
distinct mutation. Reuse that identity only for an identical request. The
project response includes projectId, mainConversationSlotId and current
conversationRevision. Task start uses Main by default. The first POST is
durably journaled, then bound to the conversation only after an authenticated
canonical GET confirms the exact message and turn. The Pro model must be
verified as actually selected. Missing ACK, HTTP 429, or an interrupted POST
does not authorize resending the same question.

Task get and task wait are read-only. A wait runs once with a bounded
deadline; the Core keeps the Task alive after clients disconnect. Agent
decisions carry a current decisionId and semantic actionRef; callers may
submit only the advertised bounded input. Result view exposes the complete
answer; evidence view exposes bounded provenance. Approved continuation
requires recorded user delegation and stays under the Core-owned timer.

## MCP

Run the standard MCP stdio server:

    sessplane mcp

Register in Codex:

    codex mcp add sessionplane -- sessplane mcp

The default MCP catalogue contains exactly:
- sessionplane_project_open
- sessionplane_task_start
- sessionplane_task_get
- sessionplane_task_wait
- sessionplane_task_decide
- sessionplane_task_cancel

There is no legacy catalogue, no --public switch, no provider-selector
mutation tool, and no client-managed continuation collection.

## Operator commands

    sessplane serve
    sessplane health --json
    sessplane doctor --json
    sessplane browser-list
    sessplane login --manual
    sessplane login --resume
    sessplane skills list --json

The operator browser login/diagnostics and internal maintenance are not
normal public Task choreography. The existing Core ownership, profile and
durable evidence remain preserved.

## Remote execution

A client may use the existing Core over a strictly verified SSH transport:

    export SESSIONPLANE_REMOTE_HOST=workshop@remote-host
    sessplane health --json
    sessplane mcp

Install and start the Core/browser on the remote host. SSH uses host-key
verification and a socket relay, never an extra client-side Core. A lost
mutation response must be inspected using the same Task/request identity
rather than automatically resubmitted.

## Installation

Tagged release instructions use the matching package version:

VERSION=0.4.93
    npm install -g ./sessionplane-$VERSION.tgz
    sessplane doctor --json

## Development

Requires Node.js 24.15–24.x and a Chromium-family browser for browser tests.

    npm ci
    npm run typecheck
    node --test --test-concurrency=1 --experimental-strip-types test/integration/public-cli.test.ts test/integration/public-task-rpc.test.ts
    node --test --test-concurrency=1 --experimental-strip-types test/browser/semantic-core-composition.test.ts
    npm run build
    npm run test:package

Package smoke installs the actual tarball in an isolated prefix, validates
the six-tool MCP catalogue and rejection of retired tools, and checks the
shipped runtime for old public CLI/RPC handlers.

Historical lower-level fixtures and product planning documents are retained
for internal recovery investigation. They do not re-enable removed public
workflow entrypoints. Release cutover and installation remain distinct from
local dev work.
