import { parseProcessTable } from '../devices/activity.ts';
import { attributeMachineUsage } from '../machine-usage.ts';
import { makeEnvironmentState } from './_factories.ts';
import type { MachineOwner } from '@stim-cli/core/state';

const UDID_A = 'AAAAAAAA-0000-4000-8000-000000000001';
const UDID_B = 'BBBBBBBB-0000-4000-8000-000000000002';
const UDID_USER = 'CCCCCCCC-0000-4000-8000-000000000003';
const RUNTIME = '/private/var/run/com.apple.security.cryptexd/mnt/iOS.simruntime/usr/libexec';
const START = 'Sat Sep 26 15:33:49 2026';

// Every process is 1 MB, so an owner's residentMb equals its process count.
const table = (rows: [pid: number, ppid: number, cpu: number, command: string][]) =>
  parseProcessTable(
    rows.map(([pid, ppid, cpu, command]) => `${pid} ${ppid} 1024 ${cpu} ${START} ${command}`).join('\n'),
  );

const processes = table([
  [
    10,
    1,
    9.4,
    '/Library/Developer/PrivateFrameworks/CoreSimulator.framework/Versions/A/XPCServices/com.apple.CoreSimulator.CoreSimulatorService.xpc/Contents/MacOS/com.apple.CoreSimulator.CoreSimulatorService',
  ],
  [
    11,
    1,
    14.1,
    '/Library/Developer/PrivateFrameworks/CoreSimulator.framework/Versions/A/Resources/SimRenderingServices.simdeviceio/Contents/XPCServices/SimMetalHost.xpc/Contents/MacOS/SimMetalHost',
  ],
  [12, 1, 0.2, 'adb -L tcp:5037 fork-server server --reply-fd 4'],
  [13, 1, 3, '/usr/bin/java -Xmx2g -cp gradle-launcher.jar org.gradle.launcher.daemon.bootstrap.GradleDaemon 8.14'],
  [14, 13, 1, '/Users/me/.gradle/caches/aapt2 daemon'],
  [16, 1, 0.5, 'node /Users/me/stim/packages/server/dist/stim-server.mjs --port 7787'],
  [
    100,
    1,
    0.2,
    `launchd_sim /Users/me/Library/Developer/CoreSimulator/Devices/${UDID_A}/data/var/run/launchd_bootstrap.plist`,
  ],
  [101, 100, 2.8, `${RUNTIME}/backboardd`],
  [102, 100, 7.3, `${RUNTIME}/SpringBoard`],
  [
    110,
    1,
    0.1,
    `launchd_sim /Users/me/Library/Developer/CoreSimulator/Devices/${UDID_B}/data/var/run/launchd_bootstrap.plist`,
  ],
  [111, 110, 1, `${RUNTIME}/SpringBoard`],
  [
    120,
    1,
    0,
    `launchd_sim /Users/me/Library/Developer/CoreSimulator/Devices/${UDID_USER}/data/var/run/launchd_bootstrap.plist`,
  ],
  [121, 120, 0, `${RUNTIME}/SpringBoard`],
  [300, 299, 0, 'node /Users/me/stim/cli.mjs ios --json'],
  [199, 300, 0, 'stim-supervisor'],
  [200, 199, 25, 'node /w/a/node_modules/expo/bin/cli start --port 8081'],
  [301, 300, 0, '/Applications/Xcode.app/Contents/Developer/usr/bin/xcodebuild -workspace /w/a/ios/a.xcworkspace'],
  [302, 301, 40, '/Applications/Xcode.app/Contents/SharedFrameworks/SwiftBuild.framework/SWBBuildService'],
  [303, 302, 95, '/Applications/Xcode.app/Contents/Developer/Toolchains/XcodeDefault.xctoolchain/usr/bin/clang -c x.m'],
  [399, 1, 0, 'stim-supervisor'],
  [400, 399, 3, 'node /w/b/node_modules/.bin/react-native start --port 8082'],
  [
    401,
    399,
    1,
    `/Library/Developer/PrivateFrameworks/CoreSimulator.framework/Versions/A/Resources/bin/simctl spawn ${UDID_B} log stream`,
  ],
  [500, 1, 0.1, '/Users/me/Library/Android/sdk/emulator/emulator @stim-b -port 5554 -no-window'],
  [
    501,
    500,
    60,
    '/Users/Jane Doe/Library/Android/sdk/emulator/qemu/darwin-aarch64/qemu-system-aarch64 -avd stim-b -port 5554',
  ],
  [502, 501, 0, '/Users/me/Library/Android/sdk/emulator/crashpad_handler'],
  [600, 1, 0.2, 'stim-web-supervisor'],
  [601, 600, 5, '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome --user-data-dir=/stim/web/profile'],
  [602, 601, 2, '/Applications/Google Chrome.app/Contents/Frameworks/Google Chrome Helper (Renderer).app'],
  [900, 1, 50, '/usr/bin/unrelated'],
]);

const a = makeEnvironmentState({
  path: '/w/a',
  ios: { name: 'stim-a (iPhone 17 Pro 26.5)', udid: UDID_A, owned: true, state: 'Booted' },
  metro: { port: 8081, running: true, pid: 200 },
});
const b = makeEnvironmentState({
  path: '/w/b',
  ios: { name: 'stim-b (iPhone 17 Pro 26.5)', udid: UDID_B, owned: true, state: 'Booted' },
  slots: [
    {
      slot: 'tablet',
      ios: null,
      android: { name: 'stim-b', owned: true, physical: false, serial: 'emulator-5554', state: 'detected' },
    },
  ],
  metro: { port: 8082, running: true, pid: 400 },
});

const attribute = () =>
  attributeMachineUsage({
    processes,
    environments: [a, b],
    roots: [
      { path: '/w/a', supervisorPid: 199, build: { platform: 'ios', pid: 300 }, browserPids: [] },
      { path: '/w/b', supervisorPid: 399, build: null, browserPids: [600, 601] },
    ],
    simNames: { [UDID_USER]: 'iPhone 16 (user)' },
  });

const residentByWorkspace = (owners: MachineOwner[]) => {
  const sums: Record<string, number> = {};
  for (const o of owners) if (o.workspace) sums[o.workspace] = (sums[o.workspace] ?? 0) + o.residentMb;
  return sums;
};

test('each process counts once, in the owner of its nearest root', () => {
  const machine = attribute();
  const rows = machine.owners.map((o) => [
    o.kind,
    o.name,
    o.workspace,
    o.slot ?? null,
    o.owned,
    o.processes,
    o.cpuPercent,
  ]);
  expect(rows).toEqual(
    expect.arrayContaining([
      ['simulator', 'stim-a (iPhone 17 Pro 26.5)', '/w/a', null, true, 3, 10],
      ['metro', 'Metro :8081', '/w/a', null, true, 2, 25],
      ['build', 'iOS build', '/w/a', null, true, 4, 135],
      ['simulator', 'stim-b (iPhone 17 Pro 26.5)', '/w/b', null, true, 2, 1],
      ['emulator', 'stim-b', '/w/b', 'tablet', true, 3, 60],
      ['metro', 'Metro :8082', '/w/b', null, true, 3, 4],
      ['browser', 'Chrome', '/w/b', null, true, 3, 7],
      ['simulator', 'iPhone 16 (user)', null, null, false, 2, 0],
      ['shared', 'CoreSimulator services', null, null, false, 2, 24],
      ['shared', 'adb server', null, null, false, 1, 0],
      ['shared', 'Gradle daemon', null, null, false, 2, 4],
      ['server', 'stim-server', null, null, false, 1, 1],
    ]),
  );
  expect(rows).toHaveLength(12);
  const attributed = machine.owners.reduce((n, o) => n + o.processes, 0);
  expect(attributed).toBe(processes.length - 1);
  expect(machine.owners.reduce((n, o) => n + o.residentMb, 0)).toBe(attributed);
  expect(residentByWorkspace(machine.owners)).toEqual({ '/w/a': 9, '/w/b': 11 });
});

test('a simulator two workspaces both record counts in one of them only', () => {
  const shared = makeEnvironmentState({ ...b, path: '/w/c', ios: a.ios, slots: [] });
  const machine = attributeMachineUsage({
    processes,
    environments: [a, shared],
    roots: [],
    simNames: {},
  });
  expect(machine.owners.filter((o) => o.id === UDID_A)).toHaveLength(1);
  expect(residentByWorkspace(machine.owners)).toEqual({ '/w/c': 3 });
});

test('a recorded pid that is no longer in the table claims nothing', () => {
  const machine = attributeMachineUsage({
    processes,
    environments: [makeEnvironmentState({ path: '/w/d', metro: { port: 8090, running: true, pid: 4242 } })],
    roots: [{ path: '/w/d', supervisorPid: 4243, build: { platform: 'android', pid: 4244 }, browserPids: [4245] }],
    simNames: {},
  });
  expect(machine.owners.filter((o) => o.workspace === '/w/d')).toEqual([]);
});
