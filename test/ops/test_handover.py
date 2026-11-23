"""Offline checks only: never connect to or signal a running SessionPlane core."""
import copy
import hashlib
import importlib.util
import json
import os
import signal
import time
import tarfile
from contextlib import closing
import pathlib
import sqlite3
import subprocess
import sys
import tempfile
import types
import unittest
from unittest.mock import MagicMock, patch

sys.dont_write_bytecode = True

SCRIPT = pathlib.Path(__file__).resolve().parents[2] / 'scripts/ops/handover.py'
OPS_DIR = SCRIPT.parent
if str(OPS_DIR) not in sys.path:
    sys.path.insert(0, str(OPS_DIR))
from sessionplane_handover import (
    model, preflight, legacy_transition, bundle, migration as migration_phase,
    cutover, rollback, retention, systemd,
)

spec = importlib.util.spec_from_file_location('handover', SCRIPT)
handover = importlib.util.module_from_spec(spec)
spec.loader.exec_module(handover)


class HandoverTests(unittest.TestCase):
    def test_late_live_successor_is_collected_until_ready_but_exit_is_failure(self):
        process = MagicMock(pid=33)
        process.poll.return_value = None
        elapsed = [0]
        expected = {'requestOk': True, 'process': {'pid': 33}, 'browser': {'state': 'ready'}}
        def health():
            if elapsed[0] < 98:
                raise subprocess.CalledProcessError(1, 'sessplane health')
            return expected
        with patch.object(handover.time, 'monotonic', side_effect=lambda: elapsed[0]), \
                patch.object(handover.time, 'sleep', side_effect=lambda seconds: elapsed.__setitem__(0, elapsed[0] + seconds)), \
                patch.object(preflight, 'health', side_effect=health):
            self.assertEqual(systemd.await_ready(process), expected)
        self.assertEqual(elapsed[0], 98)
        for result in [dict(expected, process={'pid': 44}), dict(expected, browser={'state': 'error'})]:
            with patch.object(preflight, 'health', return_value=result), self.assertRaises(AssertionError):
                systemd.await_ready(process)
        process.poll.return_value = 1
        with self.assertRaisesRegex(RuntimeError, 'exited'):
            systemd.await_ready(process)
        process.terminate.assert_not_called()
        process.kill.assert_not_called()

    def test_coordinated_drain_renews_short_lease_until_existing_calls_return(self):
        current = {'process': {'pid': 11, 'startedAt': 'original'},
                   'maintenance': {'phase': 'running', 'coordinatedDrain': True}}
        with patch.object(handover.time, 'sleep'), patch.object(preflight, 'health', side_effect=AssertionError('No idle-sample race')), \
                patch.object(preflight, 'maintenance_rpc', side_effect=[
                    {'phase': 'draining', 'token': 'owned'}, {'phase': 'ready', 'token': 'owned'}]) as rpc:
            self.assertEqual(preflight.prepare_maintenance(current)['phase'], 'ready')
            self.assertEqual(rpc.call_args.args[2]['token'], 'owned')
        with patch.object(handover.time, 'sleep', side_effect=KeyboardInterrupt), \
                patch.object(preflight, 'maintenance_rpc', return_value={'phase': 'draining', 'token': 'owned'}) as rpc:
            with self.assertRaises(KeyboardInterrupt): preflight.prepare_maintenance(current)
            self.assertEqual(rpc.call_args.args[1], 'system.maintenance.resume')

    def test_explicit_legacy_recovery_migration_drains_operations_without_waiting_for_generation(self):
        h = {'process': {'pid': 11, 'startedAt': 'original'}, 'maintenance': {'coordinatedDrain': True}}
        with patch.object(handover.time, 'sleep'), patch.object(preflight, 'maintenance_rpc', side_effect=[
                {'phase': 'draining', 'activeOperations': 1, 'token': 'owned'},
                {'phase': 'draining', 'activeOperations': 0, 'token': 'owned'}]) as rpc:
            lease = preflight.prepare_maintenance(h, recovery_handover=True)
            self.assertEqual(lease['phase'], 'draining')
            self.assertEqual(lease['activeOperations'], 0)
            self.assertEqual(rpc.call_count, 2)
            self.assertEqual(rpc.call_args.args[2]['token'], 'owned')

    def test_long_read_finishes_before_fenced_drain_and_busy_or_changed_core_is_preserved(self):
        idle = {'requestOk': True, 'process': {'pid': 11, 'startedAt': 'original'},
                'maintenance': {'phase': 'running', 'activeOperations': 0},
                'metrics': {'session_actor_queue_depth': 0}}
        busy = copy.deepcopy(idle)
        busy['maintenance']['activeOperations'] = 1
        with patch.object(preflight, 'guard'), patch.object(handover.time, 'sleep'), \
                patch.object(preflight, 'health', side_effect=[busy, idle]) as health, \
                patch.object(preflight, 'maintenance_rpc', return_value={'phase': 'ready'}) as prepare:
            self.assertEqual(preflight.prepare_maintenance(idle), {'phase': 'ready'})
            self.assertEqual(health.call_count, 2, 'do not fence while the current read is active')
            prepare.assert_called_once()
        report = {'locks': []}
        with patch.object(preflight, 'guard', side_effect=[preflight.LockActivityError(report), None]), \
                patch.object(preflight, 'health', return_value=idle), patch.object(handover.time, 'sleep'), \
                patch.object(preflight, 'procstat', return_value=['ticks'] * 20), \
                patch.object(preflight, 'drainable_writer', return_value=True) as writer, \
                patch.object(preflight, 'maintenance_rpc', return_value={'phase': 'ready'}) as prepare:
            self.assertEqual(preflight.prepare_maintenance(idle), {'phase': 'ready'})
            writer.assert_called_once_with(report, 11, 'ticks')
            prepare.assert_called_once()
        with patch.object(preflight, 'guard', side_effect=AssertionError('identity changed')), \
                patch.object(preflight, 'health', return_value=idle), \
                patch.object(preflight, 'maintenance_rpc') as prepare:
            with self.assertRaises(AssertionError): preflight.prepare_maintenance(idle)
            prepare.assert_not_called()

    def test_local_candidate_requires_bound_complete_evidence_and_live_fence(self):
        with tempfile.TemporaryDirectory() as directory:
            root = pathlib.Path(directory)
            log = root/'full.log'
            log.write_text('ℹ tests 267\nℹ pass 267\nℹ fail 0\nℹ cancelled 0\nℹ skipped 0\n')
            manifest = {'sourceCommit': 'verified', 'packageSha256': 'package', 'ciConclusion': None}
            report = {'sourceCommit': 'verified', 'packageSha256': 'package', 'typecheck': 'success',
                      'build': 'success', 'passed': 267, 'fullTestLog': str(log),
                      'fullTestLogSha256': handover.hashlib.sha256(log.read_bytes()).hexdigest()}
            receipt = root/'validation.json'
            receipt.write_text(json.dumps(report))
            bundle.validate_candidate(manifest, receipt)
            baseline = {**report, 'fullTestSourceCommit': 'previous'}
            receipt.write_text(json.dumps(baseline))
            with self.assertRaises(AssertionError): bundle.validate_candidate(manifest, receipt)
            baseline.update(focusedTestSourceCommit='verified', focusedTestLog=str(log), focusedPassed=267,
                            focusedTestLogSha256=report['fullTestLogSha256'])
            receipt.write_text(json.dumps(baseline))
            bundle.validate_candidate(manifest, receipt)
            with self.assertRaises(AssertionError): bundle.validate_candidate(manifest, None)
            for key in ['sourceCommit', 'packageSha256', 'build', 'fullTestLogSha256', 'passed']:
                changed = {**report, key: 268 if key == 'passed' else 'different'}
                receipt.write_text(json.dumps(changed))
                with self.subTest(key=key), self.assertRaises(AssertionError):
                    bundle.validate_candidate(manifest, receipt)
            for state in [{}, {'maintenance': {'phase': 'ready'}}, {'maintenance': {'phase': 'draining'}}]:
                with self.assertRaises(AssertionError): preflight.require_admission_fence(state, True)
            preflight.require_admission_fence({'maintenance': {'phase': 'running'}}, True)

    def test_exit_during_proc_stat_read_is_not_a_live_core(self):
        # Linux can open /proc/PID/stat before exit, then return ESRCH on read.
        for error in [FileNotFoundError(2, 'No such file'), ProcessLookupError(3, 'No such process')]:
            with self.subTest(error=type(error).__name__), patch.object(preflight, 'procstat', side_effect=error):
                self.assertFalse(preflight.live(11))
        with patch.object(preflight, 'procstat', side_effect=PermissionError(1, 'Operation not permitted')):
            with self.assertRaises(PermissionError):
                preflight.live(11)

    def test_drain_rejects_new_activity_and_identity_changes(self):
        with tempfile.TemporaryDirectory() as directory:
            pathlib.Path(directory, '.sessionplane-profile.lock').write_text(json.dumps({'pid': 11, 'browserPid': 22}))
            before = {'requestOk': True, 'process': {'pid': 11, 'startedAt': 'original'},
                      'browser': {'state': 'ready', 'browserPid': 22, 'profileDir': directory, 'debuggingPort': 4444},
                      'database': {'integrity': 'ok', 'path': 'unused.sqlite'},
                      'metrics': {'session_actor_queue_depth': 0}}
            db = MagicMock()
            db.__enter__.return_value = db
            db.execute.return_value.fetchone.return_value = (0,)
            with patch.object(preflight, 'read_db', return_value=db), patch.object(preflight, 'no_writer'):
                preflight.guard(before, before)
                busy = copy.deepcopy(before)
                busy['metrics']['session_actor_queue_depth'] = 1
                preflight.guard(busy, before, require_idle=False)  # pre-fence only
                with self.assertRaisesRegex(AssertionError, 'Actor running or queued'):
                    preflight.guard(busy, before)  # still mandatory after draining
                for part, key, value in [('metrics', 'session_actor_queue_depth', 1),
                                         ('process', 'pid', 33), ('process', 'startedAt', 'replacement'),
                                         ('browser', 'browserPid', 44), ('database', 'integrity', 'error'),
                                         ('database', 'path', 'different.sqlite')]:
                    with self.subTest(part=part, key=key):
                        current = copy.deepcopy(before)
                        current[part][key] = value
                        with self.assertRaises(AssertionError):
                            preflight.guard(current, before)
                        if part != 'metrics':
                            with self.assertRaises(AssertionError):
                                preflight.guard(current, before, require_idle=False)
                db.execute.return_value.fetchone.return_value = (1,)
                with self.assertRaisesRegex(AssertionError, 'Active submission'):
                    preflight.guard(before, before)
            db.execute.return_value.fetchone.return_value = (0,)
            with patch.object(preflight, 'read_db', return_value=db), patch.object(preflight, 'no_writer', side_effect=AssertionError('writer')):
                with self.assertRaisesRegex(AssertionError, 'writer'):
                    preflight.guard(before, before)

    def test_opted_in_observation_requires_the_live_cores_durable_recovery_fence(self):
        with tempfile.TemporaryDirectory() as directory:
            pathlib.Path(directory, '.sessionplane-profile.lock').write_text(json.dumps({'pid': 11, 'browserPid': 22}))
            dbpath = pathlib.Path(directory, 'state.sqlite')
            with closing(sqlite3.connect(dbpath)) as db:
                db.executescript("CREATE TABLE outbox(session_id,generation,submission_state,payload_json);"
                                 "CREATE TABLE generations(session_id,generation,completed_at);")
                db.execute("INSERT INTO outbox VALUES('original',1,'submitted',?)", (json.dumps({'thinkingFailureRecovery': True}),))
                db.execute("INSERT INTO generations VALUES('original',1,NULL)"); db.commit()
            h = {'requestOk': True, 'process': {'pid': 11, 'startedAt': 'original'},
                 'browser': {'state': 'ready', 'browserPid': 22, 'profileDir': directory, 'debuggingPort': 4444},
                 'database': {'integrity': 'ok', 'path': str(dbpath)},
                 'metrics': {'session_actor_queue_depth': 0}, 'maintenance': {'durableRecoveryHandover': True}}
            preflight.guard_state(h, h)
            legacy = copy.deepcopy(h)
            legacy['maintenance'].pop('durableRecoveryHandover')
            with self.assertRaisesRegex(AssertionError, 'Legacy core'):
                preflight.guard_state(legacy, legacy)
            preflight.guard_state(legacy, legacy, recovery_handover=True)
            with closing(sqlite3.connect(dbpath)) as db:
                db.execute("UPDATE outbox SET submission_state='submit_attempted'"); db.commit()
            with self.assertRaisesRegex(AssertionError, 'Active submission'):
                preflight.guard_state(h, h)
            with self.assertRaisesRegex(AssertionError, 'Active submission'):
                preflight.guard_state(legacy, legacy, recovery_handover=True)

    def test_target_identity_is_exact_and_read_only(self):
        with tempfile.TemporaryDirectory() as directory:
            path = pathlib.Path(directory, 'fixture.sqlite')
            with closing(sqlite3.connect(path)) as db:
                db.executescript('''
                    CREATE TABLE outbox(outbox_id,session_id,generation,request_hash,prompt_submitted);
                    CREATE TABLE generations(session_id,generation,submitted_user_message_id,submitted_user_turn_id,prompt_hash);
                    CREATE TABLE page_bindings(page_key,session_id,generation,conversation_id,target_id);
                    CREATE TABLE probe_budget(scope,next_allowed_at,blocked_until,backoff_level,consecutive_failures);
                    INSERT INTO outbox VALUES('fixture-request','fixture-session',7,'fixture-hash',1);
                    INSERT INTO generations VALUES('fixture-session',7,'fixture-user','fixture-turn','fixture-prompt-hash');
                ''')
            before = path.read_bytes()
            health = {'database': {'path': str(path)}}
            target = types.SimpleNamespace(request_ref='fixture-request', session_id='fixture-session', generation=7, user_anchor='fixture-user')
            self.assertEqual(preflight.request_identity(health, target)['anchor'][0], 'fixture-user')
            for key, value in [('request_ref', 'foreign-request'), ('session_id', 'foreign-session'), ('generation', 8), ('user_anchor', 'foreign-user')]:
                wrong = copy.copy(target)
                setattr(wrong, key, value)
                with self.subTest(key=key), self.assertRaises(AssertionError):
                    preflight.request_identity(health, wrong)
            with preflight.read_db(health) as db, self.assertRaises(sqlite3.OperationalError):
                db.execute('DELETE FROM outbox')
            self.assertEqual(path.read_bytes(), before)

    def test_admitted_generation_progress_preserves_identity_but_corruption_is_rejected(self):
        with tempfile.TemporaryDirectory() as directory:
            path = pathlib.Path(directory, 'fixture.sqlite')
            with closing(sqlite3.connect(path)) as db:
                db.executescript("""
                    CREATE TABLE outbox(outbox_id,session_id,generation,request_hash,prompt_submitted);
                    CREATE TABLE generations(session_id,generation,submitted_user_message_id,submitted_user_turn_id,prompt_hash);
                    CREATE TABLE page_bindings(page_key,session_id,generation,conversation_id,target_id);
                    CREATE TABLE probe_budget(scope,next_allowed_at,blocked_until,backoff_level,consecutive_failures);
                    INSERT INTO outbox VALUES('original','maetda',16,'original-hash',1);
                    INSERT INTO generations VALUES('maetda',16,'original-ack','original-turn','original-prompt');
                    INSERT INTO outbox VALUES('hither-12','hither',12,'previous-hash',1);
                    INSERT INTO generations VALUES('hither',12,'previous-ack','previous-turn','previous-prompt');
                    INSERT INTO page_bindings VALUES('page','hither',12,'conversation','target');
                """)
            health = {'database': {'path': str(path)}}
            target = types.SimpleNamespace(request_ref='original', session_id='maetda', generation=16, user_anchor='original-ack')
            before = preflight.request_identity(health, target)
            # Baseline precedes staging; an admitted request advances the same
            # page while the helper drains existing calls, as Hither12→13 did.
            with closing(sqlite3.connect(path)) as db:
                db.executescript("""
                    INSERT INTO outbox VALUES('hither-13','hither',13,'next-hash',0);
                    INSERT INTO generations VALUES('hither',13,NULL,NULL,'next-prompt');
                    UPDATE page_bindings SET generation=13 WHERE page_key='page';
                """)
            after = preflight.request_identity(health, target)
            preflight.verify_bindings(health, before['bindings'], after['bindings'])
            alias = ('recovered-page-key', None, None, 'conversation', 'target')
            recovered = ('recovered-page-key', 'hither', 13, 'conversation', 'target')
            preflight.verify_bindings(health, [*after['bindings'], alias], [*after['bindings'], recovered])
            for column, value in [(1, 'other-session'), (2, 14), (3, 'other-conversation'), (4, 'other-target')]:
                changed = list(recovered); changed[column] = value
                with self.subTest(recovered_column=column), self.assertRaises(AssertionError):
                    preflight.verify_bindings(health, [*after['bindings'], alias], [*after['bindings'], changed])
            self.assertEqual(after['request'], before['request'])
            self.assertEqual(after['anchor'], before['anchor'])
            self.assertTrue(all(after['requests'][key] == value for key, value in before['requests'].items()))
            for column, value in [(0, 'other-page'), (1, 'other-session'), (3, 'other-conversation'),
                                  (4, 'other-target'), (2, 11), (2, 14)]:
                changed = list(after['bindings'][0]); changed[column] = value
                with self.subTest(column=column), self.assertRaises(AssertionError):
                    preflight.verify_bindings(health, before['bindings'], [changed])
            with self.assertRaises(AssertionError):
                preflight.verify_bindings(health, before['bindings'], [])
            # An outbox row alone cannot justify skipping the generation record.
            with closing(sqlite3.connect(path)) as db:
                db.execute("INSERT INTO outbox VALUES('hither-14','hither',14,'unverified',0)")
                db.commit()
            changed = list(after['bindings'][0]); changed[2] = 14
            with self.assertRaisesRegex(AssertionError, 'no durable request'):
                preflight.verify_bindings(health, before['bindings'], [changed])
            with closing(sqlite3.connect(path)) as db:
                db.execute("INSERT INTO generations VALUES('hither',14,NULL,NULL,'next-prompt')")
                db.commit()
            advanced = list(recovered); advanced[2] = 14
            preflight.verify_bindings(health, [*after['bindings'], alias], [*after['bindings'], advanced])

    def test_optimized_python_cannot_disable_guards(self):
        result = subprocess.run([sys.executable, '-O', str(SCRIPT), '--help'], capture_output=True, text=True)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('disables safety assertions', result.stderr)


    def test_current_schema_cannot_select_or_fall_back_to_legacy_freeze(self):
        original = {'database': {'schemaVersion': 16},
                    'maintenance': {'coordinatedDrain': True,
                                    'phase': 'running',
                                    'durableRecoveryHandover': True}}
        self.assertEqual(preflight.verify_transition_mode(original, True, False, True),
                         'core_maintenance')
        with self.assertRaisesRegex(AssertionError, 'pre-v16'):
            preflight.verify_transition_mode(original, True, True, True)
        with self.assertRaisesRegex(AssertionError, 'maintenance fence'):
            preflight.verify_transition_mode(original, False, False, True)
        without = {**original, 'maintenance': {'phase': 'running',
                                               'coordinatedDrain': False}}
        with self.assertRaisesRegex(AssertionError, 'no legacy fallback'):
            preflight.verify_transition_mode(without, True, False, True)
        historical = {'database': {'schemaVersion': 15},
                      'maintenance': {'coordinatedDrain': True,
                                      'phase': 'running',
                                      'durableRecoveryHandover': False}}
        self.assertEqual(preflight.verify_transition_mode(historical, True, True, True),
                         'explicit_legacy')
        with self.assertRaisesRegex(AssertionError, 'old Core'):
            preflight.verify_transition_mode({**historical, 'maintenance': without['maintenance']}, True, True, True)
        self.assertEqual(preflight.verify_transition_mode(original, False, False, False),
                         'read_only_preflight')

    def test_apply_without_quiesce_stops_before_host_or_package_access(self):
        result = subprocess.run([sys.executable, str(SCRIPT), '--apply',
                                 '--bundle-dir', '/unused-handover-fixture',
                                 '--expected-host', 'fixture-host', '--expected-user', 'fixture-user',
                                 '--expected-cwd', '/unused', '--core-pid', '11', '--chrome-pid', '22',
                                 '--request-ref', 'fixture-request', '--session-id', 'fixture-session',
                                 '--generation', '7', '--user-anchor', 'fixture-user'],
                                capture_output=True, text=True)
        self.assertEqual(result.returncode, 2)
        self.assertIn('requires supervisor-coordinated --issuers-quiesced', result.stderr)

    def test_writer_lock_for_exact_db_inode_is_rejected(self):
        with tempfile.TemporaryDirectory() as directory:
            path = pathlib.Path(directory, 'fixture.sqlite')
            path.touch()
            stat = path.stat()
            inode = f'{os.major(stat.st_dev):02x}:{os.minor(stat.st_dev):02x}:{stat.st_ino}'
            with patch.object(pathlib.Path, 'read_text', return_value=f'1: POSIX ADVISORY READ 11 {inode} 0 1'):
                preflight.no_writer(str(path))
            with patch.object(pathlib.Path, 'read_text', return_value=f'1: POSIX ADVISORY WRITE 11 {inode} 0 1'):
                with self.assertRaises(preflight.LockActivityError) as error:
                    preflight.no_writer(str(path))
                self.assertEqual(error.exception.report['locks'][0]['mode'], 'WRITE')
                self.assertEqual(error.exception.report['locks'][0]['inode'], stat.st_ino)

    @unittest.skipUnless(sys.platform.startswith('linux'), 'Linux /proc lock evidence')
    def test_real_wal_reader_and_writer_and_read_connection_lifetime(self):
        with tempfile.TemporaryDirectory() as directory:
            path = pathlib.Path(directory, 'fixture.sqlite')
            with closing(sqlite3.connect(path)) as owner:
                owner.execute('PRAGMA journal_mode=WAL')
                owner.execute('CREATE TABLE fixture(value)')
                owner.commit()
                preflight.no_writer(str(path))
                with preflight.read_db({'database': {'path': str(path)}}) as reader:
                    reader.execute('BEGIN')
                    reader.execute('SELECT * FROM fixture').fetchall()
                    preflight.no_writer(str(path))
                with self.assertRaises(sqlite3.ProgrammingError):
                    reader.execute('SELECT 1')
                owner.execute('BEGIN IMMEDIATE')
                with self.assertRaises(preflight.LockActivityError) as error:
                    preflight.no_writer(str(path))
                writer = next(r for r in error.exception.report['locks'] if r['classification'] == 'wal-writer')
                self.assertEqual(writer['holder']['pid'], os.getpid())
                self.assertEqual((writer['start'], writer['end']), ('120', '120'))
                self.assertEqual(writer['suffix'], '-shm')
                owner.rollback()
                preflight.no_writer(str(path))

    def test_wal_management_write_is_distinguished_but_not_ignored(self):
        with tempfile.TemporaryDirectory() as directory:
            db = pathlib.Path(directory, 'fixture.sqlite')
            shm = pathlib.Path(str(db) + '-shm')
            shm.touch()
            stat = shm.stat()
            inode = f'{os.major(stat.st_dev):02x}:{os.minor(stat.st_dev):02x}:{stat.st_ino}'
            for offset, kind in [(120, 'wal-writer'), (121, 'wal-checkpoint'), (122, 'wal-recovery'),
                                 (124, 'wal-read-mark-exclusive'), (128, 'wal-shm-initialization')]:
                raw = f'1: POSIX ADVISORY WRITE -1 {inode} {offset} {offset}'
                with self.subTest(offset=offset), patch.object(pathlib.Path, 'read_text', return_value=raw):
                    with self.assertRaises(preflight.LockActivityError) as error:
                        preflight.no_writer(str(db))
                    row = error.exception.report['locks'][0]
                    self.assertEqual(row['classification'], kind)
                    self.assertEqual(row['raw'], raw)
                    self.assertTrue(row['blocksHandover'])

    def test_staging_and_failed_final_guard_leave_live_install_unchanged(self):
        with tempfile.TemporaryDirectory() as directory:
            root = pathlib.Path(directory)
            installed = root/'sessionplane'
            installed.mkdir()
            (installed/'marker').write_text('running-old')
            receipt = root/'receipt'
            receipt.mkdir()
            def install(command, **unused):
                prefix = pathlib.Path(command[command.index('--prefix') + 1])
                self.assertNotEqual(prefix, installed.parent)
                target = prefix/'lib/node_modules/sessionplane'
                target.mkdir(parents=True)
                (target/'marker').write_text('new')
            with patch.object(handover.subprocess, 'run', side_effect=install), patch.object(bundle, 'verify_package', return_value='catalog'):
                stage, candidate, _ = bundle.stage_package(installed, root/'package.tgz', {}, receipt)
            # The actual final guard can abort here without touching the live path.
            with self.assertRaises(preflight.LockActivityError):
                with patch.object(preflight, 'lock_report', return_value={'locks': [{'blocksHandover': True}]}):
                    preflight.no_writer('fixture')
            self.assertEqual((installed/'marker').read_text(), 'running-old')
            self.assertEqual((candidate/'marker').read_text(), 'new')
            self.assertFalse((receipt/'promotion.json').exists())
            bundle.promote_package(installed, candidate, stage, receipt)
            self.assertEqual((installed/'marker').read_text(), 'new')
            self.assertEqual((stage/'previous-install/marker').read_text(), 'running-old')

    def test_failed_promotion_restores_original_files(self):
        with tempfile.TemporaryDirectory() as directory:
            root = pathlib.Path(directory)
            installed, stage, candidate, receipt = (root/n for n in ['live', 'stage', 'candidate', 'receipt'])
            for p in [installed, stage, candidate, receipt]: p.mkdir()
            (installed/'marker').write_text('old')
            (candidate/'marker').write_text('new')
            rename = pathlib.Path.rename
            def fail_candidate(path, target):
                if path == candidate: raise OSError('fixture promotion failure')
                return rename(path, target)
            with patch.object(pathlib.Path, 'rename', fail_candidate), self.assertRaises(OSError):
                bundle.promote_package(installed, candidate, stage, receipt)
            self.assertEqual((installed/'marker').read_text(), 'old')
            self.assertEqual((candidate/'marker').read_text(), 'new')

    def test_resume_requires_same_live_core_and_no_prior_signal_receipt(self):
        with tempfile.TemporaryDirectory() as directory:
            prior = pathlib.Path(directory)
            health = {'process': {'pid': 11, 'startedAt': 'original'},
                      'browser': {'browserPid': 22, 'profileDir': 'fixture-profile', 'debuggingPort': 4444}}
            (prior/'before-health.json').write_text(json.dumps(health))
            for name in ['previous-install.tgz', 'predeploy.sqlite']: (prior/name).touch()
            identity = {'request': ['fixture-request-hash'], 'anchor': ['fixture-user']}
            (prior/'before-identity.json').write_text(json.dumps(identity))
            with patch.object(bundle, 'verify_package') as verify, patch.object(preflight, 'request_identity', return_value=identity):
                cutover.verify_pre_signal_resume(prior, health, prior/'installed', prior/'package', {}, None)
                verify.assert_called_once()
                wrong = copy.deepcopy(health)
                wrong['process']['startedAt'] = 'new-core'
                with self.assertRaisesRegex(AssertionError, 'lifetime'):
                    cutover.verify_pre_signal_resume(prior, wrong, prior/'installed', prior/'package', {}, None)
                (prior/'handover.json').write_text('{}')
                with self.assertRaisesRegex(AssertionError, 'may have occurred'):
                    cutover.verify_pre_signal_resume(prior, health, prior/'installed', prior/'package', {}, None)

    def test_staged_only_abort_cannot_use_legacy_installed_resume(self):
        with tempfile.TemporaryDirectory() as directory:
            prior = pathlib.Path(directory)
            (prior/'staging.json').write_text('{}')
            with patch.object(bundle, 'verify_package') as verify:
                with self.assertRaisesRegex(AssertionError, 'Staging-only abort'):
                    cutover.verify_pre_signal_resume(prior, {}, prior/'live', prior/'pkg', {}, None)
                verify.assert_not_called()

    def test_maintenance_transport_accepts_eof_only_for_commit_and_never_masks_refusal(self):
        h = {'socket': {'path': '/fixture/socket'}}
        channel = MagicMock()
        channel.__enter__.return_value = channel
        with patch.object(handover.socket, 'socket', return_value=channel):
            channel.recv.return_value = b''
            with self.assertRaisesRegex(RuntimeError, 'response missing'):
                preflight.maintenance_rpc(h, 'system.maintenance.prepare', {})
            self.assertIsNone(preflight.maintenance_rpc(h, 'system.maintenance.commit', {}, True))
            channel.recv.side_effect = ConnectionResetError('core exited')
            self.assertIsNone(preflight.maintenance_rpc(h, 'system.maintenance.commit', {}, True))
            channel.recv.side_effect = None
            channel.recv.return_value = b'{"error":{"message":"readiness changed"}}\n'
            with self.assertRaisesRegex(RuntimeError, 'Maintenance refused'):
                preflight.maintenance_rpc(h, 'system.maintenance.commit', {}, True)

    def test_legacy_freeze_commit_abort_expiry_and_parent_loss(self):
        # Only fixture children are signalled. An unrelated browser sentinel survives.
        browser = subprocess.Popen([sys.executable, '-c', 'import time; time.sleep(30)'])
        try:
            for mode in ['commit', 'abort', 'expiry', 'parent-loss', 'wrong-lifetime']:
                with self.subTest(mode=mode):
                    core = subprocess.Popen([sys.executable, '-c', 'import time; time.sleep(30)'])
                    fd = os.pidfd_open(core.pid)
                    ticks = preflight.procstat(core.pid)[19]
                    try:
                        if mode == 'wrong-lifetime':
                            with self.assertRaisesRegex(AssertionError, 'freeze failed'):
                                with legacy_transition.frozen_core(fd, core.pid, 'not-the-start-ticks'): pass
                        elif mode == 'parent-loss':
                            controller = os.fork()
                            if controller == 0:
                                with legacy_transition.frozen_core(fd, core.pid, ticks, timeout=1):
                                    os._exit(0)  # Guardian gets EOF, even without finally.
                            os.waitpid(controller, 0)
                            deadline = time.monotonic() + 2
                            while preflight.procstat(core.pid)[0] in ('T', 't') and time.monotonic() < deadline:
                                time.sleep(.01)
                        else:
                            with legacy_transition.frozen_core(fd, core.pid, ticks, timeout=.3) as commit:
                                self.assertEqual(preflight.procstat(core.pid)[0], 'T')
                                self.assertIsNone(browser.poll())
                                if mode == 'commit': commit()
                                if mode == 'expiry':
                                    time.sleep(.4)
                                    with self.assertRaises((AssertionError, OSError)): commit()
                        if mode == 'commit':
                            self.assertEqual(core.wait(timeout=2), -signal.SIGKILL)
                        else:
                            self.assertIsNone(core.poll())
                            self.assertNotIn(preflight.procstat(core.pid)[0], ('T', 't'))
                        self.assertIsNone(browser.poll())
                    finally:
                        os.close(fd)
                        if core.poll() is None: core.terminate()
                        core.wait(timeout=2)
        finally:
            browser.terminate(); browser.wait(timeout=2)

    def test_freeze_rejects_writer_and_resumes_same_core_without_db_change(self):
        with tempfile.TemporaryDirectory() as directory:
            dbpath = pathlib.Path(directory)/'fixture.sqlite'
            worker = subprocess.Popen([sys.executable, '-u', '-c',
                "import sqlite3,sys,time; d=sqlite3.connect(sys.argv[1]); d.execute('PRAGMA journal_mode=WAL'); d.execute('CREATE TABLE x(v)'); d.commit(); d.execute('BEGIN IMMEDIATE'); print('ready',flush=True); time.sleep(30)", str(dbpath)], stdout=subprocess.PIPE, text=True)
            try:
                self.assertEqual(worker.stdout.readline().strip(), 'ready')
                fd = os.pidfd_open(worker.pid)
                try:
                    with self.assertRaises(preflight.LockActivityError):
                        with legacy_transition.frozen_core(fd, worker.pid, preflight.procstat(worker.pid)[19]):
                            preflight.no_writer(str(dbpath))
                    self.assertIsNone(worker.poll())
                    self.assertNotIn(preflight.procstat(worker.pid)[0], ('T', 't'))
                finally: os.close(fd)
            finally:
                worker.terminate(); worker.wait(timeout=2); worker.stdout.close()
            with closing(sqlite3.connect(dbpath)) as db:
                self.assertEqual(db.execute('SELECT count(*) FROM x').fetchone()[0], 0)
                self.assertEqual(db.execute('PRAGMA integrity_check').fetchone()[0], 'ok')

    def test_staged_reentry_preserves_prior_receipt_and_rejects_changes(self):
        with tempfile.TemporaryDirectory() as directory:
            root = pathlib.Path(directory)
            installed, prior, candidate = (root/n for n in ['sessionplane', 'prior', 'candidate'])
            for p in [installed, prior, candidate]: p.mkdir()
            (installed/'marker').write_text('old')
            with tarfile.open(prior/'previous-install.tgz', 'w:gz') as archive:
                archive.add(installed, arcname='sessionplane')
            h = {'process': {'pid': 11, 'startedAt': 'original'}, 'browser': {'browserPid': 22, 'profileDir': 'p', 'debuggingPort': 44}}
            identity = {'request': ['same'], 'anchor': ['original']}
            for name, value in [('before-health', h), ('before-identity', identity), ('staging', {'installed': str(installed), 'candidate': str(candidate)})]:
                (prior/(name+'.json')).write_text(json.dumps(value))
            (prior/'predeploy.sqlite').touch()
            before = {p.name:p.read_bytes() for p in prior.iterdir()}
            with patch.object(preflight, 'request_identity', return_value=identity):
                cutover.verify_staged_resume(prior, h, installed, None)
                self.assertEqual(before, {p.name:p.read_bytes() for p in prior.iterdir()})
                (installed/'marker').write_text('mixed')
                with self.assertRaisesRegex(AssertionError, 'installation changed'):
                    cutover.verify_staged_resume(prior, h, installed, None)
                (installed/'marker').write_text('old')
                (prior/'handover.json').write_text('{}')
                with self.assertRaisesRegex(AssertionError, 'ambiguous'):
                    cutover.verify_staged_resume(prior, h, installed, None)
                (prior/'handover.json').write_text(json.dumps({'oldPid': 11, 'oldStartTicks': 'original-ticks'}))
                h['maintenance'] = {'phase': 'running'}
                with patch.object(preflight, 'procstat', return_value=[''] * 19 + ['original-ticks']):
                    cutover.verify_staged_resume(prior, h, installed, None)
                    h['maintenance']['phase'] = 'ready'
                    with self.assertRaisesRegex(AssertionError, 'lease is still active'):
                        cutover.verify_staged_resume(prior, h, installed, None)
                    h['maintenance']['phase'] = 'running'
                    (prior/'promotion.json').write_text('{}')
                    with self.assertRaisesRegex(AssertionError, 'ambiguous'):
                        cutover.verify_staged_resume(prior, h, installed, None)
                (prior/'promotion.json').unlink()
                with patch.object(preflight, 'procstat', return_value=[''] * 19 + ['reused-pid']):
                    with self.assertRaisesRegex(AssertionError, 'lifetime unverified'):
                        cutover.verify_staged_resume(prior, h, installed, None)

    def test_post_exit_rollback_preserves_db_and_refuses_live_successor(self):
        with tempfile.TemporaryDirectory() as directory:
            root = pathlib.Path(directory)
            installed, stage, receipt, profile = (root/n for n in ['live', 'stage', 'receipt', 'profile'])
            for p in [installed, stage, receipt, profile]: p.mkdir()
            previous = stage/'previous-install'; previous.mkdir()
            (previous/'marker').write_text('old'); (installed/'marker').write_text('candidate')
            dbpath = root/'db'
            with closing(sqlite3.connect(dbpath)) as db:
                db.executescript("""
                    CREATE TABLE outbox(outbox_id,session_id,generation,request_hash,prompt_submitted);
                    CREATE TABLE generations(session_id,generation,submitted_user_message_id,submitted_user_turn_id,prompt_hash);
                    CREATE TABLE page_bindings(page_key,session_id,generation,conversation_id,target_id);
                    CREATE TABLE probe_budget(scope,next_allowed_at,blocked_until,backoff_level,consecutive_failures);
                    CREATE TABLE schema_migrations(version);
                    INSERT INTO schema_migrations VALUES(1);
                    INSERT INTO outbox VALUES('r','s',7,'hash',1);
                    INSERT INTO outbox VALUES('unknown','s',8,'unknown-hash',0);
                    INSERT INTO generations VALUES('s',7,'a','turn','prompt-hash');
                    INSERT INTO page_bindings VALUES('page','s',7,'chat','target');
                """)
            dbbytes = dbpath.read_bytes()
            browser = subprocess.Popen([sys.executable,'-c','import time; time.sleep(30)'])
            old = subprocess.Popen([sys.executable,'-c','pass']); old.wait()
            successor = subprocess.Popen([sys.executable,'-c','import time; time.sleep(30)'])
            restored_pid = None
            restored_process = None
            try:
                (profile/'.sessionplane-profile.lock').write_text(json.dumps({'pid':old.pid, 'browserPid':browser.pid}))
                h = {'database': {'path':str(dbpath), 'integrity':'ok', 'schemaVersion':1},
                     'browser': {'browserPid':browser.pid, 'profileDir':str(profile), 'debuggingPort':44, 'ownership':'adopted'}}
                target = types.SimpleNamespace(request_ref='r',session_id='s',generation=7,user_anchor='a')
                identity = preflight.request_identity(h,target)
                def healthy_fixture():
                    result = copy.deepcopy(h)
                    result['requestOk'] = True; result['browser']['state'] = 'ready'
                    result['process'] = {'pid':json.loads((receipt/'rollback-core.json').read_text())['pid']}
                    return result
                with patch.object(preflight, 'health', side_effect=healthy_fixture):
                    args=(h,old.pid,successor,preflight.procstat(browser.pid)[19],installed,stage,receipt,
                          [sys.executable,'-c','import time; time.sleep(30)'],directory,dict(os.environ),target,identity)
                    with self.assertRaisesRegex(AssertionError,'Live successor'): rollback.rollback_exited(*args)
                    self.assertFalse((receipt/'rollback-core.json').exists())
                    self.assertEqual((installed/'marker').read_text(),'candidate')
                    successor.terminate(); successor.wait(timeout=2)
                    restored_process = rollback.rollback_exited(*args)
                    restored_pid = json.loads((receipt/'rollback-core.json').read_text())['pid']
                    self.assertTrue(preflight.live(restored_pid))
                    self.assertEqual((installed/'marker').read_text(),'old')
                    self.assertEqual((stage/'failed-candidate/marker').read_text(),'candidate')
                    self.assertEqual(dbpath.read_bytes(),dbbytes)
                    self.assertEqual(preflight.request_identity(h,target),identity)
                    self.assertIsNone(browser.poll())
                    self.assertEqual(json.loads((receipt/'rollback.json').read_text())['phase'],'original-core-restored')
            finally:
                if (receipt/'rollback-core.json').exists():
                    restored_pid = json.loads((receipt/'rollback-core.json').read_text())['pid']
                    if preflight.live(restored_pid): os.kill(restored_pid,signal.SIGTERM)
                    if restored_process is not None: restored_process.wait(timeout=2)
                    else: os.waitpid(restored_pid,0)
                if successor.poll() is None: successor.terminate()
                successor.wait(timeout=2)
                browser.terminate(); browser.wait(timeout=2)

    def test_recurring_writer_drains_after_live_checks_and_frozen_guards_decide(self):
        # Deterministic interleaving of a background observer's short WAL writes
        # with slow live health. Health does not cause production DB writes.
        for mode in ['success', 'raced-writer', 'submit', 'request', 'owner', 'chrome', 'exception', 'expiry', 'parent-loss']:
            with self.subTest(mode=mode), tempfile.TemporaryDirectory() as directory:
                root=pathlib.Path(directory); dbpath=root/'fixture.sqlite'
                with closing(sqlite3.connect(dbpath)) as db:
                    db.executescript("""
                        PRAGMA journal_mode=WAL;
                        CREATE TABLE outbox(outbox_id,session_id,generation,request_hash,prompt_submitted,submission_state,payload_json);
                        CREATE TABLE generations(session_id,generation,submitted_user_message_id,submitted_user_turn_id,prompt_hash,completed_at);
                        CREATE TABLE page_bindings(page_key,session_id,generation,conversation_id,target_id);
                        CREATE TABLE probe_budget(scope,next_allowed_at,blocked_until,backoff_level,consecutive_failures);
                        CREATE TABLE observer_tick(n);
                        INSERT INTO observer_tick VALUES(0);
                        INSERT INTO generations VALUES('fixture-session',7,'fixture-user','fixture-turn','fixture-prompt-hash',NULL);
                        INSERT INTO page_bindings VALUES('fixture-page','fixture-session',7,'fixture-conversation','fixture-target');
                    """)
                    db.executemany('INSERT INTO outbox VALUES(?,?,?,?,?,?,?)',
                        [(f'request-{i}','fixture-session',7,f'hash-{i}',1,'submission_unknown' if i<4 else 'submitted','{}') for i in range(878)])
                    db.commit()
                worker=subprocess.Popen([sys.executable,'-u','-c',
                    "import sqlite3,sys; d=sqlite3.connect(sys.argv[1]); print('ready',flush=True)\nfor line in sys.stdin:\n d.commit()\n if line.strip()=='write':\n  d.execute('BEGIN IMMEDIATE'); d.execute('UPDATE observer_tick SET n=n+1')\n print('ack',flush=True)",str(dbpath)],stdin=subprocess.PIPE,stdout=subprocess.PIPE,text=True)
                browser=subprocess.Popen([sys.executable,'-c','import time; time.sleep(30)'])
                fd=os.pidfd_open(worker.pid)
                def command(text):
                    worker.stdin.write(text+'\n');worker.stdin.flush()
                    self.assertEqual(worker.stdout.readline().strip(),'ack')
                try:
                    self.assertEqual(worker.stdout.readline().strip(),'ready')
                    ticks=preflight.procstat(worker.pid)[19]; chrome_ticks=preflight.procstat(browser.pid)[19]
                    profile=root/'.sessionplane-profile.lock'
                    profile.write_text(json.dumps({'pid':worker.pid,'browserPid':browser.pid}))
                    h={'requestOk':True,'process':{'pid':worker.pid,'startedAt':'fixture'},
                       'browser':{'state':'ready','browserPid':browser.pid,'profileDir':str(root),'debuggingPort':4444},
                       'database':{'path':str(dbpath),'integrity':'ok'},'metrics':{'session_actor_queue_depth':0}}
                    target=types.SimpleNamespace(request_ref='request-0',session_id='fixture-session',generation=7,user_anchor='fixture-user')
                    identity=preflight.request_identity(h,target); calls=[]
                    real_sleep=time.sleep
                    def health(timeout):
                        real_sleep(.02)
                        command('write'); calls.append('health-with-writer')
                        return h
                    def drain(seconds):
                        command('quiet'); calls.append('quiet')
                    with patch.object(preflight, 'health',side_effect=health), patch.object(handover.time,'sleep',side_effect=drain):
                        current=legacy_transition.prefreeze_drain(h,ticks,chrome_ticks,target,identity,root)
                    self.assertEqual(calls,['health-with-writer']*2+['quiet'])
                    samples=json.loads((root/'writer-drain.json').read_text())['samples']
                    for sample in samples[:2]:
                        self.assertTrue(any(row['classification']=='wal-writer' for row in sample['locks']))
                    self.assertEqual(samples[-1]['phase'],'quiet-observed')
                    if mode=='raced-writer': command('write')
                    if mode in ['submit','request']:
                        with closing(sqlite3.connect(dbpath)) as db:
                            db.execute("UPDATE outbox SET "+("submission_state='submit_attempted'" if mode=='submit' else "request_hash='changed'")+" WHERE outbox_id='request-0'");db.commit()
                    if mode=='owner': profile.write_text(json.dumps({'pid':0,'browserPid':browser.pid}))
                    if mode=='chrome': chrome_ticks='wrong-lifetime'
                    with patch.object(preflight, 'health',side_effect=AssertionError('No health after quiet')):
                        if mode=='parent-loss':
                            controller=os.fork()
                            if controller==0:
                                with legacy_transition.frozen_core(fd,worker.pid,ticks,timeout=1): os._exit(0)
                            os.waitpid(controller,0)
                            deadline=time.monotonic()+2
                            while preflight.procstat(worker.pid)[0] in ('T','t') and time.monotonic()<deadline: time.sleep(.01)
                            self.assertIsNone(worker.poll())
                            self.assertNotIn(preflight.procstat(worker.pid)[0],('T','t'))
                        elif mode=='success':
                            with legacy_transition.frozen_core(fd,worker.pid,ticks) as commit:
                                legacy_transition.frozen_guard(current,h,ticks,chrome_ticks,target,identity)
                                commit()
                            self.assertEqual(worker.wait(timeout=2),-signal.SIGKILL)
                        else:
                            with self.assertRaises(AssertionError):
                                with legacy_transition.frozen_core(fd,worker.pid,ticks,timeout=.2 if mode=='expiry' else 10) as commit:
                                    legacy_transition.frozen_guard(current,h,ticks,chrome_ticks,target,identity)
                                    if mode=='exception': raise AssertionError('injected parent failure')
                                    if mode=='expiry': time.sleep(.3)
                                    commit()
                            self.assertIsNone(worker.poll())
                            self.assertNotIn(preflight.procstat(worker.pid)[0],('T','t'))
                            if mode=='raced-writer': command('quiet')
                    self.assertIsNone(browser.poll())
                    with closing(sqlite3.connect(dbpath)) as db:
                        self.assertEqual(db.execute('PRAGMA integrity_check').fetchone()[0],'ok')
                        self.assertEqual(db.execute('SELECT count(*) FROM outbox').fetchone()[0],878)
                        if mode not in ['submit','request']:
                            self.assertEqual(db.execute("SELECT count(*) FROM outbox WHERE submission_state='submission_unknown'").fetchone()[0],4)
                            post=preflight.request_identity(h,target)
                            for key in ['requests','bindings','request','anchor']: self.assertEqual(post[key],identity[key])
                finally:
                    os.close(fd)
                    if worker.poll() is None: worker.terminate()
                    worker.wait(timeout=2);worker.stdin.close();worker.stdout.close()
                    browser.terminate();browser.wait(timeout=2)

    def test_prefreeze_rejects_non_drainable_locks_and_changed_live_invariants(self):
        with tempfile.TemporaryDirectory() as directory:
            root=pathlib.Path(directory)
            h={'process':{'pid':11},'browser':{'browserPid':22},'database':{'path':'fixture'}}
            identity={'request':['original']}
            for mode in ['foreign','unknown','checkpoint','recovery','exclusive','range','actor','submit','request','pid','chrome','persistent','slow-health']:
                with self.subTest(mode=mode):
                    row={'blocksHandover':True,'classification':'wal-writer','start':'120','end':'120','holder':{'pid':11,'startTicks':'ticks'}}
                    if mode=='range': row['end']='121'
                    if mode=='foreign': row['holder']['pid']=99
                    if mode=='unknown': row['holder']['startTicks']=None
                    if mode in ['checkpoint','recovery','exclusive']: row['classification']='wal-'+mode
                    clock=[0.0]
                    def sleep(seconds): clock[0]+=seconds
                    def stat(pid): return ['S']*19+['changed' if (mode=='pid' and pid==11) or (mode=='chrome' and pid==22) else 'ticks']
                    def check(*args):
                        if mode in ['actor','submit']: raise AssertionError('Active work')
                    def health(timeout):
                        if mode=='slow-health':
                            clock[0]+=timeout
                            raise subprocess.TimeoutExpired('health',timeout)
                        return h
                    with patch.object(handover.time,'monotonic',side_effect=lambda:clock[0]), patch.object(handover.time,'sleep',side_effect=sleep), patch.object(preflight, 'procstat',side_effect=stat), patch.object(preflight, 'live',return_value=True), patch.object(preflight, 'health',side_effect=health), patch.object(preflight, 'guard_state',side_effect=check), patch.object(preflight, 'request_identity',return_value={'request':['changed']} if mode=='request' else identity), patch.object(preflight, 'lock_report',return_value={'locks':[row]}), patch.object(handover.signal,'pidfd_send_signal') as signal_call:
                        with self.assertRaises((AssertionError,subprocess.TimeoutExpired)):
                            legacy_transition.prefreeze_drain(h,'ticks','ticks',None,identity,root,timeout=.25)
                        signal_call.assert_not_called()
                        self.assertLessEqual(clock[0],.25)
                        if mode not in ['persistent','slow-health']: self.assertEqual(clock[0],0)


    def test_candidate_acceptance_v1_binds_commit_tree_package_and_all_required_gates(self):
        with tempfile.TemporaryDirectory() as directory:
            receipt = pathlib.Path(directory)/'acceptance.json'
            names = ['typecheck', 'public-core-ci', 'chromium-composition',
                     'four-background-tabs', 'browser-transport-comparison',
                     'semantic-adapter', 'clean-build', 'installed-tarball-core']
            manifest = {'sourceCommit': 'a'*40, 'sourceTree': 'b'*40,
                        'packageSha256': 'c'*64, 'requiredGates': names,
                        'schemaTransition': {'from': 8, 'to': 15}}
            report = {'contract': 'sessionplane-candidate-acceptance-v1',
                'source': {'head': 'a'*40, 'tree': 'b'*40,
                    'currentHead': 'a'*40, 'currentTree': 'b'*40,
                    'currentWorktreeClean': True, 'buildMatchesCleanHead': True,
                    'sourceIssues': []},
                'externalPackageSha256': 'c'*64, 'candidateL1L2L4Passed': True,
                'gates': [{'name': name, 'passed': True, 'exitCode': 0,
                           'assertionsFailed': 0, 'skipped': 0} for name in names]}
            receipt.write_text(json.dumps(report))
            bundle.validate_candidate(manifest, receipt)
            for mutate in ['package', 'tree', 'gate']:
                changed = copy.deepcopy(report)
                if mutate == 'package': changed['externalPackageSha256'] = 'd'*64
                elif mutate == 'tree': changed['source']['currentTree'] = 'd'*40
                else: changed['gates'][2]['passed'] = False
                receipt.write_text(json.dumps(changed))
                with self.subTest(mutate=mutate), self.assertRaises(AssertionError):
                    bundle.validate_candidate(manifest, receipt)

    def test_bundle_rejects_policy_not_matching_compiled_candidate_schema(self):
        with tempfile.TemporaryDirectory() as directory:
            installed = pathlib.Path(directory)
            migrations = installed/'dist/storage/migrations'
            migrations.mkdir(parents=True)
            (installed/'package.json').write_text('{"type":"module"}')
            (migrations/'index.js').write_text(
                'export const migrations = Array.from({length:16},(_,i)=>({version:i+1}));')
            policy = {'schemaTransition': {'from': 15, 'to': 16}}
            self.assertEqual(bundle.verify_candidate_schema(installed, policy), 16)
            for bad in [
                {'schemaTransition': {'from': 8, 'to': 15}},
                {'schemaTransition': {'from': 15, 'to': 17}},
            ]:
                with self.subTest(bad=bad), self.assertRaisesRegex(
                        AssertionError, 'Candidate migration schema differs from handover policy'):
                    bundle.verify_candidate_schema(installed, bad)
            (migrations/'index.js').write_text(
                'export const migrations = Array.from({length:15},(_,i)=>({version:i+1}));')
            with self.assertRaisesRegex(
                    AssertionError, 'Candidate migration schema differs from handover policy'):
                bundle.verify_candidate_schema(installed, policy)

    def test_checked_in_policy_requires_current_16_to_17_upgrade_and_no_old_schema(self):
        root = pathlib.Path(__file__).resolve().parents[2]
        policy = json.loads((root/'scripts/ops/handover-manifest.json').read_text())
        transition = policy['schemaTransition']
        current_migration = max(int(path.name[:4]) for path in
                                (root/'src/storage/migrations').glob('[0-9][0-9][0-9][0-9]-*.ts'))
        self.assertEqual(transition, {'from': 16, 'to': 17},
                         'A schema-15-to-16 handover policy cannot deploy schema-17 dev code')
        self.assertEqual(transition['to'], current_migration,
                         'Bundle policy must never authorize an obsolete SQLite schema')
        self.assertEqual(bundle.schema_transition(policy, 16), (16, 17))
        for obsolete in [8, 14, 15]:
            with self.subTest(obsolete=obsolete), self.assertRaisesRegex(
                    AssertionError, 'Live schema differs from transition source'):
                bundle.schema_transition(policy, obsolete)

    def test_synthetic_15_to_16_promotion_preserves_source_and_archives_wal(self):
        with tempfile.TemporaryDirectory() as directory:
            root = pathlib.Path(directory)
            live = root/'sessionplane.sqlite'
            migration = root/'migration'; migration.mkdir()
            receipt = root/'receipt'; receipt.mkdir()
            original = migration/'source-snapshot.sqlite'
            candidate = migration/'candidate.sqlite'

            def make(path, schema, marker):
                db = sqlite3.connect(path)
                db.execute('CREATE TABLE schema_migrations('
                           'version INTEGER PRIMARY KEY,name TEXT,applied_at TEXT)')
                db.execute('INSERT INTO schema_migrations VALUES(?,?,?)',
                           (schema, marker, 'now'))
                db.execute('CREATE TABLE preserved(id TEXT PRIMARY KEY,value TEXT)')
                db.execute('INSERT INTO preserved VALUES(?,?)', ('original', 'fixed'))
                if schema == 16:
                    db.execute('CREATE TABLE kernel_public_scan_cursors('
                               'scan_kind TEXT PRIMARY KEY,last_task_id TEXT,'
                               'last_attempt_sequence INTEGER)')
                db.commit()
                db.close()

            make(live, 15, 'live-v15')
            make(original, 15, 'live-v15')
            make(candidate, 16, 'candidate-v16')
            pathlib.Path(str(live)+'-wal').write_bytes(b'synthetic-old-wal')
            report = migration_phase.promote_database(live, migration, receipt, (15, 16))
            self.assertEqual(report['sourceSchemaVersion'], 15)
            self.assertEqual(report['targetSchemaVersion'], 16)
            self.assertEqual(migration_phase.sqlite_schema(live), 16)
            self.assertEqual(migration_phase.sqlite_schema(original), 15)
            self.assertEqual(migration_phase.sqlite_schema(receipt/'database-archive/sessionplane.sqlite'), 15)
            self.assertEqual((receipt/'database-archive/sessionplane.sqlite-wal').read_bytes(),
                             b'synthetic-old-wal')
            with sqlite3.connect(live) as db:
                self.assertEqual(db.execute('SELECT value FROM preserved WHERE id=?',
                                            ('original',)).fetchone(), ('fixed',))
            self.assertEqual(report['sealedCandidateSha256'], bundle.sha256_file(candidate))

    def test_schema_transition_is_explicit_and_database_promotion_archives_original_sidecars(self):
        self.assertEqual(bundle.schema_transition(
            {'schemaTransition': {'from': 8, 'to': 15}}, 8), (8, 15))
        self.assertEqual(bundle.schema_transition(
            {'schemaTransition': {'from': 15, 'to': 15}}, 15), (15, 15),
            'An exact package refresh may reuse the evidence-first systemd path without a schema downgrade')
        with self.assertRaises(AssertionError):
            bundle.schema_transition({'schemaTransition': {'from': 8, 'to': 15}}, 9)
        with tempfile.TemporaryDirectory() as directory:
            root = pathlib.Path(directory)
            live = root/'sessionplane.sqlite'
            migration = root/'migration'; migration.mkdir()
            receipt = root/'receipt'; receipt.mkdir()
            def make(path, version, marker):
                db = sqlite3.connect(path)
                db.execute('CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY,name TEXT,applied_at TEXT)')
                db.execute('INSERT INTO schema_migrations VALUES(?,?,?)', (version, marker, 'now'))
                db.execute('CREATE TABLE evidence(id TEXT PRIMARY KEY,value TEXT)')
                db.execute('INSERT INTO evidence VALUES(?,?)', ('row', marker))
                db.commit(); db.close()
            make(live, 8, 'old')
            make(migration/'source-snapshot.sqlite', 8, 'old')
            make(migration/'candidate.sqlite', 15, 'new')
            pathlib.Path(str(live)+'-wal').write_bytes(b'archived-wal-evidence')
            report = migration_phase.promote_database(live, migration, receipt, (8, 15))
            self.assertEqual(migration_phase.sqlite_schema(live), 15)
            self.assertEqual(report['targetSchemaVersion'], 15)
            self.assertEqual(migration_phase.sqlite_schema(receipt/'database-archive/sessionplane.sqlite'), 8)
            self.assertEqual((receipt/'database-archive/sessionplane.sqlite-wal').read_bytes(),
                             b'archived-wal-evidence')



    def test_successful_handover_retires_only_older_verified_sqlite_snapshots(self):
        with tempfile.TemporaryDirectory() as temporary:
            state = pathlib.Path(temporary)
            snapshots = []
            for i in range(1, 5):
                receipt = state / f'release-main-0.4.{i}-fixture' / 'handover'
                receipt.mkdir(parents=True)
                result = {
                    'databaseIntegrity': 'ok', 'singleCoreWriterVerified': True,
                    'requestAndAnchorPreserved': True, 'bindingIdentityPreserved': True,
                    'browserIdentityPreserved': True, 'sourceCommit': f'{i:040x}',
                    'packageSha256': 'a' * 64, 'oldPid': i, 'newPid': i + 100,
                }
                (receipt / 'result.json').write_text(json.dumps(result))
                (receipt / 'handover.json').write_text(json.dumps({'atUnix': 1000 + i}))
                (receipt / 'before-identity.json').write_text('keep task evidence')
                (receipt / 'previous-install.tgz').write_bytes(f'package-{i}'.encode())
                (receipt / 'predeploy.sqlite').write_bytes(f'predeploy-{i}'.encode())
                for relative in ['preflight-migration/candidate.sqlite',
                                 'preflight-rollback/restored-original.sqlite',
                                 'final-migration/source-snapshot.sqlite',
                                 'database-archive/sessionplane.sqlite']:
                    candidate = receipt / relative
                    candidate.parent.mkdir(exist_ok=True)
                    candidate.write_bytes(f'{relative}-{i}'.encode())
                snapshots.append(receipt)

            # Broken or unverified cutover is never treated as disposable.
            foreign = state/'release-main-0.4.0-unverified'/'handover'
            foreign.mkdir(parents=True)
            (foreign/'result.json').write_text(json.dumps({
                'databaseIntegrity': 'ok', 'singleCoreWriterVerified': False}))
            (foreign/'predeploy.sqlite').write_text('unknown')
            current = snapshots[-1]
            outcome = retention.retain_successful_handover_snapshots(current, state)
            self.assertEqual(outcome['keptRollbackReceipts'], 2)
            self.assertEqual(outcome['compactedReceipts'], 2)
            self.assertEqual(outcome['retiredReceipts'], 2)
            for old in snapshots[:2]:
                self.assertFalse((old/'predeploy.sqlite').exists())
                self.assertFalse((old/'final-migration/source-snapshot.sqlite').exists())
                self.assertFalse((old/'database-archive/sessionplane.sqlite').exists())
                self.assertEqual((old/'before-identity.json').read_text(), 'keep task evidence')
                self.assertTrue((old/'snapshot-retention.json').exists())
            for retained in snapshots[2:]:
                self.assertFalse((retained/'predeploy.sqlite').exists())
                self.assertTrue((retained/'final-migration/source-snapshot.sqlite').exists())
                self.assertFalse((retained/'preflight-migration/candidate.sqlite').exists())
                self.assertFalse((retained/'database-archive/sessionplane.sqlite').exists())
                self.assertTrue((retained/'previous-install.tgz').exists())
                receipt = json.loads((retained/'snapshot-retention.json').read_text())
                self.assertEqual(receipt['status'], 'compacted-full-rollback')
                self.assertEqual([row['path'] for row in receipt['keptSnapshots']],
                                 ['final-migration/source-snapshot.sqlite'])
            self.assertEqual((foreign/'predeploy.sqlite').read_text(), 'unknown')
            # Re-running the same retention step is idempotent.
            rerun = retention.retain_successful_handover_snapshots(current, state)
            self.assertEqual(rerun['retiredReceipts'], 0)
            self.assertEqual(rerun['compactedReceipts'], 0)

    def test_handover_retention_rejects_an_unverified_latest_cutover(self):
        with tempfile.TemporaryDirectory() as temporary:
            state = pathlib.Path(temporary)
            receipt = state/'release-main-bad'/'handover'
            receipt.mkdir(parents=True)
            (receipt/'result.json').write_text(json.dumps({
                'databaseIntegrity': 'error', 'singleCoreWriterVerified': False}))
            (receipt/'predeploy.sqlite').write_text('preserve')
            with self.assertRaisesRegex(AssertionError, 'verified'):
                retention.retain_successful_handover_snapshots(receipt, state)
            self.assertEqual((receipt/'predeploy.sqlite').read_text(), 'preserve')

    def test_interrupted_snapshot_retention_merges_prior_hash_evidence_atomically(self):
        with tempfile.TemporaryDirectory() as temporary:
            state = pathlib.Path(temporary)
            receipts = []
            for i in range(3):
                receipt = state/f'release-main-{i}'/'handover'
                receipt.mkdir(parents=True)
                (receipt/'result.json').write_text(json.dumps({
                    'databaseIntegrity': 'ok', 'singleCoreWriterVerified': True,
                    'requestAndAnchorPreserved': True, 'bindingIdentityPreserved': True,
                    'browserIdentityPreserved': True, 'sourceCommit': f'{i:040x}',
                    'packageSha256': 'a'*64, 'oldPid': i+1, 'newPid': i+101}))
                (receipt/'handover.json').write_text(json.dumps({'atUnix': i+1}))
                (receipt/'previous-install.tgz').write_text('package')
                (receipt/'final-migration').mkdir()
                (receipt/'final-migration/source-snapshot.sqlite').write_text('source')
                (receipt/'database-archive').mkdir()
                (receipt/'database-archive/sessionplane.sqlite').write_text('archive')
                receipts.append(receipt)
            oldest = receipts[0]
            # Power loss after manifest publication and one unlink.
            (oldest/'predeploy.sqlite').write_text('already removed')
            prior_hash = hashlib.sha256(b'already removed').hexdigest()
            (oldest/'snapshot-retention.json').write_text(json.dumps({
                'kind': 'sessionplane-verified-snapshot-retention-v2',
                'removedSnapshots': [{'path': 'predeploy.sqlite',
                                      'bytes': 15, 'sha256': prior_hash}],
                'keptSnapshots': [],
            }))
            (oldest/'predeploy.sqlite').unlink()
            retention.retain_successful_handover_snapshots(receipts[-1], state)
            manifest = json.loads((oldest/'snapshot-retention.json').read_text())
            removed = {row['path']: row for row in manifest['removedSnapshots']}
            self.assertEqual(removed['predeploy.sqlite']['sha256'], prior_hash)
            self.assertIn('database-archive/sessionplane.sqlite', removed)
            self.assertFalse(list(oldest.glob('.snapshot-retention-*.tmp')))

    def test_handover_retention_requires_one_exact_rollback_and_previous_package(self):
        with tempfile.TemporaryDirectory() as temporary:
            state = pathlib.Path(temporary)
            receipt = state/'release-main-current'/'handover'
            receipt.mkdir(parents=True)
            (receipt/'result.json').write_text(json.dumps({
                'databaseIntegrity': 'ok', 'singleCoreWriterVerified': True,
                'requestAndAnchorPreserved': True, 'bindingIdentityPreserved': True,
                'browserIdentityPreserved': True, 'sourceCommit': 'a'*40,
                'packageSha256': 'b'*64, 'oldPid': 1, 'newPid': 2}))
            (receipt/'handover.json').write_text(json.dumps({'atUnix': 1}))
            (receipt/'predeploy.sqlite').write_text('database')
            with self.assertRaisesRegex(AssertionError, 'previous package'):
                retention.retain_successful_handover_snapshots(receipt, state)
            self.assertEqual((receipt/'predeploy.sqlite').read_text(), 'database')
            (receipt/'previous-install.tgz').write_text('package')
            result = retention.retain_successful_handover_snapshots(receipt, state)
            self.assertEqual(result['compactedReceipts'], 0)
            self.assertTrue((receipt/'predeploy.sqlite').exists())

    def test_handover_retention_ignores_manual_recovery_directory(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = pathlib.Path(temporary)
            receipt = root/'handover-manual'/'cutover'
            receipt.mkdir(parents=True)
            (receipt/'predeploy.sqlite').write_text('manual evidence')
            result = retention.retain_successful_handover_snapshots(receipt, root)
            self.assertEqual(result['status'], 'not-managed-release')
            self.assertEqual((receipt/'predeploy.sqlite').read_text(), 'manual evidence')

    def test_handover_retention_rejects_symlinks_and_unrecognized_files(self):
        with tempfile.TemporaryDirectory() as temporary:
            state = pathlib.Path(temporary)
            receipts = []
            for i in range(3):
                r = state/f'release-main-{i}'/'handover'
                r.mkdir(parents=True)
                (r/'result.json').write_text(json.dumps({
                    'databaseIntegrity': 'ok', 'singleCoreWriterVerified': True,
                    'requestAndAnchorPreserved': True, 'bindingIdentityPreserved': True,
                    'browserIdentityPreserved': True, 'sourceCommit': f'{i:040x}',
                    'packageSha256': 'a'*64, 'oldPid': i+1, 'newPid': i+101}))
                (r/'handover.json').write_text(json.dumps({'atUnix': i+1}))
                (r/'previous-install.tgz').write_text('package')
                (r/'predeploy.sqlite').write_text('preserve')
                (r/'database-archive').mkdir()
                (r/'database-archive/sessionplane.sqlite').write_text('original')
                receipts.append(r)
            external = state/'unrelated-important.sqlite'
            external.write_text('untouched')
            (receipts[0]/'preflight-migration').mkdir()
            (receipts[0]/'preflight-migration'/'candidate.sqlite').symlink_to(external)
            with self.assertRaisesRegex(AssertionError, 'symlink'):
                retention.retain_successful_handover_snapshots(receipts[-1], state)
            self.assertTrue((receipts[0]/'predeploy.sqlite').exists())
            self.assertEqual(external.read_text(), 'untouched')


if __name__ == '__main__':
    unittest.main()
