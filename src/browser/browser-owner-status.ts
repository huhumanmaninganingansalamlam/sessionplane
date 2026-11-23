import type { BrowserStatusSource } from './browser-health.ts';
import type { BrowserOwnerState } from './browser-owner-state.ts';
import type { TeamTabGroupStatus } from './team-group-synchronizer.ts';

/** Read-only projection of the one Core-owned browser process and native
 * group status. A reported group membership is never evidence of Task ownership.
 */
export function browserOwnerStatus(
  state: BrowserOwnerState,
): BrowserStatusSource & { teamTabGroups: TeamTabGroupStatus } {
  return Object.freeze({
    state: state.process.state, profileDir: state.profile.profileDir, headless: state.process.headless,
    chrome: state.process.chrome,
    transport: state.process.ownership === 'manual' ? null : 'cdp',
    ownership: state.process.ownership,
    browserPid: state.process.browserPid,
    debuggingPort: state.process.debuggingPort,
    lastError: state.process.lastError,
    teamTabGroups: state.groups.groupsStatus,
  });
}
