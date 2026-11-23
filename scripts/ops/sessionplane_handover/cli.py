"""Established, drained, exact-core-only replacement. Never a second Core; never kill browser/profile. Live mutation requires explicit operator maintenance approval."""
import argparse, hashlib, json, os, pathlib, pwd, signal, socket, sqlite3, subprocess, sys, time
from contextlib import closing
from . import bundle, cutover, legacy_transition, migration, model, preflight, retention, rollback, systemd


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--apply', action='store_true')
    parser.add_argument('--issuers-quiesced', action='store_true')
    parser.add_argument('--core-maintenance', action='store_true', help='Require the live core admission fence; never fall back to legacy freeze')
    parser.add_argument('--legacy-recovery-handover', action='store_true', help='Explicit browser-preserving migration from the legacy unfinished-recovery guard; requires drained core admission and bounded exact-PID transition')
    parser.add_argument('--local-validation', type=pathlib.Path, help='Explicit local-only validation receipt instead of remote CI')
    parser.add_argument('--core-pid', type=int, required=True)
    parser.add_argument('--chrome-pid', type=int, required=True)
    parser.add_argument('--bundle-dir', type=pathlib.Path, required=True)
    parser.add_argument('--expected-host', required=True)
    parser.add_argument('--expected-user', required=True)
    parser.add_argument('--expected-cwd', required=True)
    parser.add_argument('--request-ref', required=True)
    parser.add_argument('--session-id', required=True)
    parser.add_argument('--generation', type=int, required=True)
    parser.add_argument('--user-anchor', required=True)
    parser.add_argument('--resume-pre-signal', type=pathlib.Path)
    parser.add_argument('--resume-staged', type=pathlib.Path)
    parser.add_argument('--receipt-dir', type=pathlib.Path)
    parser.add_argument('--systemd-unit', help='Exact user unit that owns the Core; required for schema transitions')
    args=parser.parse_args()
    assert not (args.resume_staged and args.resume_pre_signal), 'Choose exactly one reentry contract'
    if args.apply and not args.core_maintenance:
        parser.error('--apply requires supervisor-coordinated --issuers-quiesced and the live --core-maintenance fence')
    assert hasattr(os, 'pidfd_open') and hasattr(signal, 'pidfd_send_signal'), 'Linux pidfd support is required'
    root=args.bundle_dir.resolve()
    assert pwd.getpwuid(os.getuid()).pw_name==args.expected_user and socket.gethostname()==args.expected_host, 'Wrong original host/owner'
    os.umask(0o077)
    manifest=json.loads((root/'manifest.json').read_text())
    pkg=root/manifest['package']
    assert hashlib.sha256(pkg.read_bytes()).hexdigest()==manifest['packageSha256'], 'Package checksum mismatch'
    bundle.validate_candidate(manifest, args.local_validation)
    if args.apply and (root/'local-receipt').exists():
        assert args.resume_pre_signal is not None or args.resume_staged is not None, 'Existing attempt: inspect and explicitly resume a proven pre-signal abort'
        assert (args.resume_staged or args.resume_pre_signal).resolve() == (root/'local-receipt').resolve(), 'Existing bundle receipt must be the inspected prior attempt'
    h=preflight.health(); assert h['process']['pid']==args.core_pid and h['browser']['browserPid']==args.chrome_pid, 'PID differs from supplied live receipt'
    schema_change = bundle.schema_transition(manifest, h['database']['schemaVersion'])
    if schema_change is not None:
        assert args.systemd_unit, 'Schema transition requires the exact systemd unit owner'
        assert args.core_maintenance, 'Schema transition requires Core-owned maintenance fencing'
        systemd.verify_systemd_owner(args.systemd_unit, args.core_pid)
    preflight.require_admission_fence(h, args.core_maintenance)
    transition_mode = preflight.verify_transition_mode(
        h, args.core_maintenance, args.legacy_recovery_handover, args.apply)
    pid=args.core_pid; proc=pathlib.Path(f'/proc/{pid}')
    assert proc.stat().st_uid==os.getuid() and pathlib.Path(f'/proc/{args.chrome_pid}').stat().st_uid==os.getuid()
    ticks=preflight.procstat(pid)[19]; chrome_ticks=preflight.procstat(args.chrome_pid)[19]
    cmd=proc.joinpath('cmdline').read_bytes().rstrip(b'\0').decode().split('\0')
    cwd=os.readlink(proc/'cwd')
    assert cwd==args.expected_cwd and 'serve' in cmd and any('sessplane' in c for c in cmd), 'Unexpected core command'
    prefix=subprocess.check_output(['npm','prefix','-g'], text=True).strip()
    installed=pathlib.Path(prefix)/'lib/node_modules/sessionplane'
    assert installed.is_dir() and not installed.is_symlink() and os.access(installed,os.W_OK)
    if args.resume_pre_signal is not None:
        assert args.receipt_dir is not None, 'Resume requires a distinct --receipt-dir'
        assert args.receipt_dir.resolve() != args.resume_pre_signal.resolve(), 'Preserve prior receipt'
        cutover.verify_pre_signal_resume(args.resume_pre_signal.resolve(), h, installed, pkg, manifest, args)
    if args.resume_staged is not None:
        assert args.receipt_dir is not None and args.receipt_dir.resolve() != args.resume_staged.resolve(), 'Staged reentry needs a new receipt; preserve prior evidence'
        cutover.verify_staged_resume(args.resume_staged.resolve(), h, installed, args)
    # Rollback may restart only the reviewed browser-preserving adoption implementation.
    rollback_owner_sha = manifest.get('rollbackRuntimeBrowserOwnerSha256', manifest.get('runtimeBrowserOwnerSha256'))
    assert rollback_owner_sha and bundle.sha256_file(installed/'dist/browser/browser-owner.js') == rollback_owner_sha, 'Unreviewed original browser adoption; no automatic rollback path'
    identity=preflight.request_identity(h, args)
    # The supported fence drains recovery actors atomically. An idle sample before
    # acquiring it races those actors; all post-fence guards still require idle.
    preflight.guard_state(h,h,require_idle=not args.core_maintenance, recovery_handover=args.legacy_recovery_handover)
    if args.core_maintenance:
        # An admitted operation may still own the WAL writer before draining.
        # Foreign/checkpoint/recovery locks remain errors; post-drain is strict.
        writer_pending = preflight.drainable_writer(preflight.lock_report(h['database']['path']), pid, ticks)
    else:
        preflight.no_writer(h['database']['path'])
        writer_pending = False
    print(json.dumps({'phase':'preflight','corePid':pid,'chromePid':args.chrome_pid,'sourceCommit':manifest['sourceCommit'],'packageVerified':True,'actorDepth':h['metrics']['session_actor_queue_depth'],'activeSubmitCount':0,'ownWriterPendingDrain':writer_pending,'next':'apply through required core admission fence' if args.core_maintenance else 'apply only during coordinated issuer pause'},indent=2),flush=True)
    if not args.apply: return
    receipt=args.receipt_dir.resolve() if args.receipt_dir is not None else root/'local-receipt'
    receipt.mkdir(mode=0o700) # never rerun an issued handover blindly
    model.save(receipt/'validation-basis.json', {'mode': 'local' if args.local_validation else 'ci',
        'sourceCommit': manifest['sourceCommit'], 'packageSha256': manifest['packageSha256'],
        'localValidation': json.loads(args.local_validation.read_text()) if args.local_validation else None,
        'admission': 'core-maintenance' if args.core_maintenance else 'issuers-quiesced',
        'legacyRecoveryHandover': args.legacy_recovery_handover,
        'schemaTransition': manifest.get('schemaTransition'),
        'systemdUnit': args.systemd_unit})
    model.save(receipt/'before-health.json',h); model.save(receipt/'before-identity.json',identity)
    if args.resume_pre_signal is not None:
        model.save(receipt/'resumes.json', {'priorReceipt': str(args.resume_pre_signal.resolve()), 'meaning': 'same original live core; pinned candidate already on disk; runtime SHA not inferred from disk'})
    if args.resume_staged is not None:
        model.save(receipt/'resumes.json', {'priorReceipt': str(args.resume_staged.resolve()), 'meaning': 'verified staging-only abort; live installation unchanged'})
    runtime_env=dict(item.split('=',1) for item in proc.joinpath('environ').read_text().split('\0') if '=' in item)
    subprocess.run(['tar','-czf',str(receipt/'previous-install.tgz'),'-C',str(installed.parent),'sessionplane'],check=True)
    with preflight.read_db(h) as db, closing(sqlite3.connect(receipt/'predeploy.sqlite')) as backup:
        db.backup(backup); assert backup.execute('PRAGMA integrity_check').fetchone()[0]=='ok'
    stage, candidate, catalog_hash = bundle.stage_package(installed, pkg, manifest, receipt)
    if schema_change is not None:
        migration.rehearse_schema_transition(candidate, h['database']['path'], schema_change, receipt)
    # Pin the exact process lifetime. No process groups, killall, SIGTERM, or browser signals.
    fd=os.pidfd_open(pid)
    lease = None
    try:
        if 'maintenance' in h:
            lease = preflight.prepare_maintenance(h, recovery_handover=args.legacy_recovery_handover)
            assert lease['phase'] == 'ready' or (args.legacy_recovery_handover and lease['phase'] == 'draining' and lease['activeOperations'] == 0), 'Core has not drained'
            model.save(receipt/'maintenance.json', lease)
        if lease is None:
            assert transition_mode == 'explicit_legacy', (
                'Maintenance lease missing: preserve Core; never fall back to legacy freeze')
            current = legacy_transition.prefreeze_drain(h, ticks, chrome_ticks, args, identity, receipt)
        else:
            for _ in range(2):
                current=preflight.health(); preflight.guard(current,h, recovery_handover=args.legacy_recovery_handover)
                if args.legacy_recovery_handover:
                    assert current['maintenance']['phase'] == 'draining' and current['maintenance']['activeOperations'] == 0, 'Core admission changed'
                assert preflight.procstat(pid)[19]==ticks and preflight.procstat(args.chrome_pid)[19]==chrome_ticks, 'PID reused'
                assert preflight.request_identity(current, args)['request']==identity['request']
            preflight.no_writer(h['database']['path'])
        transition = {'phase':'drained-core-only-transition','oldPid':pid,'oldStartTicks':ticks,'chromePid':args.chrome_pid,'atUnix':time.time(),'sourceCommit':manifest['sourceCommit']}
        if lease is not None and not args.legacy_recovery_handover:
            # The core rechecks the lease synchronously and exits without closing Chrome.
            # EOF is not success until the pinned process is independently gone below.
            model.save(receipt/'handover.json', transition)
            preflight.maintenance_rpc(h, 'system.maintenance.commit', {**preflight.lease_owner(h), 'token': lease['token']}, True)
        else:
            assert transition_mode == 'explicit_legacy', (
                'Current schema must use the Core maintenance commit, not legacy freeze')
            model.save(receipt/'transition-phase.json', {'phase': 'freeze-requested'})
            with legacy_transition.frozen_core(fd, pid, ticks) as commit:
                model.save(receipt/'transition-phase.json', {'phase': 'frozen-guard'})
                # Frozen core cannot race this DB/lock check. Do not issue health RPC.
                legacy_transition.frozen_guard(current, h, ticks, chrome_ticks, args, identity, recovery_handover=args.legacy_recovery_handover)
                model.save(receipt/'handover.json', transition)
                commit()
    except preflight.LockActivityError as error:
        model.save(receipt/'abort-locks.json', error.report)
        raise
    finally:
        os.close(fd)
        if lease is not None and preflight.live(pid):
            try:
                preflight.maintenance_rpc(h, 'system.maintenance.resume', {**preflight.lease_owner(h), 'token': lease['token']})
            except (OSError, RuntimeError) as error:
                # Lost/expired/revoked lease: the bounded core timer still resumes operation.
                model.save(receipt/'maintenance-resume.json', {'result': 'not-confirmed', 'error': str(error),
                    'expiresAt': lease['expiresAt']})
    deadline=time.monotonic()+5
    while preflight.live(pid) and time.monotonic()<deadline: time.sleep(.1)
    assert not preflight.live(pid), 'Old core still live: do not launch duplicate'
    assert preflight.live(args.chrome_pid) and preflight.procstat(args.chrome_pid)[19]==chrome_ticks, 'Browser no longer preserved: stop'
    successor = None
    if schema_change is not None:
        after, successor_pid = cutover.execute_schema_transition(
            h, schema_change, manifest, installed, candidate, stage, receipt,
            args.systemd_unit, args, identity, chrome_ticks, catalog_hash)
    else:
        try:
            bundle.promote_package(installed, candidate, stage, receipt)
            successor = systemd.launch_core(cmd, cwd, runtime_env, receipt, 'successor')
            model.save(receipt/'successor.json', {'pid': successor.pid, 'startedAtUnix': time.time()})
            after = systemd.await_ready(successor)
            successor_pid = successor.pid
        except Exception as error:
            model.save(receipt/'startup-failure.json', {'error': str(error), 'rollback': 'pending'})
            try:
                rollback.rollback_exited(h, pid, successor, chrome_ticks, installed, stage, receipt,
                               cmd, cwd, runtime_env, args, identity)
            except Exception as recovery_error:
                model.save(receipt/'rollback-blocked.json', {'error': str(recovery_error), 'action': 'preserve browser/DB and inspect; do not retry'})
                raise RuntimeError('Handover failed; recovery not confirmed; inspect receipts') from recovery_error
            raise RuntimeError('Handover failed; original core restored; release issuer hold, do not repeat') from error
    assert (after['database'].get('readable') is True or after['database']['integrity']=='ok') and after['database']['path']==h['database']['path']
    expected_schema = schema_change[1] if schema_change is not None else h['database']['schemaVersion']
    assert after['database']['schemaVersion']==expected_schema
    assert after['providers']['enabled']==h['providers']['enabled']
    assert after.get('sourceCommit') == manifest['sourceCommit'] and after.get('sourceTree') == manifest.get('sourceTree')
    assert after.get('sourceState') == 'clean'
    for key in ['browserPid','profileDir','debuggingPort']: assert after['browser'][key]==h['browser'][key]
    assert after['browser']['ownership']=='adopted'
    assert preflight.procstat(args.chrome_pid)[19]==chrome_ticks
    post=preflight.request_identity(after,args)
    assert post['request']==identity['request'] and post['anchor']==identity['anchor']
    assert all(post['requests'].get(k)==v for k,v in identity['requests'].items()), 'Durable request changed'
    preflight.verify_bindings(after, identity['bindings'], post['bindings'])
    locks = systemd.single_core_writer(h['database']['path'], successor_pid)
    model.save(receipt/'after-locks.json', locks)
    model.save(receipt/'after-health.json',after)
    model.save(receipt/'after-identity.json',post)
    result={'sourceCommit':manifest['sourceCommit'],'sourceTree':manifest.get('sourceTree'),
        'packageSha256':manifest['packageSha256'],'oldPid':pid,'newPid':successor_pid,
        'chromePid':args.chrome_pid,'schemaBefore':h['database']['schemaVersion'],
        'schemaAfter':expected_schema,'databaseIntegrity':'ok',
        'requestAndAnchorPreserved':True,'bindingIdentityPreserved':True,
        'browserIdentityPreserved':True,'browserOwnership':'adopted',
        'singleCoreWriterVerified':True,'installedCatalogSha256':catalog_hash,
        'systemdUnit':args.systemd_unit,'liveL3':'pending'}
    model.save(receipt/'result.json', result)
    retention_error = None
    try:
        result['snapshotRetention'] = retention.retain_successful_handover_snapshots(
            receipt, pathlib.Path(h['database']['path']).parent)
    except Exception as error:
        retention_error = error
        result['snapshotRetention'] = {
            'status': 'failed', 'error': str(error),
            'action': 'Inspect old receipts; do not rerun an already-successful cutover',
        }
        model.save(receipt/'snapshot-retention-failure.json', result['snapshotRetention'])
    model.save(receipt/'result.json', result)
    print(json.dumps(result, indent=2))
    if retention_error is not None:
        print('Cutover succeeded but bounded snapshot retention failed; '+
              'do not rerun the cutover: '+str(retention_error), file=sys.stderr)
        raise SystemExit(3)
