import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Command } from 'commander';
import gcCommand from '../commands/gc.ts';
import { collectGradleVersions } from '../commands/gc/gradle-versions.ts';
import { resetExecutor, setExecutor } from '../exec.ts';
import { saveConfig, upsertProject } from '../workspace/config.ts';

vi.mock('../devices/machine-cache-usage.ts', async (original) => ({
  ...(await original<typeof import('../devices/machine-cache-usage.ts')>()),
  getMachineCacheReport: async () => null,
}));

const asRoot = process.getuid?.() === 0;
const LEFTOVER = '.stim-delete-9.0-0f8fad5b-d9cb-469f-a165-70867728950e';

let home: string;
let gradle: string;
let ps: string | Error | (() => string);

function file(path: string, at?: Date) {
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, 'x');
  if (at) utimesSync(path, at, at);
}

function wrapper(project: string, version: string) {
  const path = join(project, 'android', 'gradle', 'wrapper', 'gradle-wrapper.properties');
  file(path);
  writeFileSync(path, `distributionUrl=https\\://services.gradle.org/distributions/gradle-${version}-bin.zip\n`);
}

function pin(project: string, version: string) {
  wrapper(project, version);
  upsertProject(project, {});
}

const java = (main: string, extra = '') => `  101 /opt/jdk/bin/java ${extra} -cp /g/lib/x.jar ${main}`;

async function gc(...args: string[]) {
  const stdout: string[] = [];
  const log = vi.spyOn(console, 'log').mockImplementation((...line) => void stdout.push(line.join(' ')));
  const error = vi.spyOn(console, 'error').mockImplementation(() => {});
  try {
    const program = new Command();
    gcCommand(program);
    await program.parseAsync(['node', 'stim', 'gc', '--cache', 'gradle-versions', ...args, '--json']);
  } finally {
    log.mockRestore();
    error.mockRestore();
  }
  return JSON.parse(stdout.at(-1) ?? 'null');
}

beforeEach(() => {
  home = realpathSync.native(mkdtempSync(join(tmpdir(), 'stim-gc-gradle-')));
  gradle = join(home, 'stim', 'gradle');
  vi.stubEnv('HOME', home);
  vi.stubEnv('USERPROFILE', home);
  vi.stubEnv('STIM_HOME', join(home, 'stim'));
  vi.stubEnv('GRADLE_USER_HOME', gradle);
  saveConfig({ version: 2, projects: {}, repos: {} });
  ps = '  1 /sbin/launchd\n';
  setExecutor({
    runFileAsync: async (command: string, args: string[]) => {
      if (command === 'du') return `1024\t${args.at(-1)}\n`;
      if (command === 'ps') {
        if (ps instanceof Error) throw ps;
        return typeof ps === 'function' ? ps() : ps;
      }
      throw new Error(`unexpected ${command}`);
    },
    runFileQuietAsync: async () => null,
  });
  for (const name of ['9.3.1', '9.4.1', 'modules-2', 'build-cache-1', 'jdks', 'transforms-3'])
    file(join(gradle, 'caches', name, 'keep'));
  file(join(gradle, 'wrapper', 'dists', 'gradle-9.3.1-bin', 'abc', 'gradle-9.3.1-bin.zip'));
  file(join(gradle, 'wrapper', 'dists', 'gradle-9.4.1-all', 'abc', 'gradle-9.4.1-all.zip'));
  pin(join(home, 'app'), '9.4.1');
});

afterEach(() => {
  resetExecutor();
  vi.unstubAllEnvs();
  rmSync(home, { recursive: true, force: true });
  process.exitCode = 0;
});

const shared = () => ['modules-2', 'build-cache-1', 'jdks', 'transforms-3'].map((n) => join(gradle, 'caches', n));

test('--delete removes the cache and wrapper dists of a version no project pins and nothing shared', async () => {
  const report = await gc('--delete');
  expect(report.sections.gradleVersions).toMatchObject({ blocked: null, leftovers: [] });
  expect(report.sections.gradleVersions.versions).toEqual([
    expect.objectContaining({ version: '9.3.1', willDelete: true, reason: null, bytes: 2048 * 1024 }),
  ]);
  expect(report.results).toEqual([expect.objectContaining({ kind: 'gradleVersion', status: 'done' })]);
  expect(existsSync(join(gradle, 'caches', '9.3.1'))).toBe(false);
  expect(existsSync(join(gradle, 'wrapper', 'dists', 'gradle-9.3.1-bin'))).toBe(false);
  expect(existsSync(join(gradle, 'caches', '9.4.1', 'keep'))).toBe(true);
  expect(existsSync(join(gradle, 'wrapper', 'dists', 'gradle-9.4.1-all'))).toBe(true);
  for (const dir of shared()) expect(existsSync(join(dir, 'keep'))).toBe(true);
});

test('a dry run reports the version as actionable and deletes nothing', async () => {
  const report = await gc();
  expect(report.actionable).toBe(true);
  expect(existsSync(join(gradle, 'caches', '9.3.1'))).toBe(true);
});

test.each([
  ['a Gradle daemon', () => (ps = java('org.gradle.launcher.daemon.bootstrap.GradleDaemon 8.13')), 'gradle-running'],
  ['a Gradle wrapper', () => (ps = java('org.gradle.wrapper.GradleWrapperMain assembleDebug')), 'gradle-running'],
  ['a failed ps', () => (ps = new Error('ps failed')), 'processes-unknown'],
  ['a missing registered project', () => upsertProject(join(home, 'gone'), {}), 'unreadable-project'],
  ['no Stim config', () => rmSync(join(home, 'stim', 'config.json'), { force: true }), 'no-registry'],
  [
    'a Gradle process naming a relative home',
    () => (ps = java('org.gradle.wrapper.GradleWrapperMain', '-Dgradle.user.home=.gradle-home')),
    'gradle-running',
  ],
  [
    'a Gradle process whose home does not resolve',
    () => (ps = java('org.gradle.wrapper.GradleWrapperMain', `-Dgradle.user.home=${join(home, 'My')}`)),
    'gradle-running',
  ],
  [
    'a Gradle 9 wrapper started with -jar',
    () =>
      (ps = `  7 /opt/jdk/bin/java -Xmx64m -jar ${join(home, 'app', 'gradle', 'wrapper', 'gradle-wrapper.jar')} build`),
    'gradle-running',
  ],
  [
    'a Gradle 9 client started with -jar on a distribution',
    () => (ps = '  7 /opt/jdk/bin/java -jar /opt/gradle-9.1/lib/gradle-gradle-cli-main-9.1.jar assembleDebug'),
    'gradle-running',
  ],
  ['a Gradle launcher', () => (ps = java('org.gradle.launcher.GradleMain assembleDebug')), 'gradle-running'],
  [
    'a --no-daemon client',
    () =>
      (ps =
        '  7 /opt/jdk/bin/java -cp /opt/gradle/lib/gradle-launcher-8.13.jar org.gradle.launcher.Main --no-daemon build'),
    'gradle-running',
  ],
  [
    'a java process naming a path under the Gradle home',
    () => (ps = `  7 /opt/jdk/bin/java -cp ${join(home, 'stim', 'gradle', 'caches', 'x.jar')} KotlinCompileDaemon`),
    'gradle-running',
  ],
  [
    'a Gradle process naming a quoted home with a space',
    () => (ps = java('org.gradle.wrapper.GradleWrapperMain', `-Dgradle.user.home="${join(home, 'other')} home"`)),
    'gradle-running',
  ],
  [
    'a Gradle process naming an existing directory that is no Gradle home',
    () => {
      mkdirSync(join(home, 'plain'));
      ps = java('org.gradle.wrapper.GradleWrapperMain', `-Dgradle.user.home=${join(home, 'plain')}`);
    },
    'gradle-running',
  ],
  [
    'a Gradle process naming a Gradle home whose path holds a quote',
    () => {
      mkdirSync(join(home, 'odd"home', 'caches'), { recursive: true });
      ps = java('org.gradle.wrapper.GradleWrapperMain', `-Dgradle.user.home=${join(home, 'odd"home')}`);
    },
    'gradle-running',
  ],
  [
    'a Gradle process naming another home and then this one',
    () =>
      (ps = java(
        'org.gradle.wrapper.GradleWrapperMain',
        `-Dgradle.user.home=${join(home, 'other')} -g ${join(home, 'stim', 'gradle')}`,
      )),
    'gradle-running',
  ],
])('%s keeps every version', async (_name, arrange, reason) => {
  arrange();
  const report = await gc('--delete');
  expect(report.sections.gradleVersions.blocked).toMatchObject({ reason });
  expect(report.sections.gradleVersions.versions).toContainEqual(
    expect.objectContaining({ version: '9.3.1', willDelete: false, reason }),
  );
  expect(report.sections.gradleVersions.versions.some((entry: { willDelete: boolean }) => entry.willDelete)).toBe(
    false,
  );
  expect(existsSync(join(gradle, 'caches', '9.3.1', 'keep'))).toBe(true);
});

test('a Gradle process for another Gradle user home does not block', async () => {
  mkdirSync(join(home, 'other', 'caches'), { recursive: true });
  ps = java('org.gradle.launcher.daemon.bootstrap.GradleDaemon 9.3.1', `-Dgradle.user.home=${join(home, 'other')}`);
  await gc('--delete');
  expect(existsSync(join(gradle, 'caches', '9.3.1'))).toBe(false);
});

test('a pin written while ps runs keeps the version', async () => {
  const late = join(home, 'late');
  mkdirSync(late);
  upsertProject(late, {});
  let calls = 0;
  ps = () => {
    calls += 1;
    if (calls === 3) wrapper(late, '9.3.1');
    return '';
  };
  const report = await gc('--delete');
  expect(report.sections.gradleVersions.versions[0]).toMatchObject({ version: '9.3.1', willDelete: true });
  expect(report.results).toEqual([
    expect.objectContaining({ kind: 'gradleVersion', status: 'kept', detail: 'a registered project now pins it' }),
  ]);
  expect(existsSync(join(gradle, 'caches', '9.3.1', 'keep'))).toBe(true);
});

test('a symlinked caches directory refuses the selector', async () => {
  const elsewhere = join(home, 'elsewhere');
  mkdirSync(elsewhere);
  file(join(elsewhere, '9.3.1', 'keep'));
  rmSync(join(gradle, 'caches'), { recursive: true });
  symlinkSync(elsewhere, join(gradle, 'caches'));
  const report = await gc('--delete');
  expect(report.sections.gradleVersions.blocked).toMatchObject({ reason: 'unsafe-layout' });
  expect(existsSync(join(elsewhere, '9.3.1', 'keep'))).toBe(true);
});

test('--older-than judges age by the newest file at any depth', async () => {
  const old = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000);
  for (const path of [
    join(gradle, 'caches', '9.3.1', 'keep'),
    join(gradle, 'caches', '9.3.1'),
    join(gradle, 'wrapper', 'dists', 'gradle-9.3.1-bin', 'abc', 'gradle-9.3.1-bin.zip'),
    join(gradle, 'wrapper', 'dists', 'gradle-9.3.1-bin', 'abc'),
    join(gradle, 'wrapper', 'dists', 'gradle-9.3.1-bin'),
  ])
    utimesSync(path, old, old);
  file(join(gradle, 'caches', '9.3.1', 'a', 'b', 'c', 'd', 'e', 'fresh.bin'));
  utimesSync(join(gradle, 'caches', '9.3.1'), old, old);
  const report = await gc('--delete', '--older-than', '3');
  expect(report.sections.gradleVersions.versions[0]).toMatchObject({ reason: 'recently-modified' });
  expect(existsSync(join(gradle, 'caches', '9.3.1', 'keep'))).toBe(true);
});

test('a version with more entries than the walk bound is kept, never judged idle', async () => {
  const sweep = await collectGradleVersions({ olderThanDays: 0, maxWalkEntries: 2 });
  expect(sweep.versions[0]).toMatchObject({ version: '9.3.1', willDelete: false, reason: 'too-many-entries' });
});

test.skipIf(asRoot)('an unreadable directory inside a version keeps it', async () => {
  const locked = join(gradle, 'caches', '9.3.1', 'locked');
  mkdirSync(locked);
  chmodSync(locked, 0o000);
  try {
    const report = await gc('--delete');
    expect(report.sections.gradleVersions.versions[0]).toMatchObject({ reason: 'walk-failed' });
    expect(existsSync(join(gradle, 'caches', '9.3.1', 'keep'))).toBe(true);
  } finally {
    chmodSync(locked, 0o755);
  }
});

test('an unfinished removal is listed and finished by --delete', async () => {
  file(join(gradle, 'caches', LEFTOVER, 'blob'));
  const dry = await gc();
  expect(dry.sections.gradleVersions.leftovers).toEqual([join(gradle, 'caches', LEFTOVER)]);
  expect(dry.actionable).toBe(true);
  await gc('--delete');
  expect(existsSync(join(gradle, 'caches', LEFTOVER))).toBe(false);
});

test.skipIf(asRoot)('an unfinished removal that fails again is reported as a failure', async () => {
  file(join(gradle, 'caches', LEFTOVER, 'blob'));
  chmodSync(join(gradle, 'caches', LEFTOVER), 0o555);
  try {
    const report = await gc('--delete');
    expect(report.results).toContainEqual(
      expect.objectContaining({ kind: 'gradleVersion', status: 'failed', id: join(gradle, 'caches', LEFTOVER) }),
    );
    expect(process.exitCode).toBe(1);
  } finally {
    chmodSync(join(gradle, 'caches', LEFTOVER), 0o755);
  }
});

test('a scoped STIM_HOME never deletes a Gradle home outside it', async () => {
  vi.stubEnv('GRADLE_USER_HOME', join(home, 'outside'));
  file(join(home, 'outside', 'caches', '9.3.1', 'keep'));
  const report = await gc('--delete');
  expect(report.sections.gradleVersions.blocked).toMatchObject({ reason: 'machine-global' });
  expect(existsSync(join(home, 'outside', 'caches', '9.3.1', 'keep'))).toBe(true);
});

test('--delete --cache all leaves Gradle versions alone', async () => {
  const program = new Command();
  gcCommand(program);
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  const error = vi.spyOn(console, 'error').mockImplementation(() => {});
  try {
    await program.parseAsync(['node', 'stim', 'gc', '--cache', 'all', '--delete', '--json']);
  } finally {
    log.mockRestore();
    error.mockRestore();
  }
  expect(existsSync(join(gradle, 'caches', '9.3.1', 'keep'))).toBe(true);
});

test.each([['wrapper'], ['wrapper', 'dists']])('a symlinked %s refuses the selector', async (...segments) => {
  const target = join(home, 'elsewhere');
  mkdirSync(target, { recursive: true });
  const link = join(gradle, ...segments);
  rmSync(link, { recursive: true });
  symlinkSync(target, link);
  const report = await gc('--delete');
  expect(report.sections.gradleVersions.blocked).toMatchObject({ reason: 'unsafe-layout' });
  expect(existsSync(join(gradle, 'caches', '9.3.1', 'keep'))).toBe(true);
});

const caseInsensitive = (() => {
  const probe = mkdtempSync(join(tmpdir(), 'stim-case-'));
  try {
    return existsSync(probe.toUpperCase()) || existsSync(probe.replace(/stim-case-/, 'STIM-CASE-'));
  } finally {
    rmSync(probe, { recursive: true, force: true });
  }
})();

test.skipIf(!caseInsensitive)('a Gradle directory whose real path differs refuses the selector', async () => {
  rmSync(join(gradle, 'caches'), { recursive: true });
  file(join(gradle, 'Caches', '9.3.1', 'keep'));
  const report = await gc('--delete');
  expect(report.sections.gradleVersions.blocked).toMatchObject({ reason: 'unsafe-layout' });
  expect(existsSync(join(gradle, 'Caches', '9.3.1', 'keep'))).toBe(true);
});

test.skipIf(asRoot)('a Gradle directory that cannot be listed refuses the selector', async () => {
  chmodSync(join(gradle, 'wrapper', 'dists'), 0o000);
  try {
    const report = await gc('--delete');
    expect(report.sections.gradleVersions.blocked).toMatchObject({ reason: 'listing-failed' });
    expect(existsSync(join(gradle, 'caches', '9.3.1', 'keep'))).toBe(true);
  } finally {
    chmodSync(join(gradle, 'wrapper', 'dists'), 0o755);
  }
});

test('a symlinked version directory is never followed or removed', async () => {
  const target = join(home, 'elsewhere', '9.2');
  file(join(target, 'keep'));
  symlinkSync(target, join(gradle, 'caches', '9.2'));
  await gc('--delete');
  expect(existsSync(join(target, 'keep'))).toBe(true);
  expect(existsSync(join(gradle, 'caches', '9.2'))).toBe(true);
});

test('a daemon that appears on the last check before the rename keeps the version', async () => {
  let calls = 0;
  ps = () => {
    calls += 1;
    return calls === 3 ? java('org.gradle.launcher.daemon.bootstrap.GradleDaemon 9.3.1') : '';
  };
  const report = await gc('--delete');
  expect(report.results).toEqual([
    expect.objectContaining({ kind: 'gradleVersion', status: 'kept', detail: expect.stringContaining('Gradle pid') }),
  ]);
  expect(existsSync(join(gradle, 'caches', '9.3.1', 'keep'))).toBe(true);
});

test.skipIf(asRoot)('a version is renamed to a .stim-delete sibling before its contents are removed', async () => {
  const version = join(gradle, 'caches', '9.3.1');
  chmodSync(version, 0o555);
  const report = await gc('--delete');
  const staged = readdirSync(join(gradle, 'caches')).filter((name) => name.startsWith('.stim-delete-9.3.1-'));
  try {
    expect(existsSync(version)).toBe(false);
    expect(staged).toHaveLength(1);
    expect(existsSync(join(gradle, 'caches', staged[0] ?? '', 'keep'))).toBe(true);
    expect(report.results).toContainEqual(expect.objectContaining({ kind: 'gradleVersion', status: 'failed' }));
  } finally {
    for (const name of staged) chmodSync(join(gradle, 'caches', name), 0o755);
  }
});

test.each([
  ['a missing registered project', () => upsertProject(join(home, 'gone'), {}), 'unreadable-project'],
  ['a failed ps', () => (ps = new Error('ps failed')), 'processes-unknown'],
  [
    'an unsafe layout',
    () => {
      rmSync(join(gradle, 'wrapper'), { recursive: true });
      symlinkSync(home, join(gradle, 'wrapper'));
    },
    'unsafe-layout',
  ],
])('looking past running Gradle still keeps %s blocking', async (_name, arrange, reason) => {
  ps = java('org.gradle.launcher.daemon.bootstrap.GradleDaemon 9.4.1');
  arrange();
  const sweep = await collectGradleVersions({ pastRunningGradle: true });
  expect(sweep.blocked).toMatchObject({ reason });
  expect(sweep.versions.some((entry) => entry.willDelete)).toBe(false);
});

test('looking past running Gradle reports the blocking pids and judges versions as if it had stopped', async () => {
  ps = java('org.gradle.launcher.daemon.bootstrap.GradleDaemon 9.4.1');
  const sweep = await collectGradleVersions({ pastRunningGradle: true });
  expect(sweep).toMatchObject({ blocked: null, gradleRunningPids: [101] });
  expect(sweep.versions).toEqual([expect.objectContaining({ version: '9.3.1', willDelete: true })]);
});
