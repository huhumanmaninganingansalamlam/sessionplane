# SessionPlane

SessionPlane is a local runtime that controls a user-installed Chromium-family
browser through Playwright, owns one dedicated persistent profile, and safely
coordinates durable, role-addressed AI chat sessions for multiple clients.

The core process owns browser state, SQLite state, session actors, observation,
and recovery. The `sessplane` CLI and MCP adapter are thin Unix-socket clients.

## Requirements

- Node.js `>=24.15 <25`
- A user-installed Google Chrome, Chromium, Microsoft Edge, or Brave browser
- A Unix-like operating system with Unix domain sockets

## Installation

Tagged releases attach a prebuilt npm package and SHA-256 checksum. Install the
release package globally, then run the built-in doctor:

```bash
VERSION=0.1.4
curl -fLO "https://github.com/huhumanmaninganingansalamlam/sessionplane/releases/download/v$VERSION/sessionplane-$VERSION.tgz"
curl -fLO "https://github.com/huhumanmaninganingansalamlam/sessionplane/releases/download/v$VERSION/sessionplane-$VERSION.tgz.sha256"
sha256sum -c "sessionplane-$VERSION.tgz.sha256"
npm uninstall -g agbrowse >/dev/null 2>&1 || true
npm install -g "./sessionplane-$VERSION.tgz"
sessplane doctor --json
```

For releases that include GitHub artifact attestations, GitHub CLI can also
verify that the tarball was produced by this repository's Release workflow:

```bash
gh attestation verify "sessionplane-$VERSION.tgz" \
  --repo huhumanmaninganingansalamlam/sessionplane
```

The package exposes only the `sessplane` executable. The retired `agbrowse`
command is not installed. `sessplane doctor` also fails closed when an older
standalone `agbrowse` executable is still present on `PATH`.

## Development

```bash
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

Maintainer release flow:

```bash
npm run release:preflight
VERSION="$(node -p "require('./package.json').version")"
git tag -a "v$VERSION" -m "SessionPlane v$VERSION"
git push origin "v$VERSION"
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

## Generic browser automation

The same long-running core also exposes the browser primitives needed to
replace the standalone agbrowse browser workflow. Pages are addressed by the
opaque `pageKey` returned by `tabs`; browser focus, title, recency, and page
array order are never identity.

The core launches a browser already installed by the user with a minimal,
positive loopback CDP endpoint and then controls its persistent default context
with `playwright-core` through `chromium.connectOverCDP()`. SessionPlane never
downloads, installs, upgrades, or silently falls back to a Playwright-managed
browser. The default selection is the user-installed Google Chrome Stable. Chromium,
Edge, Brave, and custom Chromium-family executables remain explicit choices.
The default never falls back silently to another browser. Select explicitly with
`--browser chrome|chromium|edge|brave`, use `--browser auto` to opt into the
Chromium, Chrome, Edge, then Brave fallback order, or use
`--browser custom --browser-executable /absolute/path`. Every selection uses
the dedicated SessionPlane profile; the user's normal browser profile and open
tabs are never attached. No custom fingerprint patches are injected.

Host Chromium-family browsers always run with their native process sandbox
enabled. SessionPlane launches only the profile, positive loopback CDP,
first-run, window-size, and optional headless arguments it owns. It never adds
`--enable-automation`, `--no-sandbox`, `--disable-setuid-sandbox`, warning-UI
suppression, or a silent unsandboxed fallback. A headed startup is rejected if
the resulting browser reports `navigator.webdriver !== false`.

Browser selection is a core-startup setting:

```bash
sessplane browser-list --json
sessplane serve --browser chrome
sessplane serve --browser chromium
sessplane serve --browser custom \
  --browser-executable /opt/browser/chrome
```

The equivalent environment variables are `SESSIONPLANE_BROWSER` and
`SESSIONPLANE_BROWSER_EXECUTABLE`. Stop the existing core before changing the
selection. By default profiles are isolated automatically under
`$SESSIONPLANE_STATE_DIR/profiles/<product>/`, so Chrome, Chromium, Edge, and
Brave never open each other's SessionPlane data. An explicit
`SESSIONPLANE_PROFILE_DIR` opts out of that automatic product subdirectory but
still records the browser product and fails closed on a mismatch. Known
personal/default profile roots for all supported browsers are rejected.

```bash
sessplane tabs --json
sessplane new-tab https://example.com --json
sessplane snapshot --page <pageKey> --max-nodes 120 --json
sessplane click @e1 --page <pageKey> --snapshot-id <snapshotId> --json
sessplane type @e2 --text "hello" --page <pageKey> --snapshot-id <snapshotId> --json
sessplane screenshot --page <pageKey> --out /tmp/page.png --json
```

Available browser surfaces include tabs and navigation, snapshot-bound refs,
click/type/press/hover/select/check/upload/drag, coordinate mouse input,
scroll and waits, screenshots, text/DOM reads, console/network diagnostics,
JavaScript evaluation, ObservationBundleV1, and ranked action candidates.

SessionPlane keeps these generic browser commands and role-addressed AI
sessions on the same persistent profile and PageRegistry.

Open or reuse the dedicated ChatGPT page during normal automated operation:

```bash
sessplane login --json
```

For Google OAuth or another sign-in flow that rejects an attached automation
transport, use the explicit manual handoff. SessionPlane first closes its CDP
browser and starts the same host browser with the same product-scoped
SessionPlane profile, but with no CDP endpoint or Playwright attachment:

```bash
sessplane login --manual --json
# Complete login in the visible dedicated browser window.
sessplane login --resume --json
```

`--manual` refuses to interrupt bound session Pages. `--resume` closes only the
exact SessionPlane-owned manual browser and relaunches the normal positive-port
CDP runtime. Neither phase uses or mutates the user's personal/default browser
profile, and neither performs CAPTCHA, OTP, or provider challenge bypass.

Provider sessions support ChatGPT, Gemini, and Grok, including exact local file
uploads. Provider-created downloadable files are captured into an owner-only,
content-addressed artifact store and remain queryable after core restart:

```bash
sessplane send --session <sessionId> \
  --prompt "Use the attached context and create result.zip" \
  --file ./context.md --json

sessplane artifact discover --session <sessionId> --json
sessplane artifact capture --session <sessionId> --json
sessplane artifact list --session <sessionId> --json
sessplane artifact export <artifactId> --out ./result.zip
```

Artifact descriptors are bound to the exact `sessionId + generation` and store
the provider identity, source descriptor, byte length, SHA-256, and durable
relative path. Existing output files are never replaced unless `--overwrite`
is explicit.

## Advanced ChatGPT Chat and code artifacts

SessionPlane deliberately uses the Chat surface only. It never switches a
composer into ChatGPT Work, and an explicit Work request fails before provider
mutation. Chat model/reasoning selection, named Chat modes, uploads, durable
follow-up generations, Project Sources, and artifact recovery remain supported.

When a provider Page visibly presents Cloudflare or CAPTCHA-style browser
verification, submission fails before model selection, upload, prompt fill, or
send with `provider.human-action-required`. SessionPlane leaves the headed Page
open so a person can complete the check and rerun the command with a new
request ID. It never clicks, solves, disguises, or bypasses the challenge.

ChatGPT Project Sources are addressed by an explicit project URL. `add` hashes
and validates every local file before opening the provider page, skips names
already visible in the project, and serializes concurrent mutations for the
same project. Use `--dry-run` to inspect the upload set without starting a
browser mutation.

```bash
sessplane chatgpt project-sources list \
  --project-url "https://chatgpt.com/g/<project-id>" --json

sessplane chatgpt project-sources add \
  --project-url "https://chatgpt.com/g/<project-id>" \
  --file ./requirements.md --file ./architecture.pdf --dry-run --json
```

Code mode submits a strict packaging contract, waits on the exact durable
generation, scans the corresponding ChatGPT conversation for `/mnt/data/*.zip`
artifacts, downloads the newest matching sandbox snapshot, validates the ZIP,
stores it content-addressed, and exports it to the requested path. Newly
generated code archives must contain a nonempty root `PLAN.md` or
`00_plan.md`. Unsafe paths, symbolic links, malformed local headers, oversized
archives, and output replacement are rejected.

```bash
sessplane code generate --session "$SESSION_ID" \
  --prompt "Build a small TypeScript CLI" \
  --output-zip ./result.zip \
  --request-id code-generation-1 --json

sessplane code generate --session "$SESSION_ID" \
  --prompt "Build separate frontend and backend deliverables" \
  --multi-zip --output-dir ./artifacts \
  --request-id code-generation-2 --json

# Read-only recovery from a durable session or an explicit conversation.
sessplane code extract --session "$SESSION_ID" \
  --output-zip ./recovered.zip --require-plan --json
sessplane code extract --conversation "https://chatgpt.com/c/<conversation-id>" \
  --multi-zip --output-dir ./recovered --json
```

The same Project Sources, code generation, and code extraction methods are
available through the thin MCP adapter. `compat/agbrowse-manifest.json`
binds every required agbrowse replacement row to executable contracts; the
compatibility contract fails when any required row is not implemented.

`browser-list --json` shows the supported host browsers and the exact selected
executable. `doctor --json` verifies that selection and, when the core is
running, reports the current Page bindings without changing browser focus.

Installed or linked `sessplane` commands use one stable runtime directory
independent of the caller's current directory:
`${XDG_STATE_HOME:-$HOME/.local/state}/sessionplane`. Override it with
`SESSIONPLANE_STATE_DIR` or `--state-dir` when tests or multiple isolated
instances are needed. The artifact store defaults to `<state-dir>/artifacts/`;
override it with `SESSIONPLANE_ARTIFACT_DIR`. Use
`SESSIONPLANE_MAX_ARTIFACT_FILE_BYTES` to set the fail-closed per-artifact
download limit.

## Legacy migration contract

`compat/agbrowse-manifest.json` and the compatibility tests remain in the
source tree only as a migration ledger for behavior inherited from the retired
standalone agbrowse runtime. SessionPlane does **not** install or expose an
`agbrowse` executable. `npm run test:compat` verifies that required migration
semantics remain covered by the canonical SessionPlane core without creating a
second public CLI surface.

## Context packages and bundled skills

Large local context can be inspected before any browser mutation. Selection is
root-bounded, deterministic, symlink-rejecting, binary-aware, size-bounded, and
SHA-256 addressed. `raw` renders one fenced section per file; `repomix` renders
a deterministic XML-compatible package without executing repository config or
processors.

```bash
sessplane context dry-run \
  --root . \
  --context-from-files 'src/**/*.ts' \
  --context-exclude 'src/**/*.generated.ts' \
  --max-input 120000 --json

sessplane context render \
  --root . \
  --context-file context-files.txt \
  --context-transform repomix \
  --context-transport upload --json

sessplane send --session <sessionId> --prompt "Review this repository" \
  --context-from-files 'src/**/*.ts' \
  --context-transport upload --json
```

Bundled SessionPlane skills can be inspected or installed directly from the
SessionPlane package:

```bash
sessplane skills list --json
sessplane skills get core --full
sessplane skills path web-ai
sessplane skills install --target ~/.codex/skills --skill browser --skill web-ai
```

Installation never replaces an existing skill unless `--force` is explicit.
`--link` creates directory symlinks; the default copies the bundled skills.

## Adaptive fetch, extraction, search, and research

SessionPlane owns the replacement fetch pipeline instead of shelling out to the
old agbrowse runtime. Each HTTP redirect is revalidated, DNS answers are pinned
to the requested connection, private/link-local/documentation/multicast ranges
are blocked by default, and response and extraction sizes are bounded.

```bash
sessplane fetch https://example.com --json
sessplane extract https://example.com/catalog --schema schema.json --json
sessplane search "Node.js 24 node:sqlite" --json
sessplane search --verify https://nodejs.org/api/sqlite.html --json
```

Search results are candidates, not evidence. `search` fetches original pages
and returns a scored evidence ledger with explicit verified, weak, blocked, or
failed verdicts. Provider-specific search rows can be supplied through
`--results FILE` or `--stdin-results`.

Research planning is split into inspectable, non-mutating stages:

```bash
sessplane research plan --query "Node.js 24 SQLite changes" --json > plan.json
sessplane research normalize-results --query "Node.js 24 SQLite changes" \
  --results provider-results.json --backend external --json > candidates.json
sessplane research enrich-fetch --plan plan.json --results candidates.json \
  --json > enrichment.json
sessplane research browse-plan --plan plan.json --enrichment enrichment.json --json
```

`SESSIONPLANE_FETCH_ALLOW_PRIVATE=true` exists only for isolated local fixtures
or intentionally private deployments. It is false by default and should not be
enabled for untrusted URLs.

