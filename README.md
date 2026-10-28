# SessionPlane

SessionPlane is a local or SSH-accessed remote runtime that controls a user-installed Chromium-family
browser through Playwright, owns one dedicated persistent profile, and safely
coordinates durable, role-addressed AI chat sessions for multiple clients.

The core process owns browser state, SQLite state, session actors, observation,
and recovery. The `sessplane` CLI and MCP adapter are thin Unix-socket clients.
SessionPlane is maintained as an independent project with one canonical CLI
and one runtime contract.

## ChatGPT mode

ChatGPT sends require an observed Chat selection, independently of model and effort.
`session show` and exact-request `team_get` with `view:evidence` return `observedSurface` with `mode`,
`source` and `observedAt`; `requested.surface` is caller intent, not observation.
The provider reads an explicit selected control or the mounted composer's explicit
Work-conversation state. During preparation, temporary missing or conflicting
evidence is reobserved on the same composer within the normal readiness wait.
Confirmed Chat continues the same request; unresolved evidence remains `unknown`
without changing the draft or requiring human confirmation. Existing Work requests remain readable;
only their Coordinator performs an authorized same-role Chat replacement.

## Browser diagnostics

Persistent Chromium histogram files are disabled by default for both normal
and manual-login browsers. `SESSIONPLANE_BROWSER_METRICS=true` explicitly enables
it for diagnosis on the browser host. Modern Chrome initializes metrics before
feature flags: SessionPlane reserves the dedicated `BrowserMetrics` storage path
with its own marker file, causing Chrome to use its local-memory fallback. Opt-in
restores that owned path to a directory. Unknown or active files are never replaced.
On launch and normal close, only retired
BrowserMetrics files are pruned: opt-in keeps at most 64 for 24 hours; default
keeps none. Files belonging to live/inaccessible PIDs are preserved. Chromium's
single spare file is removed only after the owned browser exits. Existing running
browsers keep their launch options until their next normal launch; no restart is
required or performed to change this setting.

## Remote execution over SSH

Local mode remains the default. For remote mode, install the same SessionPlane
version, Node.js and a supported browser on the external computer. Start its
normal `sessplane serve` service and complete `sessplane login` on that computer's
display. Its dedicated profile, SQLite state, browser and generations stay there.
The agent computer needs Node.js, SessionPlane and an existing working SSH login;
it does not need to run a core or browser for remote requests.

After verifying the SSH host key and access normally, configure the host client:

```sh
export SESSIONPLANE_REMOTE_HOST=workshop@remote-host
# Set this if sessplane is not on the remote noninteractive SSH PATH:
export SESSIONPLANE_REMOTE_EXECUTABLE=/absolute/path/to/sessplane
sessplane health --json
sessplane mcp
```

CLI commands also accept `--remote HOST`, `--remote-executable PATH` and
`--remote-socket PATH`. MCP uses the same environment settings. An SSH config
alias can supply the port, identity file and other existing SSH settings. Batch
mode and strict host-key checking remain enabled. For password authentication,
open a normal interactive OpenSSH master first, entering the password only in its
terminal, and reuse it with `SESSIONPLANE_REMOTE_CONTROL_PATH` (or
`--remote-control-path`). For example, create a private directory with `mktemp -d`,
run `ssh -M -S "$PRIVATE_DIR/control" USER@HOST`, then set
`SESSIONPLANE_REMOTE_CONTROL_PATH="$PRIVATE_DIR/control"` in the agent environment.
Keep that connection open; terminate only your own master with OpenSSH `-O exit`
after remote work. No password is stored by SessionPlane. The relay is `sessplane
rpc-stdio`; it connects only to the remote core's existing Unix socket. It never
starts another core, opens an unauthenticated network API, or falls back locally.
Run `serve` on the external computer without remote-client settings.

Use the same team, role and request handles for send, preparation, collection,
recovery and cleanup. A lost connection does not cancel a remote generation.
Inspect the same request after reconnecting; a dispatched mutation is never
replayed automatically. Pre-connection failures report `requestDispatched:false`.
Keep the selected endpoint consistent: handles belong to that core's database.
Human login and explicit focus happen on the external computer's display.

`request wait --out DIR` (MCP `wait.outputDir`) transfers captured artifacts to
**the agent computer**, verifying size and SHA256 before publishing each local
file. `artifact export` also writes locally. Transfer errors appear separately
from the recovered answer in `files.exportError`; retry collection/export of the
same stored artifact without sending again. Existing different files are never
overwritten implicitly. Host attachment uploads are currently unsupported in
remote mode and fail before dispatch; they are never interpreted as remote paths.
Chat deletion and owned-tab closure still run independently on the remote core;
inspect both results, and confirm retired tab closure even if deletion fails.

## Agent workflow

Use native MCP with `sessplane mcp`. Keep a teamId and follow
`sessionplane_team_get` → `sessionplane_send` → `sessionplane_decide` when needed
→ `sessionplane_wait`. Roles and exact requests are referenced by handles returned
by the core. UI choices are interpreted by the caller from fresh evidence; core
executes and validates them and continues the same request automatically.

The [team workflow contract](docs/team-workflow.md) includes expert creation/retirement,
explicit stop, conversation replacement and completed-history deletion. The
[preparation design](docs/provider-preparation.md) explains UI evidence and recovery.

## Use the terminal workflow

Run `sessplane --help` to find preparation, collection, recovery and cleanup actions.
Default output shows the request stage and the next exact command. `--json` retains
machine-readable RPC results (including unsuccessful request outcomes) on stdout
and command/RPC errors on stderr. Save both streams and the exit status when
retaining a command receipt; empty stdout alone does not establish the request's
outcome.

1. Run `sessplane team list`, then `sessplane team show TEAM_ID`. Use the displayed
   current role reference; create a session only for a role that has none.
   Lists are caller-scoped. To find existing native MCP work, use
   `sessplane team list --client-id sessionplane-mcp`; an empty CLI list does not
   mean those teams are missing or need to be recreated.
2. Start one request with `sessplane request send TEAM_ID ROLE_REF --prompt-file FILE`.
   This can submit immediately when the provider is ready, or pause for preparation.
   Keep its operation reference and read the reported delivery status.
3. `request show TEAM_ID REQUEST_REF` reads compact stored status without probing
   the provider. It separates ACK, answer availability, connected collectors and
   the managed chain's next review from backend pacing. `--view result` recovers
   the exact answer; `--view evidence` also reads fresh UI, prompt/candidates and
   controls (MCP: `team_get` with the same `view`). Use evidence for preparation.
   For an already-submitted later turn, `request show TEAM_ID REQUEST_REF
   --followup-message-id MESSAGE_ID` reads one exact snapshot without adding a collector.
   If that exact later turn is interrupted while the next product draft remains prepared,
   `request continue TEAM_ID REQUEST_REF --followup-message-id MESSAGE_ID
   --continuation-approved --wait-ms 0` sends only `계속`, restores the prepared draft,
   and returns its separate ACK without a collector. Keep the original request/followup
   when attaching the sole owner wait; the recovery receipt connects its response.
   To approve paced management on that existing exact collector, use the same
   Continue command with `--manage-only`. It records approval without sending or
   adding a collector. Exact reads expose the current ACK and its last/next review
   under `followup.managedContinuation`, separately from the original generation.
   Select an available combined model
   using the displayed `request configure` command, then the fresh composer control.
   Inspect the input before explicitly choosing the submit control. Disabled or stale
   controls are not a fallback; inspect the same request again.
4. Keep one managed collection owner. When normal same-conversation recovery is
   approved, use `sessplane request wait TEAM_ID REQUEST_REF --wait-ms 600000 --continuation-approved --json`
   (MCP: `continuationApproved: true`). Omitting
   the option leaves observation only. The existing client retains routine expiry,
   pacing/429 and ACK/load delays, reviews unresolved work about every 30 minutes,
   follows the continuation chain and collects the answer. Do not add a competing
   wait or manual `계속`. Add `--out DIR` for files. Return actual successor/ACK/result
   references to the owner; an ACK or alive collector is not product progress.
5. Read the same request with `--view evidence` when delivery is unconfirmed; never retry the original
   `send` or bind an ambiguous candidate. Report a returned recovery decision or
   send failure immediately. If human review/refresh is needed, focus the exact
   tab and state its current error and one required user action; do not refresh
   automatically or silently repeat ineffective recovery. Preserve drafts, active
   generation and provider pacing. After user recovery, resume the same chain.
   A normal final answer ends recovery: read its results before the Coordinator
   sends a contextual next-work follow-up, separately from managed literal `계속`.
6. After retrieving outputs, `request delete TEAM_ID REQUEST_REF --outputs-retrieved`
   deletes the exact completed conversation. `request replace TEAM_ID ROLE_REF`
   attempts old-chat deletion and starts an empty successor; `--preserve-conversation`
   uses the supported nondeleting recovery path. Neither operation replays a prompt.
   `team delete TEAM_ID` permanently removes team history: export needed results first.
   Read chat deletion, tab closure and errors separately; team deletion success does
   not mean every provider chat was deleted, and zero closed tabs does not prove absence.
   Cleanup preserves composer text, pending file attachments and visible generation.
   If the page changes conversation during inspection, it stays open with an identity
   error; inspect the exact predecessor rather than closing the currently active tab.

## Requirements

- Node.js `>=24.15 <25`
- A user-installed Google Chrome, Chromium, Microsoft Edge, or Brave browser
- A Unix-like operating system with Unix domain sockets

## Installation

Tagged releases attach a prebuilt npm package and SHA-256 checksum. Install the
release package globally, then run the built-in doctor:

```bash
VERSION=0.4.93
curl -fLO "https://github.com/huhumanmaninganingansalamlam/sessionplane/releases/download/v$VERSION/sessionplane-$VERSION.tgz"
curl -fLO "https://github.com/huhumanmaninganingansalamlam/sessionplane/releases/download/v$VERSION/sessionplane-$VERSION.tgz.sha256"
sha256sum -c "sessionplane-$VERSION.tgz.sha256"
npm install -g "./sessionplane-$VERSION.tgz"
sessplane doctor --json
```

For releases that include GitHub artifact attestations, GitHub CLI can also
verify that the tarball was produced by this repository's Release workflow:

```bash
gh attestation verify "sessionplane-$VERSION.tgz" \
  --repo huhumanmaninganingansalamlam/sessionplane
```

The package exposes only the `sessplane` executable.

### Connect the agent through MCP

Installing the package or skills does not register an MCP server. For Codex:

```bash
codex mcp add sessionplane -- sessplane mcp
codex mcp get sessionplane
```

Load the configuration in the Codex client and check `/mcp` for the connected
SessionPlane server and its preparation tools before starting ChatGPT work.
Other MCP clients should register `sessplane` with arguments `["mcp"]` as a
stdio server. The client owns the transport process; an agent must not depend
on a shell subprocess handle surviving context compaction. Reconnection uses
the original `clientId + requestId + sessionId + generation` stored in the core.

## Development

Use `dev` for ongoing development. Keep `main` as the release line and published
version tags immutable. Begin from a clean checkout; preserve uncommitted work
before switching branches.

```bash
git fetch origin
git switch dev
git pull --ff-only origin dev
npm ci
npm run typecheck
npm test
npm run build
npm link --force
```

`npm link --force` points the current Node installation's global `sessplane`
command at this source checkout. The public command surface is intentionally
`sessplane` only. To avoid changing the global link, use
`node bin/sessplane.mjs` directly instead.

`npm run test:acceptance` exercises team/session lifecycle, exact submission,
large-answer transport and restart with concurrent waits. The restart fixture
does not simulate elapsed hours; it verifies the actual before/after transitions.

Before creating a release tag, run `npm run release:preflight` on a supported host
with a user-installed Chromium-family browser. GitHub-hosted CI runs
`npm run test:ci`, which excludes host-browser spawn tests because the hosted
runner sandbox is not the SessionPlane runtime environment. Tagged releases
repeat the deterministic CI suite and smoke-test the exact packaged tarball.

CI runs on pushes to `dev` and `main`, and on pull requests. Push development to
`origin/dev`; promote a verified release candidate through a `dev` → `main` pull
request. This workflow configuration does not itself enable GitHub branch
protection; repository settings must enforce required CI checks and prohibit
force pushes and branch deletion on `main`.

Maintainer release flow:

```bash
# After the dev → main pull request has merged:
git switch main
git pull --ff-only origin main
npm run release:preflight
VERSION="$(node -p "require('./package.json').version")"
git tag -a "v$VERSION" -m "SessionPlane v$VERSION"
git push origin "v$VERSION"
# Return to development after the release workflow completes:
git switch dev
git pull --ff-only origin dev
```

`release:preflight` requires a supported Node 24 runtime, a clean `main`
checkout at exactly `origin/main`, a high-severity dependency audit, the full
host-browser clean-checkout gate, and two byte-for-byte identical `npm pack`
outputs. The tagged Release workflow separately requires the tag commit to be
the current `origin/main`, performs verification with read-only repository
permissions, transfers only the verified tarball/checksum into a privileged
publish job, rechecks the SHA-256 digest, creates a signed GitHub artifact
attestation, and publishes the tarball plus checksum as GitHub Release assets.

The release artifact is the CD boundary. SessionPlane intentionally does not
auto-deploy onto user machines because each installation owns local browser
state and a dedicated persistent profile; host upgrades remain an explicit,
checksum-verifiable install action.

For an interactive development session, start the core in one terminal:

```bash
sessplane serve
```

For persistent Linux use, run the same command as a user service tied to the
graphical login session and enable that service for subsequent logins. A detached
terminal process or transient scope does not provide reboot startup. Keep the same
account, state directory and browser profile, and check health before starting to
avoid a second core.

Query it from another terminal:

```bash
sessplane health --json
```

Provider availability is an operator setting. The safe default is ChatGPT-only;
Gemini and Grok remain supported but are disabled until the operator explicitly
enables them. Expand the allowlist only when another provider is actually wanted:

```bash
# Default: ChatGPT only.
sessplane serve
# Explicitly enable every bundled provider.
sessplane serve --providers all
# Or enable a specific set.
sessplane serve --providers chatgpt,gemini
SESSIONPLANE_ENABLED_PROVIDERS=chatgpt sessplane serve
```

`system.health` performs a small database read and reports integrity as null (not checked);
`sessplane doctor` retains the explicit full integrity check outside Core. Routine health
does not scan stored receipts or block provider observation.

`system.health` reports `providers.supported`, `providers.enabled`, and
`providers.disabled`. Disabled providers are not registered in the running core,
new sessions for them fail with `provider.disabled`, and restart recovery does not
open, observe, or probe their durable sessions. Existing durable records remain
queryable so re-enabling a provider does not destroy history.

## Provider-owned browser runtime

SessionPlane owns one persistent Chromium-family profile only to run supported
AI provider sessions and preserve their exact durable identity. It is not a
general browser automation tool. Do not use SessionPlane for arbitrary website
navigation, Notion/GitHub login, form automation, or generic browser tasks.
Use Playwright or the installed general browser skill for those workflows.

Internally, SessionPlane controls its dedicated provider profile with
playwright-core through a positive loopback CDP endpoint. It never attaches to
the user's normal browser profile. Chrome is the default host browser;
Chromium, Edge, Brave, and custom Chromium-family executables are explicit
operator configuration choices.

Host Chromium-family browsers run with their native process sandbox enabled.
SessionPlane never adds automation-identifying or sandbox-disabling launch
switches, warning-UI suppression, or a silent unsandboxed fallback.

Browser selection is an operator/core-startup setting:

    sessplane browser-list --json
    sessplane serve --browser chrome
    sessplane serve --browser chromium
    sessplane serve --browser custom --browser-executable /opt/browser/chrome

Provider adapters, recovery, and login own browser mutation. Public generic
navigation, click, type, screenshot, and JavaScript-evaluation tooling is not
part of the SessionPlane runtime surface.

Open or reuse the dedicated ChatGPT page during normal operation with
sessplane login --json. For a ChatGPT sign-in flow that rejects attached
automation transport, use sessplane login --manual --json, complete sign-in in
the visible dedicated provider window, then run sessplane login --resume --json.

Provider sessions support ChatGPT, Gemini, and Grok, including exact local file
uploads (disabled by default) and durable artifact capture.

Delete an entire team with `sessionplane_team_delete` or
`sessplane team delete TEAM_ID --request-id ID`. This removes local team history,
stops owned work and closes its tabs. Provider conversation deletion is attempted
once; individual failures are returned. Retrieve needed outputs before deletion;
exported files, shared content and idempotency receipts remain.

## Attachments, results and skills

Downloads remain enabled. Attachment uploads are disabled by default. An operator
can opt in by setting `SESSIONPLANE_UPLOADS_ENABLED=true` for the core process.
Team snapshots expose `capabilities.uploadsEnabled`. When enabled, attach files
through `sessionplane_send.files`; accepted bytes survive preparation and restart.
`sessionplane_wait`
returns exact answers and captured generated-file descriptors; outputDir exports
files with their original integrity metadata. Check per-file capture failures.

Install the bundled agent instructions with `sessplane skills install --target
/path/to/skills --skill sessionplane`. Register the native MCP server separately.
Search, context packaging, project-source management and code ZIP orchestration
are outside SessionPlane's chat-session scope; use existing agent tools.

Long operator CLI prompts support --prompt-file or --prompt-stdin. Agents use
structured MCP arguments. An ambiguous request is inspected with team_get, its
requestRef and view:evidence; inspection never resends a prompt.
