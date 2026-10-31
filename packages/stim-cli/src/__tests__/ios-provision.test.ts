import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';

import { PassThrough } from 'node:stream';
import { resetExecutor, setExecutor } from '../exec.ts';
import {
  createPlanningWatch,
  provisionAuth,
  provisionChanges,
  provisionFailure,
  readInstalledProfiles,
  runProvisioningBuild,
  signingTargetsRefusal,
  type ProvisionAuth,
} from '../engine/ios-provision.ts';

const UDID = '00008030-001A2B3C4D5E802E';

const KEY = { kind: 'api-key', keyPath: '/keys/AuthKey_ABC123.p8', keyId: 'ABC123', issuerId: 'issuer-1' } as const;
const DEVELOPMENT_PROFILE = readFileSync(
  new URL('./fixtures/ios-signing/development-profile.plist', import.meta.url),
  'utf-8',
);

const exists = () => true;

describe('provisionAuth', () => {
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

describe('signing targets', () => {
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
