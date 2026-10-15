import assert from 'node:assert';
import { runProvision, type ProvisionDeps } from '../commands/device-provision.ts';
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
  let run: ProvisioningRun = { resolved: true, lines: [], code: 75 };
  const deps: Partial<ProvisionDeps> = {
    findProjectRoot: () => ROOT,
    resolveSettings: () => ({}),
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
    discoverXcodeProject: () => ({
      flag: '-workspace',
      path: `${ROOT}/ios/App.xcworkspace`,
      dir: `${ROOT}/ios`,
      name: 'App',
    }),
    resolveScheme: async (_project, { scheme } = {}) => ({ scheme: scheme ?? 'App', schemes: ['App'] }),
    readBuildSettings: async () => BUILD_SETTINGS,
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
      return run;
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
    setRun: (next: ProvisioningRun) => {
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
});
