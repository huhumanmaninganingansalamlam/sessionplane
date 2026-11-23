"""Bounded verified handover systemd phase."""
import json, subprocess, time

from . import model, preflight


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
            result = preflight.health()
            if result['requestOk']:
                assert result['process']['pid'] == process.pid, 'Socket has a different core owner; preserve successor and inspect'
                assert result['browser']['state'] != 'error', 'Successor reports browser failure; preserve it and inspect core.log'
                if result['browser']['state'] == 'ready':
                    return result
        except (subprocess.SubprocessError, ValueError):
            pass
        time.sleep(1)
    raise RuntimeError(f'Core exited before readiness (exit {process.returncode}); inspect startup output')

class LiveSuccessorError(RuntimeError):
    pass

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
    model.save(receipt/(label + '-systemd.json'), props)
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
            last = preflight.health()
            if last['process']['pid'] != expected_pid:
                raise RuntimeError('Socket has a different Core owner')
            if last['browser']['state'] == 'error':
                raise LiveSuccessorError('Live successor reports browser failure; preserve it')
            if last['requestOk'] and last['browser']['state'] == 'ready':
                return last
        except (subprocess.SubprocessError, ValueError, FileNotFoundError):
            pass
        time.sleep(1)
    if preflight.live(expected_pid):
        raise LiveSuccessorError('Live successor did not become ready in bounded observation; preserve it')
    raise RuntimeError('Core exited before readiness')

def single_core_writer(database_path, expected_pid):
    report = preflight.lock_report(database_path)
    holders = {row['holder']['pid'] for row in report['locks'] if row['holder']['pid'] not in (None, 0)}
    assert holders.issubset({expected_pid}), 'Foreign or duplicate database holder after handover'
    return report
