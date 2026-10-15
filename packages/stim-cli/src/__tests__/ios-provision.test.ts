import { EventEmitter } from 'node:events';
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { resetExecutor, setExecutor } from '../exec.ts';
import {
  createPlanningWatch,
  parseSigningTargets,
  provisionAuth,
  provisionChanges,
  provisionFailure,
  provisionXcodebuildArgs,
  provisionPlanLines,
  readInstalledProfiles,
  redactKeyPath,
  runProvisioningBuild,
  signingTargetsRefusal,
  type ProvisionAuth,
} from '../engine/ios-provision.ts';

const UDID = '00008030-001A2B3C4D5E802E';
const PROJECT = { flag: '-workspace', path: '/app/ios/App.xcworkspace', dir: '/app/ios' };
const KEY = { kind: 'api-key', keyPath: '/keys/AuthKey_ABC123.p8', keyId: 'ABC123', issuerId: 'issuer-1' } as const;
const DEVELOPMENT_PROFILE = readFileSync(
  new URL('./fixtures/ios-signing/development-profile.plist', import.meta.url),
  'utf-8',
);

const exists = () => true;

describe('provisionAuth', () => {
  test('uses the Xcode account when no key setting is present', () => {
    expect(provisionAuth({}, {}, exists)).toEqual({ kind: 'xcode-account' });
  });

  test('uses the API key from the machine config, with the environment winning per value', () => {
    const settings = {
      ios: {
        appStoreConnectKeyPath: '/keys/AuthKey_OLD.p8',
        appStoreConnectKeyId: 'OLD',
        appStoreConnectIssuerId: 'issuer-1',
      },
    };
    expect(provisionAuth(settings, { STIM_ASC_KEY_PATH: KEY.keyPath, STIM_ASC_KEY_ID: 'ABC123' }, exists)).toEqual(KEY);
  });

  test('refuses a partial key, naming what is missing, instead of falling back to the Xcode account', () => {
    expect(provisionAuth({}, { STIM_ASC_KEY_ID: 'ABC123' }, exists)).toMatchObject({
      code: 'STIM_BAD_ARG',
      message: expect.stringContaining('ios.appStoreConnectKeyPath, ios.appStoreConnectIssuerId are not set'),
    });
  });

  test('refuses a missing key file, a malformed value and a whitespace-only override without echoing values', () => {
    const env = { STIM_ASC_KEY_PATH: KEY.keyPath, STIM_ASC_KEY_ID: 'ABC123', STIM_ASC_ISSUER_ID: 'issuer-1' };
    const pem =
      '-----BEGIN PRIVATE KEY-----\nMIGTAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBHkwdwIBAQQg\n-----END PRIVATE KEY-----';
    const refusals = [
      [provisionAuth({}, env, () => false), 'STIM_ASC_KEY_PATH', KEY.keyPath],
      [provisionAuth({}, { ...env, STIM_ASC_KEY_PATH: pem }, exists), 'STIM_ASC_KEY_PATH', 'BEGIN PRIVATE KEY'],
      [provisionAuth({}, { ...env, STIM_ASC_KEY_ID: 'ABC 123' }, exists), 'STIM_ASC_KEY_ID', 'ABC 123'],
      [provisionAuth({ ios: { appStoreConnectKeyPath: pem } }, {}, exists), 'ios.appStoreConnectKeyPath', 'BEGIN'],
      [
        provisionAuth({ ios: { appStoreConnectKeyId: 'ABC123' } }, { STIM_ASC_KEY_ID: '   ' }, exists),
        'STIM_ASC_KEY_ID',
        '   ',
      ],
    ] as const;
    for (const [refusal, names, value] of refusals) {
      expect(refusal).toMatchObject({ code: 'STIM_BAD_ARG', message: expect.stringContaining(names) });
      expect(JSON.stringify(refusal)).not.toContain(value);
    }
  });
});

describe('provisionXcodebuildArgs', () => {
  const args = (auth: ProvisionAuth) =>
    provisionXcodebuildArgs({
      project: PROJECT,
      scheme: 'App',
      configuration: 'Debug',
      udid: UDID,
      derivedDataPath: '/tmp/dd',
      auth,
    });

  test('builds for the phone with provisioning updates and device registration allowed', () => {
    const argv = args({ kind: 'xcode-account' });
    expect(argv).toEqual([
      '-workspace',
      PROJECT.path,
      '-scheme',
      'App',
      '-configuration',
      'Debug',
      '-sdk',
      'iphoneos',
      '-destination',
      `id=${UDID}`,
      '-derivedDataPath',
      '/tmp/dd',
      '-allowProvisioningUpdates',
      '-allowProvisioningDeviceRegistration',
      'build',
    ]);
  });

  test("passes a native app's Swift package arguments before the provisioning flags", () => {
    const packageArgs = ['-clonedSourcePackagesDirPath', '/stim/xcode-packages', '-disableAutomaticPackageResolution'];
    const argv = provisionXcodebuildArgs({
      project: PROJECT,
      scheme: 'App',
      configuration: 'Debug',
      udid: UDID,
      derivedDataPath: '/tmp/dd',
      auth: { kind: 'xcode-account' },
      packageArgs,
    });
    expect(argv.slice(argv.indexOf('/tmp/dd') + 1)).toEqual([
      ...packageArgs,
      '-allowProvisioningUpdates',
      '-allowProvisioningDeviceRegistration',
      'build',
    ]);
  });

  test('passes the API key as xcodebuild authentication flags', () => {
    const argv = args(KEY);
    expect(argv.slice(argv.indexOf('-authenticationKeyPath'), argv.indexOf('build'))).toEqual([
      '-authenticationKeyPath',
      KEY.keyPath,
      '-authenticationKeyID',
      KEY.keyId,
      '-authenticationKeyIssuerID',
      KEY.issuerId,
    ]);
  });
});

function targetSettings(over: Record<string, string>) {
  return {
    target: over.TARGET_NAME,
    buildSettings: {
      PLATFORM_NAME: 'iphoneos',
      CODE_SIGNING_ALLOWED: 'YES',
      PROVISIONING_PROFILE_REQUIRED: 'YES',
      CODE_SIGN_STYLE: 'Automatic',
      DEVELOPMENT_TEAM: 'TEAMID5678',
      ...over,
    },
  };
}

describe('signing targets', () => {
  test('keeps the targets that need a profile and drops frameworks and unsigned bundles', () => {
    const output = JSON.stringify([
      targetSettings({ TARGET_NAME: 'App', PRODUCT_BUNDLE_IDENTIFIER: 'com.example.stim' }),
      targetSettings({
        TARGET_NAME: 'Widget',
        PRODUCT_BUNDLE_IDENTIFIER: 'com.example.stim.widget',
        DEVELOPMENT_TEAM: '',
        CODE_SIGN_STYLE: 'Manual',
      }),
      targetSettings({
        TARGET_NAME: 'Kit',
        PRODUCT_BUNDLE_IDENTIFIER: 'com.example.kit',
        PROVISIONING_PROFILE_REQUIRED: 'NO',
      }),
      targetSettings({ TARGET_NAME: 'Assets', PRODUCT_BUNDLE_IDENTIFIER: 'org.assets', CODE_SIGNING_ALLOWED: 'NO' }),
    ]);
    expect(parseSigningTargets(output)).toEqual([
      { target: 'App', bundleId: 'com.example.stim', platform: 'iphoneos', team: 'TEAMID5678', automatic: true },
      {
        target: 'Widget',
        bundleId: 'com.example.stim.widget',
        platform: 'iphoneos',
        team: null,
        automatic: false,
      },
    ]);
  });

  test('lists signed targets of every platform the scheme builds, and refuses output that is not JSON', () => {
    const watch = targetSettings({
      TARGET_NAME: 'Watch',
      PRODUCT_BUNDLE_IDENTIFIER: 'com.example.stim.watchkitapp',
      PLATFORM_NAME: 'watchos',
    });
    expect(parseSigningTargets(JSON.stringify([watch]))).toEqual([
      expect.objectContaining({ target: 'Watch', platform: 'watchos' }),
    ]);
    expect(parseSigningTargets('note: Using new build system')).toBeNull();
  });

  test('refuses before xcodebuild runs when there is nothing to provision, no team, or manual signing', () => {
    const where = { scheme: 'App', configuration: 'Debug' };
    const app = {
      target: 'App',
      bundleId: 'com.example.stim',
      platform: 'iphoneos',
      team: 'TEAMID5678',
      automatic: true,
    };
    expect(signingTargetsRefusal([app], where)).toBeNull();
    expect(signingTargetsRefusal([], where)).toMatchObject({ code: 'STIM_PROVISION_FAILED' });
    expect(signingTargetsRefusal([{ ...app, team: null }], where)?.remedy).toMatch(/appleTeamId/);
    expect(signingTargetsRefusal([{ ...app, automatic: false }], where)?.message).toMatch(/manual signing/);
  });
});

const PLANNING = [
  'GatherProvisioningInputs',
  '',
  'CreateBuildDescription',
  'Build description signature: 2d0338ae23f8455bd7d7d376d60139ee',
  'Build description path: /dd/Build/Intermediates.noindex/XCBuildData/2d03.xcbuilddata',
];

describe('createPlanningWatch', () => {
  test('reports signing resolved at the first build task after planning', () => {
    const watch = createPlanningWatch();
    expect(PLANNING.map(watch)).toEqual(PLANNING.map(() => false));
    expect(watch('CreateBuildDirectory /dd/Build/Products')).toBe(true);
  });

  test('never reports a planning failure as resolved, including the summary after BUILD FAILED', () => {
    const watch = createPlanningWatch();
    const failed = [
      ...PLANNING,
      `/app/ios/App.xcodeproj: error: No Account for Team "TEAMID5678". Add a new account in Accounts settings or verify that your accounts have valid credentials. (in target 'App' from project 'App')`,
      '** BUILD FAILED **',
      '',
      'The following build commands failed:',
      '\tBuilding project App with scheme App and configuration Debug',
    ];
    expect(failed.some(watch)).toBe(false);
  });

  test('a capitalised Warning: or Error: line after planning is not a task', () => {
    const watch = createPlanningWatch();
    expect(PLANNING.some(watch)).toBe(false);
    expect(watch('Warning: Run script build phase will be run during every build')).toBe(false);
    expect(watch('Error: something odd was logged')).toBe(false);
    expect(watch('CreateBuildDirectory /dd/Build/Products')).toBe(true);
  });

  test('an error-looking line before the tasks does not decide; the first task still does', () => {
    const watch = createPlanningWatch();
    expect(watch('2026-10-14 xcodebuild DVTServices: error: retrying listTeams')).toBe(false);
    expect(PLANNING.some(watch)).toBe(false);
    expect(watch('CreateBuildDirectory /dd/Build/Products')).toBe(true);
  });
});

describe('provisionFailure', () => {
  const fail = (line: string, auth: ProvisionAuth = { kind: 'xcode-account' }) =>
    provisionFailure(
      [...PLANNING, `/app/ios/App.xcodeproj: error: ${line} (in target 'App' from project 'App')`],
      auth,
      'TEAMID5678',
    );

  test('no account and no key names both ways to authenticate', () => {
    const refusal = fail('No Accounts: Add a new account in Accounts settings.');
    expect(refusal.code).toBe('STIM_PROVISION_FAILED');
    expect(refusal.remedy).toMatch(/Xcode > Settings > Accounts/);
    expect(refusal.remedy).toMatch(/ios\.appStoreConnectKeyPath/);
  });

  test('an account outside the team is told the team it cannot reach', () => {
    expect(fail('No Account for Team "TEAMID5678". Add a new account in Accounts settings.')).toMatchObject({
      message: expect.stringContaining('cannot reach team TEAMID5678'),
    });
  });

  test('a rejected API key points at the key settings', () => {
    const refusal = fail(
      'Communication with Apple failed: A non-HTTP 200 response was received (401) for URL https://appstoreconnect.apple.com/xcbuild/QH65B2/listTeams.action',
      KEY,
    );
    expect(refusal.message).toMatch(/API key ABC123/);
    expect(refusal.remedy).toMatch(/key ID and issuer ID/);
  });

  test('any other error is quoted, with the API key path replaced', () => {
    const refusal = fail(`Could not read ${KEY.keyPath}: Something new went wrong.`, KEY);
    expect(refusal.message).toContain('Something new went wrong.');
    expect(refusal.message).toContain('<ios.appStoreConnectKeyPath>');
    expect(refusal.message).not.toContain(KEY.keyPath);
  });

  test('the key path is replaced in its realpath, quoted and shell-escaped forms', () => {
    const dir = mkdtempSync(join(tmpdir(), 'stim-provision-key-'));
    try {
      const keyPath = join(dir, 'AuthKey ABC123.p8');
      writeFileSync(keyPath, 'not a key');
      const real = realpathSync(keyPath);
      const auth = { ...KEY, keyPath };
      const text = [keyPath, real, `'${keyPath}'`, real.replaceAll(' ', '\\ ')].join(' | ');
      const redacted = redactKeyPath(text, auth);
      expect(redacted).not.toContain('AuthKey');
      expect(redacted.split('<ios.appStoreConnectKeyPath>')).toHaveLength(5);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('No Accounts with a key passed does not claim no key is set', () => {
    expect(fail('No Accounts: Add a new account in Accounts settings.', KEY).message).toMatch(/API key ABC123/);
  });
});

class FakeChild extends EventEmitter {
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly signals: string[] = [];
  kill(signal: string) {
    this.signals.push(signal);
    return true;
  }
  exit(code: number | null) {
    this.stdout.end();
    this.stderr.end();
    this.emit('close', code);
  }
}

describe('runProvisioningBuild', () => {
  let child: FakeChild;
  let spawned: { file: string; args: string[] } | null;
  beforeEach(() => {
    child = new FakeChild();
    spawned = null;
    setExecutor({
      spawn: (file: string, args: string[]) => {
        spawned = { file, args };
        return child;
      },
    });
  });
  afterEach(() => {
    resetExecutor();
    vi.useRealTimers();
  });
  const start = (over: Partial<Parameters<typeof runProvisioningBuild>[0]> = {}) =>
    runProvisioningBuild({ args: ['-scheme', 'App', 'build'], cwd: '/app/ios', env: {}, ...over });

  test('interrupts xcodebuild at the first task after planning and flushes a final partial line', async () => {
    const run = start();
    expect(spawned).toEqual({ file: 'xcodebuild', args: ['-scheme', 'App', 'build'] });
    child.stdout.write(`${PLANNING.join('\n')}\nCreateBuildDirectory /dd\n`);
    await new Promise((resolve) => setImmediate(resolve));
    expect(child.signals).toEqual(['SIGINT']);
    child.stderr.write('** BUILD INTERRUPTED **');
    child.exit(75);
    const result = await run;
    expect(result).toMatchObject({ resolved: true, code: 75, cancelled: false, timedOut: false });
    expect(result.lines.at(-1)).toBe('** BUILD INTERRUPTED **');
  });

  test('a planning failure is left to exit by itself and is not resolved', async () => {
    const run = start();
    child.stdout.write(
      `${PLANNING.join('\n')}\n/app: error: No Accounts\n** BUILD FAILED **\nThe following build commands failed:\n`,
    );
    await new Promise((resolve) => setImmediate(resolve));
    child.exit(65);
    expect(await run).toMatchObject({ resolved: false, code: 65 });
    expect(child.signals).toEqual([]);
  });

  test('a full build that exits 0 counts as resolved', async () => {
    const run = start();
    child.exit(0);
    expect(await run).toMatchObject({ resolved: true, code: 0 });
  });

  test('a timeout stops xcodebuild with SIGTERM, then SIGKILL, and settles when it closes', async () => {
    vi.useFakeTimers();
    const run = start({ timeoutMs: 1000, graceMs: { interrupt: 100, terminate: 50 } });
    vi.advanceTimersByTime(1000);
    expect(child.signals).toEqual(['SIGTERM']);
    vi.advanceTimersByTime(50);
    expect(child.signals).toEqual(['SIGTERM', 'SIGKILL']);
    child.exit(null);
    expect(await run).toMatchObject({ resolved: false, timedOut: true });
  });

  test('cancellation forwards SIGINT, escalates to SIGTERM and SIGKILL, and reports cancelled', async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const run = start({ signal: controller.signal, graceMs: { interrupt: 100, terminate: 50 } });
    controller.abort('SIGINT');
    expect(child.signals).toEqual(['SIGINT']);
    vi.advanceTimersByTime(100);
    vi.advanceTimersByTime(50);
    expect(child.signals).toEqual(['SIGINT', 'SIGTERM', 'SIGKILL']);
    child.exit(null);
    expect(await run).toMatchObject({ resolved: false, cancelled: true });
  });

  test('a SIGTERM cancellation forwards SIGTERM first', async () => {
    const controller = new AbortController();
    const run = start({ signal: controller.signal });
    controller.abort('SIGTERM');
    expect(child.signals).toEqual(['SIGTERM']);
    child.exit(143);
    expect(await run).toMatchObject({ cancelled: true });
  });
});

describe('provisionChanges', () => {
  beforeEach(() =>
    setExecutor({
      runFileAsync: async (_file: string, args: string[]) =>
        args.at(-1)?.includes('other-team')
          ? DEVELOPMENT_PROFILE.replaceAll('TEAMID5678', 'OTHER00000')
          : DEVELOPMENT_PROFILE,
    }),
  );
  afterEach(resetExecutor);
  const target = {
    target: 'App',
    bundleId: 'com.example.stim',
    platform: 'iphoneos',
    team: 'TEAMID5678',
    automatic: true,
  };
  const identity = { sha1: 'A'.repeat(40), name: 'Apple Development: Jane (TEAMID5678)' };
  const now = Date.parse('2026-10-14T00:00:00Z');

  test('reports a newly installed profile that lists the phone and a new keychain identity', async () => {
    const after = await readInstalledProfiles(
      new Map([
        ['/p/new.mobileprovision', 2],
        ['/p/other-team.mobileprovision', 2],
      ]),
    );
    expect(
      provisionChanges({
        before: new Map([['/p/other-team.mobileprovision', 2]]),
        after,
        targets: [target],
        udid: UDID.toLowerCase(),
        identitiesBefore: [],
        identitiesAfter: [identity],
        now,
      }),
    ).toEqual({
      profiles: [
        {
          bundleId: 'com.example.stim',
          onPhone: true,
          installed: true,
          profile: {
            name: 'iOS Team Provisioning Profile: com.example.stim',
            uuid: expect.any(String),
            expires: '2027-06-01T12:00:00.000Z',
            devices: 2,
          },
        },
      ],
      identities: [identity],
    });
  });

  test("a watch target's profile counts without listing the phone, and the plan names its platform", async () => {
    const watch = { ...target, platform: 'watchos', bundleId: 'com.example.stim' };
    const after = await readInstalledProfiles(new Map([['/p/watch.mobileprovision', 1]]));
    const changes = provisionChanges({
      before: new Map(),
      after,
      targets: [watch],
      udid: '00008150-000000000000001E',
      identitiesBefore: [],
      identitiesAfter: [],
      now,
    });
    expect(changes.profiles[0]).toMatchObject({ onPhone: false, installed: true, profile: { devices: 2 } });
    const plan = provisionPlanLines({
      device: { udid: UDID, name: 'Phone' },
      targets: [target, { ...watch, target: 'Watch' }],
      auth: { kind: 'xcode-account' },
      scheme: 'App',
      configuration: 'Debug',
    });
    expect(plan.find((line) => line.includes('target Watch'))).toMatch(/watchOS App Development profile .*\);$/);
    expect(plan.find((line) => line.includes('target App'))).toMatch(/so it lists that device;$/);
  });

  test('reports an unchanged profile as already present, and none for a phone it does not list', async () => {
    const after = await readInstalledProfiles(new Map([['/p/same.mobileprovision', 1]]));
    const unchanged = provisionChanges({
      before: new Map([['/p/same.mobileprovision', 1]]),
      after,
      targets: [target],
      udid: UDID,
      identitiesBefore: [identity],
      identitiesAfter: [identity],
      now,
    });
    expect(unchanged.profiles[0]?.installed).toBe(false);
    expect(unchanged.identities).toEqual([]);
    expect(
      provisionChanges({
        before: new Map(),
        after,
        targets: [target],
        udid: '00008150-000000000000001E',
        identitiesBefore: [],
        identitiesAfter: [],
        now,
      }).profiles[0]?.profile,
    ).toBeNull();
  });
});
