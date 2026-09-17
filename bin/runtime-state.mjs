import { homedir } from 'node:os';
import path from 'node:path';

export function ensureSessionPlaneStateDir(env = process.env, homeDir = homedir()) {
  const explicit = env.SESSIONPLANE_STATE_DIR?.trim();
  if (explicit) return explicit;

  const configuredStateHome = env.XDG_STATE_HOME?.trim();
  const stateHome =
    configuredStateHome && path.isAbsolute(configuredStateHome)
      ? configuredStateHome
      : path.join(homeDir, '.local', 'state');
  const stateDir = path.join(stateHome, 'sessionplane');
  env.SESSIONPLANE_STATE_DIR = stateDir;
  return stateDir;
}
