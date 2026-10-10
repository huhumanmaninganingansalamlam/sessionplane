"""Offline checks only: never connect to or signal a running SessionPlane core."""
import copy
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
spec = importlib.util.spec_from_file_location('handover', SCRIPT)
handover = importlib.util.module_from_spec(spec)
spec.loader.exec_module(handover)


class HandoverTests(unittest.TestCase):
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
            with patch.object(handover, 'read_db', return_value=db), patch.object(handover, 'no_writer'):
                handover.guard(before, before)
                for part, key, value in [('metrics', 'session_actor_queue_depth', 1),
                                         ('process', 'pid', 33), ('process', 'startedAt', 'replacement'),
                                         ('browser', 'browserPid', 44), ('database', 'integrity', 'error')]:
                    with self.subTest(part=part, key=key):
                        current = copy.deepcopy(before)
                        current[part][key] = value
                        with self.assertRaises(AssertionError):
                            handover.guard(current, before)
                db.execute.return_value.fetchone.return_value = (1,)
                with self.assertRaisesRegex(AssertionError, 'Active submission'):
                    handover.guard(before, before)
            db.execute.return_value.fetchone.return_value = (0,)
            with patch.object(handover, 'read_db', return_value=db), patch.object(handover, 'no_writer', side_effect=AssertionError('writer')):
                with self.assertRaisesRegex(AssertionError, 'writer'):
                    handover.guard(before, before)

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
            self.assertEqual(handover.request_identity(health, target)['anchor'][0], 'fixture-user')
            for key, value in [('request_ref', 'foreign-request'), ('session_id', 'foreign-session'), ('generation', 8), ('user_anchor', 'foreign-user')]:
                wrong = copy.copy(target)
                setattr(wrong, key, value)
                with self.subTest(key=key), self.assertRaises(AssertionError):
                    handover.request_identity(health, wrong)
            with handover.read_db(health) as db, self.assertRaises(sqlite3.OperationalError):
                db.execute('DELETE FROM outbox')
            self.assertEqual(path.read_bytes(), before)

    def test_optimized_python_cannot_disable_guards(self):
        result = subprocess.run([sys.executable, '-O', str(SCRIPT), '--help'], capture_output=True, text=True)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('disables safety assertions', result.stderr)

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
                handover.no_writer(str(path))
            with patch.object(pathlib.Path, 'read_text', return_value=f'1: POSIX ADVISORY WRITE 11 {inode} 0 1'):
                with self.assertRaises(handover.LockActivityError) as error:
                    handover.no_writer(str(path))
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
                handover.no_writer(str(path))
                with handover.read_db({'database': {'path': str(path)}}) as reader:
                    reader.execute('BEGIN')
                    reader.execute('SELECT * FROM fixture').fetchall()
                    handover.no_writer(str(path))
                with self.assertRaises(sqlite3.ProgrammingError):
                    reader.execute('SELECT 1')
                owner.execute('BEGIN IMMEDIATE')
                with self.assertRaises(handover.LockActivityError) as error:
                    handover.no_writer(str(path))
                writer = next(r for r in error.exception.report['locks'] if r['classification'] == 'wal-writer')
                self.assertEqual(writer['holder']['pid'], os.getpid())
                self.assertEqual((writer['start'], writer['end']), ('120', '120'))
                self.assertEqual(writer['suffix'], '-shm')
                owner.rollback()
                handover.no_writer(str(path))

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
                    with self.assertRaises(handover.LockActivityError) as error:
                        handover.no_writer(str(db))
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
            with patch.object(handover.subprocess, 'run', side_effect=install), patch.object(handover, 'verify_package', return_value='catalog'):
                stage, candidate, _ = handover.stage_package(installed, root/'package.tgz', {}, receipt)
            # The actual final guard can abort here without touching the live path.
            with self.assertRaises(handover.LockActivityError):
                with patch.object(handover, 'lock_report', return_value={'locks': [{'blocksHandover': True}]}):
                    handover.no_writer('fixture')
            self.assertEqual((installed/'marker').read_text(), 'running-old')
            self.assertEqual((candidate/'marker').read_text(), 'new')
            self.assertFalse((receipt/'promotion.json').exists())
            handover.promote_package(installed, candidate, stage, receipt)
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
                handover.promote_package(installed, candidate, stage, receipt)
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
            with patch.object(handover, 'verify_package') as verify, patch.object(handover, 'request_identity', return_value=identity):
                handover.verify_pre_signal_resume(prior, health, prior/'installed', prior/'package', {}, None)
                verify.assert_called_once()
                wrong = copy.deepcopy(health)
                wrong['process']['startedAt'] = 'new-core'
                with self.assertRaisesRegex(AssertionError, 'lifetime'):
                    handover.verify_pre_signal_resume(prior, wrong, prior/'installed', prior/'package', {}, None)
                (prior/'handover.json').write_text('{}')
                with self.assertRaisesRegex(AssertionError, 'may have occurred'):
                    handover.verify_pre_signal_resume(prior, health, prior/'installed', prior/'package', {}, None)

    def test_staged_only_abort_cannot_use_legacy_installed_resume(self):
        with tempfile.TemporaryDirectory() as directory:
            prior = pathlib.Path(directory)
            (prior/'staging.json').write_text('{}')
            with patch.object(handover, 'verify_package') as verify:
                with self.assertRaisesRegex(AssertionError, 'Staging-only abort'):
                    handover.verify_pre_signal_resume(prior, {}, prior/'live', prior/'pkg', {}, None)
                verify.assert_not_called()

    def test_maintenance_transport_accepts_eof_only_for_commit_and_never_masks_refusal(self):
        h = {'socket': {'path': '/fixture/socket'}}
        channel = MagicMock()
        channel.__enter__.return_value = channel
        with patch.object(handover.socket, 'socket', return_value=channel):
            channel.recv.return_value = b''
            with self.assertRaisesRegex(RuntimeError, 'response missing'):
                handover.maintenance_rpc(h, 'system.maintenance.prepare', {})
            self.assertIsNone(handover.maintenance_rpc(h, 'system.maintenance.commit', {}, True))
            channel.recv.side_effect = ConnectionResetError('core exited')
            self.assertIsNone(handover.maintenance_rpc(h, 'system.maintenance.commit', {}, True))
            channel.recv.side_effect = None
            channel.recv.return_value = b'{"error":{"message":"readiness changed"}}\n'
            with self.assertRaisesRegex(RuntimeError, 'Maintenance refused'):
                handover.maintenance_rpc(h, 'system.maintenance.commit', {}, True)

    def test_legacy_freeze_commit_abort_expiry_and_parent_loss(self):
        # Only fixture children are signalled. An unrelated browser sentinel survives.
        browser = subprocess.Popen([sys.executable, '-c', 'import time; time.sleep(30)'])
        try:
            for mode in ['commit', 'abort', 'expiry', 'parent-loss', 'wrong-lifetime']:
                with self.subTest(mode=mode):
                    core = subprocess.Popen([sys.executable, '-c', 'import time; time.sleep(30)'])
                    fd = os.pidfd_open(core.pid)
                    ticks = handover.procstat(core.pid)[19]
                    try:
                        if mode == 'wrong-lifetime':
                            with self.assertRaisesRegex(AssertionError, 'freeze failed'):
                                with handover.frozen_core(fd, core.pid, 'not-the-start-ticks'): pass
                        elif mode == 'parent-loss':
                            controller = os.fork()
                            if controller == 0:
                                with handover.frozen_core(fd, core.pid, ticks, timeout=1):
                                    os._exit(0)  # Guardian gets EOF, even without finally.
                            os.waitpid(controller, 0)
                            deadline = time.monotonic() + 2
                            while handover.procstat(core.pid)[0] in ('T', 't') and time.monotonic() < deadline:
                                time.sleep(.01)
                        else:
                            with handover.frozen_core(fd, core.pid, ticks, timeout=.3) as commit:
                                self.assertEqual(handover.procstat(core.pid)[0], 'T')
                                self.assertIsNone(browser.poll())
                                if mode == 'commit': commit()
                                if mode == 'expiry':
                                    time.sleep(.4)
                                    with self.assertRaises((AssertionError, OSError)): commit()
                        if mode == 'commit':
                            self.assertEqual(core.wait(timeout=2), -signal.SIGKILL)
                        else:
                            self.assertIsNone(core.poll())
                            self.assertNotIn(handover.procstat(core.pid)[0], ('T', 't'))
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
                    with self.assertRaises(handover.LockActivityError):
                        with handover.frozen_core(fd, worker.pid, handover.procstat(worker.pid)[19]):
                            handover.no_writer(str(dbpath))
                    self.assertIsNone(worker.poll())
                    self.assertNotIn(handover.procstat(worker.pid)[0], ('T', 't'))
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
            with patch.object(handover, 'request_identity', return_value=identity):
                handover.verify_staged_resume(prior, h, installed, None)
                self.assertEqual(before, {p.name:p.read_bytes() for p in prior.iterdir()})
                (installed/'marker').write_text('mixed')
                with self.assertRaisesRegex(AssertionError, 'installation changed'):
                    handover.verify_staged_resume(prior, h, installed, None)
                (installed/'marker').write_text('old')
                (prior/'handover.json').write_text('{}')
                with self.assertRaisesRegex(AssertionError, 'ambiguous'):
                    handover.verify_staged_resume(prior, h, installed, None)

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
                identity = handover.request_identity(h,target)
                def healthy_fixture():
                    result = copy.deepcopy(h)
                    result['requestOk'] = True; result['browser']['state'] = 'ready'
                    result['process'] = {'pid':json.loads((receipt/'rollback-core.json').read_text())['pid']}
                    return result
                with patch.object(handover, 'health', side_effect=healthy_fixture):
                    args=(h,old.pid,successor,handover.procstat(browser.pid)[19],installed,stage,receipt,
                          [sys.executable,'-c','import time; time.sleep(30)'],directory,dict(os.environ),target,identity)
                    with self.assertRaisesRegex(AssertionError,'Live successor'): handover.rollback_exited(*args)
                    self.assertFalse((receipt/'rollback-core.json').exists())
                    self.assertEqual((installed/'marker').read_text(),'candidate')
                    successor.terminate(); successor.wait(timeout=2)
                    restored_process = handover.rollback_exited(*args)
                    restored_pid = json.loads((receipt/'rollback-core.json').read_text())['pid']
                    self.assertTrue(handover.live(restored_pid))
                    self.assertEqual((installed/'marker').read_text(),'old')
                    self.assertEqual((stage/'failed-candidate/marker').read_text(),'candidate')
                    self.assertEqual(dbpath.read_bytes(),dbbytes)
                    self.assertEqual(handover.request_identity(h,target),identity)
                    self.assertIsNone(browser.poll())
                    self.assertEqual(json.loads((receipt/'rollback.json').read_text())['phase'],'original-core-restored')
            finally:
                if (receipt/'rollback-core.json').exists():
                    restored_pid = json.loads((receipt/'rollback-core.json').read_text())['pid']
                    if handover.live(restored_pid): os.kill(restored_pid,signal.SIGTERM)
                    if restored_process is not None: restored_process.wait(timeout=2)
                    else: os.waitpid(restored_pid,0)
                if successor.poll() is None: successor.terminate()
                successor.wait(timeout=2)
                browser.terminate(); browser.wait(timeout=2)


if __name__ == '__main__':
    unittest.main()
