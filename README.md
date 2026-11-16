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
requires recorded user delegation and stays under the Core-owned timer. Before
an approved 20-minute due, the Core reserves only that exact canonical
conversation's next provider read; ordinary background reads cannot consume the
slot and extend a 429 fence past the due. A direct 429 is retried at its exact
`nextCheckAt`, and only a later fresh canonical no-FINAL observation may license
the single approved Continue POST. After the exact draft is committed, the Core
may briefly re-observe the unchanged lease/model/draft until the unique Send
control becomes enabled; that bounded wait performs no second fill and no POST,
then consumes the exact send action once.

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

Use the matching package version after that release is published:

VERSION=0.4.106
    npm install -g ./sessionplane-$VERSION.tgz
    sessplane doctor --json

## Offline state rehearsal (synthetic or explicitly approved copy only)

The dev-only scripts/offline-state-rehearsal.mjs tool performs a consistent
SQLite backup (including WAL commits), keeps the original snapshot, and
migrates another candidate. It never edits the source database, Core,
browser profile or installed package.

    node scripts/offline-state-rehearsal.mjs migrate --source SOURCE_COPY.sqlite --destination REHEARSAL_DIR

The manifest records original table counts/content hashes, the snapshot
SHA-256, candidate SHA-256 and schema version. Identical replays are
read-only; changed sources or output hashes fail closed.

    node scripts/offline-state-rehearsal.mjs rollback --migration REHEARSAL_DIR --candidate REHEARSAL_DIR/candidate.sqlite --destination ROLLBACK_DIR

The sealed original can also be checked without the removed workflow runtime:

    node scripts/offline-state-rehearsal.mjs inspect --migration REHEARSAL_DIR

The installed npm tarball includes scripts/offline-state-rehearsal.mjs.
Its inspector verifies the SQLite source snapshot SHA-256, integrity,
row counts/hashes and old submission-state counts without disclosing
stored conversation bodies or starting a Core/browser.

Rollback preserves every post-migration candidate fact in a separate
evidence snapshot before restoring the original to another destination.
It never replaces the candidate in place. Run synthetic tests:

    node --test --experimental-strip-types test/integration/offline-state-rehearsal.test.ts

This verifies isolated L2 candidates, not live data approval or production
cutover. Shared/Core data and unknown-owner projects are out of scope.

## Existing logged-in browser and live acceptance

The developer preflight observes the existing SessionPlane Core and Chrome via
two read-only Core RPC methods plus bounded CDP structural checks. It never
reads conversation bodies, creates a tab, changes focus, opens a project,
submits a prompt, clones a profile, or migrates the live database.

    node scripts/live-candidate-preflight.mjs

The result distinguishes the **installed Core schema/source** from the locally
built candidate. A logged-in ChatGPT page and Pro UI are not proof that a
different, uninstalled Core implementation was exercised. A mismatched
installed schema or source is reported as a blocker, not silently upgraded.
The bounded DOM sample is diagnostic only: an archived or unhydrated sampled
tab without a composer does not block the exact Task path, which revalidates its
own current page before every provider mutation.

After a separately verified candidate is installed as the exact active Core
(runtime ownership and data migration are separate reviewed operations),
the bounded live acceptance runner uses a dedicated project/owner and only
three synthetic prompts. It records stable request IDs before sending. The
current SessionPlane-owned browser may be `spawned` or `adopted`; historical
PIDs, CDP ports and target IDs are diagnostics, not acceptance identity. Run
start and resume as distinct processes to prove that a client exit or a later
Core/browser/host restart does not own generation, ACK recovery or timers:

    node scripts/live-task-acceptance.mjs --phase start --client-id sessionplane-l3-UNIQUEOWNER --project-key sessionplane-l3-UNIQUEPROJECT --receipt-dir /ABSOLUTE/TEST-RECEIPT --allow-live-send
    node scripts/live-task-acceptance.mjs --phase resume --client-id sessionplane-l3-UNIQUEOWNER --project-key sessionplane-l3-UNIQUEPROJECT --receipt-dir /ABSOLUTE/TEST-RECEIPT --allow-live-send

The runner checks one original POST/ACK, exact FINAL byte hashes, and the same
canonical Main conversation across three Tasks. On resume it reconciles a stale
local receipt from the Core's durable Task state, including after browser/host
replacement, before creating a later Task. A blocked agent decision, uncertain
provider effect or failing answer stays recorded and **never** causes a guessed
replay. The script does not choose permissions or switch models.
This is an L3 test runner, **not** a bypass around a currently installed old
Core; it refuses every mutation until the installed Core matches the candidate
schema and verified source identity. It does not by itself prove a natural
20-minute Continue or multi-project foreground invariance.

## Reproducible candidate acceptance

For a clean committed dev candidate, run:

    npm run test:candidate -- --live-readonly

This checks Core, Chromium, four background project tabs, installed tarball,
offline migration and source/tree/package checksum. Its read-only live
preflight does not restart or replace the existing Core. An L1/L2/L4
candidate pass is not a live v15 Core pass or release approval. See
docs/verification/sessionplane-candidate-acceptance-gates.md.

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
