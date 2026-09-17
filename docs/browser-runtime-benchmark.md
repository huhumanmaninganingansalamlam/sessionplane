# Browser runtime benchmark

This note records the browser ownership choices used by SessionPlane. It is a
source-level comparison, not a claim that every compared project has the same
product scope.

## Compared revisions

| Project | Revision | Useful runtime pattern |
| --- | --- | --- |
| agbrowse | `55150e1` | dedicated profile, explicit browser ownership, CDP attachment |
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

- Install and launch the exact Chromium revision pinned by `playwright-core`
  through the standard Playwright persistent-context API.
- Keep a SessionPlane-dedicated persistent profile and reject personal/default
  Chromium profile paths.
- Keep BrowserContext and the long-running core under one explicit ownership
  record; a second owner for the same profile fails closed.
- Let Playwright own browser startup and shutdown rather than maintaining a
  second subprocess/CDP lifecycle implementation.
- Preserve SessionPlane's opaque `pageKey` and durable
  `sessionId + generation + conversationId` identity instead of active-tab or
  discovery-order selection.

## Deliberately rejected

- JavaScript fingerprint patches, `navigator` rewriting, WebGL spoofing,
  User-Agent/client-hint rewriting, and request-header impersonation.
- CAPTCHA or Cloudflare challenge solving/bypass. Headed Chromium remains
  available for explicit human completion, after which automation may resume.
- Calling undocumented provider-internal web APIs as the primary submission
  path.
- Searching for a system Chrome, attaching to an arbitrary external CDP
  endpoint, or reusing a personal default browser profile.
- Automatic `bringToFront()` for identity or routine background work.
- An extension/native-messaging relay in v1. It is useful for controlling a
  person's existing browser, but conflicts with SessionPlane's dedicated
  profile and single-core ownership contract and adds substantial deployment
  complexity.

## Resulting contract

SessionPlane uses the browser build tested with its exact Playwright version,
a persistent same-user profile, explicit ownership, and durable recovery. It
does not depend on whichever system Chrome happens to be installed, and it does
not disguise the browser or bypass site security.
