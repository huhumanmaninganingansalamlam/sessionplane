# Preserve the existing browser during a core-only handover

This is an operator-run procedure for an existing Linux, same-user, global npm
SessionPlane installation. It does not deploy over SSH, create a service, change
credentials or permissions, restart Codex, or change Codex configuration. The
supervisor coordinates the short quiesce interval. Building and checking a
package does **not** authorize or perform `--apply`.

## What this procedure does and does not guarantee

The legacy core has no atomic admission fence and no graceful browser-detach
shutdown API. Its ordinary SIGINT/SIGTERM path calls `service.close()` and
`browserOwner.close()`, which also closes Chrome. Do not use ordinary shutdown,
process-group termination, or a browser restart for this handover.

The bootstrap alternative is a naturally drained **exact-core-only bounded freeze and SIGKILL**,
followed by the same command, working directory and environment. The successor
adopts the still-running Chrome through the existing profile ownership record.
`handover.py` pins the process lifetime with a Linux pidfd and checks the core
start time/ticks, UID, profile lock, browser identity, actor queue, submission
state and DB/WAL/SHM writer locks immediately before the transition. It never
signals Chrome or a process group. Nonzero actor *count* is not queue activity.

**The initial sampled checks are not an admission fence.** All original call
issuers must actually stop issuing new mutations during the short handover,
while existing calls drain naturally. `--issuers-quiesced` records that operator
assertion; it does not suspend callers. Internal callbacks can also enter an
actor or persist state. External coordination alone does not prove they stopped.
If activity or a writer appears, abort and inspect its owner; do not weaken the
guard or force-stop it. This is not a permanent global pause or rate-limit rule.

An existing wait transport may close during the core outage. Its durable request
remains; the owner resumes that same request afterward. Browser-side generation
is not stopped or resent. The script reuses the existing DB, profile and runtime
environment. Environment values stay in memory and are not printed or saved.

The candidate below includes the B20 load-notice fix and bounded maintenance,
as well as `e38df5b`'s preservation of an existing browser when endpoint verification or
browser attachment fails. Before that fix, those failure paths could replace or
close Chrome. The fix does not make ordinary shutdown browser-preserving or
promise that every later runtime failure is a lossless handover.

## Bounded maintenance on supporting cores

A supporting runtime advertises `maintenance` in health. After candidate staging,
this helper asks that same Unix-socket core to prepare a 30-second lease, allowing
up to 5 seconds for existing operations to drain. The lease is pinned to the core
PID/start time. New ordinary RPCs receive `core.maintenance` before request receipt
creation; owners resume the same request afterward, without resending it.
Observer and acknowledgement-recovery iterations, load-recovery sweeps, automatic
continuation and browser-recovery work stop admitting new cycles. Existing work
settles naturally; retained browser operations and page mutexes must also drain.

Page-binding events and passive rate-limit callbacks are still preserved. A late
callback revokes a ready lease before its write and resumes normal operation.
This makes a stale commit fail instead of dropping evidence. Drain timeout,
explicit release and lease expiry also resume the core; maintenance is never an
unbounded mode. A failed helper attempts release, and expiry covers a lost helper.

The existing actor/submit/writer, pidfd, core start time, Chrome identity and
request checks remain. For supporting cores only, the final action is
`system.maintenance.commit`: the core rechecks its current lease and drain on its
own event loop, closes SQLite and exits without calling browser shutdown. There
is no awaited gap between that decision and exit. The helper treats EOF only as
an uncertain transport outcome and still requires the pinned old process to be
gone, with Chrome alive, before promotion/startup. Ordinary SIGTERM still closes
Chrome and is not used here. External DB writers still fail the existing lock
checks; the core gate does not control another process.

Older running cores do not gain this capability from a staged package. The legacy branch now uses the bounded pidfd freeze below after all existing guards; it still needs fresh issuer coordination. Staging does not activate maintenance in the old process.
No operational update is performed by building or testing this implementation.

`--resume-pre-signal` is only for the historical already-installed-candidate abort.
It explicitly rejects a receipt containing `staging.json`. Preserve a staging-only
abort's candidate, backup and receipts; do not relabel it as installed or erase its
receipt to repeat an attempt. Use the separate `--resume-staged` contract below with a new supervisor-coordinated issuer window.

## One-time legacy bootstrap and staged reentry

On a runtime without `maintenance`, the helper first runs the same live health,
actor, submit, owner and writer checks. A short-lived guardian pins the same
pidfd, sends SIGSTOP to **only that core**, and waits for every core thread to be
stopped. Chrome, workers and other processes continue. While frozen, the helper
rechecks DB submission state, profile ownership, exact request, PID/start ticks,
Chrome lifetime and all DB/WAL/SHM locks without calling a blocked health RPC.
A writer caught by the freeze is rejected, not ignored or killed.

The guardian has a 10-second deadline and is the only process allowed to decide
SIGKILL versus SIGCONT. It resumes on guard failure, helper disconnect/death or
expiry. A late commit cannot kill a resumed core. Successful commit ends only
the pinned old core. The original submission/unknown records are not terminalized.
This closes the old core's internal writer re-entry gap; it does not control a
foreign DB writer. The unchanged lock checks still reject foreign activity.
No SIGTERM, process-group signal or Chrome signal is used. Host failure or killing
the guardian itself is outside this bounded helper-loss guarantee.

For the preserved staging-only abort, use the new exact runtime bundle and add:

```text
--resume-staged /absolute/path/to/prior/local-receipt
--receipt-dir /absolute/path/to/new-bootstrap-receipt
```

This works in read-only preflight; `--apply --issuers-quiesced` still requires a
fresh supervisor window. The prior receipt must contain staging, original backups,
health and request identity and **no handover/promotion/successor record**. The same
old process/start time, Chrome and submitted sentinel must remain. Every regular
file in the original install backup must still match the live installation. Old
candidate/receipts are retained; a different target revision is staged separately.
A prior 5c9c8ee staging is not relabelled as 8f9b971. A new receipt name alone cannot
replace these checks. Ambiguous transition history requires inspection.

Caught promotion, spawn or exited-successor startup failures can restore the
original installation and start it once with the captured original command/cwd/
environment. Before transition, the original BrowserOwner bytes must match the
manifest's reviewed preserving implementation. Before rollback, both old core and
successor must be gone, the same Chrome must remain, ownership must not have moved
to a third process, DB integrity/schema and request identities must match, and
writer checks must pass. Rollback retains the **current DB**, verifies adoption
and request/binding preservation, and records `rollback-health.json`. It still
returns failure so issuers can be released without treating deployment as success.

A live but unhealthy successor is preserved, not killed or overwritten. Changed
Chrome/schema/foreign ownership also blocks automatic rollback. Receipt or helper
loss after old-core exit is not an automatic restart instruction: inspect the
recorded process/path phases first. Browser identity does not prove DOM drafts;
the original owner still checks draft, selection and foreground through supported
observation. Existing staging/rollback evidence is retained throughout.

## Build the exact reviewed package without accessing a running service

Prerequisites: the repository available through your existing authorized Git
route, Node 24 and npm, Python 3 with Linux `pidfd_open`/`pidfd_send_signal`, and
normal dependency access. The original package was built with Node 24.19.0 and
npm 11.17.0. No new authentication or global toolchain changes are part of this
procedure. A different toolchain must still produce the expected package hash.

Fetch/check out the exact **operations commit** supplied by the maintainer in a
separate checkout if the current checkout is dirty. Run the following from its
repository root. The runtime source revision is pinned independently of the
operations commit:

```sh
python3 test/ops/test_handover.py
handover_bundle=$(mktemp -d /tmp/sessionplane-handover.XXXXXX)
mkdir "$handover_bundle/source"
git archive 8f9b971ceef4ae50a49c4192e7614157247d9429 | tar -xf - -C "$handover_bundle/source"
(
  cd "$handover_bundle/source"
  npm ci --ignore-scripts --no-audit --no-fund
  npm pack --silent --pack-destination "$handover_bundle"
)
cp scripts/ops/handover-manifest.json "$handover_bundle/manifest.json"
python3 - "$handover_bundle" <<'PY'
import hashlib, json, pathlib, sys
root = pathlib.Path(sys.argv[1])
manifest = json.loads((root / 'manifest.json').read_text())
actual = hashlib.sha256((root / manifest['package']).read_bytes()).hexdigest()
if actual != manifest['packageSha256']:
    raise SystemExit('Package bytes differ: stop; do not overwrite the expected checksum')
print(json.dumps({'sourceCommit': manifest['sourceCommit'], 'packageSha256': actual,
                  'bundleDir': str(root), 'operationalChanges': False}, indent=2))
PY
```

Expected runtime SHA: `8f9b971ceef4ae50a49c4192e7614157247d9429`.
Exact runtime CI: [38024361219](https://github.com/huhumanmaninganingansalamlam/sessionplane/actions/runs/38024361219), success.
Package version remains `0.4.2`; version alone does not establish installed code.
Expected package SHA256:

```text
9055ad3762677b916cf42ffe05dd182b375a4e94fcbb637bd7be0c7dae7d45ed
```

The committed manifest also pins the installed catalog and browser implementation
hashes. No archive, DB, profile, credential or private operational receipt is
committed. Never add the generated bundle's `local-receipt/` directory to Git or
send it as part of a code delivery.

## Read-only preflight on the original host

Run `sessplane health --json` using the original owner's normal environment.
Record the exact live core and Chrome PIDs, core start time, DB path/integrity,
profile, and current activity. Confirm the original submitted request, session,
generation and user anchor from the owner's existing evidence. Do not guess or
substitute a different tab. This procedure currently uses a submitted request as
the preservation sentinel; it also compares all durable request hashes and page
binding identities without reading conversation bodies.

Supply those values explicitly. The placeholders below are **not defaults**:

```sh
python3 scripts/ops/handover.py \
  --bundle-dir "$handover_bundle" \
  --expected-host "$confirmed_host" --expected-user "$confirmed_user" \
  --expected-cwd "$confirmed_core_cwd" \
  --core-pid "$confirmed_core_pid" --chrome-pid "$confirmed_chrome_pid" \
  --request-ref "$original_request_ref" --session-id "$original_session_id" \
  --generation "$original_generation" --user-anchor "$original_user_anchor"
```

Without `--apply`, this performs checks only: no installation, backup, signal,
service start, browser action or request transition. Do not use Python `-O` or
`PYTHONOPTIMIZE`; the script refuses optimized execution rather than disabling
its assertions. A failed guard is a reason to stop, not to edit the script.

Before applying, use the owner's existing supported browser observation to record
its exact tab, draft, selection and foreground state. Preserve the user's selected
tab; do not focus another tab or clear a draft/selection for this operation. The
script does not use raw CDP, inspect other projects' conversation contents, or
claim it can independently verify browser draft/selection state.

## Apply only after the supervisor confirms quiesce

Re-run the **same preflight command and identity arguments**, appending:

```text
--issuers-quiesced --apply
```

This is the only mutating mode. It creates a private local receipt directory,
backs up the installed package and makes an integrity-checked SQLite backup,
installs and verifies the candidate in a separate same-filesystem staging prefix,
rechecks drain/identity, and terminates only the pinned core. Only after that core
is confirmed exited does it move the old package directory into the staging
rollback location and promote the verified candidate to the original path.
The global executable symlink and invocation path stay unchanged. These are two
directory renames during the core outage, not an atomic admission fence. It retains the original command/cwd/environment. The database is
never overwritten or manually edited.

Do not repeat an issued handover: an existing `local-receipt/` causes the script
to stop. Inspect its phase and live health first. The source fixes and this
procedure have isolated regression coverage; remote production success is not
inferred from those tests.

Require all of the following before reporting a successful update:

- New core socket health ready; same DB path/schema and integrity `ok`.
- Same Chrome PID **and start ticks**, profile and CDP port; ownership `adopted`.
- Original submitted request and anchor unchanged; durable request hashes and
  page binding identities preserved.
- `before-identity.json` / `after-identity.json` retain probe-budget metadata.
  Compare it and distinguish legitimate new provider observations from a reset;
  do not change the DB to make the comparison pass.
- The original owner verifies the same tab, foreground, draft and selection
  through existing supported observation. The script leaves this check marked
  required; browser identity alone is not proof of every DOM property.

The installed MCP files/catalog are checked. An already loaded client may still
show old description text; request schemas remain compatible with this runtime.
Do not claim live client catalog reload from a package hash. The existing client
refresh workflow writes a Codex deployment-revision setting, so it is not invoked
here. No Codex restart or option change is necessary for the existing `latest`
request shape.

## Failure and rollback boundaries

- Before installation: original package/core are unchanged. Let active work drain.
- After staging but before transition: the running package is untouched.
  `staging.json` identifies the candidate and `abort-locks.json` preserves a final
  lock-guard failure. Keep these records and do not repeat blindly. Read-only
  SQLite connections, including backup connections, are explicitly closed.
- After core exit but during promotion: inspect `promotion.json`. A caught
  candidate-rename failure restores the previous installation path; it does not
  restart the old core by itself; the guarded rollback wrapper performs the restart. A process interruption between renames requires checking
  the recorded paths first. Never overwrite a live installation or start a
  duplicate core to conceal a partial transition.
- After transition: inspect `successor.json`, `core.log` and current health. Never
  launch a duplicate core or terminate a live successor to force a result. An
  adoption failure is not success; an exited successor can enter the guarded rollback above. Preserve the browser and fix the
  demonstrated cause. Do not automatically start old code against an unhealthy
  endpoint: its old fallback may close the browser.
- `previous-install.tgz` is the local package rollback; `predeploy.sqlite` is a
  disaster-recovery backup. Normal rollback retains the current DB, not an older
  snapshot. Only after confirming no live core is using that installation may
  the operator restore the package files to the verified original prefix:

  ```sh
  prefix=$(npm prefix -g)
  tar -xzf "$handover_bundle/local-receipt/previous-install.tgz" -C "$prefix/lib/node_modules"
  ```

  This restores files only. It does not restart a core or Chrome. Starting an old
  runtime requires resolving the same browser-health risk first. Do not delete
  ownership files, change identifiers, bypass a denied request or restore the DB
  merely to obtain a ready result.

## Diagnose a lock without executing the handover

The old helper rejected every `WRITE` entry for a DB, WAL or SHM inode with a
single message and did not retain the matching line. That message alone cannot
prove a data writer, its owner, or its occurrence time. If the old run did not
save the raw line, leave its historical lock classification unknown.

This separate command reads only filesystem and `/proc` metadata. It opens no
SQLite connection, calls no core method and sends no signal:

```sh
python3 scripts/ops/handover.py locks --database "$confirmed_db_path"
```

Return one timestamped report containing the exact inode/path mapping and each
matching raw lock row, lock class/mode, holder PID/UID/comm/start ticks, waiting
flag, and byte range. An unavailable/exited holder stays unknown. No command
arguments, environment, authentication data or conversation content is read.

For the SQLite Unix WAL layout, SHM byte 120 is the writer lock, 121 checkpoint,
122 recovery, 123..127 read marks, and 128 shared-memory initialization control.
An exclusive read-mark or initialization lock is not proof of a data transaction.
Queued lock requests are also distinguished from held locks. The classification
is diagnostic: exclusive/unknown lock activity still blocks handover. No offset,
PID, wait duration, or threshold exception was added. Normal shared `READ` locks
were already allowed. Isolated real WAL tests distinguish an idle/read transaction
from `BEGIN IMMEDIATE`, and retain the writer's exact PID and range.

Preflight lock failures emit the report to stderr. Failures in the final guard
also save `abort-locks.json`. A later sample is current evidence, not a substitute
for the missing original event. Preserve guard failure evidence and identify the
actual owner before any further handover attempt.

## Continue a legacy install-before-guard abort

The legacy helper could update global package files and then abort before the
core signal. That is **partial installation**, not a completed rollout: the
same process can retain previously loaded modules while disk bytes are newer.
Do not infer its running source SHA from the on-disk package or version `0.4.2`.
Do not roll files back underneath that live process.

After collecting the original receipt and lock evidence, the revised helper can
check this specific case without discarding the old receipt. Add these arguments
to the same exact-identity **preflight** command:

```sh
--resume-pre-signal "$handover_bundle/local-receipt" \
--receipt-dir "$handover_bundle/recovery-attempt-1"
```

It requires all of the following: the original core PID/start time and browser
identity still match `before-health.json`; `handover.json`, `successor.json` and
`promotion.json` are absent; the previous package/DB backups exist; the original
request and anchor match `before-identity.json`; and the current installed files
and catalog match the pinned candidate exactly. A mixed installation, changed
owner, or ambiguous signal history is rejected. These checks do not prove the
unrecorded historical lock type.

Existing issuers may have resumed after the abort. **Obtain a new coordinated
quiesce interval** before adding `--issuers-quiesced --apply`. This stages a
verified candidate without rewriting the current package and uses a distinct
receipt directory. It references the old receipt; it never deletes or overwrites
it. The original legacy `previous-install.tgz` remains the pre-upgrade rollback,
whereas the new attempt's backup reflects the current on-disk installation.
No DB restoration, budget reset, new generation or resend is part of resumption.

If a newer attempt also aborts, inspect its recorded phase and preserve its
staging/rollback evidence. Do not select a fresh receipt name just to bypass an
unresolved failure. Only remove staging after operational verification and the
required evidence retention have completed.

## Resume exact answer collection separately

Once preservation is verified, the original owner can explicitly display the
same current request using the existing native `sessionplane_decide` tool with
`decision: "latest"`, its exact team/request identifiers and one stable action
ID. This does not focus, refresh or submit. Preserve guards for draft, selection,
active generation and alerts; return `not-dispatched` rather than changing them.

Only when the exact submitted anchor is mounted should one ordinary exact
`sessionplane_team_get` inspect the newly available DOM. Return the actual
assistant ID, answer text and terminal evidence linked to that user turn. A
global “Response complete”, a later user turn's answer, or a different generation
is not sufficient. Do not resend, assign an arbitrary ACK, create a successor
request, or repeat unchanged get/wait calls to conceal failed recovery.

Report package/core update, browser/request preservation, and actual answer
recovery as separate results.
