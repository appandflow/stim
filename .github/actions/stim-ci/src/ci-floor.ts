import { basename } from 'node:path';
import floors from '../../../../packages/core/state/release-floors.json' with { type: 'json' };

// compat C18 until removal-minor
export function refuseCiBelowFloor(version: string, cliPath: string, floor: string | null = floors.oneEngine): void {
  const oldBin = basename(cliPath) === 'stim-ci.mjs';
  const order = floor ? version.replace(/-.*/, '').localeCompare(floor, 'en', { numeric: true }) : 0;
  const message = oldBin
    ? "cli-path names a stim-ci executable; this action runs stim ci. Point cli-path at stim's bin (node_modules/stim/bin/stim.mjs or packages/stim-cli/bin/stim.mjs in the stim repo), or pin the action to an older ref"
    : version && floor && (order < 0 || (!order && version.includes('-')))
      ? `version ${version} installs @stim-cli/ci; this action runs stim ci from stim ${floor} or later. Set version: ${floor} or pin the action to an older ref`
      : '';
  if (message) throw new Error(message);
}
// compat end
