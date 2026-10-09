import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Command } from 'commander';
import { buildCacheKey, entryDir } from '../cache/build-cache.ts';
import { planPayload } from '../commands/build-plan.ts';
import { planIos } from '../commands/ios/next-build.ts';
import { DEFAULT_DEPS } from '../commands/ios/dependencies.ts';
import { planAndroid } from '../commands/android/next-build.ts';
import doctorCommand from '../commands/doctor.ts';
import { analyzeStimVersions } from '../diagnostics/stim-installations.ts';
import { resetExecutor, setExecutor } from '../exec.ts';
import { createProjectRegistry, type ProjectIntegration } from '../integrations/project-registry.ts';
import { projectIntegrations } from '../integrations/projects.ts';
import type { ProjectPlanResult } from '../integrations/project-plan.ts';
import { getProject } from '../workspace/config.ts';
import { nativeIosFixture } from './_native-ios-project.ts';
import { nativeAndroidFixture } from './_native-android-project.ts';
import { makeExecutor } from './_factories.ts';

let root: string;
let home: string;
let previousExitCode: typeof process.exitCode;

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'stim-project-contracts-')));
  home = join(root, 'state');
  process.env.STIM_HOME = home;
  previousExitCode = process.exitCode;
  process.exitCode = undefined;
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'native-tooling' }));
  mkdirSync(join(root, 'Native.xcodeproj'));
  writeFileSync(join(root, 'build.gradle.kts'), 'plugins { id("com.android.application") }');
  writeFileSync(join(root, 'Native.swift'), 'native source v1');
  setExecutor(makeExecutor());
});

afterEach(() => {
  resetExecutor();
  vi.restoreAllMocks();
  process.exitCode = previousExitCode;
  delete process.env.STIM_HOME;
  rmSync(root, { recursive: true, force: true });
});

async function output(action: () => Promise<void>) {
  const stdout = vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  await action();
  expect(stdout).toHaveBeenCalledTimes(1);
  return JSON.parse(String(stdout.mock.calls[0]![0]));
}

function registryWithPlan(
  platform: 'ios' | 'android',
  planner?: (options: { configuration?: string; variant?: string }) => Promise<ProjectPlanResult>,
) {
  const fixture = platform === 'ios' ? nativeIosFixture : nativeAndroidFixture;
  const provider: ProjectIntegration = {
    ...fixture,
    inspect(path) {
      const match = fixture.inspect(path);
      if (!match) return null;
      return platform === 'ios'
        ? { ...match, ios: async () => ({ ...(await match.ios!()), plan: planner }) }
        : { ...match, android: async () => ({ ...(await match.android!()), plan: planner }) };
    },
  };
  return createProjectRegistry([
    ...projectIntegrations.filter((integration) => integration.id !== 'native-xcode'),
    provider,
  ]);
}

test.each(['ios', 'android'] as const)(
  '%s plans use the integration cache identity and leave cache metadata unchanged',
  async (platform) => {
    const hash = createHash('sha256').update('native source v1').digest('hex');
    const key = buildCacheKey(
      platform,
      hash,
      platform === 'ios' ? { scheme: 'Native', configuration: 'Release' } : { variant: 'paidRelease' },
    );
    const artifact = join(entryDir(platform, key), platform === 'ios' ? 'Native.app' : 'native.apk');
    if (platform === 'ios') mkdirSync(artifact, { recursive: true });
    else {
      mkdirSync(entryDir(platform, key), { recursive: true });
      writeFileSync(artifact, 'native apk');
    }
    utimesSync(entryDir(platform, key), 1, 1);
    const before = statSync(entryDir(platform, key)).mtimeMs;
    const registry = registryWithPlan(platform, async (options) => {
      const currentHash = createHash('sha256')
        .update(readFileSync(join(root, 'Native.swift')))
        .digest('hex');
      const currentKey = buildCacheKey(
        platform,
        currentHash,
        platform === 'ios' ? { scheme: 'Native', configuration: options.configuration } : { variant: options.variant },
      );
      return planPayload(
        { root, projectKey: root, platform, slot: 'default' },
        {
          fingerprint: currentHash,
          cacheKey: currentKey,
          cacheHit: existsSync(join(entryDir(platform, currentKey), platform === 'ios' ? 'Native.app' : 'native.apk'))
            ? 'local'
            : false,
          provider: null,
          cacheSkipped: false,
          prebuild: null,
          refusal: null,
        },
      );
    });
    const invoke = () =>
      platform === 'ios'
        ? planIos(
            { json: true, configuration: 'Release' },
            { ...DEFAULT_DEPS, findProjectRoot: () => root, projectRegistry: registry },
          )
        : planAndroid({ json: true, variant: 'paidRelease' }, { findRoot: () => root, projectRegistry: registry });
    expect(await output(invoke)).toMatchObject({ cacheKey: key, cacheHit: 'local', fingerprint: hash });
    expect(statSync(entryDir(platform, key)).mtimeMs).toBe(before);
    expect(existsSync(join(home, 'config.json'))).toBe(false);
    writeFileSync(join(root, 'Native.swift'), 'native source v2');
    vi.restoreAllMocks();
    const changed = await output(invoke);
    expect(changed.cacheHit).toBe(false);
    expect(changed.cacheKey).not.toBe(key);
    expect(existsSync(join(home, 'workspaces'))).toBe(false);
  },
);

test.each(['ios', 'android'] as const)(
  '%s refuses an absent planner before any RN fallback or artifact work',
  async (platform) => {
    const registry = registryWithPlan(platform);
    const payload = await output(() =>
      platform === 'ios'
        ? planIos(
            { json: true, easProfile: 'development' },
            { ...DEFAULT_DEPS, findProjectRoot: () => root, projectRegistry: registry },
          )
        : planAndroid({ json: true, easProfile: 'development' }, { findRoot: () => root, projectRegistry: registry }),
    );
    expect(payload.code).toBe('STIM_BAD_ARG');
    expect(payload.message).toContain('does not provide a read-only build plan');
    expect(payload).not.toHaveProperty('cacheHit');
    expect(process.exitCode).toBe(1);
    expect(existsSync(home)).toBe(false);
  },
);

test('doctor combines shared findings with the selected native platform and records only that platform', async () => {
  writeFileSync(join(root, '.stim.json'), JSON.stringify({ ios: { configuration: 42 } }));
  const nativeDoctor = (platform: 'ios' | 'android'): ProjectIntegration => ({
    id: `native-${platform}`,
    inspect: () => ({
      root: 'candidate',
      application: true,
      platforms: () => [platform],
      validate: (operation) => (operation === platform ? null : undefined),
      doctor: async () => ({
        inspect: () =>
          existsSync(join(root, `${platform}.lock`))
            ? []
            : [
                {
                  level: 'cost',
                  code: `${platform}-lock`,
                  title: 'Native dependencies are unlocked',
                  detail: `Missing ${platform}.lock`,
                  fix: null,
                },
              ],
        inspectAsync: async () => [
          {
            level: 'note',
            code: `${platform}-policy`,
            title: 'Native cache policy',
            detail: 'Local compiler inputs only',
            fix: null,
          },
        ],
      }),
    }),
  });
  const registry = createProjectRegistry([
    ...projectIntegrations.filter((integration) => integration.id !== 'native-xcode'),
    nativeDoctor('ios'),
    nativeDoctor('android'),
  ]);
  const program = new Command();
  doctorCommand(program, '1.2.3', () => analyzeStimVersions('1.2.3', '/tools/stim', []), 'linux', {
    findProjectRoot: () => root,
    selectDoctor: registry.selectDoctor,
  });
  const payload = await output(async () => {
    await program.parseAsync(['node', 'stim', 'doctor', '--platform', 'ios', '--json']);
  });
  expect(payload.findings).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ title: 'A setting has the wrong type' }),
      expect.objectContaining({ code: 'ios-lock', level: 'cost' }),
      expect.objectContaining({ code: 'ios-policy' }),
    ]),
  );
  expect(
    payload.findings.some(
      (finding: { code?: string; title: string }) =>
        finding.code === 'not-an-app' ||
        finding.code?.startsWith('android-') ||
        finding.title.includes('iOS runs through EAS'),
    ),
  ).toBe(false);
  expect(getProject(root)?.doctorRuns?.ios?.version).toBe('1.2.3');
  expect(getProject(root)?.doctorRuns?.android).toBeUndefined();
  expect(process.exitCode).toBeUndefined();
});

test('ambiguous doctor admission does not load either project inspector', async () => {
  const fail = async () => {
    throw new Error('an ambiguous integration was loaded');
  };
  const providers = ['first', 'second'].map((id): ProjectIntegration => ({
    id,
    inspect: () => ({
      root: 'candidate',
      application: true,
      platforms: () => ['ios'],
      validate: (operation) => (operation === 'ios' ? null : undefined),
      doctor: fail,
    }),
  }));
  const selected = createProjectRegistry(providers).selectDoctor(root, 'ios');
  expect(selected.problem?.kind).toBe('ambiguous');
  expect(await selected.load()).toEqual([]);
  expect(selected.platforms).toEqual([]);
});
