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

## Public SSH relay and concurrent-source-fence evidence

The public project/task methods and MCP share exactly one Core when accessed
through an SSH stdio relay. An isolated fake-SSH fixture checks that strict
host-key and batch-mode arguments remain enabled, verifies idempotent
project/start/cancel receipts across local, remote and MCP clients and after
Core restart, and treats loss of an already-dispatched remote response as
uncertain instead of creating another Task. No real SSH account was used.

Acceptance now captures the initial committed HEAD/tree and compares them
after **each** gate and again with the emitted build identity. Any concurrent
commit, uncommitted tree mutation or build-source mismatch invalidates that
run with explicit reason codes. All green tests cannot be attached to a
source tree that changed during their execution.

## Four independent canonical POST/ACK/FINAL fixtures

The acceptance chromium-composition gate now includes one Core dispatching exactly
four disposable background initial POSTs into four separate provider conversation
fixtures, each with exact canonical ACK and unique FINAL. A scoped GET 429 for one
project defers the read and never authorizes an original POST replay. All four
answer/project bindings and zero native focus actions are asserted. This is L2,
not four actual authenticated ChatGPT projects (L3 remains pending).

## X02 second explicitly provisioned logical slot

A separate public Core integration regression explicitly provisions one reviewer
role/slot through the internal owner fixture, then admits independent Main and
reviewer Tasks using the normal task.start conversationSlotId. It verifies
slot-specific public revisions and unchanged idempotency, independent pending
leases, correct answer/result association, cancellation isolation, stale
revision rejection, and foreign/unregistered slot rejection before any provider
send. This is an L1/L2 scope foundation, not a public role-creation command or
an assertion that a real Expert account has been created.

## Historical role-slot public revision repair

An actual RPC regression reproduces a pre-public role slot whose immutable
provider binding revision has advanced to 2 but whose new public admission
revision row is missing. Before the fix, task.start returned
conversation_conflict despite the caller supplying the correct revision.
Admission now initializes only the missing public row in the same SQLite
transaction and advances it to 3 without touching provider identity. Foreign
owner and stale-revision admissions roll back with no row inserted. The
installed-package smoke repeats this after a real Core restart and verifies
that one Task/attempt is preserved. No archived old workflow runtime is used.
