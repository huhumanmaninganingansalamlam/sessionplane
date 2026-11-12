# L3 ChatGPT acceptance evidence — 2026-11-12

## Scope and provenance

This record covers **one newly created, dedicated synthetic test team and
session** in the already-running, locally installed SessionPlane Core.
No existing caller's team, transcript, Chrome profile, or tab was edited.
The installed Core reports v0.4.93, SQLite schema 8; its dedicated Chrome was
already running and was not restarted. The dev candidate uses schema 15.
This was an **installed legacy Core baseline**, not a dev Core cutover.

The experiment used one retained stable client, one session and three original
prompts, each requesting a different synthetic fixed answer. Actual team,
conversation, account and page identifiers are intentionally excluded from
this repository document.

## Observations

| Gate | Evidence | Outcome |
| --- | --- | --- |
| Actual ChatGPT login/Chat/Pro UI | Owned page with writable composer, Chat surface and exact Pro label | Observed |
| First Task | Exact original draft, one Submit, initially UNKNOWN, canonical ACK recovered, FINAL | Pass |
| Second substantive question | Same conversation; per-generation Pro configuration required; original answer not borrowed | Pass |
| Third substantive question | Same conversation, one Submit; UNKNOWN recovered to ACK without replay | Pass |
| E19: three questions on Main | Three distinct full final answers in one canonical conversation | Legacy Core L3 pass |
| Final integrity | Each answer exactly matched its requested synthetic token; separate SHA-256 receipts | Pass |
| Dev semantic adapter, read-only | Actual owned page model menu identified as composer-radix; Chat and exact user turn | Pass |
| Dev closed Pro picker bug | Original adapter reported verifiedModel=null while Pro was visibly selected; new strict picker verification now reports Pro | Fixed, real read-only rechecked |
| Dev canonical backend GET | Natural HTTP 429 returned operation-scoped deferred with Retry-After/pacing, never forged ACK/FINAL | Correct deferral, exact canonical result unobserved in this run |

Test answer SHA-256 values, in ordered turns, are:

- Turn 1: d3cef665c702bb0fbdd9f534a97e4336368fe098aa3816663741356b261b496a
- Turn 2: 29066aba9bdedcf0f6aff330617f8eb561a8af30565ba2705f413786a8ae395f
- Turn 3: 50561afee6ef4bd7b10ea43db4eac2d735d6d57e8a8586a289814887e6a9ef7d

The first and third requests temporarily reported ambiguous delivery. The Core
recovered a matching canonical user message before completion. No original
prompt was sent twice. An unrelated pre-submit block on turn two was diagnosed
as a missing per-generation Pro configuration, and the original draft survived.

## Isolated 4-project and browser scheduling evidence

In a disposable Core/Chromium fixture, four independently opened
public projects received four different Main sessions, page keys and
CDP target IDs. Every project's original Task remained planned and
blocked on its own explicit model decision, with **zero focus changes**
and no cross-project POST. Every subsequent Core tick preserved the
same four identities and read-only Task reports. The fixture is L2,
not four real logged-in provider exchanges.

A second disposable-profile Chrome fixture measured background
timers, DOM mutations, foreground-call count and target reattachment:
four target IDs rebound after a secondary CDP controller disconnected,
with no focus change. Background animation frames were not sustained
on all pages in the headless run and are **not** presented as a
pass for actual headed-native rendering. The transport comparison
likewise measures headless fixtures only.

The closed Pro picker regression now includes both the initial
observation and the **submit-time** model recheck; the verified
closed model label must be re-read immediately before an exact
POST, not merely when the decision was originally offered.

## Important incomplete acceptance

The installed Core still reports schema 8 and does not expose new
project.open / task.start/get/wait/decide/cancel. A read-only compatibility
preflight demonstrably refused to use its browser for a dev Core mutation.
Therefore this record **does not establish a dev Core L3 initial POST**.
The dev initial/root dispatch path is covered by controlled Chromium fixtures
and exact SQLite journal tests, not a real candidate install.

The separate live multi-background, no-foreground-switch, real 20-minute due,
new-Core restart and production install/rollback gates are not implied by this
experiment. Actual Core/Chrome/profile cutover requires the release-owned
maintenance and data provenance workflow; this L3 baseline is not permission
to replace those running resources.

## Reproduction

For read-only identity checks, run the dev candidate's
scripts/live-candidate-preflight.mjs. For controlled browser and model-menu
regression, run test/browser/closed-pro-model.test.ts and the main semantic
composition suite. The live receipt for this test stays outside the repository
in a mode-0600 file on the test host; it must not be distributed.
