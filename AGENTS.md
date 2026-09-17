# SessionPlane Engineering Rules

This repository implements the contracts in the workspace-level `docs/PRD.md`
and `docs/prd/` documents. Product requirements and fixed decisions take
precedence over implementation convenience.

## Invariants

- Never use the active tab, page title, recency, or page-array order as identity.
- Never call `bringToFront()` in normal runtime code.
- One core process owns one dedicated persistent Chrome profile.
- One session has one actor and one page has one mutation owner.
- A client wait timeout never terminalizes a provider generation.
- A submit with ambiguous acknowledgement is never retried automatically.
- Backend observation HTTP 429 is transport deferral, not provider blocking.
- Logs and metrics must not contain prompt, answer, cookie, or access-token bodies.

## Development

- Runtime: Node.js 24, TypeScript, ESM.
- Browser integration uses direct `playwright-core` and its exact, explicitly installed Chromium revision. System Chrome is not an implicit runtime dependency.
- SQLite access stays behind `src/storage/`.
- Public clients are thin adapters over the Unix-socket JSON-RPC core.
- Add focused invariant tests with every behavior change.
- Run `npm run typecheck`, `npm test`, and `npm run build` before completion.

