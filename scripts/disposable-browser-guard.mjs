import { readFileSync, readdirSync, readlinkSync, statSync } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';

// Only disposable headless Chrome started by this exact candidate gate is
// eligible. Production Chrome must survive Core restart for adoption.
const BROWSER_EXECUTABLES = new Set([
  'chrome', 'chromium', 'chromium-browser', 'msedge', 'brave', 'brave-browser',
]);
const GATE_ENV_KEY = 'SESSIONPLANE_CANDIDATE_GATE_TOKEN';

const DARWIN_BROWSER_COMMAND = /(?:^|\/)(?:Google Chrome|Chromium|Microsoft Edge|Brave Browser|chrome|chromium|msedge|brave)(?:\s|$)/;

export function candidateDisposableBrowserCommand({
  pid, processGroup, uid, expectedUid, commandline, gateRoot,
}) {
  if (!Number.isSafeInteger(pid) || pid <= 1 || processGroup !== pid ||
      uid !== expectedUid || typeof commandline !== 'string' ||
      typeof gateRoot !== 'string' || !DARWIN_BROWSER_COMMAND.test(commandline) ||
      !/(?:^|\s)--headless(?:=\S+)?(?:\s|$)/.test(commandline) ||
      /(?:^|\s)--type=/.test(commandline)) {
    return null;
  }
  const flag = /(?:^|\s)--user-data-dir=([^\s]+)/.exec(commandline);
  if (!flag) return null;
  const profile = path.resolve(flag[1]);
  const relative = path.relative(path.resolve(gateRoot), profile).split(path.sep);
  if (relative.length !== 2 ||
      !/^sessionplane-[A-Za-z0-9_-]+$/.test(relative[0]) ||
      !['disposable-profile', 'profile'].includes(relative[1])) {
    return null;
  }
  return { pid, profile };
}

export function candidateDisposableChrome({
  pid, argv, executable, environment, uid, expectedUid,
  gateToken, tempRoot = tmpdir(), gateRoot = null, processGroup,
}) {
  if (!Number.isSafeInteger(pid) || pid <= 1 || uid !== expectedUid ||
      processGroup !== pid || !gateToken || !Array.isArray(argv) ||
      !BROWSER_EXECUTABLES.has(path.basename(executable ?? ''))) {
    return null;
  }
  // Chrome can overwrite its /proc cmdline with a single space-joined
  // argument and remove the inherited environment from /proc/environ.
  // The supervisor's fresh, unique TMPDIR is the durable ownership proof.
  const commandline = argv.join(' ');
  if (!/(?:^|\s)--headless(?:=\S+)?(?:\s|$)/.test(commandline) ||
      /(?:^|\s)--type=/.test(commandline)) {
    return null;
  }
  if (gateRoot === null && !environment.includes(`${GATE_ENV_KEY}=${gateToken}`)) {
    return null;
  }
  const flag = /(?:^|\s)--user-data-dir=([^\s]+)/.exec(commandline);
  if (!flag) return null;
  const profile = path.resolve(flag[1]);
  const relative = path.relative(path.resolve(gateRoot ?? tempRoot), profile).split(path.sep);
  if (relative.length !== 2 ||
      !/^sessionplane-[A-Za-z0-9_-]+$/.test(relative[0]) ||
      !['disposable-profile', 'profile'].includes(relative[1])) {
    return null;
  }
  return { pid, profile };
}

function inspect(pid, gateToken, gateRoot, procRoot = '/proc') {
  try {
    const root = path.join(procRoot, String(pid));
    const uid = statSync(root).uid;
    const argv = readFileSync(path.join(root, 'cmdline')).toString().split('\0').filter(Boolean);
    const executable = readlinkSync(path.join(root, 'exe'));
    const environment = readFileSync(path.join(root, 'environ')).toString().split('\0');
    const stat = readFileSync(path.join(root, 'stat'), 'utf8');
    const fields = stat.slice(stat.lastIndexOf(')') + 2).trim().split(/\s+/);
    const processGroup = Number(fields[2]);
    const identity = candidateDisposableChrome({
      pid, argv, executable, environment, uid, expectedUid: process.getuid(),
      gateToken, gateRoot, processGroup,
    });
    return identity && { ...identity, startTicks: fields[19] };
  } catch {
    return null; // Race with normal Chrome exit or inaccessible process
  }
}

function listDarwinCandidateDisposableChromes(gateRoot) {
  try {
    const output = execFileSync('ps', ['-axo', 'pid=,pgid=,uid=,command='], {
      encoding: 'utf8', maxBuffer: 4 * 1024 * 1024,
    });
    const found = [];
    for (const line of output.split('\n')) {
      const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.+)$/.exec(line);
      if (!match) continue;
      const identity = candidateDisposableBrowserCommand({
        pid: Number(match[1]), processGroup: Number(match[2]), uid: Number(match[3]),
        expectedUid: process.getuid(), commandline: match[4], gateRoot,
      });
      if (!identity) continue;
      const startedAt = execFileSync('ps', ['-p', String(identity.pid), '-o', 'lstart='], {
        encoding: 'utf8', maxBuffer: 64 * 1024,
      }).trim();
      if (startedAt) found.push({ ...identity, startTicks: startedAt });
    }
    return found;
  } catch {
    return [];
  }
}

export function listCandidateDisposableChromes(gateToken, gateRoot, procRoot = '/proc') {
  if (process.platform === 'darwin') {
    return listDarwinCandidateDisposableChromes(gateRoot);
  }
  if (process.platform !== 'linux') return [];
  try {
    return readdirSync(procRoot)
      .filter(name => /^\d+$/.test(name))
      .map(name => inspect(Number(name), gateToken, gateRoot, procRoot))
      .filter(Boolean);
  } catch {
    return [];
  }
}

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

export async function cleanCandidateDisposableChromes(gateToken, gateRoot) {
  if (!['linux', 'darwin'].includes(process.platform)) {
    return { cleaned: 0, remaining: 0 };
  }
  const found = listCandidateDisposableChromes(gateToken, gateRoot);
  for (const browser of found) {
    const stillSame = () => {
      const current = listCandidateDisposableChromes(gateToken, gateRoot)
        .find(candidate => candidate.pid === browser.pid);
      return current !== undefined &&
        current.startTicks === browser.startTicks && current.profile === browser.profile;
    };
    if (!stillSame()) continue;
    try {
      // Exact newly-created headless test browser has its own process group.
      process.kill(-browser.pid, 'SIGTERM');
    } catch (error) {
      if (error.code !== 'ESRCH') throw error;
    }
    for (let n = 0; n < 30 && stillSame(); n++) await delay(100);
    if (stillSame()) {
      process.kill(-browser.pid, 'SIGKILL');
      for (let n = 0; n < 30 && stillSame(); n++) await delay(100);
    }
  }
  const remaining = listCandidateDisposableChromes(gateToken, gateRoot).length;
  return { cleaned: found.length - remaining, remaining };
}
