import { refuseCiBelowFloor } from './ci-floor.ts';

it('refuses versions below the floor and the old executable while accepting supported inputs', () => {
  const cli = 'node_modules/stim/bin/stim.mjs';
  const floor = '1.42.0';
  for (const version of ['1.41.9', '1.42.0-next.1']) {
    expect(() => refuseCiBelowFloor(version, '', floor)).toThrow(
      `version ${version} installs @stim-cli/ci; this action runs stim ci from stim 1.42.0 or later. Set version: 1.42.0 or pin the action to an older ref`,
    );
  }
  expect(() => refuseCiBelowFloor('', 'packages/ci/dist/stim-ci.mjs', null)).toThrow(
    "cli-path names a stim-ci executable; this action runs stim ci. Point cli-path at stim's bin (node_modules/stim/bin/stim.mjs or packages/stim-cli/bin/stim.mjs in the stim repo), or pin the action to an older ref",
  );
  for (const version of ['1.42.0', '1.43.0-next.1', '1.100.0', '2.0.0']) {
    expect(() => refuseCiBelowFloor(version, '', floor)).not.toThrow();
  }
  expect(() => refuseCiBelowFloor('1.41.9', '', null)).not.toThrow();
  expect(() => refuseCiBelowFloor('', cli, floor)).not.toThrow();
});
