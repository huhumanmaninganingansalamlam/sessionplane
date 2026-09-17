# Browser runtime benchmark

This note records the browser ownership choices used by SessionPlane. It is a
source-level comparison, not a claim that every compared project has the same
product scope.

## Compared revisions

| Project | Revision | Useful runtime pattern |
| --- | --- | --- |
| agbrowse | `55150e1` | installed Chrome subprocess, dedicated profile, CDP attachment |
| Proxima | `1113686` | persistent provider partitions and serialized provider mutations |
| browser-use | `d8110c5` | direct subprocess ownership, profile-copy validation, CDP reconnect |
| Stagehand | `e7e5b67` | random loopback port, launched-vs-connected ownership, supervised shutdown |
| Playwright MCP | `ea43eee` | Playwright-native accessibility and tool surface |
| browser-mcp | `da76936` | detached Chrome/CDP reconnect and per-tab ref state |
| chrome-use | `afd1d84` | real-Chrome extension relay, resident daemon, session tab isolation |
| browser-cdp | `9ad2e7c` | explicit real-profile or isolated-profile CDP modes |
| agent-browser | `aff6125` | resident daemon, stable tab identity, renderer liveness and cleanup |
| Chrome DevTools MCP | `23b9a48` | explicit launch/connect ownership and existing-browser attachment |

The checked-out source snapshots live outside the product repository under
`/tmp/work/sessionplane-browser-bench` and are not runtime dependencies.

## Adopted

- Launch the installed Google Chrome directly and attach through a random
  loopback-only CDP endpoint.
- Keep a SessionPlane-dedicated persistent profile and reject personal/default
  Chrome profile paths.
- Keep Chrome and the long-running core under one explicit ownership record.
- Record core PID, Chrome PID, and CDP port in an owner-only profile lock.
- On core restart, adopt a still-running Chrome only when the stale lock,
  process command line, exact profile path, exact port, and live CDP endpoint
  all agree. Otherwise fail closed or terminate only the provably owned process.
- Supervise startup readiness and shutdown, preserve Chrome stderr for
  diagnosis, and use TERM then KILL only for the exact owned process.
- Preserve SessionPlane's opaque `pageKey` and durable
  `sessionId + generation + conversationId` identity instead of active-tab or
  discovery-order selection.

## Deliberately rejected

- JavaScript fingerprint patches, `navigator` rewriting, WebGL spoofing,
  User-Agent/client-hint rewriting, and request-header impersonation.
- CAPTCHA or Cloudflare challenge solving/bypass. Headed Chrome remains
  available for explicit human completion, after which automation may resume.
- Calling undocumented provider-internal web APIs as the primary submission
  path.
- Attaching to an arbitrary external CDP endpoint or reusing a personal default
  Chrome profile without ownership proof.
- Automatic `bringToFront()` for identity or routine background work.
- An extension/native-messaging relay in v1. It is useful for controlling a
  person's existing browser, but conflicts with SessionPlane's dedicated
  profile and single-core ownership contract and adds substantial deployment
  complexity.

## Resulting contract

SessionPlane minimizes avoidable automation-only launch differences without
pretending to be a different browser. Compatibility comes from normal headed
Chrome, persistent same-user state, minimal launch arguments, exact ownership,
and reliable recovery—not from disguising or bypassing site security.
