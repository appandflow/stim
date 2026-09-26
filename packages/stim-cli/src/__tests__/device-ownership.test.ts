import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { recordCreatedDevice } from '../devices/created-devices.ts';
import { isStimOwnedAvd, isStimOwnedSim } from '../devices/device-ownership.ts';
import { ownedSimName } from '../devices/ios.ts';
import { saveConfig } from '../workspace/config.ts';

const homes: string[] = [];

function useHome(): void {
  const home = mkdtempSync(join(tmpdir(), 'stim-test-'));
  homes.push(home);
  process.env.STIM_HOME = home;
}

afterEach(() => {
  delete process.env.STIM_HOME;
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});

const foreignSim = {
  udid: 'FOREIGN-UDID',
  name: ownedSimName('1362-mobile', { model: 'iPhone 18 Pro', runtime: '27.0' }),
};

test('a device another Stim home created is not owned by this home, whatever its name', () => {
  useHome();
  recordCreatedDevice('ios', foreignSim.udid);
  recordCreatedDevice('android', 'stim-1362-mobile');
  expect(isStimOwnedSim(foreignSim)).toBe(true);
  expect(isStimOwnedAvd('stim-1362-mobile')).toBe(true);

  useHome();
  expect(isStimOwnedSim(foreignSim)).toBe(false);
  expect(isStimOwnedAvd('stim-1362-mobile')).toBe(false);
});

test('this home owns a pre-ledger device its project registry or pool records as owned', () => {
  useHome();
  saveConfig({
    version: 2,
    repos: {},
    projects: {
      '/p': { platforms: { ios: { deviceUdid: 'PROJECT-UDID', owned: true }, android: { avdName: 'stim-p' } } },
    },
    parked: {
      ios: [],
      android: [
        {
          udid: 'stim-parked',
          name: 'stim-parked',
          systemImage: 'system-images;android-36;google_apis;arm64-v8a',
          configuration: '[]',
          parkedAt: '2026-09-01T00:00:00.000Z',
        },
      ],
    },
  });
  expect(isStimOwnedSim({ udid: 'PROJECT-UDID', name: 'stim-p (iPhone 17 26.5)' })).toBe(true);
  expect(isStimOwnedAvd('stim-parked')).toBe(true);
  expect(isStimOwnedAvd('stim-p')).toBe(false);
  expect(isStimOwnedSim({ udid: 'PROJECT-UDID', name: 'iPhone 17' })).toBe(false);
});
