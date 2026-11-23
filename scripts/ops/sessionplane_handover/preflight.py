"""Bounded verified handover preflight phase."""
import datetime, json, os, pathlib, socket, sqlite3, subprocess, time
from contextlib import closing


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


def verify_transition_mode(h, core_maintenance, legacy_opt_in, apply):
    """Classify the one permitted mutating fence before touching a live Core.
    Historical freeze is never an automatic fallback on schema 16+.
    """
    schema = h['database']['schemaVersion']
    assert type(schema) is int and schema >= 1, 'Installed schema identity invalid'
    if legacy_opt_in:
        assert schema <= 15, 'Legacy freeze requires an explicitly supported pre-v16 source'
        assert core_maintenance and h.get('maintenance', {}).get('coordinatedDrain') and not h['maintenance'].get('durableRecoveryHandover'), 'Legacy recovery requires a verified old Core admission fence'
        return 'explicit_legacy'
    if apply:
        assert core_maintenance, 'Current cutover requires an explicit Core maintenance fence'
        assert h.get('maintenance', {}).get('coordinatedDrain'), 'Current Core maintenance fence unavailable; no legacy fallback'
    return 'core_maintenance' if core_maintenance else 'read_only_preflight'
