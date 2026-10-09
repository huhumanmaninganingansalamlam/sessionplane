#!/usr/bin/env python3
"""Established, drained, exact-core-only replacement. No SSH or browser protocol calls.
Run only after original owners have paused issuing new mutations for this short handover.
The old core has no atomic admission fence: sampled health is not a substitute for that coordination.
"""
import argparse, hashlib, json, os, pathlib, pwd, signal, socket, sqlite3, subprocess, tarfile, time

if not __debug__:
    raise SystemExit('Optimized Python disables safety assertions; run without -O or PYTHONOPTIMIZE')

def save(path, value):
    path.write_text(json.dumps(value, indent=2)); path.chmod(0o600)

def health():
    return json.loads(subprocess.check_output(['sessplane', 'health', '--json'], text=True, timeout=15))

def procstat(pid):
    return pathlib.Path(f'/proc/{pid}/stat').read_text().rsplit(')', 1)[1].split()

def live(pid):
    try: return procstat(pid)[0] != 'Z'
    except FileNotFoundError: return False

def read_db(h):
    return sqlite3.connect('file:' + h['database']['path'] + '?mode=ro', uri=True)

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

def no_writer(dbpath):
    paths=[pathlib.Path(dbpath + suffix) for suffix in ['', '-wal', '-shm']]
    keys={(os.major(p.stat().st_dev), os.minor(p.stat().st_dev), p.stat().st_ino) for p in paths if p.exists()}
    for line in pathlib.Path('/proc/locks').read_text().splitlines():
        parts=line.split()
        if 'WRITE' not in parts: continue
        for token in parts:
            if token.count(':')!=2: continue
            try:
                major,minor,inode=token.split(':'); key=(int(major,16),int(minor,16),int(inode))
            except ValueError: continue
            assert key not in keys, 'DB/WAL/SHM write lock active: preserve core; retry only after natural drain'

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
    args=parser.parse_args()
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
    h=health(); assert h['process']['pid']==args.core_pid and h['browser']['browserPid']==args.chrome_pid, 'PID differs from supplied live receipt'
    pid=args.core_pid; proc=pathlib.Path(f'/proc/{pid}')
    assert proc.stat().st_uid==os.getuid() and pathlib.Path(f'/proc/{args.chrome_pid}').stat().st_uid==os.getuid()
    ticks=procstat(pid)[19]; chrome_ticks=procstat(args.chrome_pid)[19]
    cmd=proc.joinpath('cmdline').read_bytes().rstrip(b'\0').decode().split('\0')
    cwd=os.readlink(proc/'cwd')
    assert cwd==args.expected_cwd and 'serve' in cmd and any('sessplane' in c for c in cmd), 'Unexpected core command'
    prefix=subprocess.check_output(['npm','prefix','-g'], text=True).strip()
    installed=pathlib.Path(prefix)/'lib/node_modules/sessionplane'
    assert installed.is_dir() and os.access(installed,os.W_OK)
    identity=request_identity(h, args)
    guard(h,h)
    print(json.dumps({'phase':'preflight','corePid':pid,'chromePid':args.chrome_pid,'sourceCommit':manifest['sourceCommit'],'packageVerified':True,'actorDepth':0,'activeSubmitCount':0,'dbWriterLocks':0,'next':'apply only during coordinated issuer pause'},indent=2),flush=True)
    if not args.apply: return
    receipt=root/'local-receipt'
    receipt.mkdir(mode=0o700) # never rerun an issued handover blindly
    save(receipt/'before-health.json',h); save(receipt/'before-identity.json',identity)
    runtime_env=dict(item.split('=',1) for item in proc.joinpath('environ').read_text().split('\0') if '=' in item)
    subprocess.run(['tar','-czf',str(receipt/'previous-install.tgz'),'-C',str(installed.parent),'sessionplane'],check=True)
    with read_db(h) as db, sqlite3.connect(receipt/'predeploy.sqlite') as backup:
        db.backup(backup); assert backup.execute('PRAGMA integrity_check').fetchone()[0]=='ok'
    # Same installation path as the original deployment; no daemon/config/Chrome changes here.
    with (receipt/'install.log').open('w') as log:
        subprocess.run(['npm','install','-g','--prefix',prefix,'--ignore-scripts','--no-audit','--no-fund',str(pkg)],check=True,stdout=log,stderr=subprocess.STDOUT)
    with tarfile.open(pkg) as archive:
        for member in archive.getmembers():
            if member.isfile():
                assert (installed/member.name.removeprefix('package/')).read_bytes()==archive.extractfile(member).read(), 'Installed bytes differ'
    catalog_script="import {pathToFileURL} from 'node:url'; import {createHash} from 'node:crypto'; const {MCP_TOOLS}=await import(pathToFileURL(process.argv[1]).href); console.log(createHash('sha256').update(JSON.stringify(MCP_TOOLS)).digest('hex'));"
    catalog_hash=subprocess.check_output(['node','--input-type=module','-e',catalog_script,str(installed/'dist/mcp/tools.js')],text=True).strip()
    assert catalog_hash==manifest['installedCatalogSha256'], 'Installed MCP catalog differs'
    # Pin the exact process lifetime. No process groups, killall, SIGTERM, or browser signals.
    fd=os.pidfd_open(pid)
    try:
        for _ in range(2):
            current=health(); guard(current,h)
            assert procstat(pid)[19]==ticks and procstat(args.chrome_pid)[19]==chrome_ticks, 'PID reused'
            assert request_identity(current, args)['request']==identity['request']
        no_writer(h['database']['path'])
        save(receipt/'handover.json',{'phase':'drained-core-only-transition','oldPid':pid,'oldStartTicks':ticks,'chromePid':args.chrome_pid,'atUnix':time.time(),'sourceCommit':manifest['sourceCommit']})
        signal.pidfd_send_signal(fd,signal.SIGKILL)
    finally: os.close(fd)
    deadline=time.monotonic()+5
    while live(pid) and time.monotonic()<deadline: time.sleep(.1)
    assert not live(pid), 'Old core still live: do not launch duplicate'
    assert live(args.chrome_pid) and procstat(args.chrome_pid)[19]==chrome_ticks, 'Browser no longer preserved: stop'
    with (receipt/'core.log').open('ab') as log:
        successor=subprocess.Popen(cmd,cwd=cwd,env=runtime_env,stdin=subprocess.DEVNULL,stdout=log,stderr=log,start_new_session=True)
    save(receipt/'successor.json',{'pid':successor.pid,'startedAtUnix':time.time()})
    after=None; deadline=time.monotonic()+60
    while time.monotonic()<deadline and successor.poll() is None:
        try:
            candidate=health()
            if candidate['requestOk'] and candidate['process']['pid']==successor.pid and candidate['browser']['state']=='ready': after=candidate; break
        except (subprocess.SubprocessError, ValueError): pass
        time.sleep(1)
    assert after is not None, 'Successor not ready: preserve Chrome and inspect local-receipt/core.log; do not repeat handover or auto-start old code'
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

if __name__=='__main__': main()
