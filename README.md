# SessionPlane

SessionPlane is a local runtime that controls a user-installed Chromium-family
browser through Playwright, owns one dedicated persistent profile, and safely
coordinates durable, role-addressed AI chat sessions for multiple clients.

The core process owns browser state, SQLite state, session actors, observation,
and recovery. The `sessplane` CLI and MCP adapter are thin Unix-socket clients.
SessionPlane is maintained as an independent project with one canonical CLI
and one runtime contract.

## Requirements

- Node.js `>=24.15 <25`
- A user-installed Google Chrome, Chromium, Microsoft Edge, or Brave browser
- A Unix-like operating system with Unix domain sockets

## Installation

Tagged releases attach a prebuilt npm package and SHA-256 checksum. Install the
release package globally, then run the built-in doctor:

```bash
VERSION=0.2.8
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
available through the thin MCP adapter.

`browser-list --json` shows the supported host browsers and the exact selected
executable. `doctor --json` verifies that selection and, when the core is
running, reports the current Page bindings without changing browser focus.

Installed or linked sessplane commands use exactly one production runtime
directory: $HOME/.local/state/sessionplane. Production callers cannot create
competing SessionPlane cores or profiles with --state-dir,
SESSIONPLANE_STATE_DIR, or XDG_STATE_HOME; isolated runtime state is reserved
for automated tests. The artifact store defaults under the canonical state
directory and keeps the same configured per-artifact limits.

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

SessionPlane owns its fetch pipeline. Each HTTP redirect is revalidated, DNS
answers are pinned to the requested connection, private/link-local/
documentation/multicast ranges are blocked by default, and response and
extraction sizes are bounded.

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
