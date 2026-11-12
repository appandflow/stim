import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createdDevicesFile, readStimHomes, stimHomesRoot } from '@stim-cli/core/state';
import { runGc } from '../commands/gc.ts';
import { collectDeviceRecords } from '../commands/gc/records.ts';
import { forgetCreatedDevice } from '../devices/created-devices.ts';
import { recordStimHome } from '../engine/stim-home-registry.ts';
import { getExecutor, resetExecutor, setExecutor } from '../exec.ts';
import { loadConfig, saveConfig } from '../workspace/config.ts';

const SCRATCH_SIM = {
  udid: 'SCRATCH-UDID',
  name: 'stim-scratch (iPhone 17 iOS 27)',
  state: 'Shutdown',
  deviceTypeIdentifier: 'com.apple.CoreSimulator.SimDeviceType.iPhone-17',
  isAvailable: true,
};

async function collectRecords() {
  const records = await collectDeviceRecords(loadConfig(), []);
  return { ...records, otherHomes: records.otherHomes?.homes ?? [] };
}

describe('gc reports the other Stim homes of the machine list', () => {
  let dir: string;
  let scratch: string;
  let listing: unknown[];

  beforeEach(() => {
    dir = realpathSync(mkdtempSync(join(tmpdir(), 'stim-other-homes-gc-')));
    scratch = join(dir, 'scratch');
    mkdirSync(scratch);
    writeFileSync(
      createdDevicesFile(scratch),
      JSON.stringify({ version: 1, ios: ['SCRATCH-UDID'], android: [], web: [] }),
    );
    vi.stubEnv('HOME', dir);
    vi.stubEnv('USERPROFILE', dir);
    vi.stubEnv('ANDROID_AVD_HOME', join(dir, 'avd'));
    delete process.env.STIM_HOME;
    saveConfig({ version: 2, projects: {}, repos: {} });
    recordStimHome(scratch, { devices: { ios: ['SCRATCH-UDID'], android: [] } });
    listing = [SCRATCH_SIM];
    const real = getExecutor();
    setExecutor({
      ...real,
      run: () => '',
      runQuiet: () => null,
      runFileAsync: async (file, args, options) => getExecutor().runFile(file, args, options),
      runFile: (file, args) =>
        file === 'xcrun' && args[0] === 'simctl' && args[1] === 'list'
          ? JSON.stringify({ devices: { 'com.apple.CoreSimulator.SimRuntime.iOS-27-0': listing } })
          : '',
      runFileQuiet: () => null,
    });
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    resetExecutor();
    rmSync(dir, { recursive: true, force: true });
    process.exitCode = 0;
  });

  test('lists a scratch home with its owned simulator, and a scoped home lists none', async () => {
    const report = await collectRecords();
    expect(report.otherHomes).toEqual([
      expect.objectContaining({
        path: scratch,
        state: 'present',
        devices: [expect.objectContaining({ id: 'SCRATCH-UDID', name: SCRATCH_SIM.name, present: true })],
      }),
    ]);
    expect(report.unverifiedDevices.map((device) => device.id)).toEqual(['SCRATCH-UDID']);

    process.env.STIM_HOME = join(dir, 'own-scoped-home');
    mkdirSync(process.env.STIM_HOME);
    saveConfig({ version: 2, projects: {}, repos: {} });
    expect((await collectRecords()).otherHomes).toEqual([]);
  });

  test('keeps a gone home while its simulator is still there, and gc drops it once nothing is left', async () => {
    rmSync(scratch, { recursive: true });
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const orphaned = await collectRecords();
      expect(orphaned.otherHomes).toEqual([
        expect.objectContaining({ path: scratch, state: 'gone', forgettable: false }),
      ]);
      await runGc({ pressure: 'normal' });
      expect([...readStimHomes(stimHomesRoot()).homes.keys()]).toEqual([scratch]);

      listing = [];
      expect((await collectRecords()).otherHomes).toEqual([
        expect.objectContaining({ path: scratch, state: 'gone', forgettable: true }),
      ]);
      await runGc({ pressure: 'normal' });
      expect([...readStimHomes(stimHomesRoot()).homes.keys()]).toEqual([]);
    } finally {
      log.mockRestore();
      error.mockRestore();
    }
  });

  test('a proper teardown that empties the ledger mirror leaves nothing to report once the directory is gone', async () => {
    process.env.STIM_HOME = scratch;
    forgetCreatedDevice('ios', 'SCRATCH-UDID');
    delete process.env.STIM_HOME;
    listing = [];
    rmSync(scratch, { recursive: true });
    expect((await collectRecords()).otherHomes).toEqual([
      expect.objectContaining({ state: 'gone', forgettable: true, devices: [] }),
    ]);
  });
});
