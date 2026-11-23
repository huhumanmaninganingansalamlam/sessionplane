"""Bounded verified handover bundle phase."""
import argparse, hashlib, json, pathlib, shutil, subprocess, tarfile, tempfile

from . import model


def sha256_file(path):
    digest = hashlib.sha256()
    with pathlib.Path(path).open('rb') as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b''):
            digest.update(block)
    return digest.hexdigest()

def verify_candidate_schema(installed, policy):
    # Read only the isolated installed package's pure migration registry.
    # Never open the operational DB, connect to the Core or touch a browser.
    transition = policy.get('schemaTransition')
    assert isinstance(transition, dict) and set(transition) == {'from', 'to'}, (
        'Candidate schema transition policy unavailable')
    assert type(transition['from']) is int and type(transition['to']) is int
    assert transition['to'] >= transition['from'] >= 0
    script = (
        "import {pathToFileURL} from 'node:url';"
        "const {migrations}=await import(pathToFileURL(process.argv[1]).href);"
        "console.log(JSON.stringify(migrations.map(m=>m.version)))"
    )
    registry = pathlib.Path(installed)/'dist/storage/migrations/index.js'
    assert registry.is_file(), 'Candidate compiled migration registry missing'
    versions = json.loads(subprocess.check_output(
        ['node', '--input-type=module', '-e', script, str(registry)], text=True))
    assert isinstance(versions, list) and versions and all(type(v) is int for v in versions), (
        'Candidate migration registry invalid')
    assert versions == list(range(1, versions[-1] + 1)), (
        'Candidate migration chain is not contiguous')
    assert versions[-1] == transition['to'], (
        'Candidate migration schema differs from handover policy')
    return versions[-1]

def verify_package(installed, pkg, manifest):
    with tarfile.open(pkg) as archive:
        for member in archive.getmembers():
            if member.isfile():
                target = installed/member.name.removeprefix('package/')
                assert target.is_file() and target.read_bytes() == archive.extractfile(member).read(), 'Package bytes differ'
    compiled_schema = verify_candidate_schema(installed, manifest)
    assert manifest.get('candidateSchemaVersion', compiled_schema) == compiled_schema, (
        'Candidate bundle compiled schema receipt differs')
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
    model.save(receipt/'staging.json', {'prefix': str(stage), 'candidate': str(candidate), 'installed': str(installed)})
    with (receipt/'install.log').open('w') as log:
        subprocess.run(['npm', 'install', '-g', '--prefix', str(stage), '--ignore-scripts', '--no-audit', '--no-fund', str(pkg)], check=True, stdout=log, stderr=subprocess.STDOUT)
    catalog = verify_package(candidate, pkg, manifest)
    assert candidate.stat().st_dev == installed.parent.stat().st_dev, 'Promotion requires the same filesystem'
    return stage, candidate, catalog

def promote_package(installed, candidate, stage, receipt):
    previous = stage/'previous-install'
    assert not previous.exists() and installed.is_dir() and not installed.is_symlink()
    model.save(receipt/'promotion.json', {'phase': 'before-promotion', 'previous': str(previous), 'candidate': str(candidate), 'installed': str(installed)})
    installed.rename(previous)
    try:
        candidate.rename(installed)
    except BaseException:
        previous.rename(installed)
        model.save(receipt/'promotion.json', {'phase': 'promotion-failed-original-files-restored', 'installed': str(installed)})
        raise
    model.save(receipt/'promotion.json', {'phase': 'promoted', 'previous': str(previous), 'installed': str(installed)})

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
        compiled_schema = verify_candidate_schema(installed, policy)
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
            'candidateSchemaVersion': compiled_schema,
            'requiredGates': policy['requiredGates'],
            'ciConclusion': None,
        }
        assert manifest['sourceState'] == 'clean'
        validate_candidate(manifest, acceptance_path)
        verify_package(installed, copied, manifest)
        model.save(destination/'manifest.json', manifest)
        model.save(destination/'bundle-receipt.json', {
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
