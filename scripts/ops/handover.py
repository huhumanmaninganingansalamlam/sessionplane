#!/usr/bin/env python3
"""Established, drained, exact-core-only replacement. No SSH or browser protocol calls.
Run only after original owners have paused issuing new mutations for this short handover.
The old core has no atomic admission fence: sampled health is not a substitute for that coordination.
"""
import argparse, datetime, hashlib, json, os, pathlib, pwd, signal, socket, sqlite3, subprocess, sys, tarfile, tempfile, time
from contextlib import closing, contextmanager

if not __debug__:
    raise SystemExit('Optimized Python disables safety assertions; run without -O or PYTHONOPTIMIZE')

def save(path, value):
    path.write_text(json.dumps(value, indent=2)); path.chmod(0o600)

def health(timeout=15):
    return json.loads(subprocess.check_output(['sessplane', 'health', '--json'], text=True, timeout=timeout))

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
    except FileNotFoundError: return False

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

def guard(h, expected):
    assert h['requestOk'] and h['browser']['state']=='ready' and h['database']['integrity']=='ok'
    for key in ['pid','startedAt']: assert h['process'][key]==expected['process'][key], 'Core owner changed'
    for key in ['browserPid','profileDir','debuggingPort']: assert h['browser'][key]==expected['browser'][key], 'Browser identity changed'
    assert h['metrics']['session_actor_queue_depth']==0, 'Actor running or queued; natural drain required'
    with read_db(h) as db:
        assert db.execute("SELECT count(*) FROM outbox WHERE submission_state IN ('submit_attempted','composer_filled')").fetchone()[0]==0, 'Active submission'
        assert db.execute("SELECT count(*) FROM outbox o JOIN generations g ON g.session_id=o.session_id AND g.generation=o.generation WHERE json_extract(o.payload_json,'$.thinkingFailureRecovery')=1 AND g.completed_at IS NULL").fetchone()[0]==0, 'Opted-in recovery still active'
    lock=json.loads((pathlib.Path(h['browser']['profileDir'])/'.sessionplane-profile.lock').read_text())
    assert lock['pid']==h['process']['pid'] and lock['browserPid']==h['browser']['browserPid']
    no_writer(h['database']['path'])

def prefreeze_drain(h, ticks, chrome_ticks, target, identity, receipt, timeout=5):
    """Two bounded validation passes with one independent natural-writer drain."""
    started = time.monotonic()
    deadline = started + timeout
    samples = []
    timings = []
    drained = False
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
        while True:
            deadline = time.monotonic() + timeout
            try:
                for index in range(2):
                    phase = f'live-guard-{index+1}'
                    save(receipt/'transition-phase.json', {'phase': phase})
                    pinned()
                    with measured('health'):
                        current = health(timeout=remaining())
                    with measured('guard'):
                        guard(current, h)
                    pinned()
                    with measured('request-identity'):
                        assert request_identity(current, target)['request'] == identity['request']
                    remaining()
                phase = 'live-final-writer'
                save(receipt/'transition-phase.json', {'phase': phase})
                no_writer(h['database']['path'])
                remaining()
                return current
            except LockActivityError as error:
                remaining()  # Slow validation cannot claim a fresh drain allowance.
                if drained:
                    raise  # One revalidation only; no repeated health/drain cycle.
                drained = True
                deadline = time.monotonic() + timeout
                report = error.report
                while True:
                    pinned()
                    samples.append({'phase': phase, **report})
                    blocking = [row for row in report['locks'] if row['blocksHandover']]
                    # Other/unknown owners and lock kinds retain immediate refusal.
                    if not all(row['classification'] == 'wal-writer' and
                               row['holder']['pid'] == h['process']['pid'] and
                               row['holder']['startTicks'] == ticks for row in blocking):
                        raise LockActivityError(report)
                    if time.monotonic() >= deadline: raise LockActivityError(report)
                    time.sleep(min(.1, remaining()))
                    pinned()
                    report = lock_report(h['database']['path'])  # No RPC/SQLite while polling.
                    if not any(row['blocksHandover'] for row in report['locks']):
                        samples.append({'phase': 'quiet-observed', **report})
                        remaining()
                        break  # Both full guards receive a fresh bounded validation budget.
    finally:
        save(receipt/'writer-drain.json', {'phase': phase, 'timeoutSeconds': timeout,
                                         'maxValidationPasses': 2, 'maxTotalSeconds': 3 * timeout,
                                         'elapsedSeconds': time.monotonic() - started,
                                         'timings': timings, 'samples': samples})


def verify_package(installed, pkg, manifest):
    with tarfile.open(pkg) as archive:
        for member in archive.getmembers():
            if member.isfile():
                assert (installed/member.name.removeprefix('package/')).read_bytes() == archive.extractfile(member).read(), 'Package bytes differ'
    script = "import {pathToFileURL} from 'node:url'; import {createHash} from 'node:crypto'; const {MCP_TOOLS}=await import(pathToFileURL(process.argv[1]).href); console.log(createHash('sha256').update(JSON.stringify(MCP_TOOLS)).digest('hex'));"
    catalog = subprocess.check_output(['node', '--input-type=module', '-e', script, str(installed/'dist/mcp/tools.js')], text=True).strip()
    assert catalog == manifest['installedCatalogSha256'], 'MCP catalog differs'
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
    assert all(not (prior/n).exists() for n in ['handover.json', 'successor.json', 'promotion.json']), 'Transition history ambiguous; do not reenter'
    before = json.loads((prior/'before-health.json').read_text())
    for key in ['pid', 'startedAt']:
        assert before['process'][key] == h['process'][key], 'Original core lifetime changed'
    for key in ['browserPid', 'profileDir', 'debuggingPort']:
        assert before['browser'][key] == h['browser'][key], 'Browser identity changed'
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


def await_ready(process, timeout=60):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline and process.poll() is None:
        try:
            result = health()
            if result['requestOk'] and result['process']['pid'] == process.pid and result['browser']['state'] == 'ready':
                return result
        except (subprocess.SubprocessError, ValueError):
            pass
        time.sleep(1)
    raise RuntimeError('Core not ready; live successors must not be killed or replaced')


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
    assert after['database']['path'] == h['database']['path'] and after['database']['integrity'] == 'ok'
    assert after['database']['schemaVersion'] == h['database']['schemaVersion']
    for key in ['browserPid', 'profileDir', 'debuggingPort']:
        assert after['browser'][key] == h['browser'][key]
    assert after['browser']['ownership'] == 'adopted' and procstat(chrome)[19] == chrome_ticks
    post = request_identity(after, target)
    assert post['request'] == identity['request'] and post['anchor'] == identity['anchor']
    assert all(post['requests'].get(k) == v for k, v in identity['requests'].items())
    assert all(row in post['bindings'] for row in identity['bindings'])
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


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--apply', action='store_true')
    parser.add_argument('--issuers-quiesced', action='store_true')
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
    args=parser.parse_args()
    assert not (args.resume_staged and args.resume_pre_signal), 'Choose exactly one reentry contract'
    if args.apply and not args.issuers_quiesced:
        parser.error('--apply requires supervisor-coordinated --issuers-quiesced')
    assert hasattr(os, 'pidfd_open') and hasattr(signal, 'pidfd_send_signal'), 'Linux pidfd support is required'
    root=args.bundle_dir.resolve()
    assert pwd.getpwuid(os.getuid()).pw_name==args.expected_user and socket.gethostname()==args.expected_host, 'Wrong original host/owner'
    os.umask(0o077)
    manifest=json.loads((root/'manifest.json').read_text())
    pkg=root/manifest['package']
    assert hashlib.sha256(pkg.read_bytes()).hexdigest()==manifest['packageSha256'], 'Package checksum mismatch'
    assert manifest['ciConclusion']=='success', 'Candidate CI not successful'
    if args.apply and (root/'local-receipt').exists():
        assert args.resume_pre_signal is not None or args.resume_staged is not None, 'Existing attempt: inspect and explicitly resume a proven pre-signal abort'
        assert (args.resume_staged or args.resume_pre_signal).resolve() == (root/'local-receipt').resolve(), 'Existing bundle receipt must be the inspected prior attempt'
    h=health(); assert h['process']['pid']==args.core_pid and h['browser']['browserPid']==args.chrome_pid, 'PID differs from supplied live receipt'
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
    assert hashlib.sha256((installed/'dist/browser/browser-owner.js').read_bytes()).hexdigest() == manifest['runtimeBrowserOwnerSha256'], 'Unreviewed original browser adoption; no automatic rollback path'
    identity=request_identity(h, args)
    guard(h,h)
    print(json.dumps({'phase':'preflight','corePid':pid,'chromePid':args.chrome_pid,'sourceCommit':manifest['sourceCommit'],'packageVerified':True,'actorDepth':0,'activeSubmitCount':0,'dbWriterLocks':0,'next':'apply only during coordinated issuer pause'},indent=2),flush=True)
    if not args.apply: return
    receipt=args.receipt_dir.resolve() if args.receipt_dir is not None else root/'local-receipt'
    receipt.mkdir(mode=0o700) # never rerun an issued handover blindly
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
    # Pin the exact process lifetime. No process groups, killall, SIGTERM, or browser signals.
    fd=os.pidfd_open(pid)
    lease = None
    try:
        if 'maintenance' in h:
            lease = maintenance_rpc(h, 'system.maintenance.prepare', {
                **lease_owner(h), 'drainTimeoutMs': 5000, 'leaseMs': 30000})
            assert lease['phase'] == 'ready', 'Core has not drained'
            save(receipt/'maintenance.json', lease)
        if lease is None:
            current = prefreeze_drain(h, ticks, chrome_ticks, args, identity, receipt)
        else:
            for _ in range(2):
                current=health(); guard(current,h)
                assert procstat(pid)[19]==ticks and procstat(args.chrome_pid)[19]==chrome_ticks, 'PID reused'
                assert request_identity(current, args)['request']==identity['request']
            no_writer(h['database']['path'])
        transition = {'phase':'drained-core-only-transition','oldPid':pid,'oldStartTicks':ticks,'chromePid':args.chrome_pid,'atUnix':time.time(),'sourceCommit':manifest['sourceCommit']}
        if lease is not None:
            # The core rechecks the lease synchronously and exits without closing Chrome.
            # EOF is not success until the pinned process is independently gone below.
            save(receipt/'handover.json', transition)
            maintenance_rpc(h, 'system.maintenance.commit', {**lease_owner(h), 'token': lease['token']}, True)
        else:
            save(receipt/'transition-phase.json', {'phase': 'freeze-requested'})
            with frozen_core(fd, pid, ticks) as commit:
                save(receipt/'transition-phase.json', {'phase': 'frozen-guard'})
                # Frozen core cannot race this DB/lock check. Do not issue health RPC.
                assert procstat(pid)[19] == ticks and procstat(args.chrome_pid)[19] == chrome_ticks
                assert live(args.chrome_pid), 'Chrome exited'
                no_writer(h['database']['path'])
                guard(current, h)
                assert request_identity(h, args)['request'] == identity['request']
                no_writer(h['database']['path'])
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
    try:
        promote_package(installed, candidate, stage, receipt)
        successor = launch_core(cmd, cwd, runtime_env, receipt, 'successor')
        save(receipt/'successor.json', {'pid': successor.pid, 'startedAtUnix': time.time()})
        after = await_ready(successor)
    except Exception as error:
        save(receipt/'startup-failure.json', {'error': str(error), 'rollback': 'pending'})
        try:
            rollback_exited(h, pid, successor, chrome_ticks, installed, stage, receipt,
                           cmd, cwd, runtime_env, args, identity)
        except Exception as recovery_error:
            save(receipt/'rollback-blocked.json', {'error': str(recovery_error), 'action': 'preserve browser/DB and inspect; do not retry'})
            raise RuntimeError('Handover failed; recovery not confirmed; inspect receipts') from recovery_error
        raise RuntimeError('Handover failed; original core restored; release issuer hold, do not repeat') from error
    assert after['database']['integrity']=='ok' and after['database']['path']==h['database']['path']
    assert after['database']['schemaVersion']==h['database']['schemaVersion']
    assert after['providers']['enabled']==h['providers']['enabled']
    for key in ['browserPid','profileDir','debuggingPort']: assert after['browser'][key]==h['browser'][key]
    assert after['browser']['ownership']=='adopted'
    assert procstat(args.chrome_pid)[19]==chrome_ticks
    post=request_identity(after, args)
    assert post['request']==identity['request'] and post['anchor']==identity['anchor']
    assert all(post['requests'].get(k)==v for k,v in identity['requests'].items()), 'Durable request changed'
    assert all(row in post['bindings'] for row in identity['bindings']), 'Binding identity changed; inspect, never overwrite DB'
    save(receipt/'after-health.json',after)
    save(receipt/'after-identity.json',post)
    result={'sourceCommit':manifest['sourceCommit'],'packageSha256':manifest['packageSha256'],'oldPid':pid,'newPid':successor.pid,'chromePid':args.chrome_pid,'databaseIntegrity':'ok','requestAndAnchorPreserved':True,'bindingIdentityPreserved':True,'browserIdentityPreserved':True,'installedCatalogSha256':catalog_hash,'loadedClientCatalog':'not reloaded; existing request schemas unchanged','draftSelectionVisualCheck':'required by original owner; no browser protocol used by this script','answerRecovery':'not yet verified'}
    save(receipt/'result.json',result); print(json.dumps(result,indent=2))

if __name__=='__main__':
    if sys.argv[1:2] == ['locks']:
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
