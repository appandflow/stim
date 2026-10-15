import { readFileSync } from 'node:fs';
import { resetExecutor, setExecutor } from '../exec.ts';
import {
  createPlanningWatch,
  parseSigningTargets,
  provisionAuth,
  provisionChanges,
  provisionFailure,
  provisionXcodebuildArgs,
  readInstalledProfiles,
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

  test('refuses a key file that does not exist and a malformed key ID', () => {
    const env = { STIM_ASC_KEY_PATH: KEY.keyPath, STIM_ASC_KEY_ID: 'ABC123', STIM_ASC_ISSUER_ID: 'issuer-1' };
    expect(provisionAuth({}, env, () => false)).toMatchObject({ code: 'STIM_BAD_ARG' });
    expect(provisionAuth({}, { ...env, STIM_ASC_KEY_ID: 'ABC 123' }, exists)).toMatchObject({
      code: 'STIM_BAD_ARG',
      message: expect.stringContaining('STIM_ASC_KEY_ID'),
    });
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
      { target: 'App', bundleId: 'com.example.stim', team: 'TEAMID5678', automatic: true },
      { target: 'Widget', bundleId: 'com.example.stim.widget', team: null, automatic: false },
    ]);
  });

  test('refuses before xcodebuild runs when there is nothing to provision, no team, or manual signing', () => {
    const where = { scheme: 'App', configuration: 'Debug' };
    const app = { target: 'App', bundleId: 'com.example.stim', team: 'TEAMID5678', automatic: true };
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

  test('any other error is quoted', () => {
    expect(fail('Something new went wrong.').message).toContain('Something new went wrong.');
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
  const target = { target: 'App', bundleId: 'com.example.stim', team: 'TEAMID5678', automatic: true };
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
