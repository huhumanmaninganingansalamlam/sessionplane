"""Bounded verified handover legacy_transition phase."""
import os, pathlib, signal, socket, time
from contextlib import contextmanager
from . import model, preflight


def prefreeze_drain(h, ticks, chrome_ticks, target, identity, receipt, timeout=5):
    """Finish live RPC checks before quiet; frozen_guard revalidates before commit."""
    started = time.monotonic()
    deadline = started + timeout
    samples = []
    timings = []
    phase = 'live-guard-1'
    def pinned():
        assert preflight.procstat(h['process']['pid'])[19] == ticks, 'Core PID reused'
        chrome = h['browser']['browserPid']
        assert preflight.live(chrome) and preflight.procstat(chrome)[19] == chrome_ticks, 'Chrome lifetime changed'
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
            model.save(receipt/'transition-phase.json', {'phase': phase})
            pinned()
            with measured('health'):
                current = preflight.health(timeout=remaining())
            with measured('guard-state'):
                preflight.guard_state(current, h)
                report = preflight.lock_report(h['database']['path'])
                samples.append({'phase': phase, **report})
                preflight.drainable_writer(report, h['process']['pid'], ticks)
            pinned()
            with measured('request-identity'):
                assert preflight.request_identity(current, target)['request'] == identity['request']
            remaining()
        # A live lock sample is not an atomic transition check. Drain only after
        # all slow RPC/DB work; any writer racing the freeze is rejected frozen.
        phase = 'live-final-writer'
        model.save(receipt/'transition-phase.json', {'phase': phase})
        deadline = time.monotonic() + timeout
        while True:
            pinned()
            report = preflight.lock_report(h['database']['path'])
            waiting = preflight.drainable_writer(report, h['process']['pid'], ticks)
            samples.append({'phase': phase if waiting else 'quiet-observed', **report})
            if not waiting:
                remaining()
                return current  # No health/SQLite work between quiet and freeze.
            if time.monotonic() >= deadline: raise preflight.LockActivityError(report)
            time.sleep(min(.1, remaining()))
    finally:
        model.save(receipt/'writer-drain.json', {'phase': phase, 'timeoutSeconds': timeout,
                                         'maxValidationPasses': 1, 'maxTotalSeconds': 2 * timeout,
                                         'elapsedSeconds': time.monotonic() - started,
                                         'timings': timings, 'samples': samples})

def frozen_guard(current, expected, ticks, chrome_ticks, target, identity, recovery_handover=False):
    """Called only under the bounded guardian; never issue health to a frozen core."""
    pid = expected['process']['pid']
    chrome = expected['browser']['browserPid']
    assert preflight.procstat(pid)[19] == ticks and preflight.procstat(chrome)[19] == chrome_ticks, 'PID reused'
    assert preflight.live(chrome), 'Chrome exited'
    preflight.no_writer(expected['database']['path'])
    if recovery_handover:
        assert current['maintenance']['phase'] == 'draining' and current['maintenance']['activeOperations'] == 0, 'Recovery handover requires drained admission'
        assert current['maintenance']['expiresAt'] > time.time() * 1000, 'Recovery handover lease expired; preserve core'
    preflight.guard(current, expected, recovery_handover=recovery_handover)  # Fresh submission/profile/lock checks.
    with preflight.read_db(expected) as db:
        assert db.execute('PRAGMA integrity_check').fetchone()[0] == 'ok', 'DB not healthy'
    post = preflight.request_identity(expected, target)
    assert post['request'] == identity['request'] and post['anchor'] == identity['anchor']
    assert all(post['requests'].get(k) == v for k, v in identity['requests'].items()), 'Durable request changed'
    preflight.verify_bindings(current, identity['bindings'], post['bindings'])
    preflight.no_writer(expected['database']['path'])

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
            assert preflight.procstat(pid)[19] == ticks, 'Core lifetime changed before freeze'
            assert preflight.procstat(pid)[0] not in ('T', 't', 'Z'), 'Core already stopped or exited'
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
            if command == b'K' and time.monotonic() < deadline and preflight.procstat(pid)[0] in ('T', 't'):
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
            assert reply == b'K' or not preflight.live(pid), 'Freeze expired; core resumed, do not promote'
        yield commit
    finally:
        parent.close()  # EOF releases the exact stopped core on any exception.
        os.waitpid(guardian, 0)
