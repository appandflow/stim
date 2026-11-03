import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { OwnedDeviceActivity } from '../commands/gc/idle.ts';
import { recordCreatedDevice } from '../devices/created-devices.ts';
import { getExecutor } from '../exec.ts';
import { parseAvdName, parseFrontApp, parseHidIdleMs, probeFocusedDeviceUse } from '../daemon/probe.ts';
import { focusedSlots, parseVmStatAvailable } from '../daemon/measure.ts';
import type { Config } from '../workspace/config.ts';
import { idleMinutesSetting } from '../workspace/settings.ts';

test('the probe reads the HID idle time, the frontmost app and an emulator window AVD from macOS tool output', () => {
  expect(parseHidIdleMs('    | | |   "HIDIdleTime" = 4682113625\n')).toBe(4682);
  expect(parseHidIdleMs('+-o IOHIDSystem\n')).toBe(null);
  const front = [
    '"Simulator" ASN:0x0-0x1565063b: (in front) ',
    '    bundleID="com.apple.iphonesimulator"',
    '    bundle path=[ NULL ] ',
    '    executable path="/Applications/Xcode.app/Contents/Developer/Applications/Simulator.app/Contents/MacOS/Simulator"',
    '    pid = 24393 !cgsConnection !signalled type=[ NULL ]  flavor=[ NULL ]  Version=[ NULL ]  Arch=!!none ',
  ].join('\n');
  expect(parseFrontApp(front)).toEqual({
    bundleId: 'com.apple.iphonesimulator',
    pid: 24393,
    executable: '/Applications/Xcode.app/Contents/Developer/Applications/Simulator.app/Contents/MacOS/Simulator',
  });
  expect(
    parseAvdName('/sdk/emulator/qemu/darwin-aarch64/qemu-system-aarch64 -netdelay none -avd stim-app -port 5554'),
  ).toBe('stim-app');
  expect(parseAvdName('/sdk/emulator/qemu/darwin-aarch64/qemu-system-aarch64 @stim-app -no-snapshot')).toBe('stim-app');
});

function frontmost(bundleId: string, currentUdid: string | null) {
  return {
    ...getExecutor(),
    async runFileAsync(file: string, args: string[] = []) {
      if (file === 'ioreg') return '    | | |   "HIDIdleTime" = 4682113625\n';
      if (file === 'lsappinfo' && args[0] === 'front') return 'ASN:0x0-0x1565063b:\n';
      if (file === 'lsappinfo') return `bundleID="${bundleId}"\npid = 24393\n`;
      if (file === 'defaults' && currentUdid) return `${currentUdid}\n`;
      throw new Error(`${file} failed`);
    },
  };
}

test('Device Hub in front, or Simulator with no readable current device, names no simulator', async () => {
  expect(
    await probeFocusedDeviceUse({ platform: 'darwin', exec: frontmost('com.apple.dt.Devices', 'UDID-A') }),
  ).toEqual({ platform: 'ios', udid: null, idleMs: 4682 });
  expect(
    await probeFocusedDeviceUse({ platform: 'darwin', exec: frontmost('com.apple.iphonesimulator', null) }),
  ).toEqual({ platform: 'ios', udid: null, idleMs: 4682 });
  expect(
    await probeFocusedDeviceUse({ platform: 'darwin', exec: frontmost('com.apple.iphonesimulator', 'UDID-A') }),
  ).toEqual({ platform: 'ios', udid: 'UDID-A', idleMs: 4682 });
  expect(await probeFocusedDeviceUse({ platform: 'darwin', exec: frontmost('com.apple.Terminal', null) })).toBe(null);
});

test('use with no named simulator counts for every booted simulator this home owns, a named one for its slot only', () => {
  const home = mkdtempSync(join(tmpdir(), 'stim-probe-'));
  process.env.STIM_HOME = home;
  onTestFinished(() => {
    delete process.env.STIM_HOME;
    rmSync(home, { recursive: true, force: true });
  });
  recordCreatedDevice('ios', 'UDID-A');
  recordCreatedDevice('ios', 'UDID-B');
  const config: Config = {
    version: 2,
    repos: {},
    projects: {
      '/w/a': { platforms: { ios: { deviceUdid: 'UDID-A', owned: true } } },
      '/w/b': { platforms: { ios: { deviceUdid: 'UDID-B', owned: true } } },
      '/w/c': { platforms: { ios: { deviceUdid: 'UDID-C', owned: true } } },
    },
  };
  const booted = (project: string, id: string): OwnedDeviceActivity => ({
    kind: 'ios',
    id,
    name: `stim-${id}`,
    project,
    slot: 'default',
    activity: { state: 'idle', basis: [] },
  });
  const devices = [booted('/w/a', 'UDID-A'), booted('/w/b', 'UDID-B'), booted('/w/c', 'UDID-C')];

  expect(focusedSlots({ platform: 'ios', udid: null, idleMs: 0 }, config, devices)).toEqual([
    { root: '/w/a', key: 'ios', id: 'UDID-A' },
    { root: '/w/b', key: 'ios', id: 'UDID-B' },
  ]);
  expect(focusedSlots({ platform: 'ios', udid: 'UDID-B', idleMs: 0 }, config, devices)).toEqual([
    { root: '/w/b', key: 'ios', id: 'UDID-B' },
  ]);
});

test('available memory is the free, inactive and speculative pages of vm_stat', () => {
  const output = [
    'Mach Virtual Memory Statistics: (page size of 16384 bytes)',
    'Pages free:                                     6065.',
    'Pages active:                                 779652.',
    'Pages inactive:                               778429.',
    'Pages speculative:                               163.',
  ].join('\n');
  expect(parseVmStatAvailable(output)).toBe((6065 + 778429 + 163) * 16384);
  expect(parseVmStatAvailable('Pages free: 1.')).toBe(null);
});

test.each([
  ['the default', {}, 15],
  [
    'the default, whatever the removed settings say',
    { metro: { idleStopMinutes: 0 }, devices: { idleShutdownMinutes: 5 } },
    15,
  ],
  ['idle.minutes', { idle: { minutes: 45 }, metro: { idleStopMinutes: 5 } }, 45],
])('idle.minutes resolves to %s', (_, settings, minutes) => {
  expect(idleMinutesSetting(settings)).toBe(minutes);
});
