# Browser runtime benchmark

This note records the source-level browser and authentication patterns used by
SessionPlane. It is not a claim that every compared project has the same
product scope.

## Compared revisions

| Project | Revision | Relevant pattern |
| --- | --- | --- |
| agbrowse | `55150e1` | dedicated profile, minimal native browser launch, positive CDP port, later Playwright attachment |
| Proxima | `1113686` | persistent provider partitions and serialized mutations, plus broad fingerprint and OAuth header rewriting |
| browser-use | `d8110c5` | profile-copy validation, `Local State` preservation, live-profile lock refusal, CDP reconnect |
| Stagehand | `e7e5b67` | random loopback port, launched-vs-connected ownership, supervised shutdown |
| Playwright MCP | `ea43eee` | Playwright-native accessibility and tool surface |
| browser-mcp | `da76936` | detached browser/CDP reconnect and per-tab ref state |
| chrome-use | `afd1d84` | existing-browser extension relay and session tab isolation |
| browser-cdp | `9ad2e7c` | explicit real-profile or isolated-profile CDP modes |
| agent-browser | `aff6125` | resident daemon, stable tab identity, renderer liveness and cleanup |
| Chrome DevTools MCP | `23b9a48` | explicit launched/connected ownership and pre-launched browser attachment for sign-in |
| Tencent BrowserSkill | reviewed 2026-09-18 | already logged-in user browser, explicit tab borrowing, human help for login/CAPTCHA/OTP |

The checked source snapshots are references only and are not runtime
dependencies.

## Authentication findings

### agbrowse

agbrowse does not solve Google or provider authentication. It launches the
host browser itself with a dedicated profile and a small argument set, then
attaches Playwright with `connectOverCDP()`. `--enable-automation` and
`--no-sandbox` are opt-in environment overrides rather than defaults.

### Chrome DevTools MCP and BrowserSkill

Both avoid treating sign-in as an ordinary autonomous browser action. Chrome
DevTools MCP documents a pre-launched/sign-in-first connection path for sites
that reject WebDriver-controlled login. BrowserSkill assumes an already logged
in real browser and explicitly hands login, CAPTCHA, OTP, and similar gates to
a person before observing again.

### browser-use

browser-use copies a profile only after validating that it is not live/locked,
preserves `Local State`, and recommends connecting to a running browser when a
live profile cannot be copied safely. This reinforces SessionPlane's rule that
personal profiles are never opened or copied implicitly.

### Proxima

Proxima's persistent provider partitions and serialized mutation ownership are
useful concepts. Its OAuth path also rewrites User-Agent and Client Hints, and
its renderer patches navigator, plugins, screen, and WebGL properties. Those
techniques create a synthetic fingerprint and are deliberately rejected.
SessionPlane does not disguise the browser, solve challenges, or impersonate a
different browser family.

## Adopted runtime

- Use only a user-installed host Chromium-family browser selected explicitly.
- Keep a product-scoped SessionPlane profile and reject every known personal or
  default browser profile, including symlink aliases.
- Launch the host browser with only SessionPlane-owned profile, window,
  first-run, optional headless, and positive loopback CDP arguments.
- Attach Playwright after launch with `connectOverCDP()`.
- Record exact core PID, browser PID, profile, and CDP port ownership; adopt only
  when all identities can be proven.
- Preserve opaque `pageKey` and durable
  `sessionId + generation + conversationId` identity instead of active-tab,
  title, or discovery-order selection.

## Adopted authentication handoff

Authentication has a separate, explicit lifecycle:

```text
sessplane login --manual
  -> stop the automated CDP browser
  -> launch the same host browser and same SessionPlane-dedicated profile
  -> no CDP, no Playwright attachment, no automation or sandbox-disable flags
  -> person completes login in the visible browser

sessplane login --resume
  -> close only the exact SessionPlane-owned manual browser
  -> flush the same dedicated profile
  -> relaunch the normal positive-port CDP runtime
  -> attach Playwright and resume automation
```

The manual phase refuses to interrupt any bound SessionPlane Page. Its lock is
durable: if the core restarts while the manual browser is still open, the new
core adopts the manual ownership record without killing the user's login
window. `browser-stop` remains an explicit request to close the owned manual
browser.

## Deliberately rejected

- JavaScript fingerprint patches, navigator rewriting, WebGL spoofing,
  User-Agent/client-hint rewriting, and request-header impersonation.
- CAPTCHA, Cloudflare, OTP, or provider challenge solving/bypass.
- Reusing, modifying, or automatically copying a person's default browser
  profile.
- Silent fallback to another browser product or to a Playwright-downloaded
  browser.
- Undocumented provider-internal APIs as the primary submission path.
- Automatic `bringToFront()` for identity or routine background work.

## Resulting contract

SessionPlane uses the user's installed browser binary but owns a separate,
product-scoped profile and process lifecycle. Normal automation uses a minimal
native launch followed by CDP attachment. Authentication can temporarily move
the same dedicated profile into a visible, non-CDP manual phase and then
explicitly resume, without touching a personal profile or fabricating a browser
fingerprint.
