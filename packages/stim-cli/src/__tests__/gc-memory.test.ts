import { EventEmitter } from 'node:events';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { runGc } from '../commands/gc.ts';
import * as memory from '../commands/gc/memory.ts';
import {
  gradleHomeFromFiles,
  isKotlinDaemonCommand,
  parseGradleDaemonCommand,
  parseGradleStatus,
  offloadClientOf,
  parseLsof,
  connectionPeers,
  planDaemons,
  planWatchman,
  runningBuild,
  stimWorkspaceOf,
  watchmanFinding,
  watchmanRootStaleness,
  type GradleDaemonFacts,
  type KotlinDaemonFacts,
  type WatchmanFacts,
} from '../commands/gc/memory.ts';
import { resetExecutor, setExecutor } from '../exec.ts';
import { parseWatchmanClients } from '../watchman.ts';
import { makeBuildLock } from './_factories.ts';

let tmpHome: string;

beforeEach(() => {
  tmpHome = mkdtempSync(join(tmpdir(), 'stim-gc-memory-'));
  process.env.STIM_HOME = tmpHome;
});

afterEach(() => {
  vi.restoreAllMocks();
  resetExecutor();
  delete process.env.STIM_HOME;
  rmSync(tmpHome, { recursive: true, force: true });
  process.exitCode = undefined;
});

const DIST = '/Users/me/.gradle/wrapper/dists/gradle-9.4.1-bin/arn2x92/gradle-9.4.1';
const GRADLE_DAEMON =
  '/Library/Java/JavaVirtualMachines/zulu-17.jdk/Contents/Home/bin/java --add-opens=java.base/java.lang=ALL-UNNAMED ' +
  `-Xmx512m -Dfile.encoding=UTF-8 -cp ${DIST}/lib/gradle-daemon-main-9.4.1.jar ` +
  `-javaagent:${DIST}/lib/agents/gradle-instrumentation-agent-9.4.1.jar org.gradle.launcher.daemon.bootstrap.GradleDaemon 9.4.1`;

test('a GradleDaemon command line gives its version, Java home and own distribution', () => {
  expect(parseGradleDaemonCommand(GRADLE_DAEMON)).toEqual({
    version: '9.4.1',
    javaHome: '/Library/Java/JavaVirtualMachines/zulu-17.jdk/Contents/Home',
    distribution: DIST,
  });
  const studio =
    '/Applications/Android Studio.app/Contents/jbr/Contents/Home/bin/java -Xmx2g -cp /Users/me/.gradle/wrapper/dists/gradle-8.10.2-all/x/gradle-8.10.2/lib/gradle-launcher-8.10.2.jar org.gradle.launcher.daemon.bootstrap.GradleDaemon 8.10.2';
  expect(parseGradleDaemonCommand(studio)).toEqual({
    version: '8.10.2',
    javaHome: '/Applications/Android Studio.app/Contents/jbr/Contents/Home',
    distribution: '/Users/me/.gradle/wrapper/dists/gradle-8.10.2-all/x/gradle-8.10.2',
  });
});

test('a process that only names a daemon class, such as pgrep, is not a daemon', () => {
  expect(parseGradleDaemonCommand('pgrep -f org.gradle.launcher.daemon.bootstrap.GradleDaemon 9.4.1')).toBeNull();
  expect(isKotlinDaemonCommand('pgrep -fl KotlinCompileDaemon')).toBe(false);
  expect(
    isKotlinDaemonCommand(
      '/opt/jdk/bin/java -cp /Users/me/.gradle/caches/kotlin-compiler-embeddable-2.1.20.jar -Xmx2g org.jetbrains.kotlin.daemon.KotlinCompileDaemon --daemon-runFilesPath /Users/me/Library/kotlin/daemon',
    ),
  ).toBe(true);
});

test('gradle --status rows are read past its banner and footer', () => {
  const output = [
    'Welcome to Gradle 9.4.1!',
    '',
    '   PID STATUS   INFO',
    ' 90756 BUSY     9.4.1',
    ' 48080 IDLE     9.4.1',
    ' 12000 STOPPED  (by user or operating system)',
    '',
    'Only Daemons for the current Gradle version are displayed.',
  ].join('\n');
  expect([...parseGradleStatus(output)]).toEqual([
    [90756, 'busy'],
    [48080, 'idle'],
    [12000, 'stopped'],
  ]);
});

test('a daemon Gradle home comes from the daemon log it holds open, and lsof lists its connections', () => {
  const lsof = [
    'p90756',
    'fcwd',
    'n/private/tmp/ghome/daemon/9.4.1',
    'f12',
    'n/private/tmp/ghome/daemon/9.4.1/daemon-90756.out.log',
    'f40',
    'nlocalhost:50567',
    'TST=LISTEN',
    'f41',
    'nlocalhost:50567->localhost:50632',
    'TST=ESTABLISHED',
    'p44174',
    'f3',
    'n/tmp/other',
  ].join('\n');
  const parsed = parseLsof(lsof);
  expect(parsed.get(90756)?.connections).toEqual(['localhost:50567->localhost:50632']);
  expect(parsed.get(44174)?.connections).toEqual([]);
  expect(gradleHomeFromFiles(90756, '9.4.1', parsed.get(90756)!.files)).toBe('/private/tmp/ghome');
  expect(gradleHomeFromFiles(90756, '8.14', parsed.get(90756)!.files)).toBeNull();
});

test.skipIf(process.platform === 'win32')(
  'a stale watch root is a gone directory on a mounted volume or a pruned linked worktree',
  () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'stim-gc-roots-')));
    try {
      mkdirSync(join(root, 'main', '.git', 'worktrees', 'live'), { recursive: true });
      mkdirSync(join(root, 'live', 'apps', 'mobile'), { recursive: true });
      writeFileSync(join(root, 'live', '.git'), `gitdir: ${join(root, 'main', '.git', 'worktrees', 'live')}\n`);
      mkdirSync(join(root, 'pruned', 'apps', 'mobile'), { recursive: true });
      writeFileSync(join(root, 'pruned', '.git'), `gitdir: ${join(root, 'main', '.git', 'worktrees', 'pruned')}\n`);

      expect(watchmanRootStaleness(join(root, 'main'))).toBeNull();
      expect(watchmanRootStaleness(join(root, 'live', 'apps', 'mobile'))).toBeNull();
      expect(watchmanRootStaleness(join(root, 'pruned', 'apps', 'mobile'))).toBe('pruned-worktree');
      expect(watchmanRootStaleness(join(root, 'gone'))).toBe('missing');
      const unmounted = { exists: () => false, isFile: () => false, read: () => null, mounted: () => false };
      expect(watchmanRootStaleness('/Volumes/Ext/repo', unmounted)).toBeNull();
      const gitdirUnmounted = {
        exists: (path: string) => !path.startsWith('/Volumes/'),
        isFile: (path: string) => path.endsWith('.git'),
        read: () => 'gitdir: /Volumes/Ext/main/.git/worktrees/wt',
        mounted: (path: string) => !path.startsWith('/Volumes/'),
      };
      expect(watchmanRootStaleness('/Users/me/wt', gitdirUnmounted)).toBeNull();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
);

function watchmanFacts(overrides: Partial<WatchmanFacts> = {}): WatchmanFacts {
  return {
    pid: 32725,
    startedAt: null,
    bytes: 4_000_000_000,
    measure: 'footprint',
    roots: [
      { path: '/repo', stale: null, subscribers: [], triggers: 0 },
      { path: '/gone', stale: 'missing', subscribers: [], triggers: 0 },
      { path: '/pruned', stale: 'pruned-worktree', subscribers: ['jest'], triggers: 0 },
    ],
    clients: [],
    ...overrides,
  };
}

test('watchman may be shut down only when no client is connected and every root was read', () => {
  const describe = (client: { pid: number; name: string | null }) =>
    client.pid === 500 ? 'the Stim workspace /w' : `${client.name} (pid ${client.pid})`;

  const used = planWatchman(watchmanFacts({ clients: [{ pid: 500, name: 'node' }] }), describe);
  expect(used.process).toMatchObject({ reclaimable: false, reason: 'in-use' });
  expect(used.process.detail).toContain('the Stim workspace /w');
  expect(used.roots.map((root) => [root.path, root.removable])).toEqual([
    ['/repo', false],
    ['/gone', true],
    ['/pruned', false],
  ]);

  expect(planWatchman(watchmanFacts({ clients: null }), describe).process).toMatchObject({ reason: 'unknown' });
  const unread = watchmanFacts({ roots: [{ path: '/repo', stale: null, subscribers: null, triggers: 0 }] });
  expect(planWatchman(unread, describe).process).toMatchObject({ reason: 'unknown', reclaimable: false });
  expect(planWatchman(watchmanFacts({ roots: null }), describe).process.reclaimable).toBe(false);

  const triggered = watchmanFacts({ roots: [{ path: '/repo', stale: null, subscribers: [], triggers: 1 }] });
  expect(planWatchman(triggered, describe).process).toMatchObject({ reason: 'in-use', reclaimable: false });
  const unreadTriggers = watchmanFacts({ roots: [{ path: '/repo', stale: null, subscribers: [], triggers: null }] });
  expect(planWatchman(unreadTriggers, describe).process).toMatchObject({ reason: 'unknown' });

  const idle = planWatchman(
    watchmanFacts({ roots: [{ path: '/repo', stale: null, subscribers: [], triggers: 0 }] }),
    describe,
  );
  expect(idle.process).toMatchObject({ reclaimable: true, reason: null });
});

test('debug-status clients are read by peer pid, and an unreadable answer is null', () => {
  expect(parseWatchmanClients({ clients: [{ peer: { pid: 7, name: 'node' } }] })).toEqual([{ pid: 7, name: 'node' }]);
  expect(parseWatchmanClients({ clients: [{ state: 'x' }] })).toBeNull();
  expect(parseWatchmanClients({ error: 'unknown command' })).toBeNull();
});

function gradle(
  pid: number,
  status: GradleDaemonFacts['status'],
  offloadClient: string | null = null,
): GradleDaemonFacts {
  return {
    pid,
    startedAt: null,
    bytes: 100,
    measure: 'footprint',
    command: { version: '9.4.1', javaHome: '/jdk', distribution: DIST },
    gradleHome: '/h',
    offloadClient,
    status,
  };
}

function kotlin(pid: number, peers: (number | null)[] | null): KotlinDaemonFacts {
  return { pid, startedAt: null, bytes: 50, measure: 'footprint', peers };
}

function decisions(plans: ReturnType<typeof planDaemons>) {
  return plans.map((plan) => [plan.pid, plan.reclaimable, plan.reason]);
}

test('only a Gradle daemon its own status calls idle is stopped, and a Kotlin daemon only when its clients stop too', () => {
  expect(
    decisions(
      planDaemons({
        gradle: [gradle(1, { state: 'idle' }), gradle(2, { state: 'busy' }), gradle(3, { unknown: 'no home' })],
        kotlin: [kotlin(10, [])],
        buildRunning: null,
        stimServerRunning: false,
      }),
    ),
  ).toEqual([
    [1, true, null],
    [2, false, 'busy'],
    [3, false, 'unknown'],
    [10, false, 'busy'],
  ]);
  expect(
    decisions(
      planDaemons({
        gradle: [gradle(1, { state: 'idle' }), gradle(2, { state: 'idle' }, 'client-a')],
        kotlin: [kotlin(10, [1, 1]), kotlin(11, [1, null]), kotlin(12, null), kotlin(13, [2])],
        buildRunning: null,
        stimServerRunning: true,
      }),
    ),
  ).toEqual([
    [1, true, null],
    [2, false, 'stim-server'],
    [10, true, null],
    [11, false, 'busy'],
    [12, false, 'unknown'],
    [13, false, 'busy'],
  ]);
});

test('a running Stim build keeps every daemon, and stim-server keeps its offload clients daemons', () => {
  const plans = planDaemons({
    gradle: [gradle(1, { state: 'idle' })],
    kotlin: [kotlin(10, [])],
    buildRunning: 'a running Android build holds /lock',
    stimServerRunning: false,
  });
  expect(decisions(plans)).toEqual([
    [1, false, 'build-running'],
    [10, false, 'build-running'],
  ]);
  const offload = planDaemons({
    gradle: [gradle(1, { state: 'idle' }, 'client-a'), gradle(2, { state: 'idle' })],
    kotlin: [],
    buildRunning: null,
    stimServerRunning: true,
  });
  expect(decisions(offload)).toEqual([
    [1, false, 'stim-server'],
    [2, true, null],
  ]);
});

test('an iOS build slot does not hold the daemons, an Android lock or an unattributed slot does', () => {
  const iosLock = makeBuildLock({ platform: 'ios', pid: 40, alive: true });
  const slot = {
    path: '/s/0',
    name: '0',
    index: 0,
    pid: 40,
    projectRoot: '/w',
    startedAt: null,
    logFile: null,
    alive: true,
    unresolved: false,
  };
  expect(runningBuild([iosLock], [slot])).toBeNull();
  expect(runningBuild([], [slot])).toContain('build slot 0 (pid 40, /w)');
  expect(runningBuild([], [{ ...slot, alive: false, unresolved: true }])).toContain('an unresolved build');
  expect(runningBuild([makeBuildLock({ platform: 'android', pid: 41, alive: true })], [])).toContain('Android build');
  expect(runningBuild([makeBuildLock({ platform: 'android', alive: false })], [])).toBeNull();
});

test('a watchman client is attributed to the Stim workspace whose supervisor it descends from', () => {
  const parentOf = new Map([
    [300, 200],
    [200, 100],
    [100, 1],
  ]);
  const supervisors = new Map([[100, '/w']]);
  expect(stimWorkspaceOf(300, parentOf, supervisors)).toBe('/w');
  expect(stimWorkspaceOf(999, parentOf, supervisors)).toBeNull();
});

test('--older-than with a memory kind is refused', async () => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  await runGc({ cache: 'watchman', olderThan: 3, json: true });
  expect(JSON.parse(String(log.mock.calls.at(-1)?.[0]))).toMatchObject({ code: 'STIM_BAD_ARG' });
  expect(process.exitCode).toBe(1);
});

const PS_ROW = (pid: number, command: string) => `${pid}     1  1000   0.0 Mon Sep 28 10:49:33 2026     ${command}`;

function fakeWatchman(state: { clients: { pid: number; name: string }[]; subscribers: Record<string, string[]> }) {
  const calls: string[][] = [];
  setExecutor({
    runFileQuiet: (file: string) =>
      file === 'ps' ? [PS_ROW(32725, '/opt/homebrew/bin/watchman --foreground')].join('\n') : null,
    runFileAsync: async (file: string, args: string[]) => {
      if (file !== 'watchman') throw new Error(`unexpected ${file}`);
      calls.push(args);
      const [, command, path] = args;
      if (command === 'get-pid') return JSON.stringify({ pid: 32725 });
      if (command === 'watch-list') return JSON.stringify({ roots: Object.keys(state.subscribers) });
      if (command === 'debug-get-subscriptions') {
        return JSON.stringify({ subscribers: state.subscribers[path!]!.map((name) => ({ info: { name } })) });
      }
      if (command === 'trigger-list') return JSON.stringify({ triggers: [] });
      if (command === 'watch-del') {
        delete state.subscribers[path!];
        return JSON.stringify({ 'watch-del': true });
      }
      if (command === 'shutdown-server') return JSON.stringify({ 'shutdown-server': true });
      throw new Error(`unexpected watchman ${command}`);
    },
    spawn: (_file: string, args: string[]) => {
      calls.push(args);
      const child = Object.assign(new EventEmitter(), { pid: 777, stdout: new EventEmitter(), kill: () => true });
      setImmediate(() => {
        const clients = [{ peer: { pid: 777, name: 'watchman' } }, ...state.clients.map((peer) => ({ peer }))];
        child.stdout.emit('data', Buffer.from(JSON.stringify({ clients })));
        child.emit('close', 0);
      });
      return child;
    },
  });
  return calls;
}

test.skipIf(process.platform === 'win32')(
  'gc --delete --cache watchman removes only an unused stale root and keeps a daemon a client uses',
  async () => {
    vi.spyOn(memory, 'memorySweepIsScoped').mockReturnValue(false);
    const gone = join(tmpHome, 'gone-worktree');
    const calls = fakeWatchman({
      clients: [{ pid: 4242, name: 'node' }],
      subscribers: { [tmpHome]: ['metro-file-map-4242-x'], [gone]: [] },
    });
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    await runGc({ cache: 'watchman', delete: true });
    const destructive = calls.filter((args) => ['watch-del', 'shutdown-server'].includes(args[1]!));
    expect(destructive).toEqual([['--no-spawn', 'watch-del', gone]]);
    expect(calls.every((args) => args[0] === '--no-spawn')).toBe(true);
    expect(log.mock.calls.flat().join('\n')).toContain('node (pid 4242)');
    expect(process.exitCode).toBeUndefined();
  },
);

test.skipIf(process.platform === 'win32')(
  'gc --delete --cache watchman shuts watchman down once only its own call is connected',
  async () => {
    vi.spyOn(memory, 'memorySweepIsScoped').mockReturnValue(false);
    const calls = fakeWatchman({ clients: [], subscribers: { [tmpHome]: [] } });
    vi.spyOn(console, 'log').mockImplementation(() => {});
    await runGc({ cache: 'watchman', delete: true });
    expect(calls.filter((args) => args[1] === 'shutdown-server')).toHaveLength(1);
    expect(calls.some((args) => args[1] === 'watch-del')).toBe(false);
  },
);

test.skipIf(process.platform === 'win32')('neither --cache all nor an unscoped --delete touches watchman', async () => {
  vi.spyOn(memory, 'memorySweepIsScoped').mockReturnValue(false);
  const calls = fakeWatchman({ clients: [], subscribers: { [tmpHome]: [] } });
  vi.spyOn(console, 'log').mockImplementation(() => {});
  await runGc({ cache: 'all', delete: true });
  expect(calls).toEqual([]);
  await runGc({ delete: true });
  expect(calls.some((args) => ['watch-del', 'shutdown-server'].includes(args[1]!))).toBe(false);
});

test('doctor notes watchman only past 2 GiB, with its stale roots and whether gc could shut it down', () => {
  const describe = () => 'the Stim workspace /w';
  const big = planWatchman(watchmanFacts({ clients: [{ pid: 1, name: 'node' }] }), describe);
  const note = watchmanFinding({ processes: [big.process], watchmanRoots: big.roots, notices: [] });
  expect(note).toMatchObject({ level: 'note' });
  expect(note?.detail).toContain('3 watched root(s), 2 of them stale');
  expect(note?.detail).toContain('the Stim workspace /w');
  const small = planWatchman(watchmanFacts({ bytes: 500_000_000 }), describe);
  expect(watchmanFinding({ processes: [small.process], watchmanRoots: small.roots, notices: [] })).toBeNull();
});

test('a Kotlin daemon connection is traced to the lsof process holding its other end', () => {
  const lsof = parseLsof(
    [
      'p13679',
      'f19',
      'n127.0.0.1:17626->127.0.0.1:61516',
      'TST=ESTABLISHED',
      'f20',
      'n10.0.0.130:61322->104.18.18.12:443',
      'TST=ESTABLISHED',
      'p87114',
      'f413',
      'n127.0.0.1:61516->127.0.0.1:17626',
      'TST=ESTABLISHED',
      'f414',
      'n127.0.0.1:61600->127.0.0.1:5000',
      'TST=ESTABLISHED',
    ].join('\n'),
  );
  expect(connectionPeers(87114, lsof)).toEqual([13679, null]);
});

test('an offload daemon is found by its classpath or by the Gradle home it runs in', () => {
  const root = '/Users/me/.stim/build-worker';
  expect(offloadClientOf(`java -cp ${root}/client-a/cache/gradle/wrapper/dists/x.jar`, root, null)).toBe('client-a');
  expect(offloadClientOf(GRADLE_DAEMON, root, `${root}/client-b/cache/gradle`)).toBe('client-b');
  expect(offloadClientOf(GRADLE_DAEMON, root, '/Users/me/.gradle')).toBeNull();
});
