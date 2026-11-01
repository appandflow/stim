import assert from 'node:assert';
import { EventEmitter } from 'node:events';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { nativeXcodePackages } from '../integrations/native-xcode-inputs.ts';
import { writeNativeXcodeProject } from './_native-xcode-project.ts';
import { confirmInTerminal, runProvision, type ProvisionDeps } from '../commands/device-provision.ts';
import { operationState } from '../engine/operation-state.ts';
import type { ProvisioningRun } from '../engine/ios-provision.ts';

const PHONE = '00008101-000A10913C89001E';
const ROOT = '/work/app';
const BUILD_SETTINGS = JSON.stringify([
  {
    target: 'App',
    buildSettings: {
      TARGET_NAME: 'App',
      PLATFORM_NAME: 'iphoneos',
      CODE_SIGNING_ALLOWED: 'YES',
      PROVISIONING_PROFILE_REQUIRED: 'YES',
      CODE_SIGN_STYLE: 'Automatic',
      DEVELOPMENT_TEAM: 'TEAMID5678',
      PRODUCT_BUNDLE_IDENTIFIER: 'com.example.stim',
    },
  },
]);

function harness(over: Partial<ProvisionDeps> = {}) {
  const out: string[] = [];
  const note: string[] = [];
  const builds: Array<{ args: string[]; cwd: string }> = [];
  const questions: string[] = [];
  const removed: string[] = [];
  let run: ProvisioningRun | (() => ProvisioningRun) = {
    resolved: true,
    lines: [],
    code: 75,
    timedOut: false,
    cancelled: false,
  };
  const deps: Partial<ProvisionDeps> = {
    findProjectRoot: () => ROOT,
    resolveSettings: () => ({}),
    machineConfig: () => ({}),
    env: {},
    fileExists: () => true,
    listIosDevices: async () => [
      {
        udid: PHONE,
        name: 'Old iPhone',
        bootState: 'booted',
        developerModeStatus: 'enabled',
        pairingState: 'paired',
        transportType: 'wired',
      },
    ],
    selectXcode: async (_root, _settings, { scheme, configuration }) => ({
      project: { flag: '-workspace', path: `${ROOT}/ios/App.xcworkspace`, dir: `${ROOT}/ios`, name: 'App' },
      scheme: scheme ?? 'App',
      configuration,
      packageArgs: [],
    }),
    readBuildSettings: async () => ({ output: BUILD_SETTINGS }),
    interactive: false,
    confirm: async (question) => {
      questions.push(question);
      return false;
    },
    profileFiles: () => new Map(),
    readInstalledProfiles: async () => [],
    findSigningIdentities: async () => [],
    runProvisioningBuild: async ({ args, cwd }) => {
      builds.push({ args, cwd });
      return typeof run === 'function' ? run() : run;
    },
    makeDerivedData: () => '/tmp/stim-provision-1',
    removeDerivedData: (path) => removed.push(path),
    now: () => Date.parse('2026-10-14T00:00:00Z'),
    out: (line) => out.push(line),
    note: (line) => note.push(line),
    ...over,
  };
  return {
    deps,
    out,
    note,
    builds,
    questions,
    removed,
    setRun: (next: ProvisioningRun | (() => ProvisioningRun)) => {
      run = next;
    },
  };
}

describe('stim device provision', () => {
  test('refuses android before looking at any project or device', async () => {
    const h = harness({
      findProjectRoot: () => {
        throw new Error('android must refuse first');
      },
    });
    expect(await runProvision('android', undefined, {}, h.deps)).toMatchObject({ code: 'STIM_BAD_ARG' });
  });

  test('without a terminal or --yes it prints the account changes and changes nothing', async () => {
    const h = harness();
    expect(await runProvision('ios', undefined, {}, h.deps)).toMatchObject({ code: 'STIM_PROVISION_UNCONFIRMED' });
    const plan = h.note.join('\n');
    expect(plan).toContain('team TEAMID5678');
    expect(plan).toContain(`Old iPhone (${PHONE})`);
    expect(plan).toContain('com.example.stim');
    expect(plan).toContain('Xcode > Settings > Accounts');
    expect(h.questions).toEqual([]);
    expect(h.builds).toEqual([]);
  });

  test('a terminal prompt runs it only on an explicit yes', async () => {
    const declined = harness({ interactive: true });
    expect(await runProvision('ios', undefined, {}, declined.deps)).toMatchObject({
      code: 'STIM_PROVISION_UNCONFIRMED',
    });
    expect(declined.questions).toHaveLength(1);
    expect(declined.builds).toEqual([]);

    const accepted = harness({ interactive: true, confirm: async () => true });
    assert(!('code' in (await runProvision('ios', undefined, {}, accepted.deps))));
    expect(accepted.builds).toHaveLength(1);
  });

  test('--json never prompts and carries the plan in the refusal', async () => {
    const h = harness({ interactive: true });
    await runProvision('ios', PHONE, { json: true }, h.deps);
    expect(h.questions).toEqual([]);
    expect(h.builds).toEqual([]);
    expect(JSON.parse(h.out.join(''))).toMatchObject({
      code: 'STIM_PROVISION_UNCONFIRMED',
      plan: { udid: PHONE, teams: ['TEAMID5678'], auth: { kind: 'xcode-account' }, scheme: 'App' },
    });
  });

  test('--yes runs xcodebuild for the selected scheme and phone with the API key, then removes its DerivedData', async () => {
    const h = harness({
      env: { STIM_ASC_KEY_PATH: '/keys/AuthKey_ABC123.p8', STIM_ASC_KEY_ID: 'ABC123', STIM_ASC_ISSUER_ID: 'issuer-1' },
    });
    const result = await runProvision(
      'ios',
      PHONE,
      { yes: true, json: true, scheme: 'AppDev', configuration: 'Release' },
      h.deps,
    );
    assert(!('code' in result));
    const [build] = h.builds;
    assert(build);
    expect(build.cwd).toBe(`${ROOT}/ios`);
    for (const [flag, value] of [
      ['-scheme', 'AppDev'],
      ['-configuration', 'Release'],
      ['-destination', `id=${PHONE}`],
      ['-derivedDataPath', '/tmp/stim-provision-1'],
      ['-authenticationKeyID', 'ABC123'],
    ] as const) {
      expect(build.args[build.args.indexOf(flag) + 1]).toBe(value);
    }
    expect(build.args).toContain('-allowProvisioningUpdates');
    expect(h.removed).toEqual(['/tmp/stim-provision-1']);
    const printed = JSON.parse(h.out.join(''));
    expect(printed).toMatchObject({ auth: { kind: 'api-key', keyId: 'ABC123' }, changes: { identities: [] } });
    expect(JSON.stringify(printed)).not.toContain('AuthKey_ABC123.p8');
  });

  test('a run that fails before signing resolves is STIM_PROVISION_FAILED with the xcodebuild cause', async () => {
    const h = harness();
    h.setRun({
      resolved: false,
      timedOut: false,
      cancelled: false,
      code: 65,
      lines: [
        "/work/app/ios/App.xcodeproj: error: No Accounts: Add a new account in Accounts settings. (in target 'App' from project 'App')",
        '** BUILD FAILED **',
      ],
    });
    expect(await runProvision('ios', undefined, { yes: true }, h.deps)).toMatchObject({
      code: 'STIM_PROVISION_FAILED',
      message: expect.stringContaining('no Apple account'),
    });
    expect(h.removed).toHaveLength(1);
  });

  test('a phone with Developer Mode off is refused before any xcodebuild call', async () => {
    const h = harness({
      listIosDevices: async () => [
        {
          udid: PHONE,
          name: 'Old iPhone',
          bootState: 'booted',
          developerModeStatus: 'disabled',
          pairingState: 'paired',
          transportType: 'wired',
        },
      ],
      readBuildSettings: async () => {
        throw new Error('must not read build settings');
      },
    });
    expect(await runProvision('ios', PHONE, { yes: true }, h.deps)).toMatchObject({
      code: 'STIM_NO_DEVICE',
      remedy: expect.stringContaining('Developer Mode'),
    });
  });

  test('several connected phones are refused with the provision command to name one', async () => {
    const phone = (udid: string) => ({
      udid,
      name: udid,
      bootState: 'booted',
      developerModeStatus: 'enabled',
      pairingState: 'paired',
      transportType: 'wired',
    });
    const h = harness({ listIosDevices: async () => [phone(PHONE), phone('00008150-000662102620401C')] });
    expect(await runProvision('ios', undefined, { yes: true }, h.deps)).toMatchObject({
      code: 'STIM_NO_DEVICE',
      remedy: expect.stringContaining('stim device provision ios <udid>'),
    });
  });

  test('build settings xcodebuild cannot report are refused with its own error', async () => {
    const h = harness({ readBuildSettings: async () => ({ error: 'xcodebuild: error: The workspace is damaged.' }) });
    expect(await runProvision('ios', undefined, { yes: true }, h.deps)).toMatchObject({
      code: 'STIM_PROVISION_FAILED',
      message: expect.stringContaining('The workspace is damaged.'),
    });
    expect(h.builds).toEqual([]);
  });

  test('a DerivedData directory it cannot create is a coded refusal before xcodebuild', async () => {
    const h = harness({
      makeDerivedData: () => {
        throw new Error('EACCES: permission denied');
      },
    });
    expect(await runProvision('ios', undefined, { yes: true }, h.deps)).toMatchObject({
      code: 'STIM_PROVISION_FAILED',
      message: expect.stringContaining('Nothing changed'),
    });
    expect(h.builds).toEqual([]);
  });

  test('a failed or interrupted run still reports what already changed, and removes DerivedData', async () => {
    const h = harness({
      profileFiles: () => new Map([['/profiles/new.mobileprovision', 2]]),
      readInstalledProfiles: async () => [
        {
          file: '/profiles/new.mobileprovision',
          mtimeMs: 2,
          applicationIdentifier: 'TEAMID5678.com.example.stim',
          profile: {
            name: 'iOS Team Provisioning Profile: com.example.stim',
            uuid: 'new-uuid',
            teamIdentifier: 'TEAMID5678',
            expirationDate: new Date('2027-10-14T00:00:00Z'),
            provisionedDevices: [PHONE],
            provisionsAllDevices: false,
            getTaskAllow: true,
            certificates: [],
          },
        },
      ],
    });
    let calls = 0;
    h.deps.profileFiles = () => (calls++ === 0 ? new Map() : new Map([['/profiles/new.mobileprovision', 2]]));
    h.setRun({ resolved: false, lines: [], code: null, timedOut: false, cancelled: true });
    const failure = await runProvision('ios', undefined, { yes: true, json: true }, h.deps);
    expect(failure).toMatchObject({
      code: 'STIM_PROVISION_FAILED',
      message: expect.stringContaining('interrupted'),
      changes: { profiles: [{ bundleId: 'com.example.stim', installed: true }] },
    });
    expect(h.removed).toEqual(['/tmp/stim-provision-1']);
  });

  test('an interrupt while xcodebuild runs drains the operation, and DerivedData removal is an exit cleanup', async () => {
    const controller = new AbortController();
    const operation = {
      home: '/home',
      buildCache: null,
      projectRoot: ROOT,
      env: {},
      cwd: ROOT,
      runId: 'run',
      signal: controller.signal,
      output: () => {},
    };
    const h = harness({ operation });
    let cleanupsDuringRun = 0;
    h.setRun(() => {
      controller.abort('SIGINT');
      const state = operationState(operation);
      cleanupsDuringRun = state.exitCleanups.size;
      expect(state).toMatchObject({ handled: true, draining: true });
      return { resolved: false, lines: [], code: null, timedOut: false, cancelled: true };
    });
    await runProvision('ios', undefined, { yes: true }, h.deps);
    expect(cleanupsDuringRun).toBe(1);
    expect(operationState(operation).exitCleanups.size).toBe(0);
  });
});

describe('stim device provision, native packages and forced exit', () => {
  const operation = (controller: AbortController) => ({
    home: '/home',
    buildCache: null,
    projectRoot: ROOT,
    env: {},
    cwd: ROOT,
    runId: 'run',
    signal: controller.signal,
    output: () => {},
  });

  test('a forced exit kills xcodebuild before it removes DerivedData', async () => {
    const order: string[] = [];
    const context = operation(new AbortController());
    const h = harness({
      operation: context,
      removeDerivedData: () => order.push('remove'),
      runProvisioningBuild: async ({ onChild }) => {
        onChild?.({ kill: (signal) => order.push(`kill:${signal}`) > 0 });
        for (const cleanup of operationState(context).exitCleanups) cleanup();
        return { resolved: false, lines: [], code: null, timedOut: false, cancelled: true };
      },
    });
    await runProvision('ios', undefined, { yes: true }, h.deps);
    expect(order.slice(0, 2)).toEqual(['kill:SIGKILL', 'remove']);
  });

  test("a native app's Swift package arguments reach both the settings read and the provisioning run", async () => {
    const packageArgs = ['-clonedSourcePackagesDirPath', '/stim/xcode-packages', '-disableAutomaticPackageResolution'];
    const reads: string[][] = [];
    const h = harness({
      selectXcode: async (_root, _settings, { configuration }) => ({
        project: { flag: '-project', path: `${ROOT}/App.xcodeproj`, dir: ROOT, name: 'App' },
        scheme: 'App',
        configuration,
        packageArgs,
      }),
      readBuildSettings: async (selection) => {
        reads.push(selection.packageArgs);
        return { output: BUILD_SETTINGS };
      },
    });
    await runProvision('ios', undefined, { yes: true }, h.deps);
    expect(reads).toEqual([packageArgs]);
    const args = h.builds[0]?.args ?? [];
    expect(
      args.slice(args.indexOf('-clonedSourcePackagesDirPath'), args.indexOf('-clonedSourcePackagesDirPath') + 3),
    ).toEqual(packageArgs);
  });

  test('a native app whose Swift packages Stim has not resolved is refused until they are', async () => {
    const home = mkdtempSync(join(tmpdir(), 'stim-home-'));
    const app = realpathSync(mkdtempSync(join(tmpdir(), 'stim-native-')));
    const previous = process.env.STIM_HOME;
    process.env.STIM_HOME = home;
    try {
      const pbx = join(writeNativeXcodeProject(app), 'project.pbxproj');
      writeFileSync(
        pbx,
        readFileSync(pbx, 'utf8').replace(
          'objects = {',
          'objects = {\nPRODUCT = { isa = XCSwiftPackageProductDependency; productName = Remote; };',
        ),
      );
      const reads: string[][] = [];
      const { selectXcode: _default, ...deps } = harness({
        findProjectRoot: () => app,
        readBuildSettings: async (selection) => {
          reads.push(selection.packageArgs);
          return { output: BUILD_SETTINGS };
        },
      }).deps;
      expect(await runProvision('ios', undefined, {}, deps)).toMatchObject({
        code: 'STIM_PROVISION_FAILED',
        message: expect.stringContaining('has not resolved them yet'),
        remedy: expect.stringContaining('`stim ios`'),
      });
      const packages = nativeXcodePackages(app);
      mkdirSync(packages, { recursive: true });
      expect(await runProvision('ios', undefined, {}, deps)).toMatchObject({
        message: expect.stringContaining('resolution is incomplete'),
      });
      writeFileSync(join(packages, 'workspace-state.json'), '{}');
      expect(await runProvision('ios', undefined, {}, deps)).toMatchObject({ code: 'STIM_PROVISION_UNCONFIRMED' });
      expect(reads).toEqual([['-clonedSourcePackagesDirPath', packages, '-disableAutomaticPackageResolution']]);
    } finally {
      if (previous === undefined) delete process.env.STIM_HOME;
      else process.env.STIM_HOME = previous;
      rmSync(home, { recursive: true, force: true });
      rmSync(app, { recursive: true, force: true });
    }
  });

  test('a watch target without a profile listing the phone does not turn success into a warning', async () => {
    const h = harness({
      readBuildSettings: async () => ({
        output: JSON.stringify([
          JSON.parse(BUILD_SETTINGS)[0],
          {
            target: 'Watch',
            buildSettings: {
              ...JSON.parse(BUILD_SETTINGS)[0].buildSettings,
              TARGET_NAME: 'Watch',
              PLATFORM_NAME: 'watchos',
              PRODUCT_BUNDLE_IDENTIFIER: 'com.example.stim.watchkitapp',
            },
          },
        ]),
      }),
      readInstalledProfiles: async () => [
        {
          file: '/profiles/app.mobileprovision',
          mtimeMs: 1,
          applicationIdentifier: 'TEAMID5678.com.example.stim',
          profile: {
            name: 'App',
            uuid: 'app-uuid',
            teamIdentifier: 'TEAMID5678',
            expirationDate: new Date('2027-10-14T00:00:00Z'),
            provisionedDevices: [PHONE],
            provisionsAllDevices: false,
            getTaskAllow: true,
            certificates: [],
          },
        },
      ],
    });
    assert(!('code' in (await runProvision('ios', undefined, { yes: true }, h.deps))));
    expect(h.out[0]).toContain('Provisioned signing for');
    expect(h.note.join('\n')).toContain('watchOS App Development profile for com.example.stim.watchkitapp');
  });

  test('a simulator UDID is refused with the provision command for a phone', async () => {
    const h = harness({
      listIosDevices: async () => [
        {
          udid: 'SIM-UDID',
          name: 'iPhone 18 Pro',
          bootState: 'booted',
          developerModeStatus: null,
          pairingState: null,
          transportType: 'sameMachine',
          reality: 'simulated',
          platform: 'iOS',
        },
      ],
    });
    expect(await runProvision('ios', 'SIM-UDID', { yes: true }, h.deps)).toMatchObject({
      code: 'STIM_NO_DEVICE',
      message: expect.stringContaining('`stim device provision ios` provisions only a physical iPhone or iPad'),
      remedy: expect.stringContaining('stim device provision ios <udid>'),
    });
  });
});

describe('confirmInTerminal', () => {
  class FakePrompt extends EventEmitter {
    closed = false;
    readonly answer: (prompt: FakePrompt, resolve: (text: string) => void) => void;
    constructor(answer: (prompt: FakePrompt, resolve: (text: string) => void) => void) {
      super();
      this.answer = answer;
    }
    question(_query: string, { signal }: { signal: AbortSignal }): Promise<string> {
      return new Promise((resolve, reject) => {
        signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
        this.answer(this, resolve);
      });
    }
    close() {
      this.closed = true;
    }
  }

  test('Ctrl+C and end of input answer no', async () => {
    for (const event of ['SIGINT', 'close']) {
      const prompt = new FakePrompt((self) => queueMicrotask(() => self.emit(event)));
      expect(await confirmInTerminal('? ', () => prompt)).toBe(false);
    }
  });
});
