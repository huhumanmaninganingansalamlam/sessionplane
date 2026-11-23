"""Bounded verified handover retention phase."""
import hashlib, json, os, pathlib, uuid



FULL_ROLLBACK_RECEIPTS_TO_KEEP = 2

SNAPSHOT_SUBDIRS = (
    'preflight-migration', 'preflight-rollback', 'final-migration',
    'database-archive', 'failed-candidate-rollback', 'failed-candidate-database',
)

SNAPSHOT_SUFFIXES = ('.sqlite', '.sqlite-wal', '.sqlite-shm', '.sqlite-journal')

def verified_release_cutover(receipt):
    try:
        outcome = json.loads((receipt/'result.json').read_text())
        event = json.loads((receipt/'handover.json').read_text())
    except (FileNotFoundError, OSError, json.JSONDecodeError):
        return None
    checks = ('requestAndAnchorPreserved', 'bindingIdentityPreserved',
              'browserIdentityPreserved', 'singleCoreWriterVerified')
    if (outcome.get('databaseIntegrity') != 'ok' or
            any(outcome.get(key) is not True for key in checks) or
            not isinstance(outcome.get('oldPid'), int) or
            not isinstance(outcome.get('newPid'), int) or
            not isinstance(event.get('atUnix'), (int, float)) or
            not isinstance(outcome.get('sourceCommit'), str) or
            not isinstance(outcome.get('packageSha256'), str)):
        return None
    return float(event['atUnix'])

def retained_snapshot_files(receipt):
    paths = []
    allowed = [receipt/'predeploy.sqlite']
    for name in SNAPSHOT_SUBDIRS:
        directory = receipt/name
        if directory.is_symlink():
            raise AssertionError('Refusing symlink in cutover: '+str(directory))
        if directory.is_dir():
            allowed.extend(path for path in directory.rglob('*')
                           if path.name.endswith(SNAPSHOT_SUFFIXES))
    for path in allowed:
        if path.is_symlink():
            raise AssertionError('Refusing symlinked snapshot: '+str(path))
        if not path.exists():
            continue
        info = path.stat()
        if (not path.is_file() or info.st_uid != os.getuid() or
                info.st_nlink != 1 or receipt not in path.resolve().parents):
            raise AssertionError('Snapshot file ownership/identity changed: '+str(path))
        paths.append((path, info))
    return paths

def exact_rollback_snapshot_set(receipt):
    # Prefer the sealed static source produced after the old Core exited. It is
    # newer than predeploy.sqlite, which is taken before the maintenance fence.
    candidates = (
        receipt/'final-migration/source-snapshot.sqlite',
        receipt/'database-archive/sessionplane.sqlite',
        receipt/'predeploy.sqlite',
    )
    selected = next((path for path in candidates if path.is_file() and
                     not path.is_symlink()), None)
    assert selected is not None, 'Verified cutover has no exact rollback database'
    keep = {selected}
    for suffix in ('-wal', '-shm', '-journal'):
        sidecar = pathlib.Path(str(selected)+suffix)
        if sidecar.is_symlink():
            raise AssertionError('Refusing symlinked rollback sidecar: '+str(sidecar))
        if sidecar.exists():
            keep.add(sidecar)
    package = receipt/'previous-install.tgz'
    assert package.is_file() and not package.is_symlink(), (
        'Verified cutover has no previous package: '+str(package))
    return keep

def save_snapshot_retention(receipt, value):
    target = receipt/'snapshot-retention.json'
    temporary = receipt/('.snapshot-retention-'+uuid.uuid4().hex+'.tmp')
    payload = (json.dumps(value, indent=2)+'\n').encode()
    descriptor = None
    try:
        descriptor = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(descriptor, 'wb', closefd=True) as file:
            descriptor = None
            file.write(payload)
            file.flush()
            os.fsync(file.fileno())
        os.replace(temporary, target)
        directory = os.open(receipt, os.O_RDONLY | os.O_DIRECTORY)
        try:
            os.fsync(directory)
        finally:
            os.close(directory)
    finally:
        if descriptor is not None:
            os.close(descriptor)
        if temporary.exists():
            temporary.unlink()

def existing_retention_entries(receipt):
    try:
        prior = json.loads((receipt/'snapshot-retention.json').read_text())
    except (FileNotFoundError, OSError, json.JSONDecodeError):
        return {}, {}
    if prior.get('kind') != 'sessionplane-verified-snapshot-retention-v2':
        return {}, {}
    removed = {row['path']: row for row in prior.get('removedSnapshots', [])
               if isinstance(row, dict) and isinstance(row.get('path'), str)}
    kept = {row['path']: row for row in prior.get('keptSnapshots', [])
            if isinstance(row, dict) and isinstance(row.get('path'), str)}
    return removed, kept

def retain_successful_handover_snapshots(receipt, state_root):
    # Only the established release-main-*/handover convention is managed.
    # Manual recovery directories and unverified/failed cutovers are excluded.
    receipt = pathlib.Path(receipt).resolve()
    state_root = pathlib.Path(state_root).resolve()
    if (receipt.name != 'handover' or receipt.parent.parent != state_root or
            not receipt.parent.name.startswith('release-main-')):
        return {'status': 'not-managed-release', 'keptRollbackReceipts': 0,
                'compactedReceipts': 0, 'retiredReceipts': 0, 'removedBytes': 0}
    assert verified_release_cutover(receipt) is not None, 'Current cutover is not verified'
    discovered = []
    for release in state_root.glob('release-main-*'):
        if not release.is_dir() or release.is_symlink():
            continue
        previous = release/'handover'
        if previous.is_symlink():
            raise AssertionError('Refusing symlinked handover directory: '+str(previous))
        timestamp = verified_release_cutover(previous)
        if timestamp is not None:
            discovered.append((timestamp, previous.resolve()))
    discovered.sort(key=lambda value: (value[0], str(value[1])), reverse=True)
    assert discovered and discovered[0][1] == receipt, (
        'Current cutover is not newest; do not prune')
    rollback_receipts = [path for _, path in
                         discovered[:FULL_ROLLBACK_RECEIPTS_TO_KEEP]]
    keep_receipts = set(rollback_receipts)
    assert receipt in keep_receipts

    plans = []
    # Validate the whole batch before deleting the first byte. Each retained
    # rollback is compacted to one exact old DB set plus previous-install.tgz.
    for index, (_, candidate_receipt) in enumerate(discovered):
        all_snapshots = retained_snapshot_files(candidate_receipt)
        if candidate_receipt in keep_receipts:
            keep_files = exact_rollback_snapshot_set(candidate_receipt)
            remove = [(path, info) for path, info in all_snapshots
                      if path not in keep_files]
            status = 'compacted-full-rollback'
        else:
            keep_files = set()
            remove = all_snapshots
            status = 'retired-from-full-rollback-window'
        if remove:
            plans.append((candidate_receipt, keep_files, remove, status, index))

    removed_bytes = 0
    compacted = 0
    retired = 0
    for candidate_receipt, keep_files, remove, status, index in plans:
        removed = []
        kept = []
        for path, before in remove:
            with path.open('rb') as file:
                digest = hashlib.file_digest(file, 'sha256').hexdigest()
            removed.append({'path': str(path.relative_to(candidate_receipt)),
                            'bytes': before.st_size, 'sha256': digest})
        for path in sorted(keep_files):
            before = path.stat()
            with path.open('rb') as file:
                digest = hashlib.file_digest(file, 'sha256').hexdigest()
            kept.append({'path': str(path.relative_to(candidate_receipt)),
                         'bytes': before.st_size, 'sha256': digest})
        for path, before in remove:
            now = path.stat()
            if (now.st_dev, now.st_ino, now.st_size, now.st_mtime_ns) != (
                    before.st_dev, before.st_ino, before.st_size, before.st_mtime_ns):
                raise AssertionError('Historical DB changed before retention: '+str(path))
        previous_removed, previous_kept = existing_retention_entries(candidate_receipt)
        previous_removed.update({row['path']: row for row in removed})
        previous_kept.update({row['path']: row for row in kept})
        save_snapshot_retention(candidate_receipt, {
            'kind': 'sessionplane-verified-snapshot-retention-v2',
            'status': status,
            'policy': 'one-exact-db-set-in-last-two-verified-release-cutovers',
            'releaseRank': index + 1,
            'keptRollbackReceipts': [str(path) for path in rollback_receipts],
            'keptSnapshots': [previous_kept[key] for key in sorted(previous_kept)],
            'removedSnapshots': [previous_removed[key] for key in sorted(previous_removed)],
        })
        for path, before in remove:
            now = path.stat()
            if (now.st_dev, now.st_ino, now.st_size, now.st_mtime_ns) != (
                    before.st_dev, before.st_ino, before.st_size, before.st_mtime_ns):
                raise AssertionError('Historical DB changed after manifest: '+str(path))
            path.unlink()
            removed_bytes += before.st_size
        if candidate_receipt in keep_receipts:
            compacted += 1
        else:
            retired += 1
    return {'status': 'success', 'keptRollbackReceipts': len(keep_receipts),
            'compactedReceipts': compacted, 'retiredReceipts': retired,
            'removedBytes': removed_bytes}
