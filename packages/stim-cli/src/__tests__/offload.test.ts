import assert from 'node:assert';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setExecutor, resetExecutor } from '../exec.ts';
import * as buildMachines from '../offload/build-machines.ts';
import { missingPackageManagerRemedy, workerFailureReason } from '../offload/selection.ts';

import type { MachineCapacity, BuildMachineCredential } from '@stim-cli/core/state';
import {
  BuildConnection,
  chooseBuildMachine,
  offloadBuild,
  machineNotes,
  machineProblems,
  offerProblems,
  offloadPlacement,
  pickOffer,
  type BuildOffer,
} from '../offload/client.ts';
import {
  toolchainMismatches,
  androidRequirements,
  sdkDownloadDisabled,
  toolchainNotes,
  type BuildTarget,
  type IosToolchain,
  type WorkerToolchain,
  type XcodeApp,
} from '../offload/toolchain.ts';

const RUNTIME = 'com.apple.CoreSimulator.SimRuntime.iOS-27-0';

const LOCAL: IosToolchain = {
  stimBuild: 'b1',
  compat: 1,
  arch: 'arm64',
  xcode: 'Xcode 27.0 / Build version 27A266a',
  simulatorSdk: '27.0',
  cocoapods: '1.16.2',
};

const IOS: BuildTarget = { platform: 'ios', local: LOCAL, runtime: RUNTIME, cocoapodsPinned: false };

const ANDROID: BuildTarget = {
  platform: 'android',
  local: { stimBuild: 'b1', compat: 1, arch: 'arm64', jdk: '17' },
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

describe('pickOffer', () => {
  const pick = (
    offers: Array<BuildOffer | null>,
    { selected = 'auto', here = { ...IDLE, builds: 3 } }: { selected?: string; here?: MachineCapacity } = {},
    target: BuildTarget = IOS,
  ) =>
    pickOffer({
      selected,
      here,
      target,
      offers: offers.map((each, index) => ({ machine: `mac${index}`, offer: each, failure: 'unreachable' })),
    });

  it('refuses any toolchain difference, a missing runtime, a busy machine and a full disk in either mode', () => {
    for (const selected of ['auto', 'remote'] as const) {
      for (const refused of [
        offer({ toolchain: { compat: 2 } }),
        offer({ toolchain: { xcode: 'Xcode 26.4' } }),
        offer({ toolchain: { simulatorSdk: '27.1' } }),
        offer({ toolchain: { arch: 'x64' } }),
        offer({ toolchain: { runtimes: ['com.apple.CoreSimulator.SimRuntime.iOS-26-5'] } }),
        offer({ capacity: capacity({ running: 1, declined: 'already running 1 offloaded build(s), its limit' }) }),
        offer({ capacity: capacity({ loadPerCore: 8.2, builds: 2, declined: 'load at or above 2/core' }) }),
        offer({ capacity: capacity({ diskFreeBytes: 1024 ** 3, declined: '1.0 GB free, builds need 10.0 GB' }) }),
        offer({ capacity: { running: 1, max: 1, diskFreeBytes: null, minDiskFreeBytes: 0 } }),
      ]) {
        expect(pick([refused], { selected }).order).toEqual([]);
      }
    }
    for (const compat of [undefined, 1])
      expect(
        pick([offer({ toolchain: { compat } })], {}, { ...IOS, local: { ...LOCAL, stimBuild: null } }).order,
      ).toEqual([]);
  });

  it('needs Bundler there when the Gemfile.lock pins CocoaPods, and compares the global CocoaPods otherwise', () => {
    const PINNED: BuildTarget = { ...IOS, cocoapodsPinned: true };
    const codes = (offered: BuildOffer, target: BuildTarget, named = false) =>
      offerProblems(offered, target, named).map((problem) => problem.code);
    expect(codes(offer({ toolchain: { cocoapods: '1.17.0' } }), PINNED)).toEqual([]);
    expect(codes(offer({ toolchain: { cocoapods: '1.17.0', bundler: null } }), PINNED)).toEqual(['bundler']);
    expect(codes(offer({ toolchain: { bundler: null } }), IOS)).toEqual([]);
    expect(codes(offer({ toolchain: { cocoapods: '1.17.0' } }), IOS)).toEqual(['cocoapods']);
    expect(codes(offer({ toolchain: { cocoapods: null } }), IOS)).toEqual(['cocoapods']);
    expect(codes(offer({ toolchain: { cocoapods: null } }), { ...IOS, native: 'xcode' })).toEqual([]);
    expect(
      codes(offer({ toolchain: { cocoapods: '1.17.0' } }), { ...IOS, local: { ...LOCAL, cocoapods: null } }),
    ).toEqual([]);
    expect(codes(offer({ toolchain: { cocoapods: '1.17.0' } }), IOS, true)).toEqual([]);
    expect(codes(offer({ toolchain: { cocoapods: null } }), IOS, true)).toEqual([]);
  });
});

describe('pickOffer for an Xcode the worker does not select', () => {
  const app = (name: string, version: string, build: string, checks: Partial<XcodeApp> = {}): XcodeApp => ({
    path: `/Applications/${name}.app`,
    version,
    build,
    ...checks,
  });
  const clt = { xcode: null, simulatorSdk: null, runtimes: [], developerDir: '/Library/Developer/CommandLineTools' };
  const problems = (toolchain: Partial<WorkerToolchain>) => offerProblems(offer({ toolchain }), IOS);
  const select = (name: string) => `sudo xcode-select -s /Applications/${name}.app/Contents/Developer`;

  it('selects the newest Xcode when none has this machine build, and quotes a path with a space', () => {
    const found = problems({ ...clt, xcodeApps: [app('Xcode 26.4', '26.4', 'x'), app('Xcode 26.5', '26.5', 'y')] });
    expect(found[0]?.commands).toEqual(["sudo xcode-select -s '/Applications/Xcode 26.5.app/Contents/Developer'"]);
  });

  it('adds the license and first-launch commands only for the checks that failed', () => {
    const commands = (checks: Partial<XcodeApp>) =>
      problems({ ...clt, xcodeApps: [app('Xcode-27.0', '27.0', '27A266a', checks)] })[0]?.commands;
    expect(commands({ license: true, firstLaunch: true })).toEqual([select('Xcode-27.0')]);
    expect(commands({ license: false, firstLaunch: true })).toEqual([
      select('Xcode-27.0'),
      'sudo xcodebuild -license accept',
    ]);
    expect(commands({ license: true, firstLaunch: false })).toEqual([
      select('Xcode-27.0'),
      'sudo xcodebuild -runFirstLaunch',
    ]);
    expect(commands({ license: false, firstLaunch: false })).toEqual([
      select('Xcode-27.0'),
      'sudo xcodebuild -license accept && sudo xcodebuild -runFirstLaunch',
    ]);
    const selected = problems({
      xcode: null,
      simulatorSdk: null,
      developerDir: '/Applications/Xcode-27.0.app/Contents/Developer',
      xcodeApps: [app('Xcode-27.0', '27.0', '27A266a', { license: false, firstLaunch: true })],
    });
    expect(selected[0]).toMatchObject({
      reason: 'no Xcode there: Xcode-27.0.app is selected but not set up',
      commands: ['sudo xcodebuild -license accept'],
    });
  });

  it('diagnoses a worker that builds the macOS app itself without comparing it with this machine', () => {
    const onWorker: BuildTarget = {
      platform: 'macos',
      runsOnWorker: true,
      local: { stimBuild: 'b1', compat: 1, arch: 'arm64', xcode: null, macosSdk: null },
    };
    const found = toolchainMismatches(
      onWorker,
      offer({ toolchain: { ...clt, xcodeApps: [app('Xcode-26.5', '26.5', 'y')] } }).toolchain,
    );
    expect(found).toEqual([
      expect.objectContaining({
        code: 'xcode',
        reason: 'no Xcode there: xcode-select points at Command Line Tools',
        commands: [select('Xcode-26.5')],
      }),
    ]);
  });

  it('asks for the Xcode of this machine to be installed when the worker has none', () => {
    expect(problems({ ...clt, xcodeApps: [] })).toEqual([
      {
        code: 'xcode',
        reason: 'no Xcode there',
        commands: ['xcodes install 27.0'],
        lead: 'install Xcode 27.0 (from the App Store, or with xcodes), then run stim doctor again',
      },
      expect.objectContaining({ code: 'runtime', followsFrom: 'xcode' }),
    ]);
  });

  it('selects the installed Xcode that matches when the selected one is another version', () => {
    const found = problems({
      xcode: 'Xcode 26.4 / Build version 26A1',
      simulatorSdk: '27.0',
      developerDir: '/Applications/Xcode-26.4.app/Contents/Developer',
      xcodeApps: [app('Xcode-26.4', '26.4', '26A1'), app('Xcode-27.0', '27.0', '27A266a')],
    });
    expect(found).toEqual([
      expect.objectContaining({ code: 'xcode', commands: [select('Xcode-27.0')], lead: 'select Xcode-27.0' }),
    ]);
  });
});

describe('pickOffer for Android', () => {
  const pickAndroid = (each: BuildOffer) =>
    pickOffer({ selected: 'remote', here: IDLE, target: ANDROID, offers: [{ machine: 'mac0', offer: each }] })
      .order[0] ?? null;

  describe('a JDK of another major than the worker default', () => {
    const jdkProblems = (toolchain: Partial<WorkerToolchain>) => offerProblems(offer({ toolchain }), ANDROID);

    it('is refused with the install command of the worker OS when no installed JDK matches', () => {
      for (const [os, command] of [
        ['darwin', 'brew install --cask zulu@17'],
        ['linux', 'sudo apt install openjdk-17-jdk-headless'],
        ['win32', 'winget install EclipseAdoptium.Temurin.17.JDK'],
      ] as const) {
        expect(jdkProblems({ jdk: '25', jdks: ['25'], os })).toEqual([
          {
            code: 'jdk',
            reason: 'JDK 25 there, 17 here',
            commands: [command],
            lead: 'install JDK 17; Stim uses it automatically, no restart needed',
          },
        ]);
      }
    });
  });

  describe('a client without a JDK', () => {
    const noJdk: BuildTarget = { ...ANDROID, local: { ...ANDROID.local, jdk: null } };
    const pickNoJdk = (each: BuildOffer) =>
      pickOffer({ selected: 'remote', here: IDLE, target: noJdk, offers: [{ machine: 'mac0', offer: each }] })
        .order[0] ?? null;

    it("takes the worker's JDK, whatever its major, as the build's JDK and says so", () => {
      const worker = offer({ toolchain: { jdk: '21', jdks: ['21'] } });
      expect(pickNoJdk(worker)).toBe(0);
      expect(offerProblems(worker, noJdk)).toEqual([]);
      expect(toolchainNotes(noJdk, worker.toolchain)).toEqual([
        { code: 'jdk', reason: 'this machine has no JDK, so the build runs on JDK 21 there' },
      ]);
    });
  });

  describe('a package the worker lacks', () => {
    const missingNdk = { androidSdk: { ...SDK, ndk: ['27.0.12077973'] } };

    it('is a note, and the build goes there, when its SDK licenses are accepted', () => {
      const accepted = offer({ toolchain: { ...missingNdk, androidLicenses: true } });
      expect(pickAndroid(accepted)).toBe(0);
      expect(offerProblems(accepted, ANDROID)).toEqual([]);
      expect(toolchainNotes(ANDROID, accepted.toolchain)).toEqual([
        {
          code: 'ndk',
          reason: 'NDK 27.1.12297006 is not installed there; Gradle downloads it on the first build (about 1-2 GB)',
          lead: 'install the package now so the first build does not download it',
          commands: ['sdkmanager "ndk;27.1.12297006"'],
        },
      ]);
      const everything = offer({
        toolchain: { androidSdk: { ndk: [], buildTools: [], platforms: [] }, androidLicenses: true },
      });
      expect(toolchainNotes(ANDROID, everything.toolchain).map((note) => note.code)).toEqual([
        'ndk',
        'build-tools',
        'compile-sdk',
      ]);
      expect(offerProblems(everything, ANDROID)).toEqual([]);
    });

    it('reports a note only for a machine that would take the build', () => {
      const accepted = offer({ toolchain: { ...missingNdk, androidLicenses: true } });
      expect(machineNotes(accepted, [ANDROID])).toHaveLength(1);
      expect(
        machineNotes(offer({ toolchain: { ...missingNdk, androidLicenses: true, jdk: '21' } }), [ANDROID]),
      ).toEqual([]);
    });

    it('quotes an SDK path the shell would split', () => {
      const spaced = offer({
        toolchain: { ...missingNdk, androidLicenses: false, androidHome: "/Users/First Last/O'Neil/sdk" },
      });
      expect(offerProblems(spaced, ANDROID)[0]?.commands).toEqual([
        "'/Users/First Last/O'\\''Neil/sdk/cmdline-tools/latest/bin/sdkmanager' --licenses",
        "'/Users/First Last/O'\\''Neil/sdk/cmdline-tools/latest/bin/sdkmanager' \"ndk;27.1.12297006\"",
      ]);
    });

    it('stays a blocker when the project turns the SDK download off', () => {
      const off = { ...ANDROID, requires: { ...ANDROID.requires, sdkDownload: false } };
      const accepted = offer({ toolchain: { ...missingNdk, androidLicenses: true } });
      expect(offerProblems(accepted, off)).toEqual([
        {
          code: 'ndk',
          reason: 'no NDK 27.1.12297006 there, and the project sets android.builder.sdkDownload=false',
          commands: ['sdkmanager "ndk;27.1.12297006"'],
          lead: 'install the package into the Android SDK stim-server uses (its ANDROID_HOME, else the default SDK location)',
        },
      ]);
      expect(toolchainNotes(off, accepted.toolchain)).toEqual([]);
    });
  });

  it('reads android.builder.sdkDownload=false from the project gradle.properties', () => {
    expect(sdkDownloadDisabled('org.gradle.jvmargs=-Xmx2g\nandroid.builder.sdkDownload=false\n')).toBe(true);
    expect(sdkDownloadDisabled('android.builder.sdkDownload = FALSE')).toBe(true);
    expect(sdkDownloadDisabled('android.builder.sdkDownload=true')).toBe(false);
    expect(sdkDownloadDisabled('# android.builder.sdkDownload=false')).toBe(false);
    const project = mkdtempSync(join(tmpdir(), 'stim-sdk-download-'));
    try {
      expect(androidRequirements(project).sdkDownload).toBeUndefined();
      mkdirSync(join(project, 'android'));
      writeFileSync(join(project, 'android', 'gradle.properties'), 'android.builder.sdkDownload=false\n');
      expect(androidRequirements(project).sdkDownload).toBe(false);
      expect(androidRequirements(project, join(project, 'elsewhere')).sdkDownload).toBeUndefined();
    } finally {
      rmSync(project, { recursive: true, force: true });
    }
  });
});

describe('macOS build compatibility', () => {
  const target: BuildTarget = {
    platform: 'macos',
    local: { stimBuild: 'b1', compat: 1, arch: 'arm64', xcode: LOCAL.xcode, macosSdk: '27.0' },
  };

  describe('for an app that runs on the worker that builds it', () => {
    const onWorker: BuildTarget = { ...target, runsOnWorker: true };
    const other = { arch: 'x64', xcode: 'Xcode 27.1 / Build version 27A9275', macosSdk: '27.1' };

    it('needs no Xcode, macOS SDK or CPU match with this Mac', () => {
      expect(toolchainMismatches(onWorker, offer({ toolchain: other }).toolchain)).toEqual([]);
      expect(toolchainMismatches(target, offer({ toolchain: other }).toolchain).map((problem) => problem.code)).toEqual(
        ['arch', 'xcode', 'macos-sdk'],
      );
    });

    it('still needs the same build compatibility, a Mac, and a worker with Xcode and a macOS SDK', () => {
      expect(toolchainMismatches(onWorker, offer({ toolchain: { compat: 2 } }).toolchain)).toEqual([
        { code: 'stim-build', reason: expect.any(String) },
      ]);
      expect(toolchainMismatches(onWorker, offer({ toolchain: { os: 'linux' } }).toolchain)).toEqual([
        { code: 'platform', reason: expect.stringContaining('macOS') },
      ]);
      expect(toolchainMismatches(onWorker, offer({ toolchain: { xcode: null, macosSdk: null } }).toolchain)).toEqual([
        { code: 'xcode', reason: 'no Xcode there' },
        { code: 'macos-sdk', reason: 'no macOS SDK there' },
      ]);
    });
  });
});

describe('a client without Xcode', () => {
  const noXcode: BuildTarget = {
    ...IOS,
    local: { ...LOCAL, arch: 'x64', xcode: null, simulatorSdk: null, cocoapods: null },
  };
  const hosted: BuildTarget = { ...noXcode, local: { ...noXcode.local, arch: 'arm64' } };

  it('still refuses a different Stim build, CPU, a missing runtime and a worker without Xcode', () => {
    expect(toolchainMismatches(noXcode, offer({ toolchain: { compat: 9 } }).toolchain).map((p) => p.code)).toEqual([
      'stim-build',
      'arch',
    ]);
    expect(toolchainMismatches(hosted, offer({ toolchain: { runtimes: [] } }).toolchain).map((p) => p.code)).toEqual([
      'runtime',
    ]);
    expect(
      toolchainMismatches(hosted, offer({ toolchain: { xcode: null, simulatorSdk: null } }).toolchain).map(
        (p) => p.reason,
      ),
    ).toEqual(['no Xcode there', 'no simulator SDK there']);
  });
});

describe('a worker that is not a Mac', () => {
  const linux = offer({
    toolchain: {
      os: 'linux',
      arch: 'x64',
      xcode: null,
      simulatorSdk: null,
      macosSdk: null,
      cocoapods: null,
      runtimes: [],
    },
  }).toolchain;

  it('is judged for doctor on the platforms it can build, naming the platform of each reason', () => {
    const offerFrom = (toolchain: Partial<BuildOffer['toolchain']>, capacityOver = {}) =>
      offer({ toolchain: { ...linux, ...toolchain }, capacity: capacity(capacityOver) });
    expect(machineProblems(offerFrom({}), [IOS, ANDROID])).toEqual([]);
    expect(machineProblems(offerFrom({ jdk: '21' }), [IOS, ANDROID])).toEqual([
      { code: 'jdk', reason: expect.stringMatching(/^Android: JDK 21 there/) },
    ]);
    expect(machineProblems(offerFrom({}), [IOS]).map((problem) => problem.code)).toEqual(['platform']);
    expect(
      machineProblems(offerFrom({}, { declined: 'all slots busy' }), [IOS, ANDROID]).filter((p) => p.code === 'busy'),
    ).toHaveLength(1);
  });
});

describe('strict client routing', () => {
  let root: string;
  const credentials = ['mini', 'other'].map((machine): BuildMachineCredential => ({
    machine,
    transport: 'tailscale',
    address: machine,
    state: 'approved',
    requestedAt: '2026-10-13T00:00:00.000Z',
    serverKey: 'K'.repeat(42) + 'A',
    deviceId: machine,
  }));

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'stim-strict-client-'));
    process.env.STIM_HOME = join(root, 'home');
    mkdirSync(join(root, '.git'));
    setExecutor({
      runFile: (_file, args) =>
        args?.includes('--git-common-dir') ? join(root, '.git') : args?.includes('ls-files') ? '' : root,
    });
    vi.spyOn(buildMachines, 'resolveEndpoint').mockImplementation(async (credential) => ({
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
      here: IDLE,
      machines: credentials,
      note: () => {},
    });

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
        features: [],
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
          iosProjectPath: 'ios',
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

test('excluded local builds require a remote regardless of relative load and refuse unsupported fallback', () => {
  const base = {
    selected: 'auto',
    machines: 1,
    here: IDLE,
    unsupported: null,
    localEnabled: false,
  };
  expect(offloadPlacement(base).offload).toBe(true);
  for (const override of [{ machines: 0 }, { unsupported: 'Release builds build here' }])
    expect(() => offloadPlacement({ ...base, ...override })).toThrow('local is disabled');
  expect(offloadPlacement({ ...base, selected: 'local' }).offload).toBe(false);
  expect(
    pickOffer({
      selected: 'auto',
      here: IDLE,
      localEnabled: false,
      target: IOS,
      offers: [{ machine: 'mini', offer: offer({ capacity: capacity({ loadPerCore: 1.9 }) }) }],
    }).order,
  ).toEqual([0]);
});

describe('missingPackageManagerRemedy', () => {
  it('names the package manager a worker could not start, not build approval', () => {
    const remedy = missingPackageManagerRemedy('linux-box', workerFailureReason('deps-failed', 'spawn pnpm ENOENT'));
    expect(remedy).toContain('linux-box has no pnpm');
    expect(remedy).toContain('corepack enable pnpm');
    expect(remedy).not.toMatch(/approv|doctor/i);
    expect(missingPackageManagerRemedy('linux-box', 'deps-failed: spawn yarn ENOENT')).toContain('no yarn');
  });
});
