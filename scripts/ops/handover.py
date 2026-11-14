#!/usr/bin/env python3
"""Established, drained, exact-core-only replacement. No SSH or browser protocol calls.
Require issuer coordination for legacy cores, or explicitly use a live core admission fence.
Sampled health is never a substitute for either protection.
"""
import argparse, datetime, hashlib, json, os, pathlib, pwd, shutil, signal, socket, sqlite3, subprocess, sys, tarfile, tempfile, time, uuid
from contextlib import closing, contextmanager

if not __debug__:
    raise SystemExit('Optimized Python disables safety assertions; run without -O or PYTHONOPTIMIZE')

def save(path, value):
    path.write_text(json.dumps(value, indent=2)); path.chmod(0o600)

def health(timeout=15):
    return json.loads(subprocess.check_output(['sessplane', 'health', '--json'], text=True, timeout=timeout, stderr=subprocess.PIPE))

def maintenance_rpc(h, method, params, allow_commit_eof=False):
    """Existing Unix socket only; no alternate transport or credentials."""
    request = {'jsonrpc': '2.0', 'id': 'core-handover', 'method': method, 'params': params}
    with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as channel:
        channel.settimeout(12)
        channel.connect(h['socket']['path'])
        channel.sendall((json.dumps(request) + '\n').encode())
        response = b''
        while b'\n' not in response:
            try:
                chunk = channel.recv(65536)
            except ConnectionResetError:
                if allow_commit_eof and not response:
                    return None
                raise
            if not chunk:
                if allow_commit_eof and not response:
                    return None  # caller must still prove the pinned old process exited
                raise RuntimeError('Maintenance response missing; do not repeat the operation')
            response += chunk
        result = json.loads(response.split(b'\n', 1)[0])
        if 'error' in result:
            raise RuntimeError('Maintenance refused: ' + json.dumps(result['error']))
        return result['result']


def lease_owner(h):
    return {'expectedPid': h['process']['pid'], 'expectedStartedAt': h['process']['startedAt']}


def procstat(pid):
    return pathlib.Path(f'/proc/{pid}/stat').read_text().rsplit(')', 1)[1].split()

def live(pid):
    try: return procstat(pid)[0] != 'Z'
    except (FileNotFoundError, ProcessLookupError): return False

def read_db(h):
    return closing(sqlite3.connect(pathlib.Path(h['database']['path']).resolve().as_uri() + '?mode=ro', uri=True))

def request_identity(h, target):
    with read_db(h) as db:
        row = db.execute('SELECT session_id,generation,request_hash,prompt_submitted FROM outbox WHERE outbox_id=?',
            (target.request_ref,)).fetchone()
        assert row and row[0]==target.session_id and row[1]==target.generation and row[3]==1, 'Original request identity changed'
        anchor = db.execute('SELECT submitted_user_message_id,submitted_user_turn_id,prompt_hash FROM generations WHERE session_id=? AND generation=?', (row[0], row[1])).fetchone()
        assert anchor and anchor[0]==target.user_anchor, 'Original anchor mismatch'
        return {'request': row, 'anchor': anchor,
            'requests': dict(db.execute('SELECT outbox_id,request_hash FROM outbox')),
            'bindings': list(db.execute('SELECT page_key,session_id,generation,conversation_id,target_id FROM page_bindings')),
            'probeBudgets': list(db.execute('SELECT scope,next_allowed_at,blocked_until,backoff_level,consecutive_failures FROM probe_budget'))}

def verify_bindings(h, before, after):
    """A drained caller may advance a generation, never the page's identity."""
    current = {row[0]: tuple(row) for row in after}
    owned = [tuple(row) for row in before if row[1] is not None and row[4] is not None]
    with read_db(h) as db:
        for original in before:
            original = tuple(original)
            row = current.get(original[0])
            if original[1:3] == (None, None) and row is not None and row[3:] == original[3:] and any(
                    owner[1] == row[1] and owner[3:] == row[3:] and isinstance(owner[2], int) and
                    isinstance(row[2], int) and row[2] >= owner[2] for owner in owned):
                # Restart may recover an unowned page-key alias of an already
                # owned target. Its exact durable owner must predate handover.
                assert db.execute('SELECT 1 FROM outbox o JOIN generations g '
                    'ON g.session_id=o.session_id AND g.generation=o.generation '
                    'WHERE o.session_id=? AND o.generation=?', (row[1], row[2])).fetchone(), \
                    'Recovered binding has no durable request'
                continue
            assert row is not None and row[:2] == original[:2] and row[3:] == original[3:], \
                'Binding identity changed; inspect, never overwrite DB'
            if row[2] != original[2]:
                assert original[1] is not None and isinstance(original[2], int) and \
                    isinstance(row[2], int) and row[2] > original[2], 'Binding generation regressed or is unverified'
                assert db.execute('SELECT 1 FROM outbox o JOIN generations g '
                    'ON g.session_id=o.session_id AND g.generation=o.generation '
                    'WHERE o.session_id=? AND o.generation=?', (row[1], row[2])).fetchone(), \
                    'Binding generation has no durable request'


class LockActivityError(AssertionError):
    def __init__(self, report):
        self.report = report
        super().__init__('DB lock activity: preserve core; inspect holder, byte range and classification')


def lock_report(dbpath):
    files = {}
    for suffix in ['', '-wal', '-shm']:
        path = pathlib.Path(dbpath + suffix)
        try:
            stat = path.stat()
        except FileNotFoundError:
            continue
        key = (os.major(stat.st_dev), os.minor(stat.st_dev), stat.st_ino)
        files[key] = {'path': str(path), 'suffix': suffix, 'deviceMajor': key[0],
                      'deviceMinor': key[1], 'inode': key[2]}
    rows = []
    for raw in pathlib.Path('/proc/locks').read_text().splitlines():
        parts = raw.split()
        waiting = len(parts) > 1 and parts[1] == '->'
        fields = parts[2:] if waiting else parts[1:]
        if len(fields) != 7:
            continue
        kind, advisory, mode, holder, device, start, end = fields
        try:
            major, minor, inode = device.split(':')
            file = files.get((int(major, 16), int(minor, 16), int(inode)))
        except ValueError:
            continue
        if file is None:
            continue
        pid = int(holder)
        owner = {'pid': pid, 'uid': None, 'comm': None, 'startTicks': None}
        if pid > 0:
            try:
                proc = pathlib.Path(f'/proc/{pid}')
                owner.update(uid=proc.stat().st_uid, comm=(proc/'comm').read_text().strip(), startTicks=procstat(pid)[19])
            except (OSError, IndexError):
                pass  # Holder exited or cannot be inspected; never substitute another PID.
        classification = 'shared-read' if mode == 'READ' else 'unclassified-exclusive-lock'
        if waiting:
            classification = 'waiting-lock-request'
        elif kind == 'POSIX' and advisory == 'ADVISORY' and mode == 'WRITE' and file['suffix'] == '-shm':
            # SQLite Unix WAL locks: SHM_BASE=120, write/checkpoint/recovery=0/1/2,
            # read marks=3..7, dead-man-switch=128. Classification is diagnostic only.
            first, last = int(start), int(end) if end != 'EOF' else 2**63-1
            if first <= 120 <= last: classification = 'wal-writer'
            elif first <= 121 <= last: classification = 'wal-checkpoint'
            elif first <= 122 <= last: classification = 'wal-recovery'
            elif first >= 123 and last <= 127: classification = 'wal-read-mark-exclusive'
            elif first == last == 128: classification = 'wal-shm-initialization'
        rows.append({**file, 'raw': raw, 'class': kind, 'advisory': advisory, 'mode': mode,
                     'waiting': waiting, 'start': start, 'end': end, 'holder': owner,
                     'classification': classification, 'blocksHandover': mode != 'READ'})
    return {'observedAtUTC': datetime.datetime.now(datetime.timezone.utc).isoformat(),
            'files': list(files.values()), 'locks': rows}


def no_writer(dbpath):
    report = lock_report(dbpath)
    if any(row['blocksHandover'] for row in report['locks']):
        raise LockActivityError(report)

def guard_state(h, expected, require_idle=True, recovery_handover=False):
    assert h['requestOk'] and h['browser']['state']=='ready' and (h['database'].get('readable') is True or h['database']['integrity']=='ok')
    assert h['database']['path'] == expected['database']['path'], 'Database path changed'
    for key in ['pid','startedAt']: assert h['process'][key]==expected['process'][key], 'Core owner changed'
    for key in ['browserPid','profileDir','debuggingPort']: assert h['browser'][key]==expected['browser'][key], 'Browser identity changed'
    if require_idle:
        assert h['metrics']['session_actor_queue_depth']==0, 'Actor running or queued; natural drain required'
    with read_db(h) as db:
        assert db.execute("SELECT count(*) FROM outbox WHERE submission_state IN ('submit_attempted','composer_filled')").fetchone()[0]==0, 'Active submission'
        if not recovery_handover and not h.get('maintenance', {}).get('durableRecoveryHandover'):
            assert db.execute("SELECT count(*) FROM outbox o JOIN generations g ON g.session_id=o.session_id AND g.generation=o.generation WHERE json_extract(o.payload_json,'$.thinkingFailureRecovery')=1 AND g.completed_at IS NULL").fetchone()[0]==0, 'Legacy core cannot hand over unfinished opted-in recovery; preserve request until natural completion'
    lock=json.loads((pathlib.Path(h['browser']['profileDir'])/'.sessionplane-profile.lock').read_text())
    assert lock['pid']==h['process']['pid'] and lock['browserPid']==h['browser']['browserPid']


def guard(h, expected, require_idle=True, recovery_handover=False):
    guard_state(h, expected, require_idle, recovery_handover)
    no_writer(h['database']['path'])

def drainable_writer(report, pid, ticks):
    blocking = [row for row in report['locks'] if row['blocksHandover']]
    if not all(row['classification'] == 'wal-writer' and row['start'] == row['end'] == '120' and
               row['holder']['pid'] == pid and row['holder']['startTicks'] == ticks
               for row in blocking):
        raise LockActivityError(report)
    return bool(blocking)

def prefreeze_drain(h, ticks, chrome_ticks, target, identity, receipt, timeout=5):
    """Finish live RPC checks before quiet; frozen_guard revalidates before commit."""
    started = time.monotonic()
    deadline = started + timeout
    samples = []
    timings = []
    phase = 'live-guard-1'
    def pinned():
        assert procstat(h['process']['pid'])[19] == ticks, 'Core PID reused'
        chrome = h['browser']['browserPid']
        assert live(chrome) and procstat(chrome)[19] == chrome_ticks, 'Chrome lifetime changed'
    def remaining():
        left = deadline - time.monotonic()
        if left <= 0: raise TimeoutError('Pre-freeze drain deadline expired; preserve original core')
        return left
    @contextmanager
    def measured(operation):
        begin = time.monotonic()
        try:
            yield
        finally:
            timings.append({'phase': phase, 'operation': operation,
                            'startSeconds': begin - started,
                            'elapsedSeconds': time.monotonic() - begin})
    try:
        for index in range(2):
            phase = f'live-guard-{index+1}'
            save(receipt/'transition-phase.json', {'phase': phase})
            pinned()
            with measured('health'):
                current = health(timeout=remaining())
            with measured('guard-state'):
                guard_state(current, h)
                report = lock_report(h['database']['path'])
                samples.append({'phase': phase, **report})
                drainable_writer(report, h['process']['pid'], ticks)
            pinned()
            with measured('request-identity'):
                assert request_identity(current, target)['request'] == identity['request']
            remaining()
        # A live lock sample is not an atomic transition check. Drain only after
        # all slow RPC/DB work; any writer racing the freeze is rejected frozen.
        phase = 'live-final-writer'
        save(receipt/'transition-phase.json', {'phase': phase})
        deadline = time.monotonic() + timeout
        while True:
            pinned()
            report = lock_report(h['database']['path'])
            waiting = drainable_writer(report, h['process']['pid'], ticks)
            samples.append({'phase': phase if waiting else 'quiet-observed', **report})
            if not waiting:
                remaining()
                return current  # No health/SQLite work between quiet and freeze.
            if time.monotonic() >= deadline: raise LockActivityError(report)
            time.sleep(min(.1, remaining()))
    finally:
        save(receipt/'writer-drain.json', {'phase': phase, 'timeoutSeconds': timeout,
                                         'maxValidationPasses': 1, 'maxTotalSeconds': 2 * timeout,
                                         'elapsedSeconds': time.monotonic() - started,
                                         'timings': timings, 'samples': samples})


def frozen_guard(current, expected, ticks, chrome_ticks, target, identity, recovery_handover=False):
    """Called only under the bounded guardian; never issue health to a frozen core."""
    pid = expected['process']['pid']
    chrome = expected['browser']['browserPid']
    assert procstat(pid)[19] == ticks and procstat(chrome)[19] == chrome_ticks, 'PID reused'
    assert live(chrome), 'Chrome exited'
    no_writer(expected['database']['path'])
    if recovery_handover:
        assert current['maintenance']['phase'] == 'draining' and current['maintenance']['activeOperations'] == 0, 'Recovery handover requires drained admission'
        assert current['maintenance']['expiresAt'] > time.time() * 1000, 'Recovery handover lease expired; preserve core'
    guard(current, expected, recovery_handover=recovery_handover)  # Fresh submission/profile/lock checks.
    with read_db(expected) as db:
        assert db.execute('PRAGMA integrity_check').fetchone()[0] == 'ok', 'DB not healthy'
    post = request_identity(expected, target)
    assert post['request'] == identity['request'] and post['anchor'] == identity['anchor']
    assert all(post['requests'].get(k) == v for k, v in identity['requests'].items()), 'Durable request changed'
    verify_bindings(current, identity['bindings'], post['bindings'])
    no_writer(expected['database']['path'])


def sha256_file(path):
    digest = hashlib.sha256()
    with pathlib.Path(path).open('rb') as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b''):
            digest.update(block)
    return digest.hexdigest()


def verify_package(installed, pkg, manifest):
    with tarfile.open(pkg) as archive:
        for member in archive.getmembers():
            if member.isfile():
                target = installed/member.name.removeprefix('package/')
                assert target.is_file() and target.read_bytes() == archive.extractfile(member).read(), 'Package bytes differ'
    identity = json.loads((installed/'dist/build-identity.json').read_text())
    assert identity['sourceCommit'] == manifest['sourceCommit'], 'Candidate build commit differs'
    assert identity.get('sourceTree') == manifest.get('sourceTree'), 'Candidate build tree differs'
    assert identity['sourceState'] == 'clean', 'Candidate build is not a clean committed source'
    assert identity['version'] == manifest['version'], 'Candidate build version differs'
    script = "import {pathToFileURL} from 'node:url'; import {createHash} from 'node:crypto'; const {MCP_TOOLS}=await import(pathToFileURL(process.argv[1]).href); console.log(createHash('sha256').update(JSON.stringify(MCP_TOOLS)).digest('hex'));"
    catalog = subprocess.check_output(['node', '--input-type=module', '-e', script, str(installed/'dist/mcp/tools.js')], text=True).strip()
    assert catalog == manifest['installedCatalogSha256'], 'MCP catalog differs'
    browser_owner = sha256_file(installed/'dist/browser/browser-owner.js')
    assert browser_owner == manifest['candidateBrowserOwnerSha256'], 'Candidate BrowserOwner differs'
    assert (installed/'scripts/offline-state-rehearsal.mjs').is_file(), 'Candidate omits offline state helper'
    help_text = subprocess.check_output([str(installed/'bin/sessplane.mjs'), '--help'], text=True)
    for name in ['project', 'task']:
        assert name in help_text, 'Candidate public CLI contract missing'
    return catalog


def stage_package(installed, pkg, manifest, receipt):
    # Adjacent, same-filesystem staging: never install into the running package.
    stage = pathlib.Path(tempfile.mkdtemp(prefix='.sessionplane-handover-', dir=installed.parent))
    candidate = stage/'lib/node_modules/sessionplane'
    save(receipt/'staging.json', {'prefix': str(stage), 'candidate': str(candidate), 'installed': str(installed)})
    with (receipt/'install.log').open('w') as log:
        subprocess.run(['npm', 'install', '-g', '--prefix', str(stage), '--ignore-scripts', '--no-audit', '--no-fund', str(pkg)], check=True, stdout=log, stderr=subprocess.STDOUT)
    catalog = verify_package(candidate, pkg, manifest)
    assert candidate.stat().st_dev == installed.parent.stat().st_dev, 'Promotion requires the same filesystem'
    return stage, candidate, catalog


def promote_package(installed, candidate, stage, receipt):
    previous = stage/'previous-install'
    assert not previous.exists() and installed.is_dir() and not installed.is_symlink()
    save(receipt/'promotion.json', {'phase': 'before-promotion', 'previous': str(previous), 'candidate': str(candidate), 'installed': str(installed)})
    installed.rename(previous)
    try:
        candidate.rename(installed)
    except BaseException:
        previous.rename(installed)
        save(receipt/'promotion.json', {'phase': 'promotion-failed-original-files-restored', 'installed': str(installed)})
        raise
    save(receipt/'promotion.json', {'phase': 'promoted', 'previous': str(previous), 'installed': str(installed)})


@contextmanager
def frozen_core(fd, pid, ticks, timeout=10):
    """One-shot legacy fence. Guardian alone decides kill vs resume before deadline.

    The parent never kills after a sampled timeout check. EOF (including parent
    death), guard failure or expiry resumes the exact pidfd, never a reused PID.
    No RPC may run while frozen. Chrome and external writers are not suspended.
    """
    parent, child = socket.socketpair()
    guardian = os.fork()
    if guardian == 0:
        parent.close()
        os.setsid()
        committed = False
        stopped = False
        deadline = time.monotonic() + timeout
        try:
            assert procstat(pid)[19] == ticks, 'Core lifetime changed before freeze'
            assert procstat(pid)[0] not in ('T', 't', 'Z'), 'Core already stopped or exited'
            signal.pidfd_send_signal(fd, signal.SIGSTOP)
            stopped = True
            while time.monotonic() < deadline:
                threads = list(pathlib.Path(f'/proc/{pid}/task').glob('*/stat'))
                if threads and all(p.read_text().rsplit(')', 1)[1].split()[0] in ('T', 't') for p in threads):
                    break
                time.sleep(.005)
            else:
                raise TimeoutError('Core did not reach a bounded frozen state')
            child.sendall(b'F')
            child.settimeout(max(.001, deadline-time.monotonic()))
            command = child.recv(1)
            if command == b'K' and time.monotonic() < deadline and procstat(pid)[0] in ('T', 't'):
                signal.pidfd_send_signal(fd, signal.SIGKILL)
                committed = True
                child.sendall(b'K')
        except (OSError, AssertionError, TimeoutError):
            pass
        finally:
            if stopped and not committed:
                try: signal.pidfd_send_signal(fd, signal.SIGCONT)
                except ProcessLookupError: pass
            child.close()
            os._exit(0)
    child.close()
    parent.settimeout(timeout + 2)
    try:
        assert parent.recv(1) == b'F', 'Legacy freeze failed; core preserved'
        def commit():
            try:
                parent.sendall(b'K')
                reply = parent.recv(1)
            except OSError:
                reply = b''
            assert reply == b'K' or not live(pid), 'Freeze expired; core resumed, do not promote'
        yield commit
    finally:
        parent.close()  # EOF releases the exact stopped core on any exception.
        os.waitpid(guardian, 0)


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
        assert transition.get('oldPid') == h['process']['pid'] and transition.get('oldStartTicks') == procstat(h['process']['pid'])[19], 'Transition history ambiguous: original process lifetime unverified'
        assert h.get('maintenance', {}).get('phase') == 'running', 'Prior commit lease is still active; preserve it'
    saved = json.loads((prior/'before-identity.json').read_text())
    current = request_identity(h, target)
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


def restore_install(installed, stage, receipt):
    """Files only, after caller proves no core is live. Never restore the DB."""
    previous = stage/'previous-install'
    if previous.exists():
        failed = stage/'failed-candidate'
        assert not failed.exists(), 'Recovery already attempted'
        installed.rename(failed)
        previous.rename(installed)
    save(receipt/'rollback.json', {'phase': 'original-files-restored', 'databaseRestored': False})


def launch_core(cmd, cwd, env, receipt, name):
    with (receipt/('core.log' if name == 'successor' else name + '.log')).open('ab') as log:
        process = subprocess.Popen(cmd, cwd=cwd, env=env, stdin=subprocess.DEVNULL,
                                   stdout=log, stderr=log, start_new_session=True)
    return process


def await_ready(process):
    # Browser adoption/recovery can outlast a sampled readiness window. Keep this
    # same launch handle until readiness or actual exit; elapsed time is neither
    # startup failure nor permission to roll back a living successor.
    print(json.dumps({'phase': 'awaiting-readiness', 'pid': process.pid,
                      'action': 'retain this handle; no restart or rollback while live'}), flush=True)
    while process.poll() is None:
        try:
            result = health()
            if result['requestOk']:
                assert result['process']['pid'] == process.pid, 'Socket has a different core owner; preserve successor and inspect'
                assert result['browser']['state'] != 'error', 'Successor reports browser failure; preserve it and inspect core.log'
                if result['browser']['state'] == 'ready':
                    return result
        except (subprocess.SubprocessError, ValueError):
            pass
        time.sleep(1)
    raise RuntimeError(f'Core exited before readiness (exit {process.returncode}); inspect startup output')


def rollback_exited(h, old_pid, successor, chrome_ticks, installed, stage, receipt, cmd, cwd, env, target, identity):
    # Never kill a live successor or restore a database snapshot. This route is
    # only for a caught promotion/spawn failure or an already exited successor.
    assert not live(old_pid), 'Original core still live'
    assert successor is None or successor.poll() is not None, 'Live successor: preserve it and inspect'
    chrome = h['browser']['browserPid']
    assert live(chrome) and procstat(chrome)[19] == chrome_ticks, 'Browser identity changed; no automatic restart'
    lock = json.loads((pathlib.Path(h['browser']['profileDir'])/'.sessionplane-profile.lock').read_text())
    assert lock['browserPid'] == chrome and lock['pid'] in [old_pid, successor.pid if successor else old_pid], 'Foreign owner; no rollback'
    no_writer(h['database']['path'])
    with read_db(h) as db:
        assert db.execute('PRAGMA integrity_check').fetchone()[0] == 'ok', 'DB not healthy; no rollback'
        assert db.execute('SELECT COALESCE(MAX(version), 0) FROM schema_migrations').fetchone()[0] == h['database']['schemaVersion'], 'Schema changed; no old-code restart'
    current = request_identity(h, target)
    assert current['request'] == identity['request'] and current['anchor'] == identity['anchor']
    assert all(current['requests'].get(k) == v for k, v in identity['requests'].items())
    restore_install(installed, stage, receipt)
    restored = launch_core(cmd, cwd, env, receipt, 'rollback-core')
    save(receipt/'rollback-core.json', {'pid': restored.pid, 'startedAtUnix': time.time()})
    after = await_ready(restored)
    assert after['database']['path'] == h['database']['path'] and (after['database'].get('readable') is True or after['database']['integrity'] == 'ok')
    assert after['database']['schemaVersion'] == h['database']['schemaVersion']
    for key in ['browserPid', 'profileDir', 'debuggingPort']:
        assert after['browser'][key] == h['browser'][key]
    assert after['browser']['ownership'] == 'adopted' and procstat(chrome)[19] == chrome_ticks
    post = request_identity(after, target)
    assert post['request'] == identity['request'] and post['anchor'] == identity['anchor']
    assert all(post['requests'].get(k) == v for k, v in identity['requests'].items())
    verify_bindings(after, identity['bindings'], post['bindings'])
    save(receipt/'rollback-health.json', after)
    save(receipt/'rollback.json', {'phase': 'original-core-restored', 'pid': restored.pid, 'databaseRestored': False})
    return restored


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
    current_identity = request_identity(h, target)
    for key in ['request', 'anchor']:
        assert list(current_identity[key]) == prior_identity[key], 'Original request evidence changed since abort'
    # Legacy helper installed before its final guard. Only its exact pinned bytes
    # are accepted here, not a mixed or unknown live installation.
    verify_package(installed, pkg, manifest)


def validate_candidate(manifest, local_validation):
    if local_validation is None:
        assert manifest.get('ciConclusion') == 'success', 'Candidate CI not successful'
        return
    report = json.loads(local_validation.read_text())
    if report.get('contract') == 'sessionplane-candidate-acceptance-v1':
        source = report.get('source', {})
        assert source.get('head') == manifest['sourceCommit'], 'Local validation source differs'
        assert source.get('tree') == manifest.get('sourceTree'), 'Local validation tree differs'
        assert source.get('currentHead') == source.get('head') and source.get('currentTree') == source.get('tree'), 'Candidate source changed during acceptance'
        assert source.get('currentWorktreeClean') is True and source.get('buildMatchesCleanHead') is True, 'Candidate acceptance was not clean and bound'
        assert source.get('sourceIssues') == [], 'Candidate source provenance has issues'
        assert report.get('externalPackageSha256') == manifest['packageSha256'], 'Local validation package differs'
        assert report.get('candidateL1L2L4Passed') is True, 'Candidate acceptance gates did not pass'
        required = manifest.get('requiredGates', [
            'typecheck', 'public-core-ci', 'chromium-composition', 'four-background-tabs',
            'browser-transport-comparison', 'semantic-adapter', 'clean-build',
            'installed-tarball-core'])
        gates = {gate.get('name'): gate for gate in report.get('gates', [])}
        assert set(required).issubset(gates), 'Candidate acceptance is missing required gates'
        for name in required:
            gate = gates[name]
            assert gate.get('passed') is True and gate.get('exitCode') == 0, 'Candidate gate failed: ' + name
            if gate.get('assertionsFailed') is not None:
                assert gate['assertionsFailed'] == 0, 'Candidate assertions failed: ' + name
            if gate.get('skipped') is not None:
                assert gate['skipped'] == 0, 'Candidate gate skipped assertions: ' + name
        return
    # Retain the established legacy local receipt parser for old same-schema
    # bundles. A schema-transition bundle must use the acceptance-v1 contract.
    assert 'schemaTransition' not in manifest, 'Schema transition needs candidate-acceptance-v1 evidence'
    assert report['sourceCommit'] == manifest['sourceCommit'], 'Local validation source differs'
    assert report['packageSha256'] == manifest['packageSha256'], 'Local validation package differs'
    assert report['typecheck'] == report['build'] == 'success', 'Local build validation incomplete'
    log = pathlib.Path(report['fullTestLog']).read_bytes()
    assert hashlib.sha256(log).hexdigest() == report['fullTestLogSha256'], 'Validation log changed'
    result = log.decode()
    assert report['passed'] > 0 and f'ℹ tests {report["passed"]}\n' in result
    assert f'ℹ pass {report["passed"]}\n' in result and 'ℹ fail 0\n' in result
    assert 'ℹ cancelled 0\n' in result and 'ℹ skipped 0\n' in result, 'Local suite incomplete'
    if report.get('fullTestSourceCommit', report['sourceCommit']) != report['sourceCommit']:
        assert report.get('focusedTestSourceCommit') == report['sourceCommit'], 'Changed source needs current focused evidence'
        focused = pathlib.Path(report['focusedTestLog']).read_bytes()
        assert hashlib.sha256(focused).hexdigest() == report['focusedTestLogSha256'], 'Focused log changed'
        focused = focused.decode()
        count = report['focusedPassed']
        assert count > 0 and all(line in focused for line in [f'ℹ tests {count}\n', f'ℹ pass {count}\n',
            'ℹ fail 0\n', 'ℹ cancelled 0\n', 'ℹ skipped 0\n']), 'Focused suite incomplete'


def schema_transition(manifest, current_schema):
    transition = manifest.get('schemaTransition')
    if transition is None:
        return None
    assert set(transition) == {'from', 'to'}, 'Schema transition contract is ambiguous'
    source, target = transition['from'], transition['to']
    assert isinstance(source, int) and isinstance(target, int) and target >= source >= 0
    assert current_schema == source, 'Live schema differs from transition source'
    return source, target

def require_admission_fence(h, required):
    if required:
        assert h.get('maintenance', {}).get('phase') == 'running', 'Core admission fence unavailable or already leased; no legacy fallback'


def prepare_maintenance(h, recovery_handover=False):
    if h.get('maintenance', {}).get('coordinatedDrain'):
        lease = maintenance_rpc(h, 'system.maintenance.quiesce', lease_owner(h))
        try:
            while lease['phase'] != 'ready':
                # Bootstrap only: old cores track recovery operations but incorrectly
                # require the external generation to finish. Keep admission closed;
                # the existing bounded freeze/DB guards perform the atomic exit.
                if recovery_handover and lease['phase'] == 'draining' and lease['activeOperations'] == 0:
                    return lease
                time.sleep(1)
                lease = maintenance_rpc(h, 'system.maintenance.quiesce', {**lease_owner(h), 'token': lease['token']})
            return lease
        except BaseException:
            maintenance_rpc(h, 'system.maintenance.resume', {**lease_owner(h), 'token': lease['token']})
            raise
    # Long read/wait calls are not interrupted by maintenance. Let their current
    # round finish before starting the short fenced drain; admission stays open.
    while True:
        current = health()
        writer = False
        try:
            guard(current, h, require_idle=False)
        except LockActivityError as error:
            # The original core may finish its current WAL write while we wait.
            # Foreign, unknown or reused holders are still rejected.
            writer = drainable_writer(error.report, h['process']['pid'], procstat(h['process']['pid'])[19])
        require_admission_fence(current, True)
        if not writer and current['maintenance']['activeOperations'] == 0 and current['metrics']['session_actor_queue_depth'] == 0:
            break
        time.sleep(.1)
    # The quiet sample is only scheduling: the fence and post-fence guards still
    # decide whether a concurrent caller permits the actual transition.
    return maintenance_rpc(h, 'system.maintenance.prepare', {
        **lease_owner(h), 'drainTimeoutMs': 5000, 'leaseMs': 30000})


class LiveSuccessorError(RuntimeError):
    pass


def sqlite_schema(path):
    with closing(sqlite3.connect(pathlib.Path(path).resolve().as_uri() + '?mode=ro', uri=True)) as db:
        row = db.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name='schema_migrations'").fetchone()
        return int(db.execute('SELECT COALESCE(MAX(version),0) FROM schema_migrations').fetchone()[0]) if row else 0


def verify_sqlite(path, expected_schema=None):
    with closing(sqlite3.connect(pathlib.Path(path).resolve().as_uri() + '?mode=ro', uri=True)) as db:
        integrity = db.execute('PRAGMA integrity_check').fetchall()
        assert integrity == [('ok',)], 'SQLite full integrity check failed'
        foreign = db.execute('PRAGMA foreign_key_check').fetchall()
        assert not foreign, 'SQLite foreign-key check failed'
        schema = sqlite_schema(path)
        if expected_schema is not None:
            assert schema == expected_schema, f'Expected schema {expected_schema}, got {schema}'
        return {'schemaVersion': schema, 'integrity': 'ok', 'foreignKeyViolations': 0}


def run_offline(candidate, mode, options, log_path, timeout=1800):
    helper = candidate/'scripts/offline-state-rehearsal.mjs'
    command = ['node', str(helper), mode]
    for key, value in options.items():
        command += ['--' + key, str(value)]
    result = subprocess.run(command, text=True, capture_output=True, timeout=timeout)
    pathlib.Path(log_path).write_text(json.dumps({
        'command': command, 'exitCode': result.returncode,
        'stdout': result.stdout, 'stderr': result.stderr,
    }, indent=2))
    pathlib.Path(log_path).chmod(0o600)
    if result.returncode != 0:
        raise RuntimeError(f'Offline state {mode} failed; inspect {log_path}')
    lines = [line for line in result.stdout.splitlines() if line.strip()]
    assert lines, 'Offline state helper returned no receipt'
    return json.loads(lines[-1])


def seed_transition_evidence(candidate, database_path, receipt):
    marker = 'handover-' + uuid.uuid4().hex
    script = r"""
import { pathToFileURL } from 'node:url';
const [root, file, marker] = process.argv.slice(1);
const { SessionPlaneDatabase } = await import(pathToFileURL(root + '/dist/storage/database.js').href);
const { TaskKernelRepository } = await import(pathToFileURL(root + '/dist/storage/task-kernel-repository.js').href);
const database = SessionPlaneDatabase.open(file);
try {
  const store = new TaskKernelRepository(database);
  for (const [index, phase] of ['uncertain', 'final', 'draft'].entries()) {
    const projectId = marker + '-project-' + index;
    const taskId = marker + '-task-' + index;
    const attemptId = marker + '-attempt-' + index;
    store.openProject({ projectId, clientId: marker, projectKey: projectId, displayName: phase });
    store.openSlot({ projectId, clientId: marker, slotId: 'main', roleKey: 'main', providerKey: 'chatgpt' });
    store.startTask({ taskId, projectId, slotId: 'main', clientId: marker,
      requestId: marker + '-start-' + phase, expectedSlotRevision: 1, prompt: 'handover ' + phase });
    store.planAttempt({ taskId, clientId: marker, attemptId,
      kind: 'initial', turnKey: 'root', content: 'handover ' + phase });
    if (phase !== 'draft') store.beginDispatch(taskId, marker, attemptId);
    if (phase === 'uncertain') store.markUncertain(taskId, marker, attemptId, 'handover-lost-ack');
    if (phase === 'final') {
      store.acknowledgeAttempt({ taskId, clientId: marker, attemptId, externalTurnId: marker + '-turn' });
      store.recordFinal({ taskId, clientId: marker, attemptId,
        externalTurnId: marker + '-turn', resultId: marker + '-result',
        answerText: 'handover exact final\n  retained', completeTask: true });
    }
  }
} finally { database.close(); }
console.log(JSON.stringify({ marker }));
"""
    result = subprocess.run(['node', '--input-type=module', '-e', script,
        str(candidate), str(database_path), marker], text=True, capture_output=True, timeout=60)
    save(receipt/'rehearsal-task-write.json', {'exitCode': result.returncode,
        'stdout': result.stdout, 'stderr': result.stderr, 'marker': marker})
    if result.returncode != 0:
        raise RuntimeError('Unable to write isolated rollback rehearsal evidence')
    return marker


def verify_transition_evidence(path, marker):
    verify_sqlite(path)
    with closing(sqlite3.connect(pathlib.Path(path))) as db:
        rows = db.execute('SELECT task_id,state FROM kernel_attempts WHERE task_id LIKE ? ORDER BY task_id',
                          (marker + '-task-%',)).fetchall()
        answer = db.execute('SELECT answer_text FROM kernel_results WHERE task_id LIKE ?',
                            (marker + '-task-%',)).fetchone()
    assert [row[1] for row in rows] == ['uncertain', 'acknowledged', 'planned'], 'Rollback evidence states changed'
    assert answer == ('handover exact final\n  retained',), 'Rollback FINAL bytes changed'
    return {'marker': marker, 'attemptStates': [row[1] for row in rows],
            'finalSha256': hashlib.sha256(answer[0].encode()).hexdigest()}


def rehearse_schema_transition(candidate, source_path, transition, receipt):
    source_schema, target_schema = transition
    migration = receipt/'preflight-migration'
    rollback = receipt/'preflight-rollback'
    migrated = run_offline(candidate, 'migrate', {
        'source': source_path, 'destination': migration,
    }, receipt/'preflight-migration.log')
    assert migrated['sourceSchemaVersion'] == source_schema, 'Rehearsal source schema differs'
    assert migrated['schemaVersion'] == target_schema, 'Rehearsal target schema differs'
    assert migrated['integrityCheck'] == 'ok' and migrated['foreignKeyViolations'] == 0
    assert all(row['count'] == 0 for row in migrated.get('createdKernelTables', [])), 'Task/slot collision in migrated copy'
    candidate_db = migration/'candidate.sqlite'
    marker = seed_transition_evidence(candidate, candidate_db, receipt)
    candidate_hash = sha256_file(candidate_db)
    rolled = run_offline(candidate, 'rollback', {
        'migration': migration, 'candidate': candidate_db, 'destination': rollback,
    }, receipt/'preflight-rollback.log')
    assert rolled['candidateWasNeverOverwritten'] and rolled['postMigrationEvidencePreserved']
    assert sha256_file(candidate_db) == candidate_hash, 'Rollback rehearsal overwrote candidate'
    evidence = verify_transition_evidence(rollback/'post-migration-evidence.sqlite', marker)
    verify_sqlite(rollback/'restored-original.sqlite', source_schema)
    report = {'migration': migrated, 'rollback': rolled, 'evidence': evidence,
              'candidateSha256AfterTaskWrites': candidate_hash}
    save(receipt/'schema-transition-rehearsal.json', report)
    return report


def promote_database(database_path, migration_dir, receipt, transition):
    source_schema, target_schema = transition
    database_path = pathlib.Path(database_path)
    candidate = pathlib.Path(migration_dir)/'candidate.sqlite'
    verify_sqlite(candidate, target_schema)
    verify_sqlite(pathlib.Path(migration_dir)/'source-snapshot.sqlite', source_schema)
    assert candidate.stat().st_dev == database_path.parent.stat().st_dev, 'Database promotion must be same-filesystem'
    # Keep the sealed migrated candidate beside its manifest. A private copy is
    # the only file renamed into the live path, so the migration receipt remains
    # independently verifiable after success or rollback.
    staged = database_path.parent/('.sessionplane-promote-' + uuid.uuid4().hex + '.sqlite')
    shutil.copy2(candidate, staged); staged.chmod(0o600)
    verify_sqlite(staged, target_schema)
    archive = receipt/'database-archive'
    archive.mkdir(mode=0o700)
    moved = []
    try:
        for suffix in ['', '-wal', '-shm']:
            current = pathlib.Path(str(database_path) + suffix)
            if current.exists():
                target = archive/(database_path.name + suffix)
                current.rename(target)
                moved.append((target, current))
        staged.rename(database_path)
        verify_sqlite(database_path, target_schema)
    except BaseException:
        if database_path.exists() and sqlite_schema(database_path) == target_schema:
            failed = archive/'uncommitted-candidate.sqlite'
            if not failed.exists(): database_path.rename(failed)
        if staged.exists(): staged.unlink()
        for archived, original in reversed(moved):
            if archived.exists() and not original.exists(): archived.rename(original)
        raise
    report = {'phase': 'promoted', 'sourceSchemaVersion': source_schema,
              'targetSchemaVersion': target_schema, 'livePath': str(database_path),
              'archive': str(archive), 'archivedFiles': [str(pair[0]) for pair in moved],
              'sealedCandidate': str(candidate), 'sealedCandidateSha256': sha256_file(candidate),
              'liveSha256': sha256_file(database_path)}
    save(receipt/'database-promotion.json', report)
    return report

def systemd_properties(unit):
    result = subprocess.check_output(['systemctl', '--user', 'show', unit,
        '-p', 'ActiveState', '-p', 'SubState', '-p', 'MainPID', '-p', 'Restart',
        '--no-pager'], text=True)
    values = {}
    for line in result.splitlines():
        if '=' in line:
            key, value = line.split('=', 1); values[key] = value
    values['MainPID'] = int(values.get('MainPID', '0') or 0)
    return values


def verify_systemd_owner(unit, pid):
    props = systemd_properties(unit)
    assert props['MainPID'] == pid and props['ActiveState'] == 'active', 'Systemd unit does not own exact old Core'
    assert props.get('Restart') == 'no', 'Core-only maintenance exit requires Restart=no'
    return props


def start_systemd_core(unit, receipt, label):
    subprocess.run(['systemctl', '--user', 'start', unit], check=True,
                   stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
    props = systemd_properties(unit)
    save(receipt/(label + '-systemd.json'), props)
    assert props['MainPID'] > 0, 'Systemd did not start a Core process'
    return props['MainPID']


def await_systemd_ready(unit, expected_pid, timeout=180):
    deadline = time.monotonic() + timeout
    last = None
    while time.monotonic() < deadline:
        props = systemd_properties(unit)
        if props['MainPID'] not in (0, expected_pid):
            raise RuntimeError('Systemd replaced the pinned successor unexpectedly')
        if props['MainPID'] == 0 or props['ActiveState'] in ('failed', 'inactive'):
            raise RuntimeError('Core exited before readiness')
        try:
            last = health()
            if last['process']['pid'] != expected_pid:
                raise RuntimeError('Socket has a different Core owner')
            if last['browser']['state'] == 'error':
                raise LiveSuccessorError('Live successor reports browser failure; preserve it')
            if last['requestOk'] and last['browser']['state'] == 'ready':
                return last
        except (subprocess.SubprocessError, ValueError, FileNotFoundError):
            pass
        time.sleep(1)
    if live(expected_pid):
        raise LiveSuccessorError('Live successor did not become ready in bounded observation; preserve it')
    raise RuntimeError('Core exited before readiness')


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
    verify_sqlite(h['database']['path'], h['database']['schemaVersion'])
    old = start_systemd_core(unit, receipt, 'rollback-core')
    save(receipt/'rollback-core.json', {'pid': old, 'startedAtUnix': time.time()})
    after = await_systemd_ready(unit, old)
    assert after['database']['schemaVersion'] == h['database']['schemaVersion']
    for key in ['browserPid', 'profileDir', 'debuggingPort']:
        assert after['browser'][key] == h['browser'][key]
    assert after['browser']['ownership'] == 'adopted'
    assert procstat(h['browser']['browserPid'])[19] == chrome_ticks
    post = request_identity(after, target)
    assert post['request'] == identity['request'] and post['anchor'] == identity['anchor']
    save(receipt/'rollback-health.json', after)
    save(receipt/'rollback.json', {'phase': 'original-core-restored', 'pid': old,
                                   'databaseRestored': False})
    return after


def execute_schema_transition(h, transition, manifest, installed, candidate, stage, receipt,
                              unit, target, identity, chrome_ticks, catalog_hash):
    database_path = pathlib.Path(h['database']['path'])
    package_promoted = False
    database_promoted = False
    successor_pid = None
    final_migration = receipt/'final-migration'
    try:
        final = run_offline(candidate, 'migrate', {
            'source': database_path, 'destination': final_migration,
        }, receipt/'final-migration.log')
        assert final['sourceSchemaVersion'] == transition[0] and final['schemaVersion'] == transition[1]
        assert final['integrityCheck'] == 'ok' and final['foreignKeyViolations'] == 0
        assert all(row['count'] == 0 for row in final.get('createdKernelTables', []))
        save(receipt/'final-migration.json', final)
        promote_package(installed, candidate, stage, receipt); package_promoted = True
        promote_database(database_path, final_migration, receipt, transition); database_promoted = True
        successor_pid = start_systemd_core(unit, receipt, 'successor')
        save(receipt/'successor.json', {'pid': successor_pid, 'startedAtUnix': time.time(),
                                       'systemdUnit': unit})
        after = await_systemd_ready(unit, successor_pid)
        return after, successor_pid
    except LiveSuccessorError:
        save(receipt/'rollback-blocked.json', {'reason': 'successor-live',
            'pid': successor_pid, 'action': 'preserve live successor, browser, database and evidence'})
        raise
    except Exception as error:
        save(receipt/'startup-failure.json', {'error': str(error), 'packagePromoted': package_promoted,
             'databasePromoted': database_promoted, 'successorPid': successor_pid})
        props = systemd_properties(unit)
        if props['MainPID'] and live(props['MainPID']):
            save(receipt/'rollback-blocked.json', {'reason': 'successor-live',
                'pid': props['MainPID'], 'action': 'preserve live successor; no automatic rollback'})
            raise LiveSuccessorError('Transition failed while successor is live; rollback blocked') from error
        if database_promoted:
            rollback_dir = receipt/'failed-candidate-rollback'
            rolled = run_offline(installed, 'rollback', {
                'migration': final_migration, 'candidate': database_path,
                'destination': rollback_dir,
            }, receipt/'failed-candidate-rollback.log')
            assert rolled['postMigrationEvidencePreserved'] and rolled['candidateWasNeverOverwritten']
            failed_files = archive_failed_candidate(database_path, receipt/'failed-candidate-database')
            restore_original_database(database_path, rollback_dir/'restored-original.sqlite')
            verify_sqlite(database_path, transition[0])
            save(receipt/'failed-candidate-evidence.json', {'rollback': rolled,
                 'archivedLiveFiles': failed_files,
                 'postMigrationEvidence': str(rollback_dir/'post-migration-evidence.sqlite')})
            restart_original_systemd(h, unit, installed, stage, receipt, target, identity,
                                     chrome_ticks, restore_files=package_promoted)
        elif package_promoted:
            restart_original_systemd(h, unit, installed, stage, receipt, target, identity,
                                     chrome_ticks, restore_files=True)
        else:
            restart_original_systemd(h, unit, installed, stage, receipt, target, identity,
                                     chrome_ticks, restore_files=False)
        raise RuntimeError('Schema transition failed; original Core restored with evidence preserved') from error


def single_core_writer(database_path, expected_pid):
    report = lock_report(database_path)
    holders = {row['holder']['pid'] for row in report['locks'] if row['holder']['pid'] not in (None, 0)}
    assert holders.issubset({expected_pid}), 'Foreign or duplicate database holder after handover'
    return report


def materialize_bundle(policy_path, package_path, acceptance_path, destination, rollback_install):
    policy = json.loads(pathlib.Path(policy_path).read_text())
    assert policy.get('kind') == 'sessionplane-core-handover-policy-v2'
    assert policy.get('manifestVersion') == 2
    assert policy.get('validationContract') == 'sessionplane-candidate-acceptance-v1'
    package_path = pathlib.Path(package_path).resolve()
    acceptance_path = pathlib.Path(acceptance_path).resolve()
    destination = pathlib.Path(destination).resolve()
    rollback_install = pathlib.Path(rollback_install).resolve()
    assert package_path.is_file() and acceptance_path.is_file()
    assert rollback_install.is_dir() and not rollback_install.is_symlink()
    destination.mkdir(mode=0o700)
    copied = destination/package_path.name
    shutil.copy2(package_path, copied)
    stage = pathlib.Path(tempfile.mkdtemp(prefix='sessionplane-bundle-inspect-'))
    try:
        subprocess.run(['npm', 'install', '-g', '--prefix', str(stage), '--ignore-scripts',
                        '--no-audit', '--no-fund', str(copied)], check=True,
                       stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        installed = stage/'lib/node_modules/sessionplane'
        identity = json.loads((installed/'dist/build-identity.json').read_text())
        script = "import {pathToFileURL} from 'node:url'; import {createHash} from 'node:crypto'; const {MCP_TOOLS}=await import(pathToFileURL(process.argv[1]).href); console.log(createHash('sha256').update(JSON.stringify(MCP_TOOLS)).digest('hex'));"
        catalog = subprocess.check_output(['node', '--input-type=module', '-e', script,
            str(installed/'dist/mcp/tools.js')], text=True).strip()
        manifest = {
            'kind': 'sessionplane-core-handover-bundle-v2',
            'manifestVersion': 2,
            'validationContract': policy['validationContract'],
            'sourceCommit': identity['sourceCommit'],
            'sourceTree': identity['sourceTree'],
            'sourceState': identity['sourceState'],
            'version': identity['version'],
            'package': copied.name,
            'packageSha256': sha256_file(copied),
            'installedCatalogSha256': catalog,
            'candidateBrowserOwnerSha256': sha256_file(installed/'dist/browser/browser-owner.js'),
            'rollbackRuntimeBrowserOwnerSha256': sha256_file(rollback_install/'dist/browser/browser-owner.js'),
            'schemaTransition': policy['schemaTransition'],
            'requiredGates': policy['requiredGates'],
            'ciConclusion': None,
        }
        assert manifest['sourceState'] == 'clean'
        validate_candidate(manifest, acceptance_path)
        verify_package(installed, copied, manifest)
        save(destination/'manifest.json', manifest)
        save(destination/'bundle-receipt.json', {
            'manifestSha256': sha256_file(destination/'manifest.json'),
            'packageSha256': manifest['packageSha256'],
            'acceptance': str(acceptance_path),
            'rollbackInstall': str(rollback_install),
        })
        return manifest
    except BaseException:
        if not (destination/'manifest.json').exists():
            shutil.rmtree(destination, ignore_errors=True)
        raise
    finally:
        shutil.rmtree(stage, ignore_errors=True)


def bundle_main(argv):
    parser = argparse.ArgumentParser(description='Materialize an exact reviewed handover bundle')
    parser.add_argument('--policy', type=pathlib.Path, required=True)
    parser.add_argument('--package', type=pathlib.Path, required=True)
    parser.add_argument('--acceptance', type=pathlib.Path, required=True)
    parser.add_argument('--destination', type=pathlib.Path, required=True)
    parser.add_argument('--rollback-install', type=pathlib.Path, required=True)
    args = parser.parse_args(argv)
    manifest = materialize_bundle(args.policy, args.package, args.acceptance,
                                  args.destination, args.rollback_install)
    print(json.dumps(manifest, indent=2))


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
    if args.apply and not (args.issuers_quiesced or args.core_maintenance):
        parser.error('--apply requires supervisor-coordinated --issuers-quiesced')
    assert hasattr(os, 'pidfd_open') and hasattr(signal, 'pidfd_send_signal'), 'Linux pidfd support is required'
    root=args.bundle_dir.resolve()
    assert pwd.getpwuid(os.getuid()).pw_name==args.expected_user and socket.gethostname()==args.expected_host, 'Wrong original host/owner'
    os.umask(0o077)
    manifest=json.loads((root/'manifest.json').read_text())
    pkg=root/manifest['package']
    assert hashlib.sha256(pkg.read_bytes()).hexdigest()==manifest['packageSha256'], 'Package checksum mismatch'
    validate_candidate(manifest, args.local_validation)
    if args.apply and (root/'local-receipt').exists():
        assert args.resume_pre_signal is not None or args.resume_staged is not None, 'Existing attempt: inspect and explicitly resume a proven pre-signal abort'
        assert (args.resume_staged or args.resume_pre_signal).resolve() == (root/'local-receipt').resolve(), 'Existing bundle receipt must be the inspected prior attempt'
    h=health(); assert h['process']['pid']==args.core_pid and h['browser']['browserPid']==args.chrome_pid, 'PID differs from supplied live receipt'
    schema_change = schema_transition(manifest, h['database']['schemaVersion'])
    if schema_change is not None:
        assert args.systemd_unit, 'Schema transition requires the exact systemd unit owner'
        assert args.core_maintenance, 'Schema transition requires Core-owned maintenance fencing'
        verify_systemd_owner(args.systemd_unit, args.core_pid)
    require_admission_fence(h, args.core_maintenance)
    if args.legacy_recovery_handover:
        assert args.core_maintenance and h.get('maintenance', {}).get('coordinatedDrain') and not h['maintenance'].get('durableRecoveryHandover'), 'Legacy recovery migration requires the old coordinated admission fence'
    pid=args.core_pid; proc=pathlib.Path(f'/proc/{pid}')
    assert proc.stat().st_uid==os.getuid() and pathlib.Path(f'/proc/{args.chrome_pid}').stat().st_uid==os.getuid()
    ticks=procstat(pid)[19]; chrome_ticks=procstat(args.chrome_pid)[19]
    cmd=proc.joinpath('cmdline').read_bytes().rstrip(b'\0').decode().split('\0')
    cwd=os.readlink(proc/'cwd')
    assert cwd==args.expected_cwd and 'serve' in cmd and any('sessplane' in c for c in cmd), 'Unexpected core command'
    prefix=subprocess.check_output(['npm','prefix','-g'], text=True).strip()
    installed=pathlib.Path(prefix)/'lib/node_modules/sessionplane'
    assert installed.is_dir() and not installed.is_symlink() and os.access(installed,os.W_OK)
    if args.resume_pre_signal is not None:
        assert args.receipt_dir is not None, 'Resume requires a distinct --receipt-dir'
        assert args.receipt_dir.resolve() != args.resume_pre_signal.resolve(), 'Preserve prior receipt'
        verify_pre_signal_resume(args.resume_pre_signal.resolve(), h, installed, pkg, manifest, args)
    if args.resume_staged is not None:
        assert args.receipt_dir is not None and args.receipt_dir.resolve() != args.resume_staged.resolve(), 'Staged reentry needs a new receipt; preserve prior evidence'
        verify_staged_resume(args.resume_staged.resolve(), h, installed, args)
    # Rollback may restart only the reviewed browser-preserving adoption implementation.
    rollback_owner_sha = manifest.get('rollbackRuntimeBrowserOwnerSha256', manifest.get('runtimeBrowserOwnerSha256'))
    assert rollback_owner_sha and sha256_file(installed/'dist/browser/browser-owner.js') == rollback_owner_sha, 'Unreviewed original browser adoption; no automatic rollback path'
    identity=request_identity(h, args)
    # The supported fence drains recovery actors atomically. An idle sample before
    # acquiring it races those actors; all post-fence guards still require idle.
    guard_state(h,h,require_idle=not args.core_maintenance, recovery_handover=args.legacy_recovery_handover)
    if args.core_maintenance:
        # An admitted operation may still own the WAL writer before draining.
        # Foreign/checkpoint/recovery locks remain errors; post-drain is strict.
        writer_pending = drainable_writer(lock_report(h['database']['path']), pid, ticks)
    else:
        no_writer(h['database']['path'])
        writer_pending = False
    print(json.dumps({'phase':'preflight','corePid':pid,'chromePid':args.chrome_pid,'sourceCommit':manifest['sourceCommit'],'packageVerified':True,'actorDepth':h['metrics']['session_actor_queue_depth'],'activeSubmitCount':0,'ownWriterPendingDrain':writer_pending,'next':'apply through required core admission fence' if args.core_maintenance else 'apply only during coordinated issuer pause'},indent=2),flush=True)
    if not args.apply: return
    receipt=args.receipt_dir.resolve() if args.receipt_dir is not None else root/'local-receipt'
    receipt.mkdir(mode=0o700) # never rerun an issued handover blindly
    save(receipt/'validation-basis.json', {'mode': 'local' if args.local_validation else 'ci',
        'sourceCommit': manifest['sourceCommit'], 'packageSha256': manifest['packageSha256'],
        'localValidation': json.loads(args.local_validation.read_text()) if args.local_validation else None,
        'admission': 'core-maintenance' if args.core_maintenance else 'issuers-quiesced',
        'legacyRecoveryHandover': args.legacy_recovery_handover,
        'schemaTransition': manifest.get('schemaTransition'),
        'systemdUnit': args.systemd_unit})
    save(receipt/'before-health.json',h); save(receipt/'before-identity.json',identity)
    if args.resume_pre_signal is not None:
        save(receipt/'resumes.json', {'priorReceipt': str(args.resume_pre_signal.resolve()), 'meaning': 'same original live core; pinned candidate already on disk; runtime SHA not inferred from disk'})
    if args.resume_staged is not None:
        save(receipt/'resumes.json', {'priorReceipt': str(args.resume_staged.resolve()), 'meaning': 'verified staging-only abort; live installation unchanged'})
    runtime_env=dict(item.split('=',1) for item in proc.joinpath('environ').read_text().split('\0') if '=' in item)
    subprocess.run(['tar','-czf',str(receipt/'previous-install.tgz'),'-C',str(installed.parent),'sessionplane'],check=True)
    with read_db(h) as db, closing(sqlite3.connect(receipt/'predeploy.sqlite')) as backup:
        db.backup(backup); assert backup.execute('PRAGMA integrity_check').fetchone()[0]=='ok'
    stage, candidate, catalog_hash = stage_package(installed, pkg, manifest, receipt)
    if schema_change is not None:
        rehearse_schema_transition(candidate, h['database']['path'], schema_change, receipt)
    # Pin the exact process lifetime. No process groups, killall, SIGTERM, or browser signals.
    fd=os.pidfd_open(pid)
    lease = None
    try:
        if 'maintenance' in h:
            lease = prepare_maintenance(h, recovery_handover=args.legacy_recovery_handover)
            assert lease['phase'] == 'ready' or (args.legacy_recovery_handover and lease['phase'] == 'draining' and lease['activeOperations'] == 0), 'Core has not drained'
            save(receipt/'maintenance.json', lease)
        if lease is None:
            current = prefreeze_drain(h, ticks, chrome_ticks, args, identity, receipt)
        else:
            for _ in range(2):
                current=health(); guard(current,h, recovery_handover=args.legacy_recovery_handover)
                if args.legacy_recovery_handover:
                    assert current['maintenance']['phase'] == 'draining' and current['maintenance']['activeOperations'] == 0, 'Core admission changed'
                assert procstat(pid)[19]==ticks and procstat(args.chrome_pid)[19]==chrome_ticks, 'PID reused'
                assert request_identity(current, args)['request']==identity['request']
            no_writer(h['database']['path'])
        transition = {'phase':'drained-core-only-transition','oldPid':pid,'oldStartTicks':ticks,'chromePid':args.chrome_pid,'atUnix':time.time(),'sourceCommit':manifest['sourceCommit']}
        if lease is not None and not args.legacy_recovery_handover:
            # The core rechecks the lease synchronously and exits without closing Chrome.
            # EOF is not success until the pinned process is independently gone below.
            save(receipt/'handover.json', transition)
            maintenance_rpc(h, 'system.maintenance.commit', {**lease_owner(h), 'token': lease['token']}, True)
        else:
            save(receipt/'transition-phase.json', {'phase': 'freeze-requested'})
            with frozen_core(fd, pid, ticks) as commit:
                save(receipt/'transition-phase.json', {'phase': 'frozen-guard'})
                # Frozen core cannot race this DB/lock check. Do not issue health RPC.
                frozen_guard(current, h, ticks, chrome_ticks, args, identity, recovery_handover=args.legacy_recovery_handover)
                save(receipt/'handover.json', transition)
                commit()
    except LockActivityError as error:
        save(receipt/'abort-locks.json', error.report)
        raise
    finally:
        os.close(fd)
        if lease is not None and live(pid):
            try:
                maintenance_rpc(h, 'system.maintenance.resume', {**lease_owner(h), 'token': lease['token']})
            except (OSError, RuntimeError) as error:
                # Lost/expired/revoked lease: the bounded core timer still resumes operation.
                save(receipt/'maintenance-resume.json', {'result': 'not-confirmed', 'error': str(error),
                    'expiresAt': lease['expiresAt']})
    deadline=time.monotonic()+5
    while live(pid) and time.monotonic()<deadline: time.sleep(.1)
    assert not live(pid), 'Old core still live: do not launch duplicate'
    assert live(args.chrome_pid) and procstat(args.chrome_pid)[19]==chrome_ticks, 'Browser no longer preserved: stop'
    successor = None
    if schema_change is not None:
        after, successor_pid = execute_schema_transition(
            h, schema_change, manifest, installed, candidate, stage, receipt,
            args.systemd_unit, args, identity, chrome_ticks, catalog_hash)
    else:
        try:
            promote_package(installed, candidate, stage, receipt)
            successor = launch_core(cmd, cwd, runtime_env, receipt, 'successor')
            save(receipt/'successor.json', {'pid': successor.pid, 'startedAtUnix': time.time()})
            after = await_ready(successor)
            successor_pid = successor.pid
        except Exception as error:
            save(receipt/'startup-failure.json', {'error': str(error), 'rollback': 'pending'})
            try:
                rollback_exited(h, pid, successor, chrome_ticks, installed, stage, receipt,
                               cmd, cwd, runtime_env, args, identity)
            except Exception as recovery_error:
                save(receipt/'rollback-blocked.json', {'error': str(recovery_error), 'action': 'preserve browser/DB and inspect; do not retry'})
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
    assert procstat(args.chrome_pid)[19]==chrome_ticks
    post=request_identity(after,args)
    assert post['request']==identity['request'] and post['anchor']==identity['anchor']
    assert all(post['requests'].get(k)==v for k,v in identity['requests'].items()), 'Durable request changed'
    verify_bindings(after, identity['bindings'], post['bindings'])
    locks = single_core_writer(h['database']['path'], successor_pid)
    save(receipt/'after-locks.json', locks)
    save(receipt/'after-health.json',after)
    save(receipt/'after-identity.json',post)
    result={'sourceCommit':manifest['sourceCommit'],'sourceTree':manifest.get('sourceTree'),
        'packageSha256':manifest['packageSha256'],'oldPid':pid,'newPid':successor_pid,
        'chromePid':args.chrome_pid,'schemaBefore':h['database']['schemaVersion'],
        'schemaAfter':expected_schema,'databaseIntegrity':'ok',
        'requestAndAnchorPreserved':True,'bindingIdentityPreserved':True,
        'browserIdentityPreserved':True,'browserOwnership':'adopted',
        'singleCoreWriterVerified':True,'installedCatalogSha256':catalog_hash,
        'systemdUnit':args.systemd_unit,'liveL3':'pending'}
    save(receipt/'result.json',result); print(json.dumps(result,indent=2))

if __name__=='__main__':
    if sys.argv[1:2] == ['bundle']:
        bundle_main(sys.argv[2:])
    elif sys.argv[1:2] == ['locks']:
        parser = argparse.ArgumentParser(description='Read-only current lock metadata; no SQLite connection or core call')
        parser.add_argument('--database', required=True)
        args = parser.parse_args(sys.argv[2:])
        print(json.dumps(lock_report(args.database), indent=2))
    else:
        try:
            main()
        except LockActivityError as error:
            print(json.dumps({'error': str(error), 'lockEvidence': error.report}), file=sys.stderr)
            raise SystemExit(1)
