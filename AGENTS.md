# SessionPlane Engineering Rules

This repository implements the contracts in the workspace-level `../docs/PRD.md`
and `../docs/specs/` documents. Product requirements and fixed decisions take
precedence over implementation convenience.

## Invariants

- Never use the active tab, page title, recency, or page-array order as identity.
- Never call `bringToFront()` in normal runtime code.
- At any instant, one core process owns one dedicated persistent Chrome profile.
  A later Core, browser, or host restart may replace OS processes while durable
  request, Task, attempt, conversation, and turn evidence remains authoritative.
- OS PIDs, CDP ports, browser target IDs, and `spawned`/`adopted` ownership labels
  are runtime diagnostics, not durable product identity or routine development/L3
  gates. Pin them only inside an active handover critical section.
- One session has one actor and one page has one mutation owner.
- A client wait timeout never terminalizes a provider generation.
- A submit with ambiguous acknowledgement is never retried automatically.
- Backend observation HTTP 429 is transport deferral, not provider blocking.
- Logs and metrics must not contain prompt, answer, cookie, or access-token bodies.
- Host browser processes keep the Chromium sandbox enabled. Never add
  `--no-sandbox`, `--disable-setuid-sandbox`, security-warning suppression, or
  a silent unsandboxed fallback.

## Development

- Work in the current checkout and preserve unrelated user work. Branch choice,
  worktree layout, a dirty tree, and remote publication state must not block an
  authorized local fix, test, runtime recovery, or acceptance continuation. Never
  discard work merely to satisfy a branch convention.
- Branch, review, clean-tree, provenance, and ancestry checks apply when publishing
  commits, packages, tags, or releases. Use the repository's reviewed promotion
  workflow for publication, but do not impose it on local development.
- Create version tags and release artifacts only from the reviewed clean release
  commit matching its remote. Never move a published release tag.
- Runtime: Node.js 24, TypeScript, ESM.
- Browser integration uses `playwright-core` only as the controller for an explicitly selected user-installed Chrome, Chromium, Edge, Brave, or custom Chromium-family executable. SessionPlane never downloads or installs a browser and never attaches to the user's personal/default profile.
- SessionPlane launches the selected host browser itself with a positive
  loopback CDP port and attaches with `connectOverCDP`; headed runtime must
  preserve `navigator.webdriver === false` without script or fingerprint
  overrides.
- SQLite access stays behind `src/storage/`.
- Public clients are thin adapters over the Unix-socket JSON-RPC core.
- Add focused invariant tests with every behavior change.
- Validate the changed behavior with relevant regressions, typecheck/build for code
  changes, and the full suite when the affected scope requires it. Reuse valid results;
  documentation-only changes do not require another full browser suite. Local runtime
  completion requires actual installed behavior, separately from Git publication.

