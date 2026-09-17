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

`doctor --json` reports the installed Chrome build and, when the core is
running, the current Page bindings without changing browser focus.

Runtime state defaults to `.state/`. Override it with
`SESSIONPLANE_STATE_DIR` when tests or multiple isolated instances are needed.

