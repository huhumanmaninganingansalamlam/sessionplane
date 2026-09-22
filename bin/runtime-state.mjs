import { homedir } from 'node:os';
import path from 'node:path';

export function ensureSessionPlaneStateDir(
  env = process.env,
  homeDir = homedir(),
  argv = process.argv.slice(2),
) {
  const canonical = path.join(homeDir, '.local', 'state', 'sessionplane');
  const explicitArg = stateDirFromArgv(argv);
  const explicitEnv = env.SESSIONPLANE_STATE_DIR?.trim() || null;

  for (const requested of [explicitArg, explicitEnv]) {
    if (requested !== null && path.resolve(requested) !== canonical) {
      throw new Error(
        `Installed SessionPlane uses one canonical runtime state: ${canonical}. ` +
          'Isolated --state-dir runtimes are test-only.',
      );
    }
  }

  env.SESSIONPLANE_STATE_DIR = canonical;
  return canonical;
}

function stateDirFromArgv(argv) {
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === '--state-dir') {
      const next = argv[index + 1]?.trim();
      return next ? next : null;
    }
    if (value?.startsWith('--state-dir=')) {
      const inline = value.slice('--state-dir='.length).trim();
      return inline || null;
    }
  }
  return null;
}
