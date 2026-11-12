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
import { withAmbientContext, type StimContext } from '@stim-cli/core';
import { collectGradleVersions, deleteGradleVersion } from '../commands/gc/gradle-versions.ts';
import { resetExecutor, setExecutor } from '../exec.ts';
import { saveConfig, upsertProject } from '../workspace/config.ts';

const posixModes = process.getuid?.() !== 0 && process.platform !== 'win32';

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

const plan = () => collectGradleVersions({ pastRunningGradle: true, measure: false });

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

test('deletion removes the cache and wrapper dists of a version no project pins and nothing shared', async () => {
  const sweep = await plan();
  expect(sweep.blocked).toBeNull();
  expect(sweep.versions).toEqual([expect.objectContaining({ version: '9.3.1', willDelete: true, reason: null })]);
  expect(await deleteGradleVersion('9.3.1')).toMatchObject({ deleted: true });
  expect(await deleteGradleVersion('9.4.1')).toEqual({ deleted: false, detail: 'a registered project pins it' });
  expect(existsSync(join(gradle, 'caches', '9.3.1'))).toBe(false);
  expect(existsSync(join(gradle, 'wrapper', 'dists', 'gradle-9.3.1-bin'))).toBe(false);
  expect(existsSync(join(gradle, 'caches', '9.4.1', 'keep'))).toBe(true);
  expect(existsSync(join(gradle, 'wrapper', 'dists', 'gradle-9.4.1-all'))).toBe(true);
  for (const dir of shared()) expect(existsSync(join(dir, 'keep'))).toBe(true);
});

test('the planner reads the Gradle home of the operation it runs for, not the process default', async () => {
  const operation: StimContext = {
    home: join(home, 'stim'),
    projectRoot: home,
    cwd: home,
    buildCache: null,
    runId: 'gradle-home',
    env: { ...process.env },
    signal: new AbortController().signal,
    output: () => {},
  };
  const otherGradle = join(home, 'stim', 'other-gradle');
  file(join(otherGradle, 'caches', '9.3.1', 'keep'));
  vi.stubEnv('GRADLE_USER_HOME', otherGradle);
  const sweep = await withAmbientContext(operation, () =>
    collectGradleVersions({ operation, pastRunningGradle: true, measure: false }),
  );
  expect(sweep.home).toBe(gradle);
  expect(sweep.versions).toEqual([
    expect.objectContaining({ version: '9.3.1', dirs: expect.arrayContaining([join(gradle, 'caches', '9.3.1')]) }),
  ]);
});

const quotedHome: [string, () => void, string][] =
  process.platform === 'win32'
    ? []
    : [
        [
          'a Gradle process naming a Gradle home whose path holds a quote',
          () => {
            mkdirSync(join(home, 'odd"home', 'caches'), { recursive: true });
            ps = java('org.gradle.wrapper.GradleWrapperMain', `-Dgradle.user.home=${join(home, 'odd"home')}`);
          },
          'Gradle pid',
        ],
      ];

test.each([
  ['a Gradle daemon', () => (ps = java('org.gradle.launcher.daemon.bootstrap.GradleDaemon 8.13')), 'Gradle pid'],
  ['a Gradle wrapper', () => (ps = java('org.gradle.wrapper.GradleWrapperMain assembleDebug')), 'Gradle pid'],
  ['a failed ps', () => (ps = new Error('ps failed')), 'ps failed'],
  ['a missing registered project', () => upsertProject(join(home, 'gone'), {}), 'could not be read'],
  ['no Stim config', () => rmSync(join(home, 'stim', 'config.json'), { force: true }), 'no Stim config'],
  [
    'a Gradle process naming a relative home',
    () => (ps = java('org.gradle.wrapper.GradleWrapperMain', '-Dgradle.user.home=.gradle-home')),
    'Gradle pid',
  ],
  [
    'a Gradle process whose home does not resolve',
    () => (ps = java('org.gradle.wrapper.GradleWrapperMain', `-Dgradle.user.home=${join(home, 'My')}`)),
    'Gradle pid',
  ],
  [
    'a Gradle 9 wrapper started with -jar',
    () => (ps = '  7 /opt/jdk/bin/java -Xmx64m -jar /work/app/gradle/wrapper/gradle-wrapper.jar build'),
    'Gradle pid',
  ],
  [
    'a Gradle 9 client started with -jar on a distribution',
    () => (ps = '  7 /opt/jdk/bin/java -jar /opt/gradle-9.1/lib/gradle-gradle-cli-main-9.1.jar assembleDebug'),
    'Gradle pid',
  ],
  ['a Gradle launcher', () => (ps = java('org.gradle.launcher.GradleMain assembleDebug')), 'Gradle pid'],
  [
    'a --no-daemon client',
    () =>
      (ps =
        '  7 /opt/jdk/bin/java -cp /opt/gradle/lib/gradle-launcher-8.13.jar org.gradle.launcher.Main --no-daemon build'),
    'Gradle pid',
  ],
  [
    'a java process naming a path under the Gradle home',
    () => (ps = `  7 /opt/jdk/bin/java -cp ${join(home, 'stim', 'gradle', 'caches', 'x.jar')} KotlinCompileDaemon`),
    'Gradle pid',
  ],
  [
    'a Gradle process naming a quoted home with a space',
    () => (ps = java('org.gradle.wrapper.GradleWrapperMain', `-Dgradle.user.home="${join(home, 'other')} home"`)),
    'Gradle pid',
  ],
  [
    'a Gradle process naming an existing directory that is no Gradle home',
    () => {
      mkdirSync(join(home, 'plain'));
      ps = java('org.gradle.wrapper.GradleWrapperMain', `-Dgradle.user.home=${join(home, 'plain')}`);
    },
    'Gradle pid',
  ],
  ...quotedHome,
  [
    'a Gradle process naming another home and then this one',
    () =>
      (ps = java(
        'org.gradle.wrapper.GradleWrapperMain',
        `-Dgradle.user.home=${join(home, 'other')} -g ${join(home, 'stim', 'gradle')}`,
      )),
    'Gradle pid',
  ],
])('%s keeps every version', async (_name, arrange, detail) => {
  arrange();
  const result = await deleteGradleVersion('9.3.1');
  expect(result).toMatchObject({ deleted: false, detail: expect.stringContaining(detail) });
  expect(existsSync(join(gradle, 'caches', '9.3.1', 'keep'))).toBe(true);
});

test('a Gradle process for another Gradle user home does not block', async () => {
  mkdirSync(join(home, 'other', 'caches'), { recursive: true });
  ps = java('org.gradle.launcher.daemon.bootstrap.GradleDaemon 9.3.1', `-Dgradle.user.home=${join(home, 'other')}`);
  expect(await deleteGradleVersion('9.3.1')).toMatchObject({ deleted: true });
  expect(existsSync(join(gradle, 'caches', '9.3.1'))).toBe(false);
});

test('a pin written while ps runs keeps the version', async () => {
  const late = join(home, 'late');
  mkdirSync(late);
  upsertProject(late, {});
  let calls = 0;
  ps = () => {
    calls += 1;
    if (calls === 2) wrapper(late, '9.3.1');
    return '';
  };
  expect(await deleteGradleVersion('9.3.1')).toEqual({ deleted: false, detail: 'a registered project now pins it' });
  expect(existsSync(join(gradle, 'caches', '9.3.1', 'keep'))).toBe(true);
});

test('a symlinked caches directory keeps every version', async () => {
  const elsewhere = join(home, 'elsewhere');
  mkdirSync(elsewhere);
  file(join(elsewhere, '9.3.1', 'keep'));
  rmSync(join(gradle, 'caches'), { recursive: true });
  symlinkSync(elsewhere, join(gradle, 'caches'));
  expect((await plan()).blocked).toMatchObject({ reason: 'unsafe-layout' });
  expect(await deleteGradleVersion('9.3.1')).toMatchObject({ deleted: false });
  expect(existsSync(join(elsewhere, '9.3.1', 'keep'))).toBe(true);
});

test('the idle age is judged by the newest file at any depth', async () => {
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
  expect(await deleteGradleVersion('9.3.1', { olderThanDays: 3 })).toMatchObject({
    deleted: false,
    detail: expect.stringContaining('modified within'),
  });
  expect(existsSync(join(gradle, 'caches', '9.3.1', 'keep'))).toBe(true);
});

test('a version with more entries than the walk bound is kept, never judged idle', async () => {
  const sweep = await collectGradleVersions({ olderThanDays: 0, maxWalkEntries: 2 });
  expect(sweep.versions[0]).toMatchObject({ version: '9.3.1', willDelete: false, reason: 'too-many-entries' });
});

test.skipIf(!posixModes)('an unreadable directory inside a version keeps it', async () => {
  const locked = join(gradle, 'caches', '9.3.1', 'locked');
  mkdirSync(locked);
  chmodSync(locked, 0o000);
  try {
    expect(await deleteGradleVersion('9.3.1')).toMatchObject({
      deleted: false,
      detail: expect.stringContaining('could not all be read'),
    });
    expect(existsSync(join(gradle, 'caches', '9.3.1', 'keep'))).toBe(true);
  } finally {
    chmodSync(locked, 0o755);
  }
});

test('a scoped STIM_HOME never deletes a Gradle home outside it', async () => {
  vi.stubEnv('GRADLE_USER_HOME', join(home, 'outside'));
  file(join(home, 'outside', 'caches', '9.3.1', 'keep'));
  expect(await deleteGradleVersion('9.3.1')).toMatchObject({
    deleted: false,
    detail: expect.stringContaining('STIM_HOME scopes'),
  });
  expect(existsSync(join(home, 'outside', 'caches', '9.3.1', 'keep'))).toBe(true);
});

test.each([['wrapper'], ['wrapper', 'dists']])('a symlinked %s keeps every version', async (...segments) => {
  const target = join(home, 'elsewhere');
  mkdirSync(target, { recursive: true });
  const link = join(gradle, ...segments);
  rmSync(link, { recursive: true });
  symlinkSync(target, link);
  expect((await plan()).blocked).toMatchObject({ reason: 'unsafe-layout' });
  expect(await deleteGradleVersion('9.3.1')).toMatchObject({ deleted: false });
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

test.skipIf(!caseInsensitive)('a Gradle directory whose real path differs keeps every version', async () => {
  rmSync(join(gradle, 'caches'), { recursive: true });
  file(join(gradle, 'Caches', '9.3.1', 'keep'));
  expect((await plan()).blocked).toMatchObject({ reason: 'unsafe-layout' });
  expect(await deleteGradleVersion('9.3.1')).toMatchObject({ deleted: false });
  expect(existsSync(join(gradle, 'Caches', '9.3.1', 'keep'))).toBe(true);
});

test.skipIf(!posixModes)('a Gradle directory that cannot be listed keeps every version', async () => {
  chmodSync(join(gradle, 'wrapper', 'dists'), 0o000);
  try {
    expect((await plan()).blocked).toMatchObject({ reason: 'listing-failed' });
    expect(await deleteGradleVersion('9.3.1')).toMatchObject({ deleted: false });
    expect(existsSync(join(gradle, 'caches', '9.3.1', 'keep'))).toBe(true);
  } finally {
    chmodSync(join(gradle, 'wrapper', 'dists'), 0o755);
  }
});

test('a symlinked version directory is never followed or removed', async () => {
  const target = join(home, 'elsewhere', '9.2');
  file(join(target, 'keep'));
  symlinkSync(target, join(gradle, 'caches', '9.2'));
  expect(await deleteGradleVersion('9.2')).toMatchObject({ deleted: false });
  expect(existsSync(join(target, 'keep'))).toBe(true);
  expect(existsSync(join(gradle, 'caches', '9.2'))).toBe(true);
});

test('a daemon that appears on the last check before the rename keeps the version', async () => {
  let calls = 0;
  ps = () => {
    calls += 1;
    return calls === 2 ? java('org.gradle.launcher.daemon.bootstrap.GradleDaemon 9.3.1') : '';
  };
  expect(await deleteGradleVersion('9.3.1')).toMatchObject({
    deleted: false,
    detail: expect.stringContaining('Gradle pid'),
  });
  expect(existsSync(join(gradle, 'caches', '9.3.1', 'keep'))).toBe(true);
});

test.skipIf(!posixModes)('a version is renamed to a .stim-delete sibling before its contents are removed', async () => {
  const version = join(gradle, 'caches', '9.3.1');
  const locked = join(version, 'locked');
  file(join(locked, 'inner'));
  chmodSync(locked, 0o555);
  await expect(deleteGradleVersion('9.3.1')).rejects.toMatchObject({ code: 'EACCES' });
  const staged = readdirSync(join(gradle, 'caches')).filter((name) => name.startsWith('.stim-delete-9.3.1-'));
  try {
    expect(existsSync(version)).toBe(false);
    expect(staged).toHaveLength(1);
    expect(existsSync(join(gradle, 'caches', staged[0] ?? '', 'locked', 'inner'))).toBe(true);
  } finally {
    for (const dir of [locked, ...staged.map((name) => join(gradle, 'caches', name, 'locked'))])
      if (existsSync(dir)) chmodSync(dir, 0o755);
  }
});
