"""Bounded verified handover rollback phase."""
import json, pathlib, shutil, time, uuid

from . import migration, model, preflight, systemd


def restore_install(installed, stage, receipt):
    """Files only, after caller proves no core is live. Never restore the DB."""
    previous = stage/'previous-install'
    if previous.exists():
        failed = stage/'failed-candidate'
        assert not failed.exists(), 'Recovery already attempted'
        installed.rename(failed)
        previous.rename(installed)
    model.save(receipt/'rollback.json', {'phase': 'original-files-restored', 'databaseRestored': False})

def rollback_exited(h, old_pid, successor, chrome_ticks, installed, stage, receipt, cmd, cwd, env, target, identity):
    # Never kill a live successor or restore a database snapshot. This route is
    # only for a caught promotion/spawn failure or an already exited successor.
    assert not preflight.live(old_pid), 'Original core still live'
    assert successor is None or successor.poll() is not None, 'Live successor: preserve it and inspect'
    chrome = h['browser']['browserPid']
    assert preflight.live(chrome) and preflight.procstat(chrome)[19] == chrome_ticks, 'Browser identity changed; no automatic restart'
    lock = json.loads((pathlib.Path(h['browser']['profileDir'])/'.sessionplane-profile.lock').read_text())
    assert lock['browserPid'] == chrome and lock['pid'] in [old_pid, successor.pid if successor else old_pid], 'Foreign owner; no rollback'
    preflight.no_writer(h['database']['path'])
    with preflight.read_db(h) as db:
        assert db.execute('PRAGMA integrity_check').fetchone()[0] == 'ok', 'DB not healthy; no rollback'
        assert db.execute('SELECT COALESCE(MAX(version), 0) FROM schema_migrations').fetchone()[0] == h['database']['schemaVersion'], 'Schema changed; no old-code restart'
    current = preflight.request_identity(h, target)
    assert current['request'] == identity['request'] and current['anchor'] == identity['anchor']
    assert all(current['requests'].get(k) == v for k, v in identity['requests'].items())
    restore_install(installed, stage, receipt)
    restored = systemd.launch_core(cmd, cwd, env, receipt, 'rollback-core')
    model.save(receipt/'rollback-core.json', {'pid': restored.pid, 'startedAtUnix': time.time()})
    after = systemd.await_ready(restored)
    assert after['database']['path'] == h['database']['path'] and (after['database'].get('readable') is True or after['database']['integrity'] == 'ok')
    assert after['database']['schemaVersion'] == h['database']['schemaVersion']
    for key in ['browserPid', 'profileDir', 'debuggingPort']:
        assert after['browser'][key] == h['browser'][key]
    assert after['browser']['ownership'] == 'adopted' and preflight.procstat(chrome)[19] == chrome_ticks
    post = preflight.request_identity(after, target)
    assert post['request'] == identity['request'] and post['anchor'] == identity['anchor']
    assert all(post['requests'].get(k) == v for k, v in identity['requests'].items())
    preflight.verify_bindings(after, identity['bindings'], post['bindings'])
    model.save(receipt/'rollback-health.json', after)
    model.save(receipt/'rollback.json', {'phase': 'original-core-restored', 'pid': restored.pid, 'databaseRestored': False})
    return restored

def archive_failed_candidate(database_path, destination):
    destination.mkdir(mode=0o700)
    moved = []
    for suffix in ['', '-wal', '-shm']:
        current = pathlib.Path(str(database_path) + suffix)
        if current.exists():
            target = destination/(pathlib.Path(database_path).name + suffix)
            current.rename(target); moved.append(str(target))
    return moved

def restore_original_database(database_path, restored_path):
    database_path = pathlib.Path(database_path)
    restored_path = pathlib.Path(restored_path)
    assert restored_path.stat().st_dev == database_path.parent.stat().st_dev
    staged = database_path.parent/('.sessionplane-restore-' + uuid.uuid4().hex + '.sqlite')
    shutil.copy2(restored_path, staged); staged.chmod(0o600)
    staged.rename(database_path)

def restart_original_systemd(h, unit, installed, stage, receipt, target, identity, chrome_ticks,
                             restore_files=False):
    if restore_files:
        restore_install(installed, stage, receipt)
    migration.verify_sqlite(h['database']['path'], h['database']['schemaVersion'])
    old = systemd.start_systemd_core(unit, receipt, 'rollback-core')
    model.save(receipt/'rollback-core.json', {'pid': old, 'startedAtUnix': time.time()})
    after = systemd.await_systemd_ready(unit, old)
    assert after['database']['schemaVersion'] == h['database']['schemaVersion']
    for key in ['browserPid', 'profileDir', 'debuggingPort']:
        assert after['browser'][key] == h['browser'][key]
    assert after['browser']['ownership'] == 'adopted'
    assert preflight.procstat(h['browser']['browserPid'])[19] == chrome_ticks
    post = preflight.request_identity(after, target)
    assert post['request'] == identity['request'] and post['anchor'] == identity['anchor']
    model.save(receipt/'rollback-health.json', after)
    model.save(receipt/'rollback.json', {'phase': 'original-core-restored', 'pid': old,
                                   'databaseRestored': False})
    return after
