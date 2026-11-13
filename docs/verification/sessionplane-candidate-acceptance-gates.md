# Candidate acceptance gate and remaining live proofs

The dev candidate is not a release. Run the candidate acceptance command in
the README on a clean committed dev branch. It executes Core, Chromium,
background-tab, browser transport, archive/migration, and real installed tarball
tests in disposable state; an optional live preflight is read-only.

The machine-readable receipt records the git HEAD/tree, clean build identity,
reproducible tarball SHA-256 and the actual test counts and output hashes.
Timeout, dirty source, incorrect package hash or failing gate is a failure.
L1/L2/L4 candidate pass does not grant L3 or release approval.

## Current status — 2026-11-14 (separate source identities)

- The installed Core source `889db8f1` (schema 15) has real-account
  canonical evidence: one Main conversation with three exact FINALs, four
  independent background project conversations with each original POST once,
  exact ACK and raw byte/SHA-verified FINAL, and one permitted literal
  `계속` after a measured 20-minute due with its own ACK and FINAL.
  The next due was observed before one-shot local cancellation; provider
  Stop was unverified, so P1's public state remains uncertain.
- The newer **dev** candidate is version `0.4.94`. It is *not* the source
  deployed for that L3 run; candidate HEAD/tree/package evidence is separate.
- A single candidate test run timed out at the previous Chromium 180-second
  limit under extreme host load; a separate bounded run passed all 16 cases.
  The failed run remains in its receipt. The candidate runner now uses finite
  gate-specific limits and captures bounded failure output tails and hashes.
- Reviewed dev-to-main PR, unique main artifact, approved maintenance cutover,
  post-install checks and final release decision are still separate gates.
  L3 alone does not authorize publishing or replacing the shared Core.

Historical snapshots below record earlier source/runtime states. Their
2026-11-12 pending entries are not a current verdict for E05/E07/E19.

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

## Historical pending list (2026-11-12 snapshot; updated above)

| Gate | Exact missing proof |
| --- | --- |
| E01–E04, E19 | New v15 Core executes real Pro Main three turns, disconnect/restart and exact ACK/FINAL |
| E05, E16, E24 | Four actual logged-in project conversations, native group and unchanged human foreground |
| E07, E08, E23 | Eligible incomplete task reaching actual 20-minute due, literal Continue once, ACK and next due |
| E10, E11, E18, E21 | New-Core live model/decision, human barriers, uncertain stop and reconnect |
| X03/X04, retained scope | Retained SSH, role, extra provider and artifact verification against approved requirements |
| Release L4 | Reviewed main version, checked external package receipt, single writer cutover and rollback |

On 2026-11-12, the live Core used schema 8 while the dev candidate used
schema 15. It has since undergone a controlled schema-15 handover. A second
Core/profile remains prohibited; source mismatch is not L3 evidence.

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

## Caller-wide request ID cannot create a second Task in another project

A controlled RPC reproduction showed the old admission path accepted two
different tasks in two projects when the same clientId/requestId was reused.
The public admission service now checks the caller's durable Task request
identity across all project IDs before admitting a new Task. It preserves
prior exact per-project receipts first (including historical replays), rejects
new cross-project collisions as idempotency_conflict, and does not advance the
other project's Main revision or create another provider attempt.
This is independently asserted in RPC integration and installed package
smoke, without changing existing live callers or their account profile.

## Public conversation revision follows an explicit provider rebinding

An isolated Core reproduction showed a dangerous stale-revision admission:
after authorized provider binding replacement advanced the immutable binding
revision to 2, the public conversationRevision incorrectly remained at 1.
The previous public caller could therefore start an unintended Task in the
replacement conversation without re-reading it. The same SQLite transaction
now advances the selected slot's public revision and immutable binding
revision, leaving other slots untouched. A new integration test validates
Core restart, stale request conflict, exactly one freshly authorized Task
and immutable historical bindings. The installed-tarball Core smoke repeats
the stale and fresh revision checks after restart.
