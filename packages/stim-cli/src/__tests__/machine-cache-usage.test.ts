import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { machineCacheUsageFile, readMachineCacheUsage, type AgentDeviceUsage } from '@stim-cli/core/state';
import { getMachineCacheReport } from '../devices/machine-cache-usage.ts';
import { machineCacheLines } from '../devices/machine-cache-usage-output.ts';
import { resetExecutor, setExecutor } from '../exec.ts';
import { saveConfig, upsertProject } from '../workspace/config.ts';

const UNUSED_RUNTIME = '88E8478B-6BAD-4120-A046-0F9F9221E17A';
const USED_RUNTIME = '244912DF-0671-4197-9C70-85AF161BF600';
const BUNDLED_RUNTIME = '11111111-2222-3333-4444-555555555555';

const runtimeList = JSON.stringify({
  [UNUSED_RUNTIME]: {
    identifier: UNUSED_RUNTIME,
    platformIdentifier: 'com.apple.platform.iphonesimulator',
    runtimeIdentifier: 'com.apple.CoreSimulator.SimRuntime.iOS-27-1',
    version: '27.1',
    build: '24A94401',
    sizeBytes: 7_873_719_649,
    deletable: true,
    lastUsedAt: '2026-10-09T00:49:33Z',
  },
  [USED_RUNTIME]: {
    identifier: USED_RUNTIME,
    platformIdentifier: 'com.apple.platform.iphonesimulator',
    runtimeIdentifier: 'com.apple.CoreSimulator.SimRuntime.iOS-27-0',
    version: '27.0',
    build: '24A434',
    sizeBytes: 8_067_000_161,
    deletable: true,
    lastUsedAt: '2026-10-14T08:08:50Z',
  },
  [BUNDLED_RUNTIME]: {
    identifier: BUNDLED_RUNTIME,
    platformIdentifier: 'com.apple.platform.iphonesimulator',
    runtimeIdentifier: 'com.apple.CoreSimulator.SimRuntime.iOS-18-6',
    version: '18.6',
    build: '22G1',
    sizeBytes: 100,
    deletable: false,
    lastUsedAt: null,
  },
});

const deviceList = JSON.stringify({
  devices: {
    'com.apple.CoreSimulator.SimRuntime.iOS-27-0': ['A', 'B'].map((udid) => ({
      udid,
      name: `iPhone ${udid}`,
      state: 'Shutdown',
      deviceTypeIdentifier: 'com.apple.CoreSimulator.SimDeviceType.iPhone-17',
      isAvailable: false,
    })),
    'com.apple.CoreSimulator.SimRuntime.iOS-27-1': [],
  },
});

let home: string;
let gradle: string;
let platform: NodeJS.Platform;
let calls: string[][];
let tools: Record<string, string | Error>;
let gitTop: string | null;

function writeDirs(...dirs: string[]) {
  for (const dir of dirs) {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'keep'), dir);
  }
}

function wrapper(project: string, version: string) {
  const dir = join(project, 'android', 'gradle', 'wrapper');
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, 'gradle-wrapper.properties'),
    `distributionBase=GRADLE_USER_HOME\ndistributionUrl=https\\://services.gradle.org/distributions/gradle-${version}-all.zip\n`,
  );
}

type RunnerEntry = AgentDeviceUsage['runnerBuilds']['platforms'][number]['entries'][number];

function runner(
  packageVersion: string | null,
  xcodeBuildVersion: string | null,
  lastUsedAt: string,
  inUse = false,
): RunnerEntry {
  return {
    name: `cache-${packageVersion}-${xcodeBuildVersion}-${lastUsedAt}`,
    dir: join(home, '.agent-device', lastUsedAt),
    bytes: 1024,
    lastUsedAt,
    packageVersion,
    xcodeBuildVersion,
    inUse,
    inUseReason: inUse ? 'lease' : null,
  };
}

function agentDevice(entries: RunnerEntry[]): AgentDeviceUsage {
  const state = join(home, '.agent-device');
  return {
    version: 1,
    measuredAt: new Date().toISOString(),
    bytes: 0,
    complete: true,
    stateDir: {
      dir: state,
      present: false,
      bytes: 0,
      sessions: { dir: join(state, 'sessions'), bytes: 0, count: 0 },
      logs: { dir: join(state, 'logs'), bytes: 0 },
      other: { bytes: 0, largest: [] },
    },
    runnerBuilds: {
      dir: state,
      present: true,
      bytes: null,
      sharedBytes: null,
      platforms: [{ platform: 'ios-simulator', dir: state, bytes: null, entries }],
    },
    workspaces: [],
    hosted: null,
  };
}

/** unique-pid loads its native addon for process.platform, so fake darwin only after setup that takes claims. */
function asDarwin() {
  Object.defineProperty(process, 'platform', { value: 'darwin' });
}

beforeEach(() => {
  home = realpathSync.native(mkdtempSync(join(tmpdir(), 'stim-machine-caches-')));
  gradle = join(home, '.gradle');
  vi.stubEnv('HOME', home);
  vi.stubEnv('USERPROFILE', home);
  vi.stubEnv('STIM_HOME', join(home, 'stim'));
  vi.stubEnv('GRADLE_USER_HOME', '');
  platform = process.platform;
  saveConfig({ version: 2, projects: {}, repos: {} });
  calls = [];
  gitTop = null;
  tools = {
    'xcrun simctl runtime list -j': runtimeList,
    'xcrun simctl list devices --json': deviceList,
    'xcodebuild -version': 'Xcode 27.0\nBuild version 27A266a\n',
    'agent-device --version': '0.21.22\n',
  };
  setExecutor({
    runFileAsync: async (file: string, args: string[]) => {
      if (file === 'git') {
        if (gitTop && args.includes('--show-toplevel')) return `${gitTop}\n`;
        throw new Error('not a git repository');
      }
      calls.push([file, ...args]);
      if (file === 'du') return `2048\t${args.at(-1)}\n`;
      const result = tools[[file, ...args].join(' ')];
      if (result === undefined || result instanceof Error) throw result ?? new Error('unexpected');
      return result;
    },
    runFileQuietAsync: async () => null,
  });
});

afterEach(() => {
  Object.defineProperty(process, 'platform', { value: platform });
  resetExecutor();
  vi.unstubAllEnvs();
  rmSync(home, { recursive: true, force: true });
});

test('reports Gradle versions no registered project pins, with each dir, size and remedy, and deletes nothing', async () => {
  const caches = join(gradle, 'caches');
  const dists = join(gradle, 'wrapper', 'dists');
  writeDirs(
    join(caches, '9.4.1'),
    join(caches, '9.3.1'),
    join(caches, 'modules-2'),
    join(caches, 'build-cache-1'),
    join(caches, 'transforms-3'),
    join(dists, 'gradle-9.4.1-all'),
    join(dists, 'gradle-9.3.1-bin'),
    join(dists, 'gradle-7.5.1-all'),
  );
  const project = join(home, 'app');
  wrapper(project, '9.4.1');
  upsertProject(project, {});
  upsertProject(join(home, 'gone'), {});

  const report = await getMachineCacheReport(null);

  expect(report.gradle.usedVersions).toEqual([{ version: '9.4.1', projects: [project] }]);
  expect(report.gradle.unreadableProjects).toEqual([join(home, 'gone')]);
  expect(report.gradle.unusedVersions.map((entry) => entry.version).toSorted()).toEqual(['7.5.1', '9.3.1']);
  expect(report.gradle.unusedVersions.find((entry) => entry.version === '9.3.1')).toEqual({
    version: '9.3.1',
    bytes: 4096 * 1024,
    dirs: [
      { dir: join(caches, '9.3.1'), bytes: 2048 * 1024 },
      { dir: join(dists, 'gradle-9.3.1-bin'), bytes: 2048 * 1024 },
    ],
    remedy: null,
  });
  expect(report.gradle.modules).toMatchObject({ dir: join(caches, 'modules-2'), bytes: 2048 * 1024 });
  const measured = calls.filter(([file]) => file === 'du').map((call) => call.at(-1));
  expect(measured).not.toContain(join(caches, '9.4.1'));
  expect(measured).not.toContain(join(caches, 'build-cache-1'));

  const text = machineCacheLines(report).join('\n');
  expect(text).toContain('Gradle versions no registered project pins');
  expect(text).toContain('may still be in use');
  expect(text).toContain('never deletes them');
  expect(readFileSync(join(caches, '9.3.1', 'keep'), 'utf8')).toBe(join(caches, '9.3.1'));
});

test('offers simctl runtime delete only for a deletable runtime no simulator uses, unavailable ones included', async () => {
  asDarwin();
  const report = await getMachineCacheReport(null);
  const remedies = Object.fromEntries(report.simRuntimes.runtimes.map((entry) => [entry.identifier, entry.remedy]));
  expect(report.simRuntimes.checked).toBe(true);
  expect(remedies).toEqual({
    [UNUSED_RUNTIME]: `xcrun simctl runtime delete ${UNUSED_RUNTIME}`,
    [USED_RUNTIME]: null,
    [BUNDLED_RUNTIME]: null,
  });
  expect(report.simRuntimes.runtimes.find((entry) => entry.identifier === USED_RUNTIME)?.devices).toBe(2);
  expect(calls.some(([file, sub, op]) => file === 'xcrun' && sub === 'simctl' && op === 'delete')).toBe(false);
});

test('a simctl failure leaves runtimes unchecked instead of reporting them unused', async () => {
  asDarwin();
  tools['xcrun simctl list devices --json'] = Object.assign(new Error('timed out'), { code: 'ETIMEDOUT' });
  const report = await getMachineCacheReport(null);
  expect(report.simRuntimes).toEqual({ checked: false, runtimes: [] });
  expect(report.complete).toBe(false);
  expect(machineCacheLines(report).join('\n')).toContain('not checked');
});

test('lists each Xcode device support entry with its size', async () => {
  asDarwin();
  const support = join(home, 'Library', 'Developer', 'Xcode', 'iOS DeviceSupport');
  writeDirs(join(support, 'iPhone13,3 18.7.8 (22H352)'), join(home, 'Library', 'Developer', 'Xcode', 'DerivedData'));
  const report = await getMachineCacheReport(null);
  expect(report.deviceSupport.entries).toEqual([
    { dir: join(support, 'iPhone13,3 18.7.8 (22H352)'), bytes: 2048 * 1024 },
  ]);
});

test('groups agent-device runner builds by agent-device and Xcode version against the installed ones', async () => {
  asDarwin();
  const report = await getMachineCacheReport(
    agentDevice([
      runner('0.21.22', '27A266a', '2026-10-14T00:00:00.000Z', true),
      runner('0.20.10', '17F113', '2026-09-01T00:00:00.000Z'),
      runner('0.20.10', '17F113', '2026-08-29T00:00:00.000Z'),
      runner(null, null, '2026-09-24T00:00:00.000Z'),
    ]),
  );
  expect(report.runnerBuilds).toMatchObject({ agentDeviceVersion: '0.21.22', xcodeBuildVersion: '27A266a' });
  expect(report.runnerBuilds.groups).toEqual([
    {
      packageVersion: '0.20.10',
      xcodeBuildVersion: '17F113',
      current: false,
      entries: 2,
      inUse: 0,
      bytes: 2048,
      oldestUseAt: '2026-08-29T00:00:00.000Z',
    },
    expect.objectContaining({ packageVersion: null, current: null }),
    expect.objectContaining({ packageVersion: '0.21.22', current: true, inUse: 1 }),
  ]);
});

test('reuses a measurement for ten minutes and measures again when the measured dirs change', async () => {
  const caches = join(gradle, 'caches');
  writeDirs(join(caches, '9.3.1'));
  await getMachineCacheReport(null);
  const first = calls.length;
  await getMachineCacheReport(null);
  expect(calls).toHaveLength(first);

  const project = join(home, 'app');
  wrapper(project, '9.3.1');
  upsertProject(project, {});
  const report = await getMachineCacheReport(null);
  expect(calls.length).toBeGreaterThan(first);
  expect(report.gradle.unusedVersions).toEqual([]);

  const count = calls.length;
  writeFileSync(
    machineCacheUsageFile(),
    JSON.stringify({ ...readMachineCacheUsage(), measuredAt: new Date(Date.now() - 600_000).toISOString() }),
  );
  await getMachineCacheReport(null);
  expect(calls.length).toBeGreaterThan(count);

  const before = calls.length;
  writeFileSync(machineCacheUsageFile(), JSON.stringify({ version: 1, measuredAt: 'not a date' }));
  await getMachineCacheReport(null);
  expect(calls.length).toBeGreaterThan(before);
  expect(readMachineCacheUsage()?.version).toBe(1);
});

test('quotes remedy paths so a pasted command expands nothing', async () => {
  const odd = join(home, "gr$(touch pwned)'x`id`");
  vi.stubEnv('GRADLE_USER_HOME', odd);
  writeDirs(join(odd, 'caches', 'modules-2'));
  const report = await getMachineCacheReport(null);
  expect(report.gradle.modules?.remedy).toContain(
    `rm -rf '${join(home, 'gr$(touch pwned)')}'\\''${join('x`id`', 'caches', 'modules-2')}'`,
  );
});

const posixModes = process.getuid?.() !== 0 && process.platform !== 'win32';

test.skipIf(!posixModes)('an unreadable wrapper is reported like an unreadable project, never as no pin', async () => {
  writeDirs(join(gradle, 'caches', '9.3.1'));
  const project = join(home, 'app');
  wrapper(project, '9.3.1');
  const file = join(project, 'android', 'gradle', 'wrapper', 'gradle-wrapper.properties');
  chmodSync(file, 0o000);
  upsertProject(project, {});
  try {
    const report = await getMachineCacheReport(null);
    expect(report.gradle.unreadableProjects).toEqual([project]);
    expect(machineCacheLines(report).join('\n')).toContain('missing or unreadable');
  } finally {
    chmodSync(file, 0o644);
  }
});

test.skipIf(!posixModes)('a Gradle dir that cannot be listed marks the report incomplete with a notice', async () => {
  const caches = join(gradle, 'caches');
  writeDirs(join(caches, '9.3.1'));
  chmodSync(caches, 0o000);
  try {
    const report = await getMachineCacheReport(null);
    expect(report.complete).toBe(false);
    expect(report.notices).toEqual([expect.stringContaining(`${caches} not listed`)]);
    expect(machineCacheLines(report).join('\n')).toContain(`${caches} not listed`);
  } finally {
    chmodSync(caches, 0o755);
  }
});

test('off macOS no simulator line appears, since simctl is never asked', async () => {
  Object.defineProperty(process, 'platform', { value: 'linux' });
  const report = await getMachineCacheReport(null);
  expect(report.simRuntimes).toEqual({ checked: true, runtimes: [] });
  expect(report.complete).toBe(true);
  expect(calls.some(([file]) => file === 'xcrun')).toBe(false);
  expect(machineCacheLines(report)).toEqual([]);
});

test('a project pins the wrapper under its android.gradleRoot setting', async () => {
  writeDirs(join(gradle, 'caches', '9.3.1'), join(gradle, 'caches', '9.2'));
  const project = join(home, 'rn');
  const native = join(project, 'native');
  mkdirSync(join(native, 'app'), { recursive: true });
  writeFileSync(join(native, 'settings.gradle'), '');
  writeFileSync(join(native, 'app', 'build.gradle'), '');
  mkdirSync(join(native, 'gradle', 'wrapper'), { recursive: true });
  writeFileSync(
    join(native, 'gradle', 'wrapper', 'gradle-wrapper.properties'),
    'distributionUrl=https\\://services.gradle.org/distributions/gradle-9.3.1-bin.zip\n',
  );
  writeFileSync(join(project, '.stim.json'), JSON.stringify({ android: { gradleRoot: 'native' } }));
  upsertProject(project, {});
  const report = await getMachineCacheReport(null);
  expect(report.gradle.usedVersions).toEqual([{ version: '9.3.1', projects: [project] }]);
  expect(report.gradle.unusedVersions.map((entry) => entry.version)).toEqual(['9.2']);
});

test.each([
  ['an android.gradleRoot that cannot be resolved', { android: { gradleRoot: 'missing' } }, null],
  [
    'a wrapper whose distributionUrl names no Gradle version',
    {},
    'distributionUrl=https\\://mirror.example/gradle.zip?v=1\n',
  ],
])('%s makes the project unreadable', async (_name, settings, properties) => {
  const project = join(home, 'app');
  mkdirSync(project, { recursive: true });
  writeFileSync(join(project, '.stim.json'), JSON.stringify(settings));
  if (properties) {
    wrapper(project, '9.3.1');
    writeFileSync(join(project, 'android', 'gradle', 'wrapper', 'gradle-wrapper.properties'), properties);
  }
  upsertProject(project, {});
  const report = await getMachineCacheReport(null);
  expect(report.gradle.unreadableProjects).toEqual([project]);
});

function gradleProject(root: string, version: string) {
  mkdirSync(join(root, 'app'), { recursive: true });
  writeFileSync(join(root, 'settings.gradle'), '');
  writeFileSync(join(root, 'app', 'build.gradle'), '');
  mkdirSync(join(root, 'gradle', 'wrapper'), { recursive: true });
  writeFileSync(
    join(root, 'gradle', 'wrapper', 'gradle-wrapper.properties'),
    `distributionUrl=https\\://services.gradle.org/distributions/gradle-${version}-bin.zip\n`,
  );
}

test('a monorepo android.gradleRoot resolves against the repository root', async () => {
  const repo = join(home, 'repo');
  const app = join(repo, 'apps', 'mobile');
  mkdirSync(app, { recursive: true });
  gradleProject(join(repo, 'android'), '8.10');
  writeFileSync(join(app, '.stim.json'), JSON.stringify({ android: { gradleRoot: '../../android' } }));
  upsertProject(app, {});
  gitTop = repo;
  const report = await getMachineCacheReport(null);
  expect(report.gradle.usedVersions).toEqual([{ version: '8.10', projects: [app] }]);
  expect(report.gradle.unreadableProjects).toEqual([]);
});

const spoilers: [string, (file: string) => void][] = [
  ['names no version', (file) => writeFileSync(file, 'distributionBase=GRADLE_USER_HOME\n')],
];
if (posixModes) spoilers.push(['cannot be read', (file) => chmodSync(file, 0o000)]);

test.each(spoilers)('a version one wrapper pins stays used when the other wrapper %s', async (_name, spoil) => {
  const project = join(home, 'app');
  gradleProject(project, '8.10');
  wrapper(project, '9.3.1');
  const other = join(project, 'android', 'gradle', 'wrapper', 'gradle-wrapper.properties');
  spoil(other);
  upsertProject(project, {});
  try {
    const report = await getMachineCacheReport(null);
    expect(report.gradle.usedVersions).toEqual([{ version: '8.10', projects: [project] }]);
    expect(report.gradle.unreadableProjects).toEqual([project]);
  } finally {
    chmodSync(other, 0o644);
  }
});

test('the project root wrapper still pins when the Android settings cannot be resolved', async () => {
  const project = join(home, 'app');
  gradleProject(project, '8.10');
  writeFileSync(join(project, '.stim.json'), JSON.stringify({ android: { gradleRoot: 'missing' } }));
  upsertProject(project, {});
  const report = await getMachineCacheReport(null);
  expect(report.gradle.usedVersions).toEqual([{ version: '8.10', projects: [project] }]);
  expect(report.gradle.unreadableProjects).toEqual([project]);
});

test('the gc remedy appears only when gc may act on the Gradle home', async () => {
  const inside = join(home, 'stim', 'gradle');
  vi.stubEnv('GRADLE_USER_HOME', inside);
  writeDirs(join(inside, 'caches', '9.3.1'));
  const report = await getMachineCacheReport(null);
  expect(report.gradle.unusedVersions[0]?.remedy).toBe('stim gc --delete --cache gradle-versions');
});
