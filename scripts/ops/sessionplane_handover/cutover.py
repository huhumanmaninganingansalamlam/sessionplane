"""Bounded verified handover cutover phase."""
import json, pathlib, tarfile, time

from . import bundle, migration, model, preflight, rollback, systemd


def verify_staged_resume(prior, h, installed, target):
    assert (prior/'staging.json').is_file(), 'Not a staging-only abort'
    assert all(not (prior/n).exists() for n in ['successor.json', 'promotion.json']), 'Transition history ambiguous; do not reenter'
    before = json.loads((prior/'before-health.json').read_text())
    for key in ['pid', 'startedAt']:
        assert before['process'][key] == h['process'][key], 'Original core lifetime changed'
    for key in ['browserPid', 'profileDir', 'debuggingPort']:
        assert before['browser'][key] == h['browser'][key], 'Browser identity changed'
    if (prior/'handover.json').exists():
        transition = json.loads((prior/'handover.json').read_text())
        # This records commit intent, not exit. A refused commit can leave the exact old core live.
        assert transition.get('oldPid') == h['process']['pid'] and transition.get('oldStartTicks') == preflight.procstat(h['process']['pid'])[19], 'Transition history ambiguous: original process lifetime unverified'
        assert h.get('maintenance', {}).get('phase') == 'running', 'Prior commit lease is still active; preserve it'
    saved = json.loads((prior/'before-identity.json').read_text())
    current = preflight.request_identity(h, target)
    for key in ['request', 'anchor']:
        assert list(current[key]) == saved[key], 'Original request changed'
    assert (prior/'predeploy.sqlite').is_file(), 'Missing backup'
    # A failed staging attempt must not have rewritten the live installation.
    with tarfile.open(prior/'previous-install.tgz') as archive:
        for member in archive.getmembers():
            if member.isfile():
                assert (installed.parent/member.name).read_bytes() == archive.extractfile(member).read(), 'Live installation changed after abort'
    stage = json.loads((prior/'staging.json').read_text())
    assert pathlib.Path(stage['installed']).resolve() == installed.resolve(), 'Different installation'
    assert pathlib.Path(stage['candidate']).is_dir(), 'Prior candidate missing; inspect evidence'

def verify_pre_signal_resume(prior, h, installed, pkg, manifest, target):
    # An old receipt is never erased, overwritten or treated as a fresh attempt.
    assert prior.is_dir(), 'Missing previous receipt'
    assert not (prior/'staging.json').exists(), 'Staging-only abort is not a legacy installed-candidate resume; preserve it and inspect'
    assert not (prior/'handover.json').exists() and not (prior/'successor.json').exists() and not (prior/'promotion.json').exists(), 'Prior signal/promotion may have occurred: inspect instead of retrying'
    before = json.loads((prior/'before-health.json').read_text())
    assert before['process']['pid'] == h['process']['pid'] and before['process']['startedAt'] == h['process']['startedAt'], 'Original core lifetime is not preserved'
    for key in ['browserPid', 'profileDir', 'debuggingPort']:
        assert before['browser'][key] == h['browser'][key], 'Original browser identity changed'
    assert (prior/'previous-install.tgz').is_file() and (prior/'predeploy.sqlite').is_file(), 'Original rollback evidence missing'
    prior_identity = json.loads((prior/'before-identity.json').read_text())
    current_identity = preflight.request_identity(h, target)
    for key in ['request', 'anchor']:
        assert list(current_identity[key]) == prior_identity[key], 'Original request evidence changed since abort'
    # Legacy helper installed before its final guard. Only its exact pinned bytes
    # are accepted here, not a mixed or unknown live installation.
    bundle.verify_package(installed, pkg, manifest)

def execute_schema_transition(h, transition, manifest, installed, candidate, stage, receipt,
                              unit, target, identity, chrome_ticks, catalog_hash):
    database_path = pathlib.Path(h['database']['path'])
    package_promoted = False
    database_promoted = False
    successor_pid = None
    final_migration = receipt/'final-migration'
    try:
        final = migration.run_offline(candidate, 'migrate', {
            'source': database_path, 'destination': final_migration,
        }, receipt/'final-migration.log')
        assert final['sourceSchemaVersion'] == transition[0] and final['schemaVersion'] == transition[1]
        assert final['integrityCheck'] == 'ok' and final['foreignKeyViolations'] == 0
        assert all(row['count'] == 0 for row in final.get('createdKernelTables', []))
        model.save(receipt/'final-migration.json', final)
        bundle.promote_package(installed, candidate, stage, receipt); package_promoted = True
        migration.promote_database(database_path, final_migration, receipt, transition); database_promoted = True
        successor_pid = systemd.start_systemd_core(unit, receipt, 'successor')
        model.save(receipt/'successor.json', {'pid': successor_pid, 'startedAtUnix': time.time(),
                                       'systemdUnit': unit})
        after = systemd.await_systemd_ready(unit, successor_pid)
        return after, successor_pid
    except systemd.LiveSuccessorError:
        model.save(receipt/'rollback-blocked.json', {'reason': 'successor-live',
            'pid': successor_pid, 'action': 'preserve live successor, browser, database and evidence'})
        raise
    except Exception as error:
        model.save(receipt/'startup-failure.json', {'error': str(error), 'packagePromoted': package_promoted,
             'databasePromoted': database_promoted, 'successorPid': successor_pid})
        props = systemd.systemd_properties(unit)
        if props['MainPID'] and preflight.live(props['MainPID']):
            model.save(receipt/'rollback-blocked.json', {'reason': 'successor-live',
                'pid': props['MainPID'], 'action': 'preserve live successor; no automatic rollback'})
            raise systemd.LiveSuccessorError('Transition failed while successor is live; rollback blocked') from error
        if database_promoted:
            rollback_dir = receipt/'failed-candidate-rollback'
            rolled = migration.run_offline(installed, 'rollback', {
                'migration': final_migration, 'candidate': database_path,
                'destination': rollback_dir,
            }, receipt/'failed-candidate-rollback.log')
            assert rolled['postMigrationEvidencePreserved'] and rolled['candidateWasNeverOverwritten']
            failed_files = rollback.archive_failed_candidate(database_path, receipt/'failed-candidate-database')
            rollback.restore_original_database(database_path, rollback_dir/'restored-original.sqlite')
            migration.verify_sqlite(database_path, transition[0])
            model.save(receipt/'failed-candidate-evidence.json', {'rollback': rolled,
                 'archivedLiveFiles': failed_files,
                 'postMigrationEvidence': str(rollback_dir/'post-migration-evidence.sqlite')})
            rollback.restart_original_systemd(h, unit, installed, stage, receipt, target, identity,
                                     chrome_ticks, restore_files=package_promoted)
        elif package_promoted:
            rollback.restart_original_systemd(h, unit, installed, stage, receipt, target, identity,
                                     chrome_ticks, restore_files=True)
        else:
            rollback.restart_original_systemd(h, unit, installed, stage, receipt, target, identity,
                                     chrome_ticks, restore_files=False)
        raise RuntimeError('Schema transition failed; original Core restored with evidence preserved') from error
