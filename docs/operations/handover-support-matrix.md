# Core handover compatibility and evidence matrix

Reviewed for the local 0.4.111 / SQLite schema 17 candidate on 2026-11-23.
This is a support inventory, not an operational cutover receipt or permission to
attach to the currently installed Core/Chrome/profile.

| Source / mode | Grounded current evidence | Supported automatic action |
| --- | --- | --- |
| Checked-in schema 16 to schema 17 candidate | [Handover policy](../../scripts/ops/handover-manifest.json) declares an exact 16 to 17 transition and candidate-acceptance-v1. [Core handover procedure](core-handover.md) requires the exact owner, maintenance fence, source/package proof, WAL-consistent migration and systemd MainPID. | Eligible only after a clean reviewed candidate and separate authorized maintenance window; no legacy freeze fallback. |
| Equal-schema current package refresh | The handover CLI explicitly distinguishes absence of schemaTransition from a requested schema upgrade. Older local validation receipts remain readable for same-schema review. | Only the current Core maintenance admission-fence path may perform a current installation refresh; a failed fence cannot trigger a freeze fallback. |
| Historical schema 15 to 16 | Existing synthetic preflight/rollback and migration tests preserve previous facts. The present release policy no longer declares this transition. | Historical recovery evidence, not evidence that an installed schema-15 Core is currently supported for a new automatic cutover. |
| Schema 8 historical archive | An isolated migration rehearsal test proves historical WAL/ACK/FINAL retention. This is not a live installed support inventory. | Read/migrate only in a separate offline rehearsal; never infer live authorization. |
| Legacy issuer freeze / explicit legacy recovery | The previous implementation had a separately selected, bounded frozen-core/PID guardian and an explicit --legacy-recovery-handover flag. No authoritative installed owner inventory was supplied proving the last caller or rollback package is gone. | Quarantine in legacy_transition.py, require explicit opt-in, exact old-source state and operator coordination. Current schema 16+ must not reach this branch. Review for retirement by 2027-01-31; remove only after an authorized installation/receipt inventory proves no eligible source remains. |
| Post-cutover rollback | Retention code retains two complete rollback receipts plus bounded snapshots. Historical receipts, browser PID and database integrity remain distinct from source code lifetime. | Retain receipt reading, original install bytes and exact database snapshots. Never retry an issued cutover blindly or kill an unrelated Chrome/process. |

## Installed evidence boundary

The authenticated installed Core source commit, active database schema and lock
holders, actual rollback package inventory, historical receipts, and live browser
PID/start ticks are **not established by repository files**. No live health or
production database was opened during this code refactor. Before applying any
cutover, authorized operations must collect those exact values by the
[core handover procedure](core-handover.md); an absence of a local receipt or
lack of a known user does not prove a mode is unused.

Current source proof resides in the checked-in handover policy, versioned
SQLite migrations and the offline lock/rollback tests. Every phase must
preserve one writer, a WAL-consistent original, exact PID/systemd owner,
unmodified shared browser/profile, migration integrity and post-cutover
evidence before rollback. A successful isolated package or fixture test is not
a live L3 approval.
