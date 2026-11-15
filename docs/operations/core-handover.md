# Core-only handover with a preserved Chrome and schema transition

This procedure replaces one running, same-user SessionPlane Core without closing
the dedicated Chrome profile. It is the supported path for the production
SQLite transition declared by `scripts/ops/handover-manifest.json` (currently
schema 15 to schema 16). It never treats a package version string as source
identity and never starts two Cores against one profile or database.

## Safety contract

The old Core must advertise `maintenance.coordinatedDrain`. The helper acquires
that Core-owned admission fence, drains existing work, rechecks the exact Core
PID/start ticks, Chrome PID/start ticks, profile lock, submitted sentinel, every
existing request hash, page bindings, active submission states, and DB locks,
then invokes `system.maintenance.commit`. That RPC closes SQLite and exits the
Core without calling browser shutdown. Ordinary `SIGTERM`, `SIGINT`, process
group signals, Chrome signals, and profile-lock deletion are not used.

The checked-in handover policy describes the *next development candidate*
(15 -> 16); it is not a deployment order or an acceptance receipt. Never use
an old 8 -> 15 manifest against the installed schema-15 Core, and never
bypass clean source, tarball, all required acceptance gates, exact handover
identity, and review just because the policy names the new schema.

The exact user systemd unit must own the old PID and use `Restart=no`. The same
unit is started after package and database promotion, so the successor is not an
unmanaged background process. The successor must adopt the same Chrome PID,
profile and CDP port.

These PID/start-tick/port checks are scoped only to the interval from this
handover's preflight through its `result.json`. They prevent signaling or
promoting against the wrong live process. After a completed cutover, a normal
browser crash, host reboot, or later service restart may create new PIDs, ports,
target IDs, and `spawned` ownership. That does not invalidate the cutover receipt
or durable Task evidence and must not block normal development, recovery, or L3;
those paths revalidate the dedicated profile and canonical conversation instead.

A later exact-package refresh may declare an equal source and target schema
(for example 16 to 16). It still runs the same WAL-consistent copy, evidence-first
rollback rehearsal, raw DB archive, systemd ownership and browser-adoption checks;
it is not a shortcut around the handover contract.

For a schema transition, a same-schema rollback is not assumed. Before the old
Core is stopped, the staged candidate performs an actual WAL-consistent backup
and migration of the live production database into a separate directory. It
checks full `PRAGMA integrity_check`, foreign keys, every original table row/hash,
and that newly created Task tables contain no conflicting rows. It writes
isolated uncertain, FINAL and draft Task evidence to that copy, then rehearses
rollback. Rollback first snapshots post-migration evidence and only then creates
a separate restored original.

After the exact old Core exits, the helper repeats migration from the now-static
production database. The original raw DB/WAL/SHM files are moved into a private
archive. A copy of the sealed schema-16 candidate is atomically renamed into the
live DB path; the sealed migration candidate and source snapshot remain beside
their manifest.

If the new Core exits before readiness, rollback uses the schema-15 package to
retain the live candidate as `post-migration-evidence.sqlite`, archives its raw
DB/WAL/SHM files, restores a schema-15 copy, restores the old package, and starts
the same systemd unit once. A live but unhealthy successor is preserved and
blocks automatic rollback. Never kill it or launch another Core to force a green
result.

## Build and bind an exact bundle

Bundle verification reads the *installed candidate's compiled migration registry*
and requires its highest schema version to match the policy target (16). A
version label, Git commit label, or edited policy alone cannot establish schema
compatibility; a mismatch aborts bundle construction without accessing the live
Core or database.

The committed `handover-manifest.json` is a policy, not a stale package receipt.
After committing a clean `dev` candidate and obtaining a successful
`sessionplane-candidate-acceptance-v1` receipt, create the deterministic tarball
and materialize an exact bundle:

```sh
npm pack --silent --pack-destination /absolute/package-dir
python3 scripts/ops/handover.py bundle \
  --policy scripts/ops/handover-manifest.json \
  --package /absolute/package-dir/sessionplane-CANDIDATE_VERSION.tgz \
  --acceptance /absolute/candidate-acceptance.json \
  --rollback-install /home/USER/.nvm/versions/node/VERSION/lib/node_modules/sessionplane \
  --destination /absolute/private-handover-bundle
```

Bundle creation installs the tarball only into a temporary prefix and binds the
manifest to the package SHA-256, clean Git commit/tree embedded in the build, all
eight acceptance gates, six-tool MCP catalog hash, candidate BrowserOwner hash,
and the currently installed old BrowserOwner hash needed for rollback. It does
not contact or mutate the running Core.

## Read-only preflight

Use an existing submitted request as a preservation sentinel. Confirm its
`requestRef`, `sessionId`, generation and exact submitted user-message anchor in
the live database without reading unrelated conversation bodies. Then run:

```sh
python3 scripts/ops/handover.py \
  --bundle-dir /absolute/private-handover-bundle \
  --local-validation /absolute/candidate-acceptance.json \
  --expected-host HOST --expected-user USER --expected-cwd CORE_CWD \
  --core-pid OLD_CORE_PID --chrome-pid CHROME_PID \
  --request-ref REQUEST_REF --session-id SESSION_ID \
  --generation GENERATION --user-anchor USER_MESSAGE_ID \
  --core-maintenance --systemd-unit sessionplane-core.service
```

Without `--apply`, this performs no staging, backup, signal, service start, DB
write, browser action or provider submission. A failed guard is a reason to stop
and inspect, not to weaken the check.

## Apply

Use a new private receipt directory on the same filesystem as the production
database, then repeat the exact identity arguments with:

```text
--receipt-dir /home/USER/.local/state/sessionplane/handover-YYYYMMDD-HHMMSS
--core-maintenance --systemd-unit sessionplane-core.service --apply
```

The mutating order is fixed:

1. Back up the old installation and create a WAL-consistent predeploy backup.
2. Install and byte-verify the candidate in an adjacent staging prefix.
3. Migrate and rollback-rehearse a real production DB copy, including new Task evidence.
4. Acquire the old Core maintenance fence and prove drain/identity twice.
5. Commit the exact old Core only; prove Chrome is still the same process.
6. Migrate the final static DB, archive old DB/WAL/SHM, promote package and DB.
7. Start the same systemd unit and verify the exact candidate commit/tree, schema 16, adopted Chrome, sentinel, request hashes, bindings and sole DB holder.

An issued receipt is never reused blindly. Preserve every migration, archive,
rollback and process-phase file.

## Success criteria

`result.json` is a cutover receipt only when all of these hold:

- old and new Core PIDs differ, and the new PID is the systemd unit MainPID;
- health reports the bundle commit/tree as clean and schema 16;
- Chrome PID/start ticks, profile and CDP port are unchanged, with ownership `adopted`;
- the sentinel request/anchor, every pre-existing request hash and binding identity are preserved;
- full SQLite integrity and foreign keys passed on source snapshot and candidate;
- the schema-15 source snapshot and raw DB/WAL/SHM archive remain available;
- only the new Core holds SQLite locks; and
- the installed six-tool public catalog matches the accepted package.

This receipt does not claim live provider acceptance. Run
`scripts/live-task-acceptance.mjs` only after the exact installed source/schema
preflight succeeds. Provider L3, four independent live projects, and the actual
20-minute continuation are separate receipts. Those later receipts rely on
durable request/Task/conversation evidence; they do not require the historical
handover Chrome PID, target IDs, CDP port, or `adopted` label to remain unchanged.

## Lock diagnostics

To inspect only current DB/WAL/SHM lock metadata, without opening SQLite or
calling the Core:

```sh
python3 scripts/ops/handover.py locks --database /absolute/sessionplane.sqlite
```

Any foreign, waiting, checkpoint, recovery or otherwise unclassified exclusive
lock blocks handover. The exact old Core WAL-writer byte may drain before the
maintenance commit; it is never ignored or killed.
