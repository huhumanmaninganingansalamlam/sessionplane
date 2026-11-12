# Candidate acceptance gate and remaining live proofs

The dev candidate is not a release. Run the candidate acceptance command in
the README on a clean committed dev branch. It executes Core, Chromium,
background-tab, browser transport, archive/migration, and real installed tarball
tests in disposable state; an optional live preflight is read-only.

The machine-readable receipt records the git HEAD/tree, clean build identity,
reproducible tarball SHA-256 and the actual test counts and output hashes.
Timeout, dirty source, incorrect package hash or failing gate is a failure.
L1/L2/L4 candidate pass does not grant L3 or release approval.

## Proven in supported isolation

- Six public Core/MCP tools, stable idempotency, cancellation receipt and
  exact canonical POST/ACK/FINAL journal
- Owned Chromium new-root first submission, exact model guard at both
  observation and final pre-click mutation, and restart recovery without resend
- Four independent projects retaining separate Main sessions, background
  page/target IDs and unchanged model decisions, with zero focus changes
- Core-owned virtual 20-minute due, idempotent Continue and current revocation
- Headless Chrome background timer/DOM and CDP reconnect, plus browser
  transport comparison; not a native-headed foreground guarantee
- Synthetic v8 to v15 migration, all original facts and post-upgrade evidence
  preserved, and foreign rollback candidate rejection
- Reproducible tarball, isolated npm install and isolated installed Core
  project/task/MCP/cancel with zero provider POST

## Actually observed with a logged-in ChatGPT account

Three substantive prompts in a single dedicated legacy Core test conversation
produced three independent exact canonical FINAL results. First and third
ACK uncertainty recovered without resending. The dev adapter independently
observed real ChatGPT Chat/Pro/turn evidence and natural operation-scoped
HTTP 429 deferral read-only; the dev Core did not send those prompts.

Full details: sessionplane-l3-real-2026-11-12.md.

## Still pending before any new-runtime release assertion

| Gate | Exact missing proof |
| --- | --- |
| E01–E04, E19 | New v15 Core executes real Pro Main three turns, disconnect/restart and exact ACK/FINAL |
| E05, E16, E24 | Four actual logged-in project conversations, native group and unchanged human foreground |
| E07, E08, E23 | Eligible incomplete task reaching actual 20-minute due, literal Continue once, ACK and next due |
| E10, E11, E18, E21 | New-Core live model/decision, human barriers, uncertain stop and reconnect |
| X03/X04, retained scope | Retained SSH, role, extra provider and artifact verification against approved requirements |
| Release L4 | Reviewed main version, checked external package receipt, single writer cutover and rollback |

A live Core with historical user work owns Chrome and SQLite at schema 8,
while the dev candidate uses schema 15. Running a second Core on that
profile/database is not a substitute for an authorized one-owner handover.
The read-only preflight reports this mismatch, never a fake L3 pass.
