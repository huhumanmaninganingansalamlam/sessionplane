"""Offline checks only: never connect to or signal a running SessionPlane core."""
import copy
import importlib.util
import json
import os
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
            with sqlite3.connect(path) as db:
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


if __name__ == '__main__':
    unittest.main()
