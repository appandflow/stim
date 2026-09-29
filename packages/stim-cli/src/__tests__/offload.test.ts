import type { MachineCapacity, OffloadMode } from '@stim-cli/core/state';
import { offerProblems, offloadPlacement, pickOffer, type BuildOffer } from '../offload/client.ts';
import {
  iphoneRuntimes,
  jdkMajor,
  parseAndroidRequirements,
  type BuildTarget,
  type IosToolchain,
  type WorkerToolchain,
} from '../offload/toolchain.ts';

const RUNTIME = 'com.apple.CoreSimulator.SimRuntime.iOS-27-0';

const LOCAL: IosToolchain = {
  stimBuild: 'b1',
  arch: 'arm64',
  xcode: 'Xcode 27.0 / Build version 27A266a',
  simulatorSdk: '27.0',
  cocoapods: '1.16.2',
};

const IOS: BuildTarget = { platform: 'ios', local: LOCAL, runtime: RUNTIME };

const ANDROID: BuildTarget = {
  platform: 'android',
  local: { stimBuild: 'b1', arch: 'arm64', jdk: '17' },
  requires: { ndk: '27.1.12297006', buildTools: '37.0.0', compileSdk: '37' },
};

const SDK = { ndk: ['27.1.12297006'], buildTools: ['37.0.0'], platforms: ['android-36', 'android-37.0'] };

function offer(
  overrides: Omit<Partial<BuildOffer>, 'toolchain'> & { toolchain?: Partial<WorkerToolchain> } = {},
): BuildOffer {
  return {
    capacity: capacity(),
    warm: { checkout: false, dependencies: false, build: false },
    ...overrides,
    toolchain: { ...LOCAL, runtimes: [RUNTIME], jdk: '17', androidSdk: SDK, ...overrides.toolchain },
  };
}

const IDLE: MachineCapacity = { cpus: 10, loadPerCore: 0.3, builds: 0, maxBuilds: 3, maxLoadPerCore: 2 };

function capacity(overrides: Partial<BuildOffer['capacity']> = {}): BuildOffer['capacity'] {
  return {
    running: 0,
    max: 1,
    diskFreeBytes: 500 * 1024 ** 3,
    minDiskFreeBytes: 10 * 1024 ** 3,
    cpus: 10,
    loadPerCore: 0.2,
    builds: 0,
    maxBuilds: 0,
    maxLoadPerCore: 2,
    declined: null,
    ...overrides,
  };
}

describe('offloadPlacement', () => {
  const base = { mode: 'auto' as const, machines: 1, here: IDLE, unsupported: null };

  it.each([
    ['auto, a free slot and low load', base, false, 'load 0.3/core, 0 of 3 build slots busy here'],
    [
      'auto, no build limit and low load',
      { ...base, here: { ...IDLE, maxBuilds: 0, builds: 9 } },
      false,
      'load 0.3/core, 9 builds here',
    ],
    [
      'auto, every slot busy',
      { ...base, here: { ...IDLE, builds: 3 } },
      true,
      'this Mac is busy: all 3 build slots busy (load 0.3/core, 3 of 3 build slots busy)',
    ],
    [
      'auto, no build limit but saturated',
      { ...base, here: { ...IDLE, maxBuilds: 0, loadPerCore: 8.2 } },
      true,
      'this Mac is busy: load at or above 2/core (load 8.2/core, 0 builds)',
    ],
    ['force on an idle Mac', { ...base, mode: 'force' as const }, true, 'offload.mode is force'],
    [
      'off on a saturated Mac',
      { ...base, mode: 'off' as const, here: { ...IDLE, builds: 3 } },
      false,
      'offload.mode is off',
    ],
    ['force with no machine', { ...base, mode: 'force' as const, machines: 0 }, false, 'no build machine is paired'],
    [
      'force for a device build',
      { ...base, mode: 'force' as const, unsupported: 'device builds build here' },
      false,
      'device builds build here',
    ],
  ])('%s', (_, input, offload, reason) => {
    expect(offloadPlacement(input)).toEqual({ offload, reason });
  });
});

describe('pickOffer', () => {
  const pick = (
    offers: Array<BuildOffer | null>,
    { mode = 'auto', here = { ...IDLE, builds: 3 } }: { mode?: OffloadMode; here?: MachineCapacity } = {},
    target: BuildTarget = IOS,
  ) =>
    pickOffer({
      mode,
      here,
      target,
      offers: offers.map((each, index) => ({ machine: `mac${index}`, offer: each, failure: 'unreachable' })),
    });

  it('refuses any toolchain difference, a missing runtime, a busy machine and a full disk in either mode', () => {
    for (const mode of ['auto', 'force'] as const) {
      for (const refused of [
        offer({ toolchain: { stimBuild: 'b2' } }),
        offer({ toolchain: { cocoapods: '1.17.0' } }),
        offer({ toolchain: { xcode: 'Xcode 26.4' } }),
        offer({ toolchain: { simulatorSdk: '27.1' } }),
        offer({ toolchain: { arch: 'x64' } }),
        offer({ toolchain: { runtimes: ['com.apple.CoreSimulator.SimRuntime.iOS-26-5'] } }),
        offer({ capacity: capacity({ running: 1, declined: 'already running 1 offloaded build(s), its limit' }) }),
        offer({ capacity: capacity({ loadPerCore: 8.2, builds: 2, declined: 'load at or above 2/core' }) }),
        offer({ capacity: capacity({ diskFreeBytes: 1024 ** 3, declined: '1.0 GB free, builds need 10.0 GB' }) }),
        offer({ capacity: { running: 1, max: 1, diskFreeBytes: null, minDiskFreeBytes: 0 } }),
      ]) {
        expect(pick([refused], { mode }).order).toEqual([]);
      }
    }
    expect(pick([offer()], {}, { ...IOS, local: { ...LOCAL, stimBuild: null } }).order).toEqual([]);
  });

  it.each([
    ['auto, slots full here, idle machine', 'auto', { ...IDLE, builds: 3 }, capacity(), 0, []],
    [
      'auto, slots full here, machine more loaded but accepting',
      'auto',
      { ...IDLE, builds: 3 },
      capacity({ loadPerCore: 1.5 }),
      0,
      [],
    ],
    [
      'auto, saturated by load here, machine less loaded',
      'auto',
      { ...IDLE, maxBuilds: 0, loadPerCore: 6 },
      capacity({ loadPerCore: 1.1, builds: 1 }),
      0,
      [],
    ],
    [
      'auto, saturated by load here, machine no less loaded',
      'auto',
      { ...IDLE, maxBuilds: 0, loadPerCore: 2.4 },
      capacity({ loadPerCore: 2.4 }),
      null,
      ['mac0: no less loaded (load 2.4/core there, 2.4/core here)'],
    ],
    [
      'auto, both saturated',
      'auto',
      { ...IDLE, builds: 3, loadPerCore: 9 },
      capacity({ loadPerCore: 8.2, builds: 2, declined: 'load at or above 2/core' }),
      null,
      ['mac0: busy (load at or above 2/core; load 8.2/core, 2 builds)'],
    ],
    [
      'auto, older machine, slots full here',
      'auto',
      { ...IDLE, builds: 3 },
      { running: 0, max: 1, diskFreeBytes: null, minDiskFreeBytes: 0 },
      0,
      [],
    ],
    [
      'auto, older machine, saturated by load only',
      'auto',
      { ...IDLE, maxBuilds: 0, loadPerCore: 6 },
      { running: 0, max: 1, diskFreeBytes: null, minDiskFreeBytes: 0 },
      null,
      ['mac0: capacity unknown (older stim-server) while this Mac has a free slot'],
    ],
    ['force, idle here, machine more loaded', 'force', IDLE, capacity({ loadPerCore: 1.9 }), 0, []],
    ['force, older machine', 'force', IDLE, { running: 0, max: 1, diskFreeBytes: null, minDiskFreeBytes: 0 }, 0, []],
    [
      'force, machine declines',
      'force',
      IDLE,
      capacity({ builds: 2, maxBuilds: 2, declined: 'all 2 build slots busy' }),
      null,
      ['mac0: busy (all 2 build slots busy; load 0.2/core, 2 of 2 build slots busy)'],
    ],
  ] as const)('%s', (_, mode, here, offered, index, reasons) => {
    expect(pick([offer({ capacity: offered })], { mode, here })).toEqual({
      order: index === null ? [] : [index],
      reasons,
    });
  });

  it('names every problem of one machine, as doctor reports them', () => {
    const offered = offer({
      toolchain: { stimBuild: 'b2', runtimes: [] },
      capacity: capacity({ loadPerCore: 8.2, builds: 2, declined: 'load at or above 2/core' }),
    });
    expect(offerProblems(offered, IOS).map((problem) => problem.code)).toEqual(['stim-build', 'runtime', 'busy']);
  });

  it('ranks the warmest machine first, then the least loaded, and names the machines it passed over', () => {
    const cold = offer();
    const warm = offer({ warm: { checkout: true, dependencies: true, build: false } });
    expect(pick([cold, null, warm])).toEqual({ order: [2, 0], reasons: ['mac1: unreachable'] });
    const loaded = offer({ capacity: capacity({ loadPerCore: 1.4 }) });
    const older = offer({ capacity: { running: 0, max: 1, diskFreeBytes: null, minDiskFreeBytes: 0 } });
    expect(pick([older, loaded, cold]).order).toEqual([2, 1, 0]);
  });
});

describe('pickOffer for Android', () => {
  const pickAndroid = (each: BuildOffer) =>
    pickOffer({ mode: 'force', here: IDLE, target: ANDROID, offers: [{ machine: 'mac0', offer: each }] }).order[0] ??
    null;

  it('takes a machine whose JDK major and SDK packages match, whatever its Xcode or JDK vendor', () => {
    expect(pickAndroid(offer({ toolchain: { xcode: null, cocoapods: null, runtimes: [] } }))).toBe(0);
    expect(jdkMajor('JAVA_VERSION="17.0.19"\nIMPLEMENTOR="Homebrew"')).toBe('17');
  });

  it('refuses another JDK major, no SDK, or a missing NDK, build-tools or compile platform', () => {
    for (const [refused, code] of [
      [offer({ toolchain: { jdk: '21' } }), 'jdk'],
      [offer({ toolchain: { jdk: null } }), 'jdk'],
      [offer({ toolchain: { androidSdk: null } }), 'android-sdk'],
      [offer({ toolchain: { androidSdk: { ...SDK, ndk: ['27.0.12077973'] } } }), 'ndk'],
      [offer({ toolchain: { androidSdk: { ...SDK, buildTools: ['36.0.0'] } } }), 'build-tools'],
      [offer({ toolchain: { androidSdk: { ...SDK, platforms: ['android-36'] } } }), 'compile-sdk'],
    ] as const) {
      expect(pickAndroid(refused)).toBeNull();
      expect(offerProblems(refused, ANDROID).map((problem) => problem.code)).toEqual([code]);
    }
  });

  it("reads the SDK packages from React Native's version catalog", () => {
    expect(
      parseAndroidRequirements(
        '[versions]\nminSdk = "24"\ncompileSdk = "37"\nbuildTools = "37.0.0"\nndkVersion = "27.1.12297006"\n',
      ),
    ).toEqual({ ndk: '27.1.12297006', buildTools: '37.0.0', compileSdk: '37' });
  });
});

describe('iphoneRuntimes', () => {
  it('lists only runtimes with an available iPhone simulator', () => {
    expect(
      iphoneRuntimes({
        devices: {
          [RUNTIME]: [{ name: 'iPhone 18 Pro', isAvailable: true }],
          'com.apple.CoreSimulator.SimRuntime.iOS-26-5': [{ name: 'iPad Air', isAvailable: true }],
          'com.apple.CoreSimulator.SimRuntime.iOS-18-6': [{ name: 'iPhone 16', isAvailable: false }],
        },
      }),
    ).toEqual([RUNTIME]);
  });
});
