import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { vi } from 'vitest';
import { easOptionRefusal, resolveEasDevelopmentBuild, selectEasBuild } from '../engine/eas-build.ts';
import * as locks from '../engine/build-lock.ts';
import { resetExecutor, setExecutor } from '../exec.ts';
import { ClaimUnavailableError } from '../ownership-claim.ts';

const fingerprint = 'a'.repeat(40);
const projectId = 'project-1';
const profile = 'development';
const target = { platform: 'ios' as const, profile, fingerprint, projectId };
const listedBuild = {
  id: 'build-1',
  status: 'FINISHED',
  platform: 'IOS',
  fingerprint: { hash: fingerprint },
  app: { id: projectId },
  isForIosSimulator: true,
  distribution: 'INTERNAL',
  artifacts: { applicationArchiveUrl: 'https://example.com/app.tar.gz' },
};
const build = { ...listedBuild, buildProfile: profile };
let home: string;
let root: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'stim-eas-test-'));
  root = join(home, 'project');
  mkdirSync(root);
  process.env.STIM_HOME = home;
  vi.spyOn(locks, 'acquireBuildLock').mockReturnValue({ acquired: true });
  vi.spyOn(locks, 'releaseBuildLock').mockReturnValue(true);
});
afterEach(() => {
  resetExecutor();
  vi.restoreAllMocks();
  rmSync(home, { recursive: true, force: true });
  delete process.env.STIM_HOME;
});

function fixture({
  platform = 'ios',
  builds = [build],
  config = {},
  failCommand = '',
  projectFromEnv = false,
  physical = false,
  easCliVersion = 'eas-cli/24.8.0 darwin-arm64 node-v22.22.2',
}: {
  platform?: 'ios' | 'android';
  builds?: unknown;
  config?: Record<string, unknown>;
  failCommand?: string;
  projectFromEnv?: boolean;
  physical?: boolean;
  easCliVersion?: string | null;
} = {}) {
  const calls: string[][] = [];
  setExecutor({
    runQuiet: () => '/eas',
    findExecutable: () => '/eas',
    runFile: (file, args, options) => {
      expect(file).toBe('/eas');
      expect(options.cwd).toBe(root);
      expect(args).toContain('--json');
      expect(args).toContain('--non-interactive');
      calls.push(args);
      if (args[0] === failCommand) throw new Error('private environment value');
      switch (args[0]) {
        case 'config':
          return JSON.stringify({
            buildProfile: { developmentClient: true, distribution: 'internal', simulator: !physical, ...config },
            appConfig: { extra: { eas: { projectId } } },
          });
        case 'fingerprint:generate':
          if (projectFromEnv && options.env?.APP_VARIANT !== 'development')
            throw new Error('Fingerprint would be uploaded to the wrong project');
          return JSON.stringify({ hash: fingerprint, sources: [] });
        case 'build:list':
          return JSON.stringify(projectFromEnv && options.env?.APP_VARIANT !== 'development' ? [] : builds);
        case 'build:download': {
          const path = join(home, 'eas-run-cache', `${args[2]}.${platform === 'ios' ? 'app' : 'apk'}`);
          mkdirSync(join(home, 'eas-run-cache'), { recursive: true });
          if (platform === 'ios') mkdirSync(path, { recursive: true });
          else if (!existsSync(path)) writeFileSync(path, 'apk bytes');
          return JSON.stringify({ path });
        }
        default:
          throw new Error(`Unexpected EAS command ${args[0]}`);
      }
    },
  });
  const resolve = () =>
    resolveEasDevelopmentBuild({
      root,
      platform,
      profile,
      physical,
      note: () => {},
      readEasCliVersion: () => easCliVersion,
    });
  return { calls, resolve };
}

test.each([
  { status: 'ERRORED' },
  { platform: 'ANDROID' },
  { buildProfile: 'production' },
  { fingerprint: { hash: 'b'.repeat(40) } },
  { app: { id: 'another-project' } },
  { app: undefined },
  { app: {} },
  { app: undefined, project: { id: 'another-project' } },
  { app: undefined, project: {} },
  { app: { id: 'another-project' }, project: { id: projectId } },
  { app: { id: '' }, project: { id: projectId } },
  { isForIosSimulator: false },
  { artifacts: {} },
])('does not select an incompatible EAS artifact: %j', (change) => {
  expect(selectEasBuild([{ ...build, ...change }], target)).toBeNull();
});

test.each([
  ['ios', 'app'],
  ['android', 'app'],
  ['ios', 'project'],
  ['android', 'project'],
] as const)(
  'uses the matching %s artifact with %s identity from EAS CLI without copying or deleting it',
  async (platform, identity) => {
    const { resolve, calls } = fixture({
      platform,
      builds: [{ ...build, platform: platform.toUpperCase(), app: undefined, [identity]: { id: projectId } }],
    });
    const first = await resolve();
    expect(first).toMatchObject({ ok: true, cacheHit: 'remote', fingerprint });
    if (!first?.ok) throw new Error(JSON.stringify(first));
    expect(existsSync(first.path)).toBe(true);
    expect(first.path).toBe(realpathSync(join(home, 'eas-run-cache', `build-1.${platform === 'ios' ? 'app' : 'apk'}`)));
    expect(first.cacheKey).toMatch(/^eas-/);
    expect(calls.find((call) => call[0] === 'fingerprint:generate')).toContain('--build-profile');
    expect(calls.find((call) => call[0] === 'build:list')).toEqual([
      'build:list',
      '--platform',
      platform,
      '--build-profile',
      profile,
      '--fingerprint-hash',
      fingerprint,
      '--status',
      'finished',
      ...(platform === 'ios' ? ['--simulator'] : ['--distribution', 'internal']),
      '--limit',
      '1',
      '--json',
      '--non-interactive',
    ]);
    expect(calls.find((call) => call[0] === 'build:download')).toEqual([
      'build:download',
      '--build-id',
      'build-1',
      '--json',
      '--non-interactive',
    ]);
    expect(await resolve()).toEqual(first);
    expect(calls.filter((call) => call[0] === 'build:download')).toHaveLength(2);
  },
);

test('a miss gives a build command without running it', async () => {
  const { resolve, calls } = fixture({ builds: [] });
  const result = await resolve();
  expect(result).toMatchObject({ ok: false, code: 'STIM_EAS_BUILD_MISSING' });
  if (result?.ok !== false) throw new Error('Expected a miss');
  expect(result.remedy).toContain('npx eas-cli build --platform ios --profile development');
  expect(result.remedy).toContain('charges');
  expect(calls.map((call) => call[0])).toEqual(['config', 'fingerprint:generate', 'build:list']);
  expect(locks.releaseBuildLock).toHaveBeenCalled();
});

test.each([
  ['eas-cli/18.8.0 darwin-arm64 node-v22.22.2', 'eas-cli 18.8.0 (/eas) cannot download a build by ID'],
  [null, 'Could not read an eas-cli version from `/eas --version`'],
])(
  'an eas-cli without build:download --build-id refuses before any EAS command (%s)',
  async (easCliVersion, message) => {
    const { resolve, calls } = fixture({ easCliVersion });
    const result = await resolve();
    expect(result).toMatchObject({ ok: false, code: 'STIM_EAS_UNAVAILABLE' });
    if (result?.ok !== false) throw new Error('Expected a refusal');
    expect(result.message).toContain(message);
    expect(result.message).toContain('needs eas-cli 18.9.0 or later');
    expect(result.remedy).toContain('npm install --global eas-cli@latest');
    expect(calls).toEqual([]);
  },
);

test('the first eas-cli release with build:download --build-id downloads the build', async () => {
  const { resolve } = fixture({ easCliVersion: 'eas-cli/18.9.0 linux-x64 node-v22.18.0' });
  expect(await resolve()).toMatchObject({ ok: true, cacheHit: 'remote' });
});

test.each(['config', 'fingerprint:generate', 'build:list', 'build:download'])(
  'a failed %s is not a cache miss and does not expose command output',
  async (failCommand) => {
    const result = await fixture({ failCommand }).resolve();
    expect(result).toMatchObject({ ok: false, code: 'STIM_EAS_UNAVAILABLE' });
    expect(JSON.stringify(result)).not.toContain('private environment value');
  },
);

test.each([{ developmentClient: false }, { distribution: 'store' }, { simulator: false }])(
  'rejects a profile that cannot produce simulator development builds: %j',
  async (config) => {
    const { resolve, calls } = fixture({ config });
    expect(await resolve()).toMatchObject({ ok: false, code: 'STIM_BAD_ARG' });
    expect(calls.map((call) => call[0])).toEqual(['config']);
  },
);

test('a newly signed build uses a new identity even when its native fingerprint is unchanged', async () => {
  const first = await fixture().resolve();
  const second = await fixture({ builds: [{ ...build, id: 'build-2' }] }).resolve();
  if (!first?.ok || !second?.ok) throw new Error('Expected downloads');
  expect(second.cacheKey).not.toBe(first.cacheKey);
  expect(second.cacheHit).toBe('remote');
  expect(second.path).not.toBe(first.path);
});

test('a profile that selects a different EAS project fingerprints and downloads from that project', async () => {
  const { resolve } = fixture({ config: { env: { APP_VARIANT: 'development' } }, projectFromEnv: true });
  expect(await resolve()).toMatchObject({ ok: true, cacheHit: 'remote' });
});

test.each([
  { platform: 'ios' as const, config: { buildConfiguration: 'Release' } },
  { platform: 'android' as const, config: { gradleCommand: ':app:assembleRelease' } },
  { platform: 'android' as const, config: { gradleCommand: ':app:bundleDebug' } },
])('refuses incompatible development profile overrides: %j', async ({ platform, config }) => {
  const { resolve, calls } = fixture({ platform, config });
  expect(await resolve()).toMatchObject({ ok: false, code: 'STIM_BAD_ARG' });
  expect(calls.map((call) => call[0])).toEqual(['config']);
});

test.each([
  { platform: 'ios' as const, config: { buildConfiguration: 'Debug' } },
  { platform: 'android' as const, config: { gradleCommand: ':app:assembleDevelopmentDebug' } },
])('accepts explicit development profile overrides: %j', async ({ platform, config }) => {
  const { resolve } = fixture({ platform, config, builds: [{ ...build, platform: platform.toUpperCase() }] });
  expect(await resolve()).toMatchObject({ ok: true, cacheHit: 'remote' });
});

test.each(['ios', 'android'] as const)('resolves a physical %s development build', async (platform) => {
  const { resolve, calls } = fixture({
    physical: true,
    platform,
    builds: [{ ...build, isForIosSimulator: false, platform: platform.toUpperCase() }],
  });
  expect(await resolve()).toMatchObject({ ok: true, cacheHit: 'remote' });
  const list = calls.find((call) => call[0] === 'build:list');
  expect(list).toContain('--distribution');
  expect(list).not.toContain('--simulator');
});

test('a simulator build is not selected for an iOS device', () => {
  expect(selectEasBuild([build], { ...target, physical: true })).toBeNull();
});

test('a held claim prevents downloading or storing an artifact', async () => {
  const { resolve, calls } = fixture();
  vi.mocked(locks.acquireBuildLock).mockReturnValue({
    path: '/claim',
    held: { pid: 12, projectRoot: root, startedAt: null, logFile: null },
  });
  expect(await resolve()).toMatchObject({ ok: false, code: 'STIM_EAS_UNAVAILABLE' });
  expect(calls.map((call) => call[0])).toEqual(['config', 'fingerprint:generate', 'build:list']);
});

test('a failed device claim preserves the original device selection in its retry guidance', async () => {
  const { resolve } = fixture({ physical: true, builds: [{ ...build, isForIosSimulator: false }] });
  vi.mocked(locks.acquireBuildLock).mockImplementation(() => {
    throw new ClaimUnavailableError('identity unavailable');
  });
  const result = await resolve();
  expect(result).toMatchObject({ ok: false, code: 'STIM_CLAIM_UNAVAILABLE' });
  if (result?.ok !== false) throw new Error('Expected a refusal');
  expect(result.remedy).toContain('retry the same Stim command');
  expect(result.remedy).not.toContain('--device');
});

test.each([{ isExpo: false }, { buildSelector: 'Release' }, { buildCache: false }, { profile: '' }])(
  'refuses incompatible EAS options before side effects: %j',
  (change) => {
    expect(easOptionRefusal({ profile, isExpo: true, ...change })).toMatchObject({
      code: 'STIM_BAD_ARG',
    });
  },
);
