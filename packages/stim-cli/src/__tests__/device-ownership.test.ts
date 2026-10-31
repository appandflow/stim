import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { recordCreatedDevice } from '../devices/created-devices.ts';
import { isStimOwnedAvd, isStimOwnedSim } from '../devices/device-ownership.ts';
import { ownedSimName } from '../devices/ios.ts';

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
