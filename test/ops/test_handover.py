"""Offline checks only: never connect to or signal a running SessionPlane core."""
import copy
import importlib.util
import json
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
            import os
            inode = f'{os.major(stat.st_dev):02x}:{os.minor(stat.st_dev):02x}:{stat.st_ino}'
            with patch.object(pathlib.Path, 'read_text', return_value=f'1: POSIX ADVISORY READ 11 {inode} 0 1'):
                handover.no_writer(str(path))
            with patch.object(pathlib.Path, 'read_text', return_value=f'1: POSIX ADVISORY WRITE 11 {inode} 0 1'):
                with self.assertRaisesRegex(AssertionError, 'write lock active'):
                    handover.no_writer(str(path))


if __name__ == '__main__':
    unittest.main()
