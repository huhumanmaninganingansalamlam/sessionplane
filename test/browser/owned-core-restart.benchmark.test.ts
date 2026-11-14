import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { BrowserOwner } from '../../src/browser/browser-owner.ts';
import { PageRegistry } from '../../src/browser/page-registry.ts';

interface PriorPage {
  readonly targetId: string;
  readonly pageKey: string;
  readonly sessionId: string;
  readonly draft: string;
}
interface FirstOwnerReceipt {
  readonly browserPid: number;
  readonly debuggingPort: number;
  readonly pages: PriorPage[];
}

const childCode = [
  "import { BrowserOwner } from './src/browser/browser-owner.ts';",
  "import { PageRegistry } from './src/browser/page-registry.ts';",
  "const profileDir = process.argv[1];",
  "const registry = new PageRegistry();",
  "const owner = new BrowserOwner({profileDir, pageRegistry:registry, headless:false});",
  "try {",
  "  await owner.start();",
  "  const pages=[];",
  "  for(let i=0;i<4;i++){",
  "    const {page,binding}=await owner.createPage();",
  "    const sessionId='restart-fixture-'+i;",
  "    registry.reservePage(binding.pageKey,{sessionId,generation:1,conversationId:null});",
  "    await owner.preparePageInteraction(binding.pageKey,{sessionId,generation:1,conversationId:null});",
  "    await page.setContent('<textarea aria-label=\"Draft\"></textarea>');",
  "    const draft='persisted-draft-'+i;",
  "    await page.getByRole('textbox',{name:'Draft'}).fill(draft);",
  "    pages.push({targetId:binding.targetId,pageKey:binding.pageKey,sessionId,draft});",
  "  }",
  "  const browserPid=owner.status.browserPid,debuggingPort=owner.status.debuggingPort;",
  "  if(!browserPid||!debuggingPort)throw Error('Missing exact Chrome identity');",
  "  process.stdout.write('RESTART_OWNER_A '+JSON.stringify({browserPid,debuggingPort,pages})+'\\n',()=>process.exit(0));",
  "} catch(error){console.error('OWNER_A_FAILURE '+(error?.stack??String(error)));process.exit(1);}",
].join('\n');

function exactBrowserStillAlive(pid: number | null, profileDir: string): boolean {
  if (pid === null || !Number.isSafeInteger(pid) || pid < 1) return false;
  try {
    const command = readFileSync('/proc/' + pid + '/cmdline', 'utf8');
    return command.includes('--user-data-dir=' + path.resolve(profileDir));
  } catch {
    return false;
  }
}

/**
 * Opt-in headed virtual-display L2: kill Core process A without closing its
 * dedicated Chrome, then attach fresh Core process B by exact stale lock.
 * Never a default/user profile. A verified owned Chrome is explicitly stopped
 * on any error, before deleting its disposable profile.
 */
test('new Core process adopts the same four exact headed Chrome targets after Core exits', {
  skip: process.env.SESSIONPLANE_RUN_CORE_RESTART_HEADED_L2 !== '1',
  timeout: 90_000,
}, async () => {
  assert.equal(process.env.DISPLAY, undefined, 'Do not use the human X display');
  assert.match(process.env.WAYLAND_DISPLAY ?? '', /^sessionplane-l2-/,
    'Require a unique isolated Mutter Wayland display');

  const root = mkdtempSync(path.join(tmpdir(), 'sessionplane-core-restart-l2-'));
  const profileDir = path.join(root, 'disposable-profile');
  let browserPid: number | null = null;
  let adopted: BrowserOwner | null = null;
  try {
    // The explicit child exit simulates a Core crash; it does not call
    // BrowserOwner.close(). Chrome is detached and the lock retains its identity.
    const first = spawnSync(process.execPath, [
      '--input-type=module', '--experimental-strip-types', '-e', childCode, profileDir,
    ], {
      cwd: process.cwd(),
      env: process.env,
      encoding: 'utf8',
      timeout: 45_000,
      maxBuffer: 100_000,
    });
    assert.equal(first.status, 0, 'Core A did not launch: ' + first.stderr);
    const receiptLine = first.stdout.split(/\r?\n/).find(line => line.startsWith('RESTART_OWNER_A '));
    assert.ok(receiptLine, 'Core A returned no owned Chrome identity');
    const receipt = JSON.parse(receiptLine.slice('RESTART_OWNER_A '.length)) as FirstOwnerReceipt;
    browserPid = receipt.browserPid;
    assert.equal(receipt.pages.length, 4);
    assert.equal(new Set(receipt.pages.map(p => p.targetId)).size, 4);
    assert.ok(exactBrowserStillAlive(browserPid, profileDir),
      'Core A exit must leave only its disposable Chrome alive for adoption');

    const registry = new PageRegistry();
    adopted = new BrowserOwner({
      profileDir, pageRegistry: registry, headless: false,
    });
    await adopted.start();
    assert.equal(adopted.status.ownership, 'adopted');
    assert.equal(adopted.status.browserPid, receipt.browserPid);
    assert.equal(adopted.status.debuggingPort, receipt.debuggingPort);
    const bindings = registry.listBindings({ includeClosed: false });
    const recovered = [];
    for (const prior of receipt.pages) {
      const matches = bindings.filter(item => item.targetId === prior.targetId);
      assert.equal(matches.length, 1, 'Must not adopt an URL-similar replacement tab');
      const current = matches[0]!;
      assert.notEqual(current.pageKey, prior.pageKey,
        'Page wrapper is new after Core restart; target ownership must remain exact');
      registry.reservePage(current.pageKey, {
        sessionId: prior.sessionId, generation: 1, conversationId: null,
      });
      const page = await adopted.preparePageInteraction(current.pageKey, {
        sessionId: prior.sessionId, generation: 1, conversationId: null,
      });
      assert.equal(await page.getByRole('textbox', { name: 'Draft' }).inputValue(), prior.draft);
      recovered.push(current.targetId);
    }
    assert.deepEqual(new Set(recovered), new Set(receipt.pages.map(page => page.targetId)));
    console.log('ISOLATED_CORE_RESTART_L2 ' + JSON.stringify({
      originalTargets: receipt.pages.length, exactReboundTargets: recovered.length,
      processOwnership: adopted.status.ownership, browserPidUnchanged: true,
      savedDraftsRecovered: 4, oldPageKeysNeverImplicitlyAdopted: true,
    }));
  } finally {
    if (adopted !== null) await adopted.close().catch(() => undefined);
    // If adoption itself failed, terminate only an exact verified test Chrome.
    if (browserPid === null && existsSync(path.join(profileDir, '.sessionplane-profile.lock'))) {
      try {
        const lock = JSON.parse(readFileSync(
          path.join(profileDir, '.sessionplane-profile.lock'), 'utf8',
        )) as { browserPid?: number };
        browserPid = lock.browserPid ?? null;
      } catch {
        // Do not guess a PID or touch unrelated processes.
      }
    }
    if (exactBrowserStillAlive(browserPid, profileDir)) {
      try { process.kill(browserPid!, 'SIGTERM'); } catch { /* may already have exited */ }
      for (let attempt = 0; attempt < 20 && exactBrowserStillAlive(browserPid, profileDir); attempt++) {
        await new Promise(resolve => setTimeout(resolve, 100));
      }
    }
    if (exactBrowserStillAlive(browserPid, profileDir)) {
      throw new Error('Exact disposable Chrome could not be stopped; profile retained at ' + profileDir);
    }
    rmSync(root, { recursive: true, force: true });
  }
});
