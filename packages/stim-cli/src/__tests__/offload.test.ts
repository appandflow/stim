import assert from 'node:assert';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setExecutor, resetExecutor } from '../exec.ts';
import * as buildMachines from '../offload/build-machines.ts';
import { resolveBuildMachine, requireConfiguredMachine, parseBuildMachineOption } from '../offload/selection.ts';
import { manifestDigest } from '../offload/manifest.ts';
import type { MachineCapacity, OffloadMode, BuildMachineCredential } from '@stim-cli/core/state';
import {
  BuildConnection,
  chooseBuildMachine,
  offloadBuild,
  offerProblems,
  offloadPlacement,
  pickOffer,
  type BuildOffer,
} from '../offload/client.ts';
import {
  toolchainMismatches,
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

const IOS: BuildTarget = { platform: 'ios', local: LOCAL, runtime: RUNTIME, cocoapodsPinned: false };

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
    toolchain: {
      ...LOCAL,
      macosSdk: '27.0',
      bundler: 'Bundler version 4.0.8',
      runtimes: [RUNTIME],
      jdk: '17',
      androidSdk: SDK,
      ...overrides.toolchain,
    },
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

  it('compares global CocoaPods only when the Gemfile.lock pins none, and then needs Bundler there', () => {
    const PINNED: BuildTarget = { ...IOS, cocoapodsPinned: true };
    const codes = (offered: BuildOffer, target: BuildTarget) =>
      offerProblems(offered, target).map((problem) => problem.code);
    expect(codes(offer({ toolchain: { cocoapods: '1.17.0' } }), PINNED)).toEqual([]);
    expect(codes(offer({ toolchain: { cocoapods: '1.17.0', bundler: null } }), PINNED)).toEqual(['bundler']);
    expect(codes(offer({ toolchain: { bundler: null } }), IOS)).toEqual([]);
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

describe('macOS build compatibility', () => {
  const target: BuildTarget = {
    platform: 'macos',
    local: { stimBuild: 'b1', arch: 'arm64', xcode: LOCAL.xcode, macosSdk: '27.0' },
  };
  it.each([
    ['stim-build', { stimBuild: 'b2' }],
    ['arch', { arch: 'x64' }],
    ['xcode', { xcode: 'Xcode 26.0' }],
    ['macos-sdk', { macosSdk: '26.0' }],
  ] as const)('refuses a macOS worker with another %s', (code, mismatch) => {
    expect(toolchainMismatches(target, offer({ toolchain: mismatch }).toolchain)).toEqual([
      { code, reason: expect.any(String) },
    ]);
  });
  it('accepts matching macOS tools without CocoaPods, runtimes or a JDK', () => {
    expect(
      toolchainMismatches(
        target,
        offer({ toolchain: { cocoapods: null, bundler: null, runtimes: [], jdk: null, androidSdk: null } }).toolchain,
      ),
    ).toEqual([]);
  });
});

it('fingerprints the same manifest in any order but detects changed content and executable kind', () => {
  const entries = [
    { path: 'a', kind: 'file', sha256: 'aa' },
    { path: 'b', kind: 'exec', sha256: 'bb' },
  ];
  const digest = manifestDigest(entries);
  expect(manifestDigest(entries.toReversed())).toBe(digest);
  expect(manifestDigest([{ ...entries[0]!, sha256: 'cc' }, entries[1]!])).not.toBe(digest);
  expect(manifestDigest([{ ...entries[0]!, kind: 'link' }, entries[1]!])).not.toBe(digest);
});

describe('explicit build placement', () => {
  it.each([
    [undefined, undefined, undefined, 'auto'],
    [undefined, undefined, 'mini', 'mini'],
    [undefined, 'local', 'mini', 'local'],
    ['auto', 'local', 'mini', 'auto'],
    ['mini:8443', 'local', 'auto', 'mini:8443'],
    [undefined, '', 'mini', 'mini'],
    [undefined, '  ', 'local', 'local'],
    [undefined, '  ', undefined, 'auto'],
    [' AUTO ', 'mini', 'local', 'auto'],
    ['Local', 'mini', 'auto', 'local'],
  ])('resolves flag %s, env %s and setting %s without losing precedence', (flag, env, setting, expected) => {
    expect(resolveBuildMachine(flag, env, setting)).toBe(expected);
  });

  it.each(['', ' ', 'bad name', '../mini', 'mini:0', 'mini:65536', 12])(
    'rejects invalid selection %s instead of silently choosing auto',
    (value) => {
      expect(() => resolveBuildMachine(undefined, undefined, value)).toThrow(
        expect.objectContaining({ code: 'STIM_BAD_ARG' }),
      );
    },
  );

  it('an empty explicit flag does not inherit a valid environment selection', () => {
    expect(() => resolveBuildMachine('', 'mini', 'local')).toThrow(expect.objectContaining({ code: 'STIM_BAD_ARG' }));
  });

  it('refuses a name outside the configured list while auto and local require no list', () => {
    expect(() => requireConfiguredMachine('mini', ['other'])).toThrow(
      expect.objectContaining({ code: 'STIM_OFFLOAD_REFUSED', message: expect.stringContaining('mini') }),
    );
    expect(() => requireConfiguredMachine('local', undefined)).not.toThrow();
    expect(() => requireConfiguredMachine('auto', undefined)).not.toThrow();
  });

  it.each(['mini', 'Mini', 'MINI:7443'])(
    'matches %s to the configured default-port entry, preserving its spelling',
    (selected) => {
      expect(requireConfiguredMachine(selected, ['other', 'mini:7443'])).toBe('mini:7443');
      expect(requireConfiguredMachine(selected, ['Mini'])).toBe('Mini');
      expect(() => requireConfiguredMachine(selected, ['mini:8443'])).toThrow('configured: mini:8443');
    },
  );

  it('invalid flag values use the Commander argument error instead of a runtime exception', () => {
    expect(() => parseBuildMachineOption('')).toThrow(expect.objectContaining({ code: 'commander.invalidArgument' }));
  });

  it('strict placement ignores local load and offload.mode off, but still requires a pairing', () => {
    const base = { selected: 'mini', mode: 'off' as const, here: IDLE, machines: 1, unsupported: null };
    expect(offloadPlacement(base).offload).toBe(true);
    expect(() => offloadPlacement({ ...base, machines: 0 })).toThrow(
      expect.objectContaining({ code: 'STIM_OFFLOAD_REFUSED' }),
    );
    expect(offloadPlacement({ ...base, selected: 'local', mode: 'force' }).offload).toBe(false);
  });

  it.each([
    'device builds build here',
    '--remote builds build here',
    'Release builds build here',
    'Apple Clang CAS builds build here',
    'the build cache is off',
    'the runtime of simulator U1 is unknown',
  ])('strict placement refuses unsupported build: %s', (unsupported) => {
    expect(() => offloadPlacement({ selected: 'mini', mode: 'off', here: IDLE, machines: 1, unsupported })).toThrow(
      expect.objectContaining({
        code: 'STIM_OFFLOAD_REFUSED',
        message: `mini: ${unsupported}, so a named build machine cannot take it`,
      }),
    );
  });

  it.each(['auto', 'local'])(
    '%s keeps unsupported Release and device builds here even when offload.mode is force',
    (selected) => {
      for (const unsupported of ['Release builds build here', 'device builds build here']) {
        expect(offloadPlacement({ selected, mode: 'force', here: IDLE, machines: 1, unsupported }).offload).toBe(false);
      }
    },
  );

  it('strict offers bypass auto load gating and cannot rank another worker as a runner up', () => {
    const offers = [
      { machine: 'other', offer: offer({ warm: { checkout: true, dependencies: true, build: true } }) },
      { machine: 'mini', offer: offer({ capacity: capacity({ loadPerCore: 1.5 }) }) },
    ];
    expect(pickOffer({ selected: 'mini', mode: 'off', here: IDLE, offers, target: IOS }).order).toEqual([1]);
    expect(pickOffer({ selected: 'mini', mode: 'auto', here: IDLE, offers, target: IOS }).order).toEqual([1]);
    expect(
      pickOffer({
        selected: 'mini',
        mode: 'auto',
        here: IDLE,
        offers: [{ ...offers[1]!, offer: null, failure: 'unreachable' }, offers[0]!],
        target: IOS,
      }),
    ).toEqual({ order: [], reasons: ['mini: unreachable'] });
  });

  it.each([
    ['CPU incompatible', offer({ toolchain: { arch: 'x64' } })],
    ['runtime unavailable', offer({ toolchain: { runtimes: [] } })],
    ['disk too low', offer({ capacity: capacity({ diskFreeBytes: 0 }) })],
    ['no free slot', offer({ capacity: capacity({ declined: 'all slots busy' }) })],
  ])('strict offers keep safety checks for %s instead of choosing another worker', (_reason, blocked) => {
    const picked = pickOffer({
      selected: 'mini',
      mode: 'force',
      here: IDLE,
      offers: [
        { machine: 'mini', offer: blocked },
        { machine: 'other', offer: offer() },
      ],
      target: IOS,
    });
    expect(picked.order).toEqual([]);
    expect(picked.reasons[0]).toMatch(/^mini: /);
  });
});

describe('strict client routing', () => {
  let root: string;
  const credentials = ['mini', 'other'].map((machine) => ({ machine, deviceToken: machine }) as BuildMachineCredential);

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'stim-strict-client-'));
    process.env.STIM_HOME = join(root, 'home');
    mkdirSync(join(root, '.git'));
    setExecutor({
      runFile: (_file, args) =>
        args?.includes('--git-common-dir') ? join(root, '.git') : args?.includes('ls-files') ? '' : root,
    });
    vi.spyOn(buildMachines, 'pinnedEndpoint').mockImplementation((credential) => ({
      url: credential.machine,
      servername: credential.machine,
      host: credential.machine,
    }));
  });
  afterEach(() => {
    vi.restoreAllMocks();
    resetExecutor();
    delete process.env.STIM_HOME;
    rmSync(root, { recursive: true, force: true });
  });

  const choose = () =>
    chooseBuildMachine({
      projectRoot: root,
      selected: 'mini',
      target: IOS,
      mode: 'off',
      here: IDLE,
      machines: credentials,
      note: () => {},
    });

  it.each(['unreachable', 'approval-pending', 'forbidden', 'pinned identity changed'])(
    'strict %s never probes another configured worker',
    async (reason) => {
      const open = vi.spyOn(BuildConnection, 'open').mockResolvedValue({ failure: reason, refused: true });
      expect(await choose()).toBe(`mini: ${reason}`);
      expect(open.mock.calls.map(([endpoint]) => endpoint.url)).toEqual(['mini']);
    },
  );

  it.each(['sync', 'start'])(
    'strict %s failure closes the chosen worker without trying another',
    async (failedMethod) => {
      const request = vi.fn<BuildConnection['request']>().mockImplementation(async (method) => {
        if (method === 'build.offer') return { result: offer({ capacity: capacity({ loadPerCore: 1.5 }) }) };
        if (method === `build.${failedMethod}`) return { error: { code: 'busy', message: 'cannot take this build' } };
        return { result: {} };
      });
      const close = vi.fn<() => void>();
      const connection = Object.assign(Object.create(BuildConnection.prototype), {
        request,
        close,
        onProgress: () => {},
      }) as BuildConnection;
      const open = vi.spyOn(BuildConnection, 'open').mockResolvedValue(connection);
      const choice = await choose();
      assert(typeof choice !== 'string');
      expect(choice.runnersUp).toEqual([]);
      const outcome = await offloadBuild({
        choice,
        expectedFingerprint: 'fingerprint',
        request: {
          platform: 'ios',
          runtime: RUNTIME,
          configuration: null,
          scheme: null,
          isExpo: false,
          optimizations: {},
        },
        stagingDir: join(root, 'staging'),
        onPhase: () => {},
        onEnter: () => {},
        onRecord: () => {},
        note: () => {},
      });
      expect(outcome).toEqual({ ok: false, machine: 'mini', reason: `${failedMethod}: busy: cannot take this build` });
      expect(open.mock.calls.map(([endpoint]) => endpoint.url)).toEqual(['mini']);
      expect(close).toHaveBeenCalled();
    },
  );
});
