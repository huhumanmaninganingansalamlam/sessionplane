# SessionPlane

SessionPlane is a local runtime that owns one dedicated Playwright persistent
Chrome profile and safely coordinates durable, role-addressed AI chat sessions
for multiple clients.

The core process owns browser state, SQLite state, session actors, observation,
and recovery. The `sessplane` CLI and MCP adapter are thin Unix-socket clients.

## Requirements

- Node.js `>=24.15 <25`
- Installed Google Chrome
- A Unix-like operating system with Unix domain sockets

## Development

```bash
npm ci
npm run typecheck
npm test
npm run build
```

Start the core in one terminal:

```bash
npm exec sessplane -- serve
```

Query it from another terminal:

```bash
npm exec sessplane -- health --json
```

## Generic browser automation

The same long-running core also exposes the browser primitives needed to
replace the standalone agbrowse browser workflow. Pages are addressed by the
opaque `pageKey` returned by `tabs`; browser focus, title, recency, and page
array order are never identity.

```bash
npm exec sessplane -- tabs --json
npm exec sessplane -- new-tab https://example.com --json
npm exec sessplane -- snapshot --page <pageKey> --max-nodes 120 --json
npm exec sessplane -- click @e1 --page <pageKey> --snapshot-id <snapshotId> --json
npm exec sessplane -- type @e2 --text "hello" --page <pageKey> --snapshot-id <snapshotId> --json
npm exec sessplane -- screenshot --page <pageKey> --out /tmp/page.png --json
```

Available browser surfaces include tabs and navigation, snapshot-bound refs,
click/type/press/hover/select/check/upload/drag, coordinate mouse input,
scroll and waits, screenshots, text/DOM reads, console/network diagnostics,
JavaScript evaluation, ObservationBundleV1, and ranked action candidates.

An `agbrowse` compatibility bin is installed from this repository as well, so
existing root browser commands can be migrated without running the old CDP
runtime:

```bash
npm exec agbrowse -- tabs --json
npm exec agbrowse -- snapshot --page <pageKey> --json
```

SessionPlane keeps these generic browser commands and role-addressed AI
sessions on the same persistent profile and PageRegistry.

Open or reuse the dedicated ChatGPT login page without attaching to a personal
Chrome profile:

```bash
npm exec sessplane -- login --json
```

Provider sessions support ChatGPT, Gemini, and Grok, including exact local file
uploads. Provider-created downloadable files are captured into an owner-only,
content-addressed artifact store and remain queryable after core restart:

```bash
npm exec sessplane -- send --session <sessionId> \
  --prompt "Use the attached context and create result.zip" \
  --file ./context.md --json

npm exec sessplane -- artifact discover --session <sessionId> --json
npm exec sessplane -- artifact capture --session <sessionId> --json
npm exec sessplane -- artifact list --session <sessionId> --json
npm exec sessplane -- artifact export <artifactId> --out ./result.zip
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

agbrowse web-ai project-sources add \
  --chatgpt-url "https://chatgpt.com/g/<project-id>" \
  --file ./requirements.md --dry-run summary --json
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

# Legacy-compatible spellings
agbrowse web-ai code --vendor chatgpt --prompt "Build an MVP" \
  --output-zip ./result.zip --json
agbrowse web-ai code-extract --vendor chatgpt --session "$SESSION_ID" \
  --output-zip ./recovered.zip --json
```

The same Project Sources, code generation, and code extraction methods are
available through the thin MCP adapter. `compat/agbrowse-manifest.json`
binds every required agbrowse replacement row to executable contracts; the
compatibility contract fails when any required row is not implemented.

`doctor --json` reports the installed Chrome build and, when the core is
running, the current Page bindings without changing browser focus.

Runtime state defaults to `.state/`. Override it with
`SESSIONPLANE_STATE_DIR` when tests or multiple isolated instances are needed.
The artifact store defaults to `.state/artifacts/`; override it with
`SESSIONPLANE_ARTIFACT_DIR`. Use `SESSIONPLANE_MAX_ARTIFACT_FILE_BYTES` to set
the fail-closed per-artifact download limit.

## agbrowse compatibility

The repository also installs an `agbrowse` compatibility binary. It translates
supported legacy browser commands into the same SessionPlane core RPCs; it does
not start the old agbrowse runtime or reuse its state directory.

```bash
agbrowse start --headed
agbrowse new-tab https://example.com --json
agbrowse snapshot --interactive --json
agbrowse click e1 --json
agbrowse stop --json
```

`compat/agbrowse-manifest.json` is the machine-readable replacement ledger.
`npm run test:compat` verifies the implemented browser rows. Commands whose
required capability is not implemented fail with `compatibility.unsupported`
instead of silently approximating old behavior.

Normal ChatGPT, Gemini, and Grok sessions are available through both the
canonical team/session commands and the legacy web-ai grammar:

```bash
agbrowse web-ai send --vendor gemini --prompt "..." --json
agbrowse web-ai poll --vendor gemini --session <sessionId> --json
agbrowse web-ai query --vendor grok --prompt "..." --json
```

These aliases create or resume durable SessionPlane sessions and share the same
generation, idempotency, wait, observer, and restart contracts as `sessplane`.

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

The legacy utility grammar is preserved:

```bash
agbrowse web-ai context-dry-run --context-from-files 'src/**/*.ts' --json
agbrowse web-ai context-render --context-file context-files.txt \
  --context-transport inline --json
```

Bundled SessionPlane skills can be inspected or installed without the old
agbrowse package:

```bash
sessplane skills list --json
sessplane skills get core --full
sessplane skills path web-ai
sessplane skills install --target ~/.codex/skills --skill browser --skill web-ai

# Compatible aliases
agbrowse skills get core --full
agbrowse install-skills --target ~/.codex/skills --link
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

The same grammar is exposed by the `agbrowse` compatibility bin:

```bash
agbrowse fetch https://example.com --json
agbrowse search "Node.js 24 node:sqlite" --json
agbrowse research plan --query "Node.js 24 SQLite changes" --json
```

`SESSIONPLANE_FETCH_ALLOW_PRIVATE=true` exists only for isolated local fixtures
or intentionally private deployments. It is false by default and should not be
enabled for untrusted URLs.

