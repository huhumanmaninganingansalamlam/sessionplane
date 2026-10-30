# Browser runtime benchmark

This note records the source-level browser and authentication patterns used by
SessionPlane. It is not a claim that every compared project has the same
product scope.

## Compared revisions

| Project | Revision | Relevant pattern |
| --- | --- | --- |
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

## Live recovery comparison — 2026-10-30

Checked public web sources at 10:45–10:49 UTC using GitHub repository search,
commit lookup and pinned source downloads (plus Context7 source search).
Existing runtime research above is reused; these are newly fetched sources,
not a rerun of historical tests. The comparison is source/contract based; it
is not a claim that another service was exercised with our private conversations.

| Public source | Observed contract | SessionPlane decision |
| --- | --- | --- |
| [browser-use skill](https://github.com/browser-use/browser-use/blob/b49a68e4060acb226da8f784194fef301c53a6d7/browser_use/skills/browser-use/SKILL.md) and [session implementation](https://github.com/browser-use/browser-use/blob/b49a68e4060acb226da8f784194fef301c53a6d7/browser_use/browser/session.py) | Reuse one working target; separate background attachment from visible activation; keep unsaved/needed tabs; reconnect state has its own lock/task. | Keep exact physical target identity across Core adoption. Do not treat an old open receipt or a visible composer as proof of the intended conversation. No automatic focus or borrowed-profile changes. |
| [agent-browser docs](https://github.com/vercel-labs/agent-browser/blob/099e84ea23ee995422dc94d02c9c2309e34d3e02/README.md) and [browser implementation](https://github.com/vercel-labs/agent-browser/blob/099e84ea23ee995422dc94d02c9c2309e34d3e02/cli/src/native/browser.rs) | Stable target IDs survive daemon restart; bound missing tabs fail with explicit identity errors. Discarded-tab revival reports its reload; wedge handling distinguishes owned and attached browsers. | Revalidate the persisted exact target on completed open replay. Never silently replace a missing/closed page or revive it by reload: SessionPlane must preserve prompts, drafts and ambiguous execution. |
| [Stagehand target context](https://github.com/browserbase/stagehand/blob/b7a4b899079f198a0ee78a6dcb62ad02f545cf49/packages/extension/understudy/context.ts) and [page implementation](https://github.com/browserbase/stagehand/blob/b7a4b899079f198a0ee78a6dcb62ad02f545cf49/packages/extension/understudy/page.ts) | One Page per top-level target; explicit frame/session ownership; target-destroyed cleanup; pending page creation waits for attachment. | Retain target ownership, rebind only that target after adoption, and verify the resulting current surface. Do not select by page order/title or import an agent framework. |
| [Playwright MCP documentation](https://github.com/microsoft/playwright-mcp/blob/0c4107acbecb75472b23c05c0e42471a0011874f/README.md) | Structured fresh snapshots/references; configurable action settling (default 500ms); existing-tab extension attachment. | Snapshot/action settling helps UI verification but is not delivery acceptance or answer completion. Keep SessionPlane's separate ACK and result boundaries. |
| [chatgpt.js implementation](https://github.com/KudoAI/chatgpt.js/blob/43f377e0485c3ca8eaaf1cb8363fc8b03afd602c/src/chatgpt.js) | Frontend send waits for an enabled button on 222ms timers; frontend isIdle watches message presence and Stop appearing/disappearing with MutationObservers. | Do not copy fast retry loops or Stop-only finality. Preserve exact submitted message/answer ancestry, provider acceptance, real errors and quiet-final checks; a missed transition cannot authorize a resend. |

### Original-path findings and changes

The two user-identified home targets were Maetda Main generation zero and
ResourceShare custody Expert generation zero. Both had no request, ACK,
conversation ID or draft. On 2026-10-30, replaying each original completed
`workflow.session_open` returned `requestOk:true` with **2026-10-29** mode evidence,
while current `session show` returned `mode:unknown/source:unavailable`.
A new supported open operation rebound each **same physical target** and returned
fresh Chat evidence, without navigating, sending or collecting. A home composer
still does not mean that an existing conversation has been recovered.

The regression reproduces completed-receipt replay after Core adoption. Open
now revalidates/rebinds its exact retained page and returns fresh mode evidence.
A completed open whose page was explicitly cleaned up fails instead of silently
creating another tab. Explicit unused-current-home cleanup extends the existing
`session.close_pages` lifecycle with exact generation-zero/null-conversation and
target evidence. It refuses requests, foreign ownership, messages, drafts,
attachments, alerts, dialogs and active generation; it preserves the role/session.
A later authorized open needs a new operation ID, never a fabricated prompt.

Read-only held permission inspection is a separate reproduced recovery failure:
PR181 removes only the inspection hold guard; grant/decline/Continue remain
blocked. The exact held Bible card is the original-path installation check.

### Waiting, rate limits and result collection

The inspected generic browser tools do not supply SessionPlane's durable
ChatGPT ACK/answer/permission/UNKNOWN contracts. We retain one original collector,
the native 1200000ms continuation-review default, actual scoped Retry-After and
separate backend `nextCheckAt`. `networkidle`, elapsed action-settle time, an
empty assistant container, Stop disappearance and old successful tool calls are
not equivalent to a recovered answer. No new 429/focus/ACK patch is justified
by this two-target reproduction. The previously recovered Webturn original
FINAL remains consumed; it is not recollected to make the benchmark look complete.
