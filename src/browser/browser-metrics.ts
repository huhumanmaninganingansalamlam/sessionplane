import { lstatSync, readdirSync, unlinkSync, mkdirSync, readFileSync, rmdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

/** Only Chromium's retired histogram files in this dedicated profile. */
export function pruneBrowserMetrics(profileDir: string, enabled: boolean, browserExited = false, now = Date.now()) {
  const retired: { file: string; time: number; ino: number; dev: number }[] = [];
  for (const directory of ['BrowserMetrics', 'DeferredBrowserMetrics']) {
    const root = path.join(profileDir, directory);
    let names: string[];
    try { if (!lstatSync(root).isDirectory() || lstatSync(root).isSymbolicLink()) continue; names = readdirSync(root); }
    catch { continue; }
    for (const name of names) {
      const match = /^BrowserMetrics-[A-F0-9]+-([A-F0-9]+)\.pma$/i.exec(name);
      if (!match) continue;
      const pid = Number.parseInt(match[1]!, 16);
      // A live or inaccessible PID is never treated as abandoned, even after PID reuse.
      try { process.kill(pid, 0); continue; } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') continue; }
      const file = path.join(root, name);
      try { const stat = lstatSync(file); if (stat.isFile()) retired.push({ file, time: stat.mtimeMs, ino: stat.ino, dev: stat.dev }); }
      catch { /* Concurrent Chromium cleanup. */ }
    }
  }
  retired.sort((a, b) => b.time - a.time);
  const removed: string[] = [];
  for (const [index, item] of retired.entries()) {
    if (enabled && index < 64 && now - item.time < 24 * 60 * 60 * 1000) continue;
    try {
      const fresh = lstatSync(item.file);
      if (fresh.isFile() && fresh.ino === item.ino && fresh.dev === item.dev) { unlinkSync(item.file); removed.push(item.file); }
    } catch { /* Preserve uncertain ownership or a concurrent cleanup. */ }
  }
  // Chromium may create one spare even when histogram recording is disabled.
  // Remove it only after our exact owned browser has actually exited.
  if (browserExited && !enabled) {
    const spare = path.join(profileDir, 'BrowserMetrics-spare.pma');
    try { if (lstatSync(spare).isFile()) { unlinkSync(spare); removed.push(spare); } } catch { /* Absent or inaccessible. */ }
  }
  return { removedCount: removed.length };
}

const disabledMarker = 'SessionPlane: persistent browser histograms disabled\n';

/** Chrome initializes these files before feature flags; a dedicated non-directory
 * storage path makes its allocator use its built-in local-memory fallback. */
export function prepareBrowserMetrics(profileDir: string, enabled: boolean, now = Date.now()) {
  pruneBrowserMetrics(profileDir, enabled, false, now);
  const storage = path.join(profileDir, 'BrowserMetrics');
  let stat;
  try { stat = lstatSync(storage); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  if (stat?.isSymbolicLink()) throw new Error('BrowserMetrics storage is not owned by this profile');
  if (enabled) {
    if (stat?.isFile() && readFileSync(storage, 'utf8') === disabledMarker) unlinkSync(storage);
    mkdirSync(storage, { recursive: true, mode: 0o700 });
  } else {
    if (stat?.isFile() && readFileSync(storage, 'utf8') === disabledMarker) return;
    // rmdir removes only an empty directory. Unknown or live files are preserved.
    if (stat?.isDirectory()) rmdirSync(storage);
    writeFileSync(storage, disabledMarker, { flag: 'wx', mode: 0o600 });
  }
}
