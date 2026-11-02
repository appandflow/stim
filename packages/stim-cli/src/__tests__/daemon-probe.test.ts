import { parseAvdName, parseFrontApp, parseHidIdleMs } from '../daemon/probe.ts';
import { parseVmStatAvailable } from '../daemon/measure.ts';
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
    'the smaller of the two older settings',
    { metro: { idleStopMinutes: 60 }, devices: { idleShutdownMinutes: 30 } },
    30,
  ],
  ['a 0 in either older setting', { metro: { idleStopMinutes: 0 } }, 0],
  ['idle.minutes over both older settings', { idle: { minutes: 45 }, metro: { idleStopMinutes: 5 } }, 45],
])('idle.minutes resolves to %s', (_, settings, minutes) => {
  expect(idleMinutesSetting(settings)).toBe(minutes);
});
