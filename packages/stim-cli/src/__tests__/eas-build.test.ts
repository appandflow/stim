import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { vi } from 'vitest';
import { planEasDevelopmentBuild, resolveEasDevelopmentBuild } from '../engine/eas-build.ts';
import * as locks from '../engine/build-lock.ts';
import { resetExecutor, setExecutor } from '../exec.ts';
import { ClaimUnavailableError } from '../ownership-claim.ts';

const fingerprint = 'a'.repeat(40);
const projectId = 'project-1';
const profile = 'development';
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
])('does not select an incompatible EAS artifact: %j', async (change) => {
  const { plan } = planFixture([{ ...build, ...change }]);
  expect(await plan).toMatchObject({ buildId: null, missing: { code: 'STIM_EAS_BUILD_MISSING' } });
});

test.each([['eas-cli/18.8.0 darwin-arm64 node-v22.22.2', 'eas-cli 18.8.0 (/eas) cannot download a build by ID']])(
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

test.each(['config'])('a failed %s is not a cache miss and does not expose command output', async (failCommand) => {
  const result = await fixture({ failCommand }).resolve();
  expect(result).toMatchObject({ ok: false, code: 'STIM_EAS_UNAVAILABLE' });
  expect(JSON.stringify(result)).not.toContain('private environment value');
});

test.each([{ developmentClient: false }, { distribution: 'store' }, { simulator: false }])(
  'rejects a profile that cannot produce simulator development builds: %j',
  async (config) => {
    const { resolve, calls } = fixture({ config });
    expect(await resolve()).toMatchObject({ ok: false, code: 'STIM_BAD_ARG' });
    expect(calls.map((call) => call[0])).toEqual(['config']);
  },
);

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

function planFixture(builds: unknown[]) {
  const { calls } = fixture({ builds });
  const plan = planEasDevelopmentBuild({
    root,
    platform: 'ios',
    profile,
    note: () => {},
    readEasCliVersion: () => 'eas-cli/24.8.0 darwin-arm64 node-v22.22.2',
  });
  return { calls, plan };
}

test('a plan finds the EAS build without downloading it or taking a claim', async () => {
  const { calls, plan } = planFixture([build]);
  expect(await plan).toEqual({
    ok: true,
    fingerprint,
    buildId: 'build-1',
    cacheKey: expect.stringMatching(/^eas-[a-f0-9]{64}-debug-sim$/),
    missing: null,
  });
  expect(calls.map((args) => args[0])).toEqual(['config', 'fingerprint:generate', 'build:list']);
  expect(locks.acquireBuildLock).not.toHaveBeenCalled();
});

test('a plan reports an EAS miss as the refusal the run would print', async () => {
  const { plan } = planFixture([]);
  expect(await plan).toEqual({
    ok: true,
    fingerprint,
    buildId: null,
    cacheKey: null,
    missing: expect.objectContaining({ code: 'STIM_EAS_BUILD_MISSING' }),
  });
});
