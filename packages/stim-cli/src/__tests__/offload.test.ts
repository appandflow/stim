import assert from 'node:assert';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setExecutor, resetExecutor } from '../exec.ts';
import * as buildMachines from '../offload/build-machines.ts';
import {
  buildPlacementSettings,
  parseBuildMachineOption,
  podsFailedRemedy,
  workerFailureReason,
  requireConfiguredMachine,
  resolveBuildMachine,
  resolveBuildPlacement,
} from '../offload/selection.ts';
import { withAmbientContext } from '@stim-cli/core';
import { POD_MISSING_REASON } from '../engine/deps.ts';
import { testContext } from './_context.ts';
import { manifestDigest } from '../offload/manifest.ts';
import type { MachineCapacity, OffloadMode, BuildMachineCredential } from '@stim-cli/core/state';
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
  iphoneRuntimes,
  jdkMajor,
  androidRequirements,
  parseAndroidRequirements,
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
      'this machine is busy: all 3 build slots busy (load 0.3/core, 3 of 3 build slots busy)',
    ],
    [
      'auto, no build limit but saturated',
      { ...base, here: { ...IDLE, maxBuilds: 0, loadPerCore: 8.2 } },
      true,
      'this machine is busy: load at or above 2/core (load 8.2/core, 0 builds)',
    ],
    ['force on an idle machine', { ...base, mode: 'force' as const }, true, 'remote.buildMode is force'],
    [
      'off on a saturated machine',
      { ...base, mode: 'off' as const, here: { ...IDLE, builds: 3 } },
      false,
      'remote.buildMode is off',
    ],
    ['force with no machine', { ...base, mode: 'force' as const, machines: 0 }, false, 'no remote machine is paired'],
    [
      'force for a device build',
      { ...base, mode: 'force' as const, unsupported: 'device builds build here' },
      false,
      'device builds build here',
    ],
  ])('%s', (_, input, offload, reason) => {
    expect(offloadPlacement(input)).toMatchObject({ offload, reason });
  });

  it.each([
    ['auto, a free slot and low load', {}, 'this-mac-free'],
    ['auto, every slot busy', { here: { ...IDLE, builds: 3 } }, 'this-mac-busy'],
    ['force', { mode: 'force' as const }, 'forced'],
    ['off', { mode: 'off' as const }, 'mode-off'],
    ['no paired machine', { machines: 0 }, 'no-remote-mac'],
    ['an unsupported build', { unsupported: 'device builds build here' }, 'unsupported'],
    ['--remote-build local', { selected: 'local' }, 'local-selected'],
    ['a named machine', { selected: 'mini' }, 'named'],
  ])('gives a stable code for %s', (_, input, code) => {
    expect(offloadPlacement({ ...base, ...input }).code).toBe(code);
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
        expect(pick([refused], { mode }).order).toEqual([]);
      }
    }
    for (const compat of [undefined, 1])
      expect(
        pick([offer({ toolchain: { compat } })], {}, { ...IOS, local: { ...LOCAL, stimBuild: null } }).order,
      ).toEqual([]);
  });

  it('compares the build compatibility version with a machine that reports one, else the Stim build', () => {
    const codes = (toolchain: Partial<WorkerToolchain>) =>
      toolchainMismatches(IOS, offer({ toolchain }).toolchain).map((problem) => problem.code);
    expect(codes({ stimBuild: 'b2' })).toEqual([]);
    expect(codes({ compat: 2 })).toEqual(['stim-build']);
    expect(codes({ stimBuild: 'b2', compat: undefined })).toEqual(['stim-build']);
    expect(codes({ compat: undefined })).toEqual([]);
    expect(toolchainMismatches(ANDROID, offer({ toolchain: { stimBuild: 'b2' } }).toolchain)).toEqual([]);
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
      ['mac0: capacity unknown (older stim-server) while this machine has a free slot'],
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
    const picked = pick([offer({ capacity: offered })], { mode, here });
    expect({ order: picked.order, reasons: picked.reasons }).toEqual({
      order: index === null ? [] : [index],
      reasons,
    });
  });

  it('gives every machine a reason code next to its message, accepted machines included', () => {
    const picked = pick([
      null,
      offer({ toolchain: { xcode: 'Xcode 26.4', runtimes: [] } }),
      offer({ toolchain: { runtimes: [] } }),
      offer({ capacity: capacity({ loadPerCore: 8.2, builds: 2, declined: 'load at or above 2/core' }) }),
      offer({ capacity: capacity({ diskFreeBytes: 1024 ** 3, declined: 'low disk' }) }),
      offer({ capacity: capacity({ loadPerCore: 0.1 }) }),
    ]);
    expect(picked.candidates.map(({ machine, code, detail }) => ({ machine, code, detail }))).toEqual([
      { machine: 'mac0', code: 'unreachable', detail: undefined },
      { machine: 'mac1', code: 'version-mismatch', detail: ['xcode', 'runtime'] },
      { machine: 'mac2', code: 'no-matching-device', detail: ['runtime'] },
      { machine: 'mac3', code: 'busy', detail: ['busy'] },
      { machine: 'mac4', code: 'disk', detail: ['disk'] },
      { machine: 'mac5', code: 'accepted', detail: undefined },
    ]);
    expect(picked.candidates[1]!.msg).toContain('Xcode');
  });

  it('gives a load code to a machine that is not less loaded or reports no load', () => {
    const here = { ...IDLE, maxBuilds: 0, loadPerCore: 2.4 };
    const noLess = pick([offer({ capacity: capacity({ loadPerCore: 2.4 }) })], { here });
    const unknown = pick([offer({ capacity: { running: 0, max: 1, diskFreeBytes: null, minDiskFreeBytes: 0 } })], {
      here,
    });
    expect([noLess.candidates[0]!.code, unknown.candidates[0]!.code]).toEqual(['load', 'load']);
  });

  it('names every problem of one machine, as doctor reports them', () => {
    const offered = offer({
      toolchain: { compat: 2, runtimes: [] },
      capacity: capacity({ loadPerCore: 8.2, builds: 2, declined: 'load at or above 2/core' }),
    });
    expect(offerProblems(offered, IOS).map((problem) => problem.code)).toEqual(['stim-build', 'runtime', 'busy']);
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

  it('skips a worker with another CocoaPods in auto and shows why, sends a named build there, and takes a held artifact', () => {
    for (const cocoapods of [null, '1.17.0']) {
      const toolchain = { cocoapods };
      const auto = pick([offer({ toolchain })]);
      expect(auto.order).toEqual([]);
      expect(auto.reasons[0]).toContain('CocoaPods');
      expect(auto.candidates[0]).toMatchObject({ code: 'version-mismatch', detail: ['cocoapods'] });
      const named = pickOffer({
        mode: 'auto',
        here: { ...IDLE, builds: 3 },
        target: IOS,
        selected: 'mac0',
        offers: [{ machine: 'mac0', offer: offer({ toolchain }) }],
      });
      expect(named.order).toEqual([0]);
      expect(named.candidates[0]?.msg).toContain('CocoaPods');
    }
    const fingerprint = 'a'.repeat(64);
    const held = offer({
      toolchain: { cocoapods: null },
      artifact: {
        name: 'App.app',
        size: 10,
        sha256: 'b'.repeat(64),
        fingerprint,
        cacheKey: `react-native-ios-${fingerprint}`,
      },
    });
    expect(
      pickOffer({
        mode: 'auto',
        here: { ...IDLE, builds: 3 },
        target: IOS,
        artifact: 'react-native-ios',
        offers: [{ machine: 'mac0', offer: held }],
      }).order,
    ).toEqual([0]);
  });

  it('notes the CocoaPods a named machine is sent the build despite, with the install when there is none', () => {
    const notes = (toolchain: Partial<WorkerToolchain>, target: BuildTarget = IOS) =>
      toolchainNotes(target, offer({ toolchain }).toolchain);
    expect(notes({ cocoapods: '1.16.2' })).toEqual([]);
    expect(notes({ cocoapods: '1.17.0' })).toEqual([
      expect.objectContaining({ code: 'cocoapods', reason: expect.stringContaining('1.17.0 there') }),
    ]);
    expect(notes({ cocoapods: null })).toEqual([
      expect.objectContaining({ code: 'cocoapods', commands: ['brew install cocoapods'] }),
    ]);
    expect(notes({ cocoapods: null }, { ...IOS, cocoapodsPinned: true })).toEqual([]);
    expect(notes({ cocoapods: null }, { ...IOS, native: 'xcode' })).toEqual([]);
  });

  it('names a missing tool instead of printing null, on either side', () => {
    const reasons = (offered: BuildOffer, target: BuildTarget) =>
      offerProblems(offered, target).map((problem) => problem.reason);
    expect(reasons(offer({ toolchain: { xcode: null, simulatorSdk: null, cocoapods: null } }), IOS)).toEqual([
      'no Xcode there, Xcode 27.0 / Build version 27A266a here',
      'no simulator SDK there, simulator SDK 27.0 here',
      'no CocoaPods there, CocoaPods 1.16.2 here',
    ]);
    const macos: BuildTarget = {
      platform: 'macos',
      local: { stimBuild: 'b1', compat: 1, arch: 'arm64', xcode: LOCAL.xcode, macosSdk: '27.0' },
    };
    expect(reasons(offer({ toolchain: { macosSdk: null } }), macos)).toEqual([
      'no macOS SDK there, macOS SDK 27.0 here',
    ]);
  });

  it('ranks the warmest machine first, then the least loaded, and names the machines it passed over', () => {
    const cold = offer();
    const warm = offer({ warm: { checkout: true, dependencies: true, build: false } });
    const ranked = pick([cold, null, warm]);
    expect({ order: ranked.order, reasons: ranked.reasons }).toEqual({ order: [2, 0], reasons: ['mac1: unreachable'] });
    const loaded = offer({ capacity: capacity({ loadPerCore: 1.4 }) });
    const older = offer({ capacity: { running: 0, max: 1, diskFreeBytes: null, minDiskFreeBytes: 0 } });
    expect(pick([older, loaded, cold]).order).toEqual([2, 1, 0]);
  });

  it('does not rank checkout or legacy build-folder flags ahead of a less loaded worker', () => {
    const unverified = offer({
      warm: { checkout: true, dependencies: false, build: true },
      capacity: capacity({ loadPerCore: 1.4 }),
    });
    expect(pick([unverified, offer()]).order).toEqual([1, 0]);
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

  it('names xcode-select as the cause, selects the Xcode of this machine build, and says the runtime follows', () => {
    const found = problems({
      ...clt,
      xcodeApps: [app('Xcode-27.1', '27.1', '27A9275'), app('Xcode-27.0', '27.0', '27A266a')],
    });
    expect(found).toEqual([
      {
        code: 'xcode',
        reason: 'no Xcode there: xcode-select points at Command Line Tools',
        commands: [select('Xcode-27.0')],
        lead: 'select Xcode-27.0',
      },
      {
        code: 'runtime',
        reason: `no iPhone simulator on ${RUNTIME} there; this follows from the Xcode problem`,
        followsFrom: 'xcode',
      },
    ]);
  });

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

  it('says so when the selected Xcode fails without a failed check, and when the newest one does not match', () => {
    const selected = problems({
      xcode: null,
      simulatorSdk: null,
      developerDir: '/Applications/Xcode-27.0.app/Contents/Developer',
      xcodeApps: [app('Xcode-27.0', '27.0', '27A266a', { license: true, firstLaunch: true })],
    });
    expect(selected[0]).toEqual({
      code: 'xcode',
      reason: 'no Xcode there: Xcode-27.0.app is selected but xcodebuild fails',
      commands: [],
      lead: 'finish setting up Xcode-27.0',
    });
    const other = problems({ ...clt, xcodeApps: [app('Xcode-26.5', '26.5', 'y')] });
    expect(other[0]?.lead).toBe('select Xcode-26.5 (this Mac has Xcode 27.0; xcodes install 27.0 matches it)');
  });

  it('points a runtime at the Xcode problem whenever the Xcode needs another command first', () => {
    const found = problems({
      xcode: 'Xcode 26.4 / Build version 26A1',
      simulatorSdk: '27.0',
      runtimes: [],
      developerDir: '/Applications/Xcode-26.4.app/Contents/Developer',
      xcodeApps: [app('Xcode-27.0', '27.0', '27A266a')],
    });
    expect(found.map((problem) => [problem.code, problem.followsFrom])).toEqual([
      ['xcode', undefined],
      ['runtime', 'xcode'],
    ]);
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

  it('gives the download command for a runtime that is really missing, only to a worker that reports its developer directory', () => {
    const missing = { runtimes: ['com.apple.CoreSimulator.SimRuntime.iOS-26-5'] };
    expect(problems({ ...missing, developerDir: '/Applications/Xcode-27.0.app/Contents/Developer' })).toEqual([
      {
        code: 'runtime',
        reason: `no iPhone simulator on ${RUNTIME} there`,
        commands: ['xcodebuild -downloadPlatform iOS -buildVersion 27.0'],
        lead: 'download the iOS 27.0 simulator runtime if it is not installed (an installed runtime also needs an iPhone simulator)',
      },
    ]);
    expect(problems(missing)).toEqual([{ code: 'runtime', reason: `no iPhone simulator on ${RUNTIME} there` }]);
  });

  it('keeps today reasons and no commands for a stim-server that does not report its developer directory', () => {
    expect(problems({ xcode: null, simulatorSdk: null, runtimes: [] })).toEqual([
      { code: 'xcode', reason: 'no Xcode there, Xcode 27.0 / Build version 27A266a here' },
      { code: 'simulator-sdk', reason: 'no simulator SDK there, simulator SDK 27.0 here' },
      { code: 'runtime', reason: `no iPhone simulator on ${RUNTIME} there` },
    ]);
  });
});

describe('pickOffer for Android', () => {
  const pickAndroid = (each: BuildOffer) =>
    pickOffer({ mode: 'force', here: IDLE, target: ANDROID, offers: [{ machine: 'mac0', offer: each }] }).order[0] ??
    null;

  it('takes a machine whose JDK major and SDK packages match, whatever its CPU, Xcode or JDK vendor', () => {
    expect(pickAndroid(offer({ toolchain: { xcode: null, cocoapods: null, runtimes: [] } }))).toBe(0);
    expect(pickAndroid(offer({ toolchain: { arch: 'x64', xcode: null, cocoapods: null, runtimes: [] } }))).toBe(0);
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

  describe('a JDK of another major than the worker default', () => {
    const jdkProblems = (toolchain: Partial<WorkerToolchain>) => offerProblems(offer({ toolchain }), ANDROID);

    it('is taken when the worker has a JDK of this machine major installed', () => {
      expect(jdkProblems({ jdk: '25', jdks: ['17', '25'] })).toEqual([]);
      expect(pickAndroid(offer({ toolchain: { jdk: null, jdks: ['17'] } }))).toBe(0);
    });

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

    it('keeps the strict rule and no install command for a stim-server that does not list its JDKs', () => {
      expect(jdkProblems({ jdk: '25' })).toEqual([{ code: 'jdk', reason: 'JDK 25 there, 17 here' }]);
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

    it('stays a blocker with the license command when the licenses are not accepted', () => {
      const refused = offer({
        toolchain: { ...missingNdk, androidLicenses: false, androidHome: '/Users/x/Library/Android/sdk' },
      });
      expect(pickAndroid(refused)).toBeNull();
      expect(offerProblems(refused, ANDROID)).toEqual([
        {
          code: 'ndk',
          reason: 'no NDK 27.1.12297006 there, and its SDK licenses are not accepted',
          commands: [
            '/Users/x/Library/Android/sdk/cmdline-tools/latest/bin/sdkmanager --licenses',
            '/Users/x/Library/Android/sdk/cmdline-tools/latest/bin/sdkmanager "ndk;27.1.12297006"',
          ],
          lead: 'accept the SDK licenses so Gradle downloads the package, or install it',
        },
      ]);
      expect(toolchainNotes(ANDROID, refused.toolchain)).toEqual([]);
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

    it('keeps the strict rule for a stim-server that does not report its licenses', () => {
      const old = offer({ toolchain: missingNdk });
      expect(offerProblems(old, ANDROID)).toEqual([
        {
          code: 'ndk',
          reason: 'no NDK 27.1.12297006 there',
          commands: ['sdkmanager "ndk;27.1.12297006"'],
          lead: 'install the package into the Android SDK stim-server uses (its ANDROID_HOME, else the default SDK location)',
        },
      ]);
      expect(toolchainNotes(ANDROID, old.toolchain)).toEqual([]);
    });

    it('names the downloads in the placement of the machine that takes the build', () => {
      const { candidates } = pickOffer({
        mode: 'force',
        here: IDLE,
        target: ANDROID,
        offers: [{ machine: 'mac0', offer: offer({ toolchain: { ...missingNdk, androidLicenses: true } }) }],
      });
      expect(candidates).toEqual([
        expect.objectContaining({ code: 'accepted', msg: expect.stringContaining('Gradle downloads it') }),
      ]);
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
          [RUNTIME]: [
            {
              name: 'stim-renamed (iPhone 18 Pro 27.0)',
              isAvailable: true,
              deviceTypeIdentifier: 'com.apple.CoreSimulator.SimDeviceType.iPhone-18-Pro',
            },
          ],
          'com.apple.CoreSimulator.SimRuntime.iOS-26-5': [
            {
              name: 'iPhone misleading name',
              isAvailable: true,
              deviceTypeIdentifier: 'com.apple.CoreSimulator.SimDeviceType.iPad-Air',
            },
          ],
          'com.apple.CoreSimulator.SimRuntime.iOS-18-6': [
            {
              name: 'iPhone 16',
              isAvailable: false,
              deviceTypeIdentifier: 'com.apple.CoreSimulator.SimDeviceType.iPhone-16',
            },
          ],
        },
      }),
    ).toEqual([RUNTIME]);
  });
});

describe('macOS build compatibility', () => {
  const target: BuildTarget = {
    platform: 'macos',
    local: { stimBuild: 'b1', compat: 1, arch: 'arm64', xcode: LOCAL.xcode, macosSdk: '27.0' },
  };
  it('fetches a busy worker exact SwiftPM artifact only with compatible tools', () => {
    const fingerprint = 'a'.repeat(64);
    const artifact = {
      fingerprint,
      cacheKey: `swiftpm-peer-${fingerprint}`,
      name: 'App.app',
      size: 10,
      sha256: 'b'.repeat(64),
    };
    const options = { mode: 'auto' as const, here: IDLE, target, artifact: 'swiftpm' as const, cacheOnly: true };
    expect(
      pickOffer({
        ...options,
        offers: [{ machine: 'mini', offer: offer({ artifact, capacity: capacity({ declined: 'busy' }) }) }],
      }).order,
    ).toEqual([0]);
    expect(
      pickOffer({ ...options, offers: [{ machine: 'mini', offer: offer({ artifact, toolchain: { arch: 'x64' } }) }] })
        .order,
    ).toEqual([]);
  });
  it.each([
    ['stim-build', { compat: 2 }],
    ['arch', { arch: 'x64' }],
    ['xcode', { xcode: 'Xcode 26.0' }],
    ['macos-sdk', { macosSdk: '26.0' }],
  ] as const)('refuses a macOS worker with another %s', (code, mismatch) => {
    expect(toolchainMismatches(target, offer({ toolchain: mismatch }).toolchain)).toEqual([
      { code, reason: expect.any(String) },
    ]);
  });
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

    it('takes a worker SwiftPM artifact built with another Xcode than this Mac has', () => {
      const fingerprint = 'a'.repeat(64);
      const artifact = {
        fingerprint,
        cacheKey: `swiftpm-peer-${fingerprint}`,
        name: 'App.app',
        size: 10,
        sha256: 'b'.repeat(64),
      };
      const options = { mode: 'auto' as const, here: IDLE, artifact: 'swiftpm' as const, cacheOnly: true };
      const offers = [{ machine: 'mini', offer: offer({ artifact, toolchain: other }) }];
      expect(pickOffer({ ...options, target: onWorker, offers }).order).toEqual([0]);
      expect(pickOffer({ ...options, target, offers }).order).toEqual([]);
    });
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
  const macos: BuildTarget = {
    platform: 'macos',
    local: { stimBuild: 'b1', compat: 1, arch: 'arm64', xcode: LOCAL.xcode, macosSdk: '27.0' },
  };

  it('refuses iOS and macOS builds with one platform reason instead of every missing Apple tool', () => {
    expect(toolchainMismatches(IOS, linux)).toEqual([{ code: 'platform', reason: expect.stringContaining('linux') }]);
    expect(toolchainMismatches(macos, linux)).toEqual([{ code: 'platform', reason: expect.stringContaining('macOS') }]);
  });

  it('still takes Android builds', () => {
    expect(toolchainMismatches(ANDROID, linux)).toEqual([]);
  });

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

  it('judges a stim-server that reports no OS by its tools, as before', () => {
    const { os: _os, ...unreported } = linux;
    expect(toolchainMismatches(IOS, unreported).map((problem) => problem.code)).toContain('xcode');
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

  it('strict placement ignores local load and remote.buildMode off, but still requires a pairing', () => {
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
        message: `mini: ${unsupported}, so a named remote machine cannot take it`,
      }),
    );
  });

  it.each(['auto', 'local'])(
    '%s keeps unsupported Release and device builds here even when remote.buildMode is force',
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
    ).toMatchObject({ order: [], reasons: ['mini: unreachable'] });
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
      mode: 'off',
      here: IDLE,
      machines: credentials,
      note: () => {},
    });

  it('automatic placement skips disabled remotes but an explicit name still connects', async () => {
    mkdirSync(join(root, 'home'), { recursive: true });
    writeFileSync(join(root, 'home', 'config.json'), JSON.stringify({ remote: { buildPoolDisabled: ['mini'] } }));
    const open = vi.spyOn(BuildConnection, 'open').mockResolvedValue({ failure: 'offline', refused: false });
    await chooseBuildMachine({
      projectRoot: root,
      selected: 'auto',
      target: IOS,
      mode: 'force',
      here: IDLE,
      machines: credentials,
      note: () => {},
    });
    expect(open.mock.calls.map(([endpoint]) => endpoint.url)).toEqual(['other']);
    open.mockClear();
    await choose();
    expect(open.mock.calls.map(([endpoint]) => endpoint.url)).toEqual(['mini']);
  });

  it.each(['unreachable', 'approval-pending', 'forbidden', 'pinned identity changed'])(
    'strict %s never probes another configured worker',
    async (reason) => {
      const open = vi.spyOn(BuildConnection, 'open').mockResolvedValue({ failure: reason, refused: true });
      expect(await choose()).toBe(`mini: ${reason}`);
      expect(open.mock.calls.map(([endpoint]) => endpoint.url)).toEqual(['mini']);
    },
  );

  it('a member disabled during source sync receives no new remote build', async () => {
    mkdirSync(join(root, 'home'), { recursive: true });
    const request = vi.fn<BuildConnection['request']>().mockImplementation(async (method) => {
      if (method === 'build.offer') return { result: offer() };
      if (method === 'build.sync') {
        writeFileSync(join(root, 'home', 'config.json'), JSON.stringify({ remote: { buildPoolDisabled: ['mini'] } }));
        return { result: { missing: [] } };
      }
      throw new Error(`Unexpected request: ${method}`);
    });
    const close = vi.fn<() => void>();
    const connection = Object.assign(Object.create(BuildConnection.prototype), {
      features: [],
      request,
      close,
      onProgress: () => {},
    }) as BuildConnection;
    vi.spyOn(BuildConnection, 'open').mockResolvedValue(connection);
    const choice = await chooseBuildMachine({
      projectRoot: root,
      selected: 'auto',
      target: IOS,
      mode: 'force',
      here: IDLE,
      machines: [credentials[0]!],
      note: () => {},
    });
    assert(typeof choice !== 'string');
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
    expect(outcome).toMatchObject({ ok: false, machine: 'mini', reason: expect.stringContaining('disabled') });
    expect(request.mock.calls.map(([method]) => method)).toEqual(['build.offer', 'build.sync']);
    expect(close).toHaveBeenCalled();
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
    mode: 'auto' as const,
    machines: 1,
    here: IDLE,
    unsupported: null,
    localEnabled: false,
  };
  expect(offloadPlacement(base).offload).toBe(true);
  for (const override of [{ machines: 0 }, { unsupported: 'Release builds build here' }, { mode: 'off' as const }])
    expect(() => offloadPlacement({ ...base, ...override })).toThrow('local is disabled');
  expect(offloadPlacement({ ...base, selected: 'local' }).offload).toBe(false);
  expect(
    pickOffer({
      selected: 'auto',
      mode: 'auto',
      here: IDLE,
      localEnabled: false,
      target: IOS,
      offers: [{ machine: 'mini', offer: offer({ capacity: capacity({ loadPerCore: 9 }) }) }],
    }).order,
  ).toEqual([0]);
});

test('worker matching ignores global CocoaPods for every iOS build while retaining Xcode, SDK, runtime and CPU requirements', () => {
  const worker = offer({ toolchain: { cocoapods: null, bundler: null } }).toolchain;
  expect(toolchainMismatches({ ...IOS, native: 'xcode', cocoapodsPinned: true }, worker)).toEqual([]);
  expect(toolchainMismatches(IOS, worker)).toEqual([]);
  expect(toolchainMismatches({ ...IOS, native: 'xcode' }, { ...worker, simulatorSdk: null, runtimes: [] })).toEqual([
    expect.objectContaining({ code: 'simulator-sdk' }),
    expect.objectContaining({ code: 'runtime' }),
  ]);
  expect(toolchainMismatches({ ...IOS, native: 'xcode' }, { ...worker, xcode: 'another build', arch: 'x64' })).toEqual([
    expect.objectContaining({ code: 'arch' }),
    expect.objectContaining({ code: 'xcode' }),
  ]);
});

test('each operation reports its own --remote-build flag as the source of its placement', async () => {
  const home = mkdtempSync(join(tmpdir(), 'stim-placement-'));
  const operations = ['local', undefined].map((flag) => ({ flag, context: testContext({ home }) }));
  try {
    const sources = await Promise.all(
      operations.map(({ flag, context }) =>
        withAmbientContext(context, async () => {
          resolveBuildPlacement(flag);
          await new Promise((resolve) => setTimeout(resolve, 10));
          return buildPlacementSettings('local').find((setting) => setting.key === 'remote.build')?.from;
        }),
      ),
    );
    expect(sources).toEqual(['flag', 'default']);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("two operations resolve STIM_REMOTE_BUILD from their own environments, not the host's", async () => {
  const home = mkdtempSync(join(tmpdir(), 'stim-placement-'));
  vi.stubEnv('STIM_REMOTE_BUILD', 'auto');
  const operations = ['local', undefined].map((value) =>
    testContext({ home, env: { ...process.env, STIM_REMOTE_BUILD: value } }),
  );
  try {
    const selected = await Promise.all(
      operations.map((context) =>
        withAmbientContext(context, async () => {
          await new Promise((resolve) => setTimeout(resolve, 10));
          const placement = resolveBuildPlacement();
          return [placement.selected, buildPlacementSettings(placement.selected)[0]?.from];
        }),
      ),
    );
    expect(selected).toEqual([
      ['local', 'env'],
      ['auto', 'default'],
    ]);
  } finally {
    vi.unstubAllEnvs();
    rmSync(home, { recursive: true, force: true });
  }
});

describe('a named machine refused before this Mac changes the checkout', () => {
  const problems = (toolchain: Partial<WorkerToolchain>, target: BuildTarget = IOS) =>
    offerProblems(offer({ toolchain }), target);

  it('refuses a toolchain difference with the fix on that machine, and a global CocoaPods difference never', () => {
    expect(buildMachines.predictedRefusal('mini', problems({ cocoapods: null }))).toBeNull();
    expect(buildMachines.predictedRefusal('mini', problems({ cocoapods: '1.17.0' }))).toBeNull();
    expect(buildMachines.predictedRefusal('mini', problems({ runtimes: [], cocoapods: null }))).toEqual({
      reason: 'no iPhone simulator on com.apple.CoreSimulator.SimRuntime.iOS-27-0 there',
      remedy: expect.stringContaining('mini'),
    });
    expect(buildMachines.predictedRefusal('mini', problems({ xcode: 'Xcode 26.4' }))?.reason).toContain('Xcode');
  });

  it('leaves a busy, unreachable or low-disk machine to the build itself', () => {
    const transient = offer({ capacity: capacity({ running: 1, declined: 'already running 1 offloaded build(s)' }) });
    expect(buildMachines.predictedRefusal('mini', offerProblems(transient, IOS))).toBeNull();
    expect(buildMachines.predictedRefusal('mini', [{ code: 'unreachable', reason: 'timed out' }])).toBeNull();
  });
});

describe('workerFailureReason', () => {
  it('reports a pods-failed job as a failed pod install, and any other job by its code', () => {
    expect(workerFailureReason('pods-failed', 'boom')).toBe('pod install failed: boom');
    expect(workerFailureReason('fingerprint-mismatch', 'the checkout there fingerprints x')).toBe(
      'fingerprint-mismatch: the checkout there fingerprints x',
    );
    expect(workerFailureReason(undefined, undefined)).toBe('failed: ');
  });

  it('is what podsFailedRemedy recognizes', () => {
    expect(podsFailedRemedy('mini', workerFailureReason('pods-failed', POD_MISSING_REASON), null)).toContain(
      'brew install cocoapods',
    );
  });
});

describe('podsFailedRemedy', () => {
  it('names the CocoaPods install on the machine that has none', () => {
    expect(
      podsFailedRemedy(
        'mini',
        'pod install failed: CocoaPods is not installed: no `pod` executable on PATH.',
        '1.17.0',
      ),
    ).toBe(
      [
        'On mini, install CocoaPods (this Mac has 1.17.0; `gem install cocoapods -v 1.17.0` instead of Homebrew installs that version):',
        'brew install cocoapods',
        'Then run the same command again, or rerun with --remote-build auto or --remote-build local.',
      ].join('\n'),
    );
  });

  it('points at the error for any other pod install failure and ignores other failures', () => {
    expect(podsFailedRemedy('mini', 'pod install failed: [!] Unable to find a specification', null)).toContain(
      'Fix the pod install error on mini',
    );
    expect(podsFailedRemedy('mini', 'fingerprint-mismatch: the checkout there differs', null)).toBeUndefined();
  });
});
