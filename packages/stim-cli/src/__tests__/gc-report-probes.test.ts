import type { ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { collectParkedAvds, collectParkedSims } from '../commands/gc/devices.ts';

import { getExecutor, resetExecutor, setExecutor } from '../exec.ts';
import { parkSim } from '../devices/sim-pool.ts';
import { recordCreatedDevice } from '../devices/created-devices.ts';
import { upsertProject } from '../workspace/config.ts';

let home: string;
let child: ChildProcess | undefined;
let reportAbort: AbortController | undefined;
let activeReport: Promise<unknown> | undefined;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'stim-gc-report-probes-'));
  vi.stubEnv('STIM_HOME', home);
  resetExecutor();
});

afterEach(async () => {
  reportAbort?.abort();
  await activeReport?.catch(() => {});
  reportAbort = undefined;
  activeReport = undefined;
  if (child?.exitCode === null && child.signalCode === null) {
    const closed = once(child, 'close');
    child.kill('SIGKILL');
    await closed;
  }
  child = undefined;
  vi.clearAllTimers();
  resetExecutor();
  vi.unstubAllEnvs();
  rmSync(home, { recursive: true, force: true });
});

function gatedProbe() {
  let markStarted: () => void = () => {};
  const started = new Promise<void>((resolve) => {
    markStarted = resolve;
  });
  let release: () => void = () => {};
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  return {
    run<T>(probe: () => Promise<T>): Promise<T> {
      markStarted();
      return released.then(probe);
    },
    async settle<T>(report: Promise<T>): Promise<T> {
      const pending = await Promise.race([started.then(() => true), report.then(() => false)]);
      expect(pending).toBe(true);
      release();
      return report;
    },
  };
}

test.each(['simulators', 'device types', 'AVDs', 'AVD size'] as const)(
  'a slow %s child leaves the event loop responsive while collecting parked devices',
  async (slow) => {
    const ios = slow === 'simulators' || slow === 'device types';
    const platform = ios ? 'ios' : 'android';
    const id = ios ? 'OWNED-SIM' : 'stim-owned-avd';
    recordCreatedDevice(platform, id);
    upsertProject('/source', {
      platforms: ios
        ? { ios: { deviceUdid: id, deviceName: 'stim-owned-sim', owned: true } }
        : { android: { avdName: id, owned: true } },
    });
    parkSim({
      platform,
      projectPath: '/source',
      max: 3,
      record: ios
        ? {
            udid: id,
            name: 'stim-owned-sim',
            runtimeIdentifier: 'com.apple.CoreSimulator.SimRuntime.iOS-26-5',
            deviceTypeIdentifier: 'iphone',
            simslimManaged: false,
            parkedAt: new Date().toISOString(),
          }
        : {
            udid: id,
            name: id,
            systemImage: 'system-images;android-36;google_apis;arm64-v8a',
            configuration: '[]',
            parkedAt: new Date().toISOString(),
          },
    });
    const outputs = {
      simulators: JSON.stringify({
        devices: {
          'com.apple.CoreSimulator.SimRuntime.iOS-26-5': [
            {
              udid: id,
              name: 'stim-owned-sim',
              state: 'Shutdown',
              deviceTypeIdentifier: 'iphone',
              isAvailable: true,
              dataPathSize: 1024,
            },
          ],
        },
      }),
      'device types': JSON.stringify({ devicetypes: [{ identifier: 'iphone', name: 'iPhone' }] }),
      AVDs: id,
      'AVD size': `1\t${home}`,
    };
    const probe = (file: string, args: string[]) => {
      if (file === 'du') return 'AVD size';
      if (args.includes('-list-avds')) return 'AVDs';
      if (args.includes('devicetypes')) return 'device types';
      if (args.includes('devices')) return 'simulators';
      throw new Error(`Unexpected report probe: ${file} ${args.join(' ')}`);
    };
    const executor = getExecutor();
    const delay = ['-e', 'setTimeout(() => process.stdout.write(process.argv[1]), 150)', outputs[slow]];
    const gate = gatedProbe();
    setExecutor({
      runFile(file, args, options) {
        const phase = probe(file, args);
        return phase === slow ? executor.runFile(process.execPath, delay, options) : outputs[phase];
      },
      runFileAsync(file, args, options) {
        const phase = probe(file, args);
        return phase === slow
          ? gate.run(() => executor.runFileAsync(process.execPath, delay, options))
          : Promise.resolve(outputs[phase]);
      },
    });
    const report = ios
      ? await gate.settle(collectParkedSims({}))
      : await gate.settle(collectParkedAvds({ avdDirectory: () => home }));
    expect(report).toMatchObject([
      { listed: true, bytes: 1024, ...(ios ? { udid: id, model: 'iPhone' } : { name: id }) },
    ]);
  },
);
