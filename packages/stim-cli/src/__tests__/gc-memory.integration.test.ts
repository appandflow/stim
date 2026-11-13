import { createStim } from '../api.ts';
import { EventEmitter } from 'node:events';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { runGc } from '../commands/gc.ts';
import { deleteGcItem } from '../commands/gc/item.ts';
import { ambientContext, withAmbientContext } from '@stim-cli/core';
import { daemonSnapshotFile, maintenanceRunClaims } from '@stim-cli/core/state';
import { testContext } from './_context.ts';
import { operationState } from '../engine/operation-state.ts';
import { readClaimSet, releaseClaim, type ClaimHandle } from '../ownership-claim.ts';
import { captureProcessIdentity, inspectProcessIdentity, waitForProcessExit } from '@stim-cli/core/process-identity';
import * as identities from '../process-identity.ts';
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
  watchmanFinding,
  watchmanRootStaleness,
  type GradleDaemonFacts,
  type KotlinDaemonFacts,
  type WatchmanFacts,
} from '../commands/gc/memory.ts';
import { getExecutor, resetExecutor, setExecutor } from '../exec.ts';
import { parseWatchmanClients } from '../watchman.ts';
import { makeBuildLock, makeChildProcess, plantClaim } from './_factories.ts';
import { saveConfig } from '../workspace/config.ts';
import { buildLockPath } from '../engine/build-lock.ts';
import * as hostMemory from '../host-memory.ts';

let tmpHome: string;

beforeEach(() => {
  tmpHome = mkdtempSync(join(tmpdir(), 'stim-gc-memory-'));
  process.env.STIM_HOME = tmpHome;
  vi.stubEnv('HOME', tmpHome);
  vi.stubEnv('USERPROFILE', tmpHome);
  vi.stubEnv('AGENT_DEVICE_STATE_DIR', '');
  vi.stubEnv('AGENT_DEVICE_IOS_RUNNER_LEASE_DIR', '');
});

afterEach(() => {
  vi.unstubAllEnvs();
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

test('a Stim dev server that just started keeps watchman, since its Metro has not connected yet', () => {
  const describe = () => 'a client';
  const idle = { roots: [{ path: '/repo', stale: null, subscribers: [], triggers: 0 }] };
  const starting = planWatchman(watchmanFacts({ ...idle, recentStarts: ['/work/app'] }), describe).process;
  expect(starting).toMatchObject({ reclaimable: false, reason: 'in-use' });
  expect(starting.detail).toContain('/work/app');
  expect(planWatchman(watchmanFacts({ ...idle, recentStarts: [] }), describe).process.reclaimable).toBe(true);
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
    client: null,
    alive: true,
    unresolved: false,
  };
  expect(runningBuild([iosLock], [slot])).toBeNull();
  expect(runningBuild([], [slot])).toContain('build slot 0 (pid 40, /w)');
  expect(runningBuild([], [{ ...slot, alive: false, unresolved: true }])).toContain('an unresolved build');
  expect(runningBuild([makeBuildLock({ platform: 'android', pid: 41, alive: true })], [])).toContain('Android build');
  expect(runningBuild([makeBuildLock({ platform: 'android', alive: false })], [])).toBeNull();
});

const PS_ROW = (pid: number, command: string, rssKb = 1000) =>
  `${pid}     1  ${rssKb}   0.0 Mon Sep 28 10:49:33 2026     ${command}`;
const LARGE_RSS_KB = 1.5 * 1024 ** 2;

function fakeWatchman(state: {
  clients: { pid: number; name: string }[];
  subscribers: Record<string, string[]>;
  rssKb?: number;
}) {
  const calls: string[][] = [];
  setExecutor({
    runFileQuiet: (file: string) =>
      file === 'ps' ? PS_ROW(32725, '/opt/homebrew/bin/watchman --foreground', state.rssKb) : null,
    runFileAsync: async (file, args, options) => {
      if (file === 'ps') return PS_ROW(32725, '/opt/homebrew/bin/watchman --foreground', state.rssKb);
      if (file !== 'watchman') throw new Error(`unexpected ${file}`);
      calls.push(args);
      const [, command, path] = args;
      if (command === 'get-pid') return JSON.stringify({ pid: 32725 });
      if (command === 'debug-status') {
        options.onSpawn?.(makeChildProcess({ pid: 777 }));
        return JSON.stringify({
          clients: [{ peer: { pid: 777, name: 'watchman' } }, ...state.clients.map((peer) => ({ peer }))],
        });
      }
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
  'the watchman item removes only an unused stale root and keeps a daemon a client uses',
  async () => {
    delete process.env.STIM_HOME;
    const gone = join(tmpHome, 'gone-worktree');
    const calls = fakeWatchman({
      clients: [{ pid: 4242, name: 'node' }],
      subscribers: { [tmpHome]: ['metro-file-map-4242-x'], [gone]: [] },
    });
    const result = await deleteGcItem({ kind: 'watchman' });
    const destructive = calls.filter((args) => ['watch-del', 'shutdown-server'].includes(args[1]!));
    expect(destructive).toEqual([['--no-spawn', 'watch-del', gone]]);
    expect(calls.every((args) => args[0] === '--no-spawn')).toBe(true);
    expect(result.results).toContainEqual(expect.objectContaining({ kind: 'watchman', status: 'kept' }));
    expect(result.failures).toBe(0);
  },
);

test.skipIf(process.platform === 'win32')(
  'the watchman item shuts watchman down once only its own call is connected',
  async () => {
    delete process.env.STIM_HOME;
    const calls = fakeWatchman({ clients: [], subscribers: { [tmpHome]: [] } });
    await deleteGcItem({ kind: 'watchman' });
    expect(calls.filter((args) => args[1] === 'shutdown-server')).toHaveLength(1);
    expect(calls.some((args) => args[1] === 'watch-del')).toBe(false);
  },
);

test.skipIf(process.platform === 'win32')('gc at high shuts down a large watchman no client uses', async () => {
  delete process.env.STIM_HOME;
  saveConfig({ version: 2, projects: {}, repos: {} });
  const calls = fakeWatchman({ clients: [], subscribers: { [tmpHome]: [] }, rssKb: LARGE_RSS_KB });
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  await runGc({ pressure: 'high' });
  expect(calls.filter((args) => args[1] === 'shutdown-server')).toEqual([['--no-spawn', 'shutdown-server']]);
});

test.skipIf(process.platform === 'win32')('gc at high keeps a large watchman a client uses', async () => {
  delete process.env.STIM_HOME;
  saveConfig({ version: 2, projects: {}, repos: {} });
  const calls = fakeWatchman({
    clients: [{ pid: 4242, name: 'node' }],
    subscribers: { [tmpHome]: ['metro-file-map-4242-x'] },
    rssKb: LARGE_RSS_KB,
  });
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  await runGc({ pressure: 'high' });
  expect(calls.some((args) => ['watch-del', 'shutdown-server'].includes(args[1]!))).toBe(false);
});

test.skipIf(process.platform === 'win32')('a dry run at high plans the watchman stop and runs nothing', async () => {
  delete process.env.STIM_HOME;
  saveConfig({ version: 2, projects: {}, repos: {} });
  const calls = fakeWatchman({ clients: [], subscribers: { [tmpHome]: [] }, rssKb: LARGE_RSS_KB });
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  await runGc({ dryRun: true, pressure: 'high', json: true });
  expect(calls.some((args) => ['watch-del', 'shutdown-server'].includes(args[1]!))).toBe(false);
  expect(JSON.parse(String(log.mock.calls.at(-1)?.[0])).actions).toContainEqual(
    expect.objectContaining({ kind: 'stop-watchman', outcome: 'would' }),
  );
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

test.skipIf(process.platform === 'win32')(
  'an offload daemon is found by its classpath or by the Gradle home it runs in',
  () => {
    const root = '/Users/me/.stim/build-worker';
    for (const area of ['', 'repos/source-4ecffdb90498/']) {
      const classpathClient = offloadClientOf(
        `java -cp ${root}/client-a/${area}cache/gradle/wrapper/dists/x.jar`,
        root,
        null,
      );
      const homeClient = offloadClientOf(GRADLE_DAEMON, root, `${root}/client-b/${area}cache/gradle`);
      expect(classpathClient).toBe('client-a');
      expect(homeClient).toBe('client-b');
      expect(
        decisions(
          planDaemons({
            gradle: [gradle(1, { state: 'idle' }, classpathClient), gradle(2, { state: 'idle' }, homeClient)],
            kotlin: [],
            buildRunning: null,
            stimServerRunning: true,
          }),
        ),
      ).toEqual([
        [1, false, 'stim-server'],
        [2, false, 'stim-server'],
      ]);
    }
    expect(offloadClientOf(GRADLE_DAEMON, root, '/Users/me/.gradle')).toBeNull();
  },
);

test.skipIf(process.platform === 'win32')(
  'manual Gradle GC requires current memory permission, no build, and unchanged signal identity',
  async () => {
    const home = join(tmpHome, '.stim');
    const gradleHome = join(tmpHome, 'gradle');
    const distribution = join(tmpHome, 'distribution');
    const launcher = join(distribution, 'bin', 'gradle');
    mkdirSync(join(distribution, 'bin'), { recursive: true });
    mkdirSync(gradleHome);
    writeFileSync(launcher, 'fixture launcher');
    const context = testContext({ home, env: { ...process.env, STIM_HOME: undefined, STIM_DAEMON: 'off' } });
    let pressured = false;
    let warning = false;
    let pressureReads = 0;
    let duringPressure: (() => void) | undefined;
    let extraBusy = false;
    let secondDaemon = false;
    let replacedSecond = false;
    let present = true;
    let stops = 0;
    const configure = () =>
      withAmbientContext(context, () =>
        saveConfig({
          projects: {},
          repos: {},
          iosSimulatorApp: 'stim-desktop',
          androidEmulatorApp: 'stim-desktop',
        }),
      );
    vi.spyOn(hostMemory, 'readHostMemoryPressureAsync').mockImplementation(async () => {
      pressureReads++;
      duringPressure?.();
      return process.platform === 'darwin' ? (warning ? 'warning' : pressured ? 'critical' : 'normal') : null;
    });
    const signals = vi.spyOn(process, 'kill').mockImplementation(() => {
      throw new Error('unexpected signal');
    });
    setExecutor({
      runFileQuiet: () => null,
      runQuiet: () => null,
      runFileAsync: async (file, args) => {
        if (file === 'ps') {
          const command = `/opt/jdk/bin/java -cp ${distribution}/lib/gradle-daemon-main-9.4.1.jar org.gradle.launcher.daemon.bootstrap.GradleDaemon 9.4.1`;
          return present
            ? [
                PS_ROW(1001, command),
                ...(secondDaemon
                  ? [PS_ROW(1002, command).replace('Sep 28', replacedSecond ? 'Sep 29' : 'Sep 28')]
                  : []),
              ].join('\n')
            : '';
        }
        if (file === 'lsof')
          return `p1001\nf12\nn${gradleHome}/daemon/9.4.1/daemon-1001.out.log\n${secondDaemon ? `p1002\nf12\nn${gradleHome}/daemon/9.4.1/daemon-1002.out.log\n` : ''}`;
        if (file === launcher && args[0] === '--status')
          return `1001 IDLE 9.4.1\n${secondDaemon ? '1002 IDLE 9.4.1\n' : ''}${extraBusy ? '2002 BUSY 9.4.1\n' : ''}`;
        if (file === launcher && args[0] === '--stop') {
          stops++;
          present = false;
          return '';
        }
        throw new Error(`unexpected command ${file}`);
      },
    });
    const client = createStim({ projectRoot: tmpHome, env: context.env });
    configure();
    const healthy = await client.previewGarbage();
    expect(healthy.sections?.memory).toMatchObject([
      { pid: 1001, reclaimable: false, detail: expect.stringContaining('pressure') },
    ]);
    expect(stops).toBe(0);

    const snapshotFile = withAmbientContext(context, daemonSnapshotFile);
    const writeSnapshot = (pressure: { memory: string; memoryWarningSince: string | null }) => {
      mkdirSync(dirname(snapshotFile), { recursive: true });
      writeFileSync(
        snapshotFile,
        JSON.stringify({
          version: 1,
          pid: 1,
          startedAt: new Date().toISOString(),
          mode: 'on',
          tickAt: new Date().toISOString(),
          tickMs: 1,
          intervalMs: 60_000,
          measurement: {},
          workspaces: [],
          pressure: { level: pressure.memory, disk: 'normal', reasons: [], ...pressure },
        }),
      );
    };
    const warningObservations = [];
    if (process.platform === 'darwin') {
      warning = true;
      warningObservations.push((await client.previewGarbage()).sections?.memory[0]?.reclaimable);
      writeSnapshot({ memory: 'normal', memoryWarningSince: new Date(Date.now() - 60_000).toISOString() });
      warningObservations.push((await client.previewGarbage()).sections?.memory[0]?.reclaimable);
      writeSnapshot({ memory: 'normal', memoryWarningSince: new Date(Date.now() - 11 * 60_000).toISOString() });
      warningObservations.push((await client.previewGarbage()).sections?.memory[0]?.reclaimable);
      rmSync(snapshotFile);
      warning = false;
    }
    expect(warningObservations).toEqual(process.platform === 'darwin' ? [false, false, true] : []);

    pressured = true;
    configure();
    writeSnapshot({ memory: 'critical', memoryWarningSince: null });
    expect((await client.previewGarbage()).sections?.memory[0]?.reclaimable).toBe(true);
    pressureReads = 0;
    const lock = withAmbientContext(context, () => buildLockPath('ios', 'owned'));
    const birth = captureProcessIdentity(process.pid);
    if (!birth.ok) throw new Error('the owned build fixture has no process identity');
    duringPressure = () => {
      if (pressureReads === 2) plantClaim(lock, 'exclusive', { pid: process.pid, processToken: birth.token });
    };
    const building = await client.deleteGarbageItem({ item: { kind: 'gradle-daemons' } });
    expect(building.results).toContainEqual(
      expect.objectContaining({ status: 'kept', detail: expect.stringContaining('ios build') }),
    );
    expect(stops).toBe(0);
    rmSync(lock, { recursive: true, force: true });

    extraBusy = true;
    secondDaemon = true;
    const captured = vi.spyOn(identities, 'captureProcessIdentity').mockReturnValue({ ok: true, token: 'owned-token' });
    const inspected = vi.spyOn(identities, 'inspectProcessIdentity').mockReturnValue('same');
    pressureReads = 0;
    duringPressure = () => {
      if (pressureReads === 3) {
        inspected.mockImplementation((record) => (record?.pid === 1001 ? 'different' : 'same'));
        replacedSecond = true;
      }
    };
    const replaced = await client.deleteGarbageItem({ item: { kind: 'gradle-daemons' } });
    expect(replaced.results).toContainEqual(
      expect.objectContaining({ id: '1001', status: 'kept', detail: expect.stringContaining('process changed') }),
    );
    expect(replaced.results).toContainEqual(
      expect.objectContaining({ id: '1002', status: 'kept', detail: expect.stringContaining('process changed') }),
    );
    expect(stops).toBe(0);
    expect(signals).not.toHaveBeenCalled();
    captured.mockRestore();
    inspected.mockRestore();

    extraBusy = false;
    secondDaemon = false;
    duringPressure = undefined;
    const eligible = await client.deleteGarbageItem({ item: { kind: 'gradle-daemons' } });
    expect(eligible.exitCode).toBe(0);
    expect(eligible.results).toContainEqual(expect.objectContaining({ status: 'done', id: '1001' }));
    expect(stops).toBe(1);
  },
);

test.skipIf(process.platform === 'win32')(
  'GC API cancellation between watchman roots keeps the remaining root and confines progress to its client',
  async () => {
    const roots = [join(tmpHome, 'gone-one'), join(tmpHome, 'gone-two')];
    const subscribers = Object.fromEntries(roots.map((root) => [root, []]));
    const calls = fakeWatchman({ clients: [], subscribers });
    const executor = getExecutor();
    setExecutor({
      ...executor,
      async runFileQuietAsync(file, args, options) {
        if (file !== 'watchman') return executor.runFileQuietAsync(file, args, options);
        options.onSpawn?.(makeChildProcess({ pid: 777 }));
        return executor.runFileAsync(file, args, options);
      },
    });
    const controller = new AbortController();
    const progress: string[] = [];
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const client = createStim({
      projectRoot: tmpHome,
      env: { ...process.env, STIM_HOME: undefined },
      onProgress: ({ message }) => {
        progress.push(message);
        if (calls.some((args) => args[1] === 'watch-del')) controller.abort();
      },
    });
    await expect(
      client.deleteGarbageItem({ item: { kind: 'watchman' }, signal: controller.signal }),
    ).rejects.toMatchObject({ code: 'STIM_CANCELLED' });
    expect(Object.keys(subscribers)).toHaveLength(1);
    expect(calls.filter((args) => args[1] === 'watch-del')).toHaveLength(1);
    expect(calls.some((args) => args[1] === 'shutdown-server')).toBe(false);
    const result = await client.deleteGarbageItem({ item: { kind: 'watchman' } });
    expect(result.exitCode).toBe(0);
    expect(Object.keys(subscribers)).toEqual([]);
    expect(calls.some((args) => args[1] === 'shutdown-server')).toBe(true);
    expect(progress.length).toBeGreaterThan(0);
    expect(log).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();
  },
);

test
  .skipIf(process.platform === 'win32')
  .each([
    'get-pid',
    'debug-status',
    'watch-list',
    'debug-get-subscriptions',
    'trigger-list',
    'watch-del',
    'shutdown-server',
  ])('the watchman item preserves unresolved %s cleanup without continuing mutations', async (command) => {
  resetExecutor();
  const real = getExecutor().runFileAsync.bind(getExecutor());
  delete process.env.STIM_HOME;
  const state = {
    clients: [],
    subscribers:
      command === 'watch-del' ? { [join(tmpHome, 'a-gone')]: [], [join(tmpHome, 'b-gone')]: [] } : { [tmpHome]: [] },
  };
  const calls = fakeWatchman(state);
  const executor = getExecutor();
  const client = createStim({ projectRoot: tmpHome, env: { ...process.env, STIM_HOME: undefined } });
  let owned: { pid: number; processToken: string } | undefined;
  let handles: ClaimHandle[] = [];
  let closed: Promise<void> = Promise.resolve();
  const inspect = vi
    .spyOn(identities, 'inspectProcessIdentity')
    .mockImplementation((record) => (owned && record?.pid === owned.pid ? 'unknown' : inspectProcessIdentity(record)));
  const run = executor.runFileAsync;
  vi.spyOn(executor, 'runFileAsync').mockImplementation((file, args, options) => {
    if (file !== 'watchman' || args[1] !== command || owned) return run(file, args, options);
    calls.push(args);
    return real(process.execPath, ['-e', 'setInterval(()=>{},1000)'], {
      ...options,
      timeoutMs: 25,
      onSpawn: (child) => {
        options.onSpawn?.(child);
        const birth = child.pid === undefined ? null : captureProcessIdentity(child.pid);
        if (child.pid === undefined || !birth?.ok) throw new Error('The Watchman fixture child has no identity');
        owned = { pid: child.pid, processToken: birth.token };
        handles = [...operationState(ambientContext()).declaring];
        closed = new Promise<void>((resolve) => child.once('close', resolve));
      },
    });
  });
  try {
    await expect(client.deleteGarbageItem({ item: { kind: 'watchman' } })).rejects.toMatchObject({
      code: 'STIM_CLAIM_UNAVAILABLE',
    });
    if (!owned) throw new Error('The Watchman operation did not start');
    expect(inspectProcessIdentity(owned)).toBe('same');
    expect(calls.filter((args) => ['watch-del', 'shutdown-server'].includes(args[1] ?? ''))).toEqual(
      ['watch-del', 'shutdown-server'].includes(command)
        ? [['--no-spawn', command, ...(command === 'watch-del' ? [join(tmpHome, 'a-gone')] : [])]]
        : [],
    );
    expect(handles.map((handle) => handle.root)).toContain(maintenanceRunClaims());
    for (const handle of handles) expect(readClaimSet(handle.root).live).toMatchObject([{ child: { pid: owned.pid } }]);
    await expect(client.deleteGarbageItem({ item: { kind: 'watchman' } })).rejects.toMatchObject({
      code: 'STIM_CLAIM_REFUSED',
    });
  } finally {
    inspect.mockRestore();
    if (owned && inspectProcessIdentity(owned) === 'same') process.kill(owned.pid, 'SIGKILL');
    await closed;
    expect(owned ? await waitForProcessExit(owned, 5000) : true).toBe(true);
    for (const handle of handles) releaseClaim(handle);
  }
});

test.skipIf(process.platform === 'win32')(
  'a dry run whose report child cannot be verified names the child and retries the command it ran',
  async () => {
    resetExecutor();
    const real = getExecutor().runFileAsync.bind(getExecutor());
    delete process.env.STIM_HOME;
    fakeWatchman({ clients: [], subscribers: { [tmpHome]: [] } });
    const executor = getExecutor();
    const operation = testContext({ home: tmpHome, cwd: tmpHome, projectRoot: tmpHome });
    let owned: { pid: number; processToken: string } | undefined;
    const inspect = vi
      .spyOn(identities, 'inspectProcessIdentity')
      .mockImplementation((record) =>
        owned && record?.pid === owned.pid ? 'unknown' : inspectProcessIdentity(record),
      );
    const run = executor.runFileAsync;
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(executor, 'runFileAsync').mockImplementation((file, args, options) => {
      if (file !== 'watchman' || args[1] !== 'get-pid' || owned) return run(file, args, options);
      return real(process.execPath, ['-e', 'setInterval(()=>{},1000)'], {
        ...options,
        timeoutMs: 25,
        onSpawn: (child) => {
          options.onSpawn?.(child);
          const birth = child.pid === undefined ? null : captureProcessIdentity(child.pid);
          if (child.pid === undefined || !birth?.ok) throw new Error('The Watchman fixture child has no identity');
          owned = { pid: child.pid, processToken: birth.token };
        },
      });
    });
    try {
      await withAmbientContext(operation, () => runGc({ dryRun: true, pressure: 'normal', json: true }, { operation }));
      if (!owned) throw new Error('The Watchman operation did not start');
      const lines = error.mock.calls.map((call) => String(call[0]));
      expect(lines[0]).toContain('STIM_CLAIM_UNAVAILABLE');
      expect(lines[1]).not.toContain('undefined');
      expect(lines[1]).toContain(`ps -p ${owned.pid}`);
      expect(lines[1]).toContain('`stim gc --dry-run --pressure normal --json`');
      expect(process.exitCode).toBe(1);
    } finally {
      inspect.mockRestore();
      if (owned && inspectProcessIdentity(owned) === 'same') process.kill(owned.pid, 'SIGKILL');
      expect(owned ? await waitForProcessExit(owned, 5000) : true).toBe(true);
    }
  },
);
