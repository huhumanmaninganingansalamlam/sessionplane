# SessionPlane

SessionPlane is a local runtime that controls a user-installed Chromium-family
browser through Playwright, owns one dedicated persistent profile, and safely
coordinates durable, role-addressed AI chat sessions for multiple clients.

The core process owns browser state, SQLite state, session actors, observation,
and recovery. The `sessplane` CLI and MCP adapter are thin Unix-socket clients.
SessionPlane is maintained as an independent project with one canonical CLI
and one runtime contract.

## Agent workflow

Use native MCP with `sessplane mcp`. Keep a teamId and follow
`sessionplane_team_get` → `sessionplane_send` → `sessionplane_decide` when needed
→ `sessionplane_wait`. Roles and exact requests are referenced by handles returned
by the core. UI choices are interpreted by the caller from fresh evidence; core
executes and validates them and continues the same request automatically.

The [ten-tool contract](docs/team-workflow.md) includes expert creation/retirement,
explicit stop, conversation replacement and completed-history deletion. The
[preparation design](docs/provider-preparation.md) explains UI evidence and recovery.

## Requirements

- Node.js `>=24.15 <25`
- A user-installed Google Chrome, Chromium, Microsoft Edge, or Brave browser
- A Unix-like operating system with Unix domain sockets

## Installation

Tagged releases attach a prebuilt npm package and SHA-256 checksum. Install the
release package globally, then run the built-in doctor:

```bash
VERSION=0.3.1
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

Before creating a release tag, run `npm run verify:clean` on a supported host
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

Start the core in one terminal:

```bash
sessplane serve
```

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
uploads and durable artifact capture.

## Attachments, results and skills

Attach ordinary files through `sessionplane_send.files`. Accepted bytes are retained
for preparation and restart even if source files change. `sessionplane_wait`
returns exact answers and captured generated-file descriptors; outputDir exports
files with their original integrity metadata. Check per-file capture failures.

Install the bundled agent instructions with `sessplane skills install --target
/path/to/skills --skill sessionplane`. Register the native MCP server separately.
Search, context packaging, project-source management and code ZIP orchestration
are outside SessionPlane's chat-session scope; use existing agent tools.

Long operator CLI prompts support --prompt-file or --prompt-stdin. Agents use
structured MCP arguments. An ambiguous request is inspected with team_get and its
requestRef; inspection never resends a prompt.
