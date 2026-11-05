import { mkdirSync, mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { recordCreatedDevice } from '../devices/created-devices.ts';
import { isStimOwnedAvd, isStimOwnedSim } from '../devices/device-ownership.ts';
import { ownedSimName } from '../devices/ios.ts';
import { upsertProject } from '../workspace/config.ts';

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

test('a device the config records as owned is owned without a ledger entry only in the default home', () => {
  const user = mkdtempSync(join(tmpdir(), 'stim-test-'));
  homes.push(user);
  vi.stubEnv('HOME', user);
  vi.stubEnv('USERPROFILE', user);
  onTestFinished(() => {
    vi.unstubAllEnvs();
  });
  mkdirSync(join(user, 'app'));
  const recordOwned = () =>
    upsertProject(join(user, 'app'), {
      platforms: {
        ios: { deviceUdid: foreignSim.udid, owned: true },
        android: { avdName: 'stim-1362-mobile', owned: true },
      },
    });
  useHome();
  recordOwned();
  expect(isStimOwnedSim(foreignSim)).toBe(false);
  expect(isStimOwnedAvd('stim-1362-mobile')).toBe(false);

  delete process.env.STIM_HOME;
  recordOwned();
  expect(isStimOwnedSim(foreignSim)).toBe(true);
  expect(isStimOwnedAvd('stim-1362-mobile')).toBe(true);

  process.env.STIM_HOME = join(user, '.stim');
  expect(isStimOwnedSim(foreignSim)).toBe(false);
  expect(isStimOwnedAvd('stim-1362-mobile')).toBe(false);
});
