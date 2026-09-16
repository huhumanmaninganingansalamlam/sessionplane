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

Runtime state defaults to `.state/`. Override it with
`SESSIONPLANE_STATE_DIR` when tests or multiple isolated instances are needed.

