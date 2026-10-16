import { captureProcessIdentity, inspectProcessIdentity, waitForProcessExit } from '@stim-cli/core/process-identity';
import * as identities from '../process-identity.ts';
import * as git from '../workspace/git.ts';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import { ambientContext, withAmbientContext, type StimContext } from '@stim-cli/core';
import { createStim } from '../api.ts';
import gcCommand, { runGc } from '../commands/gc.ts';
import { Command } from 'commander';
import * as cliOperation from '../cli-operation.ts';
import { recordGcResult, takeGcResults } from '../commands/gc/results.ts';
import { getExecutor } from '../exec.ts';
import { readClaimSet, releaseClaim, type ClaimHandle } from '../ownership-claim.ts';
import { operationState } from '../engine/operation-state.ts';
import { collectGradleVersions } from '../commands/gc/gradle-versions.ts';
import * as tailnet from '../offload/tailnet.ts';
import { testContext } from './_context.ts';
import { ensureWorkspaceStorage, workspaceLogsDir } from '../workspace/paths.ts';
import { macosDir } from '../macos/state.ts';
import * as gcDevices from '../commands/gc/devices.ts';

let scratch: string;
let fixtureAbort: AbortController;
let activeReports: Set<Promise<unknown>>;
beforeEach(() => {
  scratch = realpathSync.native(mkdtempSync(join(tmpdir(), 'stim-api-reports-')));
  fixtureAbort = new AbortController();
  activeReports = new Set();
  vi.stubEnv('STIM_HOME', join(scratch, 'caller'));
});
afterEach(async () => {
  fixtureAbort.abort();
  await Promise.allSettled(activeReports);
  vi.unstubAllEnvs();
  takeGcResults();
  // https://github.com/nodejs/node/issues/64016: Windows rmSync can ignore retryDelay.
  await rm(scratch, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});

function killFixtureChild(record: { pid: number; processToken: string } | undefined): void {
  if (!record || inspectProcessIdentity(record) !== 'same') return;
  try {
    process.kill(record.pid, 'SIGKILL');
  } catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'ESRCH')) throw error;
  }
}

function trackRead<T>(work: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const result = work(fixtureAbort.signal);
  activeReports.add(result);
  void result.then(
    () => activeReports.delete(result),
    () => activeReports.delete(result),
  );
  return result;
}

function fixture(name: string) {
  const root = join(scratch, name);
  const home = join(scratch, `${name}-home`);
  const cache = join(home, 'cache');
  mkdirSync(root);
  mkdirSync(cache, { recursive: true });
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name, private: true }));
  writeFileSync(join(home, 'config.json'), JSON.stringify({ maintenance: { mode: 'off' } }));
  writeFileSync(
    join(home, 'caches.json'),
    JSON.stringify({ version: 1, caches: [{ name: 'fixture', dir: cache, prune: 'entries' }] }),
  );
  writeFileSync(join(cache, 'artifact'), name);
  const env = {
    ...process.env,
    HOME: scratch,
    USERPROFILE: scratch,
    STIM_HOME: home,
    PATH:
      process.platform === 'win32'
        ? [
            dirname(process.execPath),
            join(process.env.SystemRoot || 'C:\\Windows', 'System32'),
            join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0'),
          ].join(delimiter)
        : `${dirname(process.execPath)}:/usr/bin:/bin`,
  };
  return { root, home, cache, env };
}

test('concurrent GC clients isolate homes, output and results without changing process context', async () => {
  const first = fixture('first');
  const second = fixture('second');
  const cwd = process.cwd();
  const env = { ...process.env };
  const exit = process.exitCode;
  const log = vi.spyOn(console, 'log');
  const error = vi.spyOn(console, 'error');
  const output: string[] = [];
  recordGcResult('cache', 'done', 'another operation');
  try {
    const reports = await Promise.all(
      [first, second].map((item) =>
        createStim({
          projectRoot: item.root,
          home: item.home,
          env: item.env,
          onProgress: ({ stream, message }) => {
            expect(stream).toBe('stderr');
            output.push(message);
          },
        }).gc({ cache: 'fixture' }),
      ),
    );
    for (const [index, report] of reports.entries()) {
      expect(report.sections.caches.map((entry) => entry.dir)).toEqual([index === 0 ? first.cache : second.cache]);
      expect(report.results).toEqual([]);
      expect(report.mode).toBe('dry-run');
    }
    expect(output.length).toBeGreaterThan(0);
    expect(takeGcResults().map((entry) => entry.label)).toEqual(['another operation']);
    expect(log).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();
    expect(process.cwd()).toBe(cwd);
    expect(process.env).toEqual(env);
    expect(process.exitCode).toBe(exit);
  } finally {
    log.mockRestore();
    error.mockRestore();
  }
});

test('cancelling a parked erase drains its native child and leaves the next pool entry untouched', async () => {
  const item = fixture('parked-erase-cancel');
  const ids = ['FIRST', 'SECOND'];
  const pool = ids.map((udid) => ({
    udid,
    name: `stim-${udid}`,
    deviceTypeIdentifier: 'iphone',
    runtimeIdentifier: 'com.apple.CoreSimulator.SimRuntime.iOS-26-5',
    parkedAt: '2026-01-01T00:00:00Z',
    simslimManaged: false,
    bundleId: 'fixture.app',
    cacheKey: `cache-${udid}`,
  }));
  writeFileSync(
    join(item.home, 'config.json'),
    JSON.stringify({ version: 2, projects: {}, repos: {}, parked: { ios: pool }, maintenance: { mode: 'off' } }),
  );
  writeFileSync(
    join(item.home, 'created-devices.json'),
    JSON.stringify({ version: 1, ios: ids, android: [], web: [] }),
  );
  const controller = new AbortController();
  const executor = getExecutor();
  const run = executor.runFileAsync.bind(executor);
  const mutations: string[] = [];
  let owned: { pid: number; processToken: string } | undefined;
  const found = vi.spyOn(executor, 'findExecutable').mockReturnValue(null);
  const probe = vi.spyOn(executor, 'runFileAsync').mockImplementation((file, args, options) => {
    if (file === 'xcrun' && args.includes('devices'))
      return Promise.resolve(
        JSON.stringify({
          devices: {
            'com.apple.CoreSimulator.SimRuntime.iOS-26-5': ids.map((udid) => ({
              udid,
              name: `stim-${udid}`,
              state: 'Shutdown',
              isAvailable: true,
              deviceTypeIdentifier: 'iphone',
            })),
          },
        }),
      );
    if (file === 'xcrun' && args.includes('devicetypes'))
      return Promise.resolve(JSON.stringify({ devicetypes: [{ identifier: 'iphone', name: 'iPhone' }] }));
    if (file !== 'xcrun' || args[1] !== 'erase') throw new Error(`Unexpected fixture command ${file}`);
    mutations.push(args[2] ?? '<missing device>');
    return run(process.execPath, ['-e', 'console.log("erase started"); setInterval(() => {}, 1000)'], {
      ...options,
      onSpawn: (child) => {
        options.onSpawn?.(child);
        const captured = child.pid === undefined ? null : captureProcessIdentity(child.pid);
        if (child.pid === undefined || !captured?.ok) throw new Error('The fixture erase child has no identity');
        owned = { pid: child.pid, processToken: captured.token };
        child.stdout?.once('data', () => controller.abort());
      },
    });
  });
  try {
    await expect(
      trackRead((signal) =>
        createStim({ projectRoot: item.root, home: item.home, env: item.env }).collectGarbage({
          cache: 'parked',
          delete: true,
          signal: AbortSignal.any([signal, controller.signal]),
        }),
      ),
    ).rejects.toMatchObject({ code: 'STIM_CANCELLED' });
    expect(mutations).toEqual(['FIRST']);
    expect(owned).toBeDefined();
    expect(owned && inspectProcessIdentity(owned)).toBe('gone');
    const config = JSON.parse(readFileSync(join(item.home, 'config.json'), 'utf8'));
    expect(config.parked.ios[1]).toEqual(pool[1]);
    expect(config.parked.ios[0]).not.toHaveProperty('deletionClaim');
    expect(config.parked.ios[0]).not.toHaveProperty('bundleId');
    expect(readClaimSet(join(item.home, 'pool-locks', 'ios', 'first.lock')).live).toEqual([]);
    expect(readClaimSet(join(item.home, 'maintenance', 'run.claims')).live).toEqual([]);
  } finally {
    controller.abort();
    probe.mockRestore();
    found.mockRestore();
    if (owned && inspectProcessIdentity(owned) === 'same') {
      killFixtureChild(owned);
      await waitForProcessExit(owned, 2000);
    }
  }
});

test('concurrent GC mutations empty only their selected cache and keep results and progress in the calling client', async () => {
  const items = [fixture('delete-first'), fixture('delete-second')];
  const kept = fixture('keep');
  const cwd = process.cwd();
  const env = { ...process.env };
  const exit = process.exitCode;
  const log = vi.spyOn(console, 'log');
  const error = vi.spyOn(console, 'error');
  try {
    const reports = await Promise.all(
      items.map(async (item) => {
        const progress: string[] = [];
        const result = await trackRead((signal) =>
          createStim({
            projectRoot: item.root,
            home: item.home,
            env: item.env,
            onProgress: ({ stream, message }) => {
              expect(stream).toBe('stderr');
              progress.push(message);
            },
          }).collectGarbage({ cache: 'fixture', delete: true, signal }),
        );
        return { item, report: result.report, exitCode: result.exitCode, progress };
      }),
    );
    for (const { item, report, progress, exitCode } of reports) {
      expect(exitCode).toBe(0);
      expect(report.mode).toBe('delete');
      expect(report.failures).toBe(0);
      expect(report.results).toMatchObject([{ kind: 'cache', status: 'done', id: item.cache }]);
      expect(existsSync(join(item.cache, 'artifact'))).toBe(false);
      expect(progress.length).toBeGreaterThan(0);
    }
    expect(readFileSync(join(kept.cache, 'artifact'), 'utf8')).toBe('keep');
    expect(log).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();
    expect(process.cwd()).toBe(cwd);
    expect(process.env).toEqual(env);
    expect(process.exitCode).toBe(exit);
  } finally {
    log.mockRestore();
    error.mockRestore();
  }
});

test.each(
  [
    'cache size',
    'CLI cache size',
    'cache emptying',
    'CLI cache emptying',
    'simulator inventory',
    'emulator inventory',
    'agent-device size',
    'SwiftPM size',
    'machine size',
    'machine tools',
    'Gradle size',
    'Gradle process inventory',
    'Gradle project settings',
    'worktree inventory',
    'worktree size',
    ...(process.platform !== 'win32' ? ['temporary process inventory', 'Jest cache size'] : []),
    ...(process.platform === 'darwin' ? ['orphaned workspace', 'workspace exclusions'] : []),
  ].flatMap((kind) => [false, true].map((unavailable) => ({ kind, unavailable }))),
)('GC $kind declares its native child and preserves cleanup refusal=$unavailable', async ({ kind, unavailable }) => {
  const item = fixture('native-inventory');
  const cli = kind.startsWith('CLI ');
  const emptying = kind.endsWith('cache emptying');
  const cacheProbe = kind === 'cache size' || cli || emptying;
  const workspaceProbe = kind === 'orphaned workspace' || kind === 'workspace exclusions';
  const usageProbe = ['agent-device size', 'SwiftPM size', 'machine size', 'machine tools'].includes(kind);
  const gradleProbe = kind.startsWith('Gradle ');
  const worktreeProbe = kind === 'worktree inventory' || kind === 'worktree size';
  const tempProbe = kind === 'temporary process inventory' || kind === 'Jest cache size';
  const temporary = join(item.home, 'tmp');
  if (tempProbe) {
    mkdirSync(temporary);
    Object.assign(item.env, { TMPDIR: temporary, TMP: temporary, TEMP: temporary });
  }
  const usageDir =
    kind === 'Jest cache size'
      ? join(temporary, `jest_${process.getuid?.().toString(36)}`)
      : kind === 'worktree size'
        ? join(item.root, 'node_modules')
        : kind === 'agent-device size'
          ? join(item.home, 'agent-device')
          : kind === 'SwiftPM size'
            ? join(
                item.env.HOME,
                ...(process.platform === 'darwin' ? ['Library', 'Caches'] : ['.cache']),
                'org.swift.swiftpm',
              )
            : join(item.home, 'gradle', 'caches', gradleProbe ? '9.4.1' : 'modules-2');
  Object.assign(item.env, {
    AGENT_DEVICE_STATE_DIR: join(item.home, 'agent-device'),
    GRADLE_USER_HOME: join(item.home, 'gradle'),
    XDG_CACHE_HOME: join(item.env.HOME, '.cache'),
  });
  if (usageProbe || gradleProbe || kind === 'worktree size') mkdirSync(usageDir, { recursive: true });
  const platform = kind === 'simulator inventory' ? 'ios' : 'android';
  const config = {
    version: 2,
    projects: kind === 'Gradle project settings' || worktreeProbe ? { [item.root]: {} } : {},
    repos: {},
    maintenance: { mode: 'off' },
    parked: {
      [platform]: [
        {
          udid: 'stim-native-probe',
          name: 'stim-native-probe',
          parkedAt: '2026-01-01T00:00:00Z',
          deviceTypeIdentifier: 'iphone',
          runtimeIdentifier: 'runtime',
          simslimManaged: false,
          systemImage: 'system-images;android-35;google_apis;arm64-v8a',
          configuration: '[]',
        },
      ],
    },
  };
  if (!cacheProbe && !workspaceProbe && !usageProbe && !tempProbe)
    writeFileSync(join(item.home, 'config.json'), JSON.stringify(config));
  let preserved = join(item.cache, 'artifact');
  if (tempProbe) {
    if (kind === 'Jest cache size') mkdirSync(usageDir);
    preserved = kind === 'Jest cache size' ? join(usageDir, 'original') : join(temporary, 'instruments-test.ktrace');
    writeFileSync(preserved, 'native-inventory');
    const old = new Date(Date.now() - 48 * 60 * 60 * 1000);
    utimesSync(preserved, old, old);
  }
  if (emptying) {
    mkdirSync(join(item.cache, 'entry'));
    preserved = join(item.cache, 'entry', 'original');
    writeFileSync(preserved, 'native-inventory');
  }
  if (kind === 'worktree size') {
    preserved = join(usageDir, 'original');
    writeFileSync(preserved, 'native-inventory');
  }
  if (workspaceProbe)
    withAmbientContext(testContext({ home: item.home, env: item.env }), () => {
      const gone = join(item.root, 'deleted-worktree');
      const dir = ensureWorkspaceStorage(gone);
      mkdirSync(macosDir(gone), { recursive: true });
      preserved = join(dir, 'original');
      writeFileSync(preserved, 'native-inventory');
    });
  const originalConfig = readFileSync(join(item.home, 'config.json'), 'utf8');
  const tag = `requested-${kind}`;
  const infoFile = join(item.root, 'probe.json');
  const controller = new AbortController();
  const context = testContext({
    home: item.home,
    projectRoot: item.root,
    cwd: item.root,
    env: { ...item.env, STIM_NATIVE_PROBE_TAG: tag },
    signal: AbortSignal.any([fixtureAbort.signal, controller.signal]),
  });
  const exitCode = process.exitCode;
  const stdout: string[] = [];
  const cliLog = cli
    ? vi.spyOn(console, 'log').mockImplementation((value) => {
        stdout.push(String(value));
      })
    : undefined;
  const cliError = cli ? vi.spyOn(console, 'error').mockImplementation(() => {}) : undefined;
  const cliProcess = cli
    ? vi
        .spyOn(cliOperation, 'runProcessOperation')
        .mockImplementation(async <T>(_root: string, work: (context: StimContext) => Promise<T>) => ({
          value: await work(context),
          interrupted: controller.signal.aborted ? 130 : null,
        }))
    : undefined;
  const executor = getExecutor();
  const original = executor.runFileAsync.bind(executor);
  const originalSync = executor.runFile.bind(executor);
  const syncQueries: string[][] = [];
  const sync = vi.spyOn(executor, 'runFile').mockImplementation((file, args, options) => {
    if (workspaceProbe && file === 'ps' && args.includes('pid=,comm=')) {
      syncQueries.push(args);
      return '';
    }
    return originalSync(file, args, options);
  });
  let owned: { pid: number; processToken: string } | undefined;
  const targets: { pid: number; processToken: string }[] = [];
  let handles: ClaimHandle[] = [];
  let observedPid: number | undefined;
  let observedContext: unknown;
  let closed: Promise<void> = Promise.resolve();
  const inspectOriginal = inspectProcessIdentity;
  const inspect = vi
    .spyOn(identities, 'inspectProcessIdentity')
    .mockImplementation((record) =>
      unavailable && owned !== undefined && record?.pid === owned.pid ? 'unknown' : inspectOriginal(record),
    );
  const probe = vi.spyOn(executor, 'runFileAsync').mockImplementation((file, args, options) => {
    const wanted = tempProbe
      ? kind === 'Jest cache size'
        ? file === 'du' && args.includes(usageDir)
        : file === 'ps' && args.includes('comm=')
      : kind === 'worktree size'
        ? file === 'du' && args.includes(usageDir)
        : kind === 'worktree inventory'
          ? file === 'git' && args.includes('worktree')
          : gradleProbe
            ? kind === 'Gradle process inventory'
              ? file === 'ps'
              : kind === 'Gradle project settings'
                ? file === 'git'
                : file === 'du' && args.includes(usageDir)
            : usageProbe
              ? kind === 'machine tools'
                ? file === 'agent-device'
                : file === 'du' && args.includes(usageDir)
              : workspaceProbe
                ? file === 'ps'
                : cacheProbe
                  ? file === 'du' && (!emptying || args.includes(join(item.cache, 'entry')))
                  : kind === 'simulator inventory'
                    ? file === 'xcrun' && args.includes('devices')
                    : /emulator(?:\.exe)?$/.test(file) && args.includes('-list-avds');
    if (!wanted) {
      if (emptying && file === 'du') return Promise.resolve('1');
      if (worktreeProbe && file === 'git' && args.includes('worktree'))
        return Promise.resolve(`worktree ${item.root}\nHEAD ${'1'.repeat(40)}\nbranch refs/heads/main\n`);
      if (usageProbe || gradleProbe || worktreeProbe || tempProbe)
        return Promise.resolve(file === 'du' ? `1\t${args.at(-1)}\n` : '');
      throw new Error(`Unexpected native probe: ${file} ${args.join(' ')}`);
    }
    return original(
      process.execPath,
      [
        '-e',
        'require("node:fs").writeFileSync(process.argv[1],JSON.stringify({pid:process.pid,parent:process.ppid,cwd:process.cwd(),tag:process.env.STIM_NATIVE_PROBE_TAG})); console.log("ready"); ' +
          (cli ? 'setTimeout(()=>{},2000)' : 'setInterval(()=>{},1000)'),
        infoFile,
      ],
      {
        ...options,
        onSpawn: (child) => {
          options.onSpawn?.(child);
          const birth = child.pid === undefined ? null : captureProcessIdentity(child.pid);
          if (!birth?.ok || child.pid === undefined) throw new Error('The fixture native child has no identity');
          owned = { pid: child.pid, processToken: birth.token };
          targets.push(owned);
          handles = [...operationState(options.declareFor).declaring];
          closed = new Promise<void>((resolve) => child.once('close', resolve));
          child.stdout?.once('data', () => {
            const metadata = JSON.parse(readFileSync(infoFile, 'utf8'));
            for (const pid of process.platform === 'win32' ? [metadata.pid, metadata.parent] : [metadata.pid]) {
              if (targets.some((record) => record.pid === pid)) continue;
              const captured = captureProcessIdentity(pid);
              if (!captured.ok) throw new Error(captured.reason);
              targets.push({ pid, processToken: captured.token });
            }
            observedContext = { cwd: metadata.cwd, tag: metadata.tag };
            observedPid = readClaimSet(join(item.home, 'maintenance', 'run.claims')).live[0]?.child?.pid;
            controller.abort();
          });
        },
      },
    );
  });
  const scope = tempProbe ? vi.spyOn(gcDevices, 'deviceSweepIsScoped').mockReturnValue(false) : undefined;
  try {
    const result = trackRead((signal) =>
      cli
        ? withAmbientContext(context, async () => {
            const program = new Command();
            gcCommand(program);
            await program.parseAsync(['node', 'stim', 'gc', '--cache', 'fixture', '--delete', '--json']);
          })
        : createStim({
            projectRoot: item.root,
            home: item.home,
            env: { ...item.env, STIM_NATIVE_PROBE_TAG: tag },
          })
            .collectGarbage({
              cache: gradleProbe
                ? 'gradle-versions'
                : cacheProbe
                  ? 'fixture'
                  : kind === 'workspace exclusions'
                    ? 'workspaces'
                    : workspaceProbe || usageProbe || worktreeProbe || tempProbe
                      ? undefined
                      : 'parked',
              delete: true,
              worktrees: kind === 'worktree size' ? true : undefined,
              signal: AbortSignal.any([signal, controller.signal]),
            })
            .then(() => undefined),
    );
    const failure = await (cli
      ? result.then(() => JSON.parse(stdout[0] ?? ''))
      : result.then(
          () => null,
          (error) => error,
        ));
    expect(failure).toMatchObject({ code: unavailable ? 'STIM_CLAIM_UNAVAILABLE' : 'STIM_CANCELLED' });
    expect(stdout).toHaveLength(cli ? 1 : 0);
    expect(process.exitCode).toBe(cli ? 130 : exitCode);
    if (!owned) throw new Error('The controlled native inventory probe did not start');
    expect(observedPid).toBe(owned.pid);
    expect(syncQueries).toEqual([]);
    expect(observedContext).toEqual({ cwd: item.root, tag });
    const expected = unavailable ? ['same'] : ['gone', 'different'];
    for (const record of targets) expect(expected).toContain(inspectProcessIdentity(record));
    expect(readFileSync(join(item.home, 'config.json'), 'utf8')).toBe(originalConfig);
    for (const path of emptying ? [preserved] : [join(item.cache, 'artifact'), preserved])
      expect(readFileSync(path, 'utf8')).toBe('native-inventory');
    const admission = readClaimSet(join(item.home, 'maintenance', 'run.claims'));
    expect(admission.live).toHaveLength(unavailable ? 1 : 0);
    expect(admission.unresolved).toEqual([]);
  } finally {
    scope?.mockRestore();
    inspect.mockRestore();
    probe.mockRestore();
    sync.mockRestore();
    controller.abort();
    cliProcess?.mockRestore();
    cliLog?.mockRestore();
    cliError?.mockRestore();
    process.exitCode = exitCode;
    for (const record of targets.toReversed()) {
      killFixtureChild(record);
    }
    await closed;
    for (const record of targets) expect(await waitForProcessExit(record, 5000)).toBe(true);
    for (const handle of handles) releaseClaim(handle);
  }
});

test.each([
  ...['idle refresh', 'shutdown inventory', 'shutdown'].map((phase) => ({ phase, unavailable: false })),
  ...['device session inventory', 'device session close'].flatMap((phase) =>
    [false, true].map((unavailable) => ({ phase, unavailable })),
  ),
])(
  'GC idle $phase drains its child and preserves registration with cleanup refusal=$unavailable',
  async ({ phase, unavailable }) => {
    const item = fixture('idle-shutdown');
    const home = join(item.home, '.stim');
    mkdirSync(home);
    const id = 'OWNED-IDLE-SIM';
    const env = {
      ...item.env,
      HOME: item.home,
      USERPROFILE: item.home,
      STIM_HOME: undefined,
      STIM_NATIVE_PROBE_TAG: phase,
      STIM_MAINTENANCE: 'off',
      AGENT_DEVICE_STATE_DIR: join(item.home, 'agent-device'),
      AGENT_DEVICE_CLAIMS_DIR: join(item.home, 'claims'),
      AGENT_DEVICE_IOS_RUNNER_LEASE_DIR: join(item.home, 'leases'),
    };
    const config = JSON.stringify({
      version: 2,
      projects: { [item.root]: { platforms: { ios: { deviceUdid: id, owned: true } } } },
      repos: {},
      maintenance: { mode: 'off' },
    });
    writeFileSync(join(home, 'config.json'), config);
    const ledger = JSON.stringify({ version: 1, ios: [id], android: [], web: [] });
    writeFileSync(join(home, 'created-devices.json'), ledger);
    withAmbientContext(testContext({ home, env, projectRoot: item.root, cwd: item.root }), () => {
      const logs = workspaceLogsDir(item.root);
      mkdirSync(logs, { recursive: true });
      writeFileSync(
        join(logs, 'device.ndjson'),
        JSON.stringify({ ts: Date.now() - 3_600_000, src: 'device', platform: 'ios', msg: 'old app log' }) + '\n',
      );
    });
    const controller = new AbortController();
    const executor = getExecutor();
    const original = executor.runFileAsync.bind(executor);
    const find = executor.findExecutable.bind(executor);
    const executable = vi
      .spyOn(executor, 'findExecutable')
      .mockImplementation((name) => (name === 'agent-device' ? 'fixture-agent-device' : find(name)));
    const sync = vi.spyOn(executor, 'runFile').mockImplementation(() => {
      throw new Error('Idle GC must not execute a synchronous native query');
    });
    const quiet = vi.spyOn(executor, 'runFileQuiet').mockReturnValue(null);
    let listed = 0;
    let observedPid: number | undefined;
    let owned: { pid: number; processToken: string } | undefined;
    let closed: Promise<void> = Promise.resolve();
    let handles: ClaimHandle[] = [];
    const targets: { pid: number; processToken: string }[] = [];
    const inspect = vi
      .spyOn(identities, 'inspectProcessIdentity')
      .mockImplementation((record) =>
        unavailable && owned && record?.pid === owned.pid ? 'unknown' : inspectProcessIdentity(record),
      );
    const infoFile = join(item.root, 'child.json');
    let observedContext: unknown;
    const shutdowns: string[] = [];
    const probe = vi.spyOn(executor, 'runFileAsync').mockImplementation((file, args, options) => {
      const inventory = file === 'xcrun' && args.includes('devices');
      const shutdown = file === 'xcrun' && args[1] === 'shutdown';
      if (inventory) listed++;
      if (shutdown) shutdowns.push(args[2] ?? 'missing device');
      const wanted = phase.startsWith('device session')
        ? file === 'agent-device' && args[0] === (phase === 'device session close' ? 'close' : 'session')
        : phase === 'shutdown'
          ? shutdown
          : inventory && listed === (phase === 'idle refresh' ? 3 : 4);
      if (wanted)
        return original(
          process.execPath,
          [
            '-e',
            'require("node:fs").writeFileSync(process.argv[1],JSON.stringify({pid:process.pid,parent:process.ppid,cwd:process.cwd(),tag:process.env.STIM_NATIVE_PROBE_TAG})); console.log("ready"); ' +
              (unavailable ? 'setInterval(()=>{},1000)' : 'setTimeout(()=>{},250)'),
            infoFile,
          ],
          {
            ...options,
            onSpawn: (child) => {
              options.onSpawn?.(child);
              const birth = child.pid === undefined ? null : captureProcessIdentity(child.pid);
              if (!birth?.ok || child.pid === undefined) throw new Error('The fixture idle child has no identity');
              owned = { pid: child.pid, processToken: birth.token };
              targets.push(owned);
              handles = [...operationState(ambientContext()).declaring];
              closed = new Promise<void>((resolve) => child.once('close', resolve));
              child.stdout?.once('data', () => {
                observedPid = readClaimSet(join(home, 'maintenance', 'run.claims')).live[0]?.child?.pid;
                const metadata = JSON.parse(readFileSync(infoFile, 'utf8'));
                observedContext = { cwd: metadata.cwd, tag: metadata.tag };
                for (const pid of process.platform === 'win32' ? [metadata.pid, metadata.parent] : [metadata.pid]) {
                  if (targets.some((record) => record.pid === pid)) continue;
                  const captured = captureProcessIdentity(pid);
                  if (!captured.ok) throw new Error(captured.reason);
                  targets.push({ pid, processToken: captured.token });
                }
                controller.abort();
              });
            },
          },
        );
      if (file === 'agent-device')
        return Promise.resolve(
          JSON.stringify({
            success: true,
            data: {
              sessions: [
                {
                  name: 'stim-owned',
                  platform: 'ios',
                  device_udid: id,
                  createdAt: 1,
                },
              ],
            },
          }),
        );
      if (inventory)
        return Promise.resolve(
          JSON.stringify({
            devices: {
              'com.apple.CoreSimulator.SimRuntime.iOS-26-5': [
                { udid: id, name: 'stim-idle', state: 'Booted', isAvailable: true, deviceTypeIdentifier: 'iphone' },
              ],
            },
          }),
        );
      return Promise.resolve('');
    });
    try {
      await expect(
        trackRead((signal) =>
          createStim({ projectRoot: item.root, env }).collectGarbage({
            idleMs: 60_000,
            signal: AbortSignal.any([signal, controller.signal]),
          }),
        ),
      ).rejects.toMatchObject({ code: unavailable ? 'STIM_CLAIM_UNAVAILABLE' : 'STIM_CANCELLED' });
      if (!owned) throw new Error('The controlled idle probe did not start');
      expect(observedPid).toBe(owned.pid);
      expect(observedContext).toEqual({ cwd: item.root, tag: phase });
      expect(unavailable ? ['same'] : ['gone', 'different']).toContain(inspectProcessIdentity(owned));
      expect(shutdowns).toEqual(phase === 'shutdown' ? [id] : []);
      expect(readFileSync(join(home, 'config.json'), 'utf8')).toBe(config);
      expect(readFileSync(join(home, 'created-devices.json'), 'utf8')).toBe(ledger);
      expect(readClaimSet(join(home, 'maintenance', 'run.claims')).live.map((holder) => holder.child?.pid)).toEqual(
        unavailable ? [owned.pid] : [],
      );
    } finally {
      controller.abort();
      probe.mockRestore();
      sync.mockRestore();
      quiet.mockRestore();
      executable.mockRestore();
      inspect.mockRestore();
      for (const target of targets.toReversed()) killFixtureChild(target);
      await closed;
      for (const target of targets) expect(await waitForProcessExit(target, 5000)).toBe(true);
      for (const handle of handles) releaseClaim(handle);
    }
  },
);

test.skipIf(process.platform === 'win32' || process.getuid?.() === 0)(
  'GC returns a failed exit status and partial report when a cache entry cannot be deleted',
  async () => {
    const item = fixture('failed-delete');
    const exit = process.exitCode;
    chmodSync(item.cache, 0o500);
    try {
      const result = await trackRead((signal) =>
        createStim({ projectRoot: item.root, home: item.home, env: item.env }).collectGarbage({
          cache: 'fixture',
          delete: true,
          signal,
        }),
      );
      expect(result.exitCode).toBe(1);
      expect(result.report.results).toMatchObject([{ kind: 'cache', status: 'failed', id: item.cache }]);
      expect(readFileSync(join(item.cache, 'artifact'), 'utf8')).toBe('failed-delete');
      expect(process.exitCode).toBe(exit);
    } finally {
      chmodSync(item.cache, 0o700);
    }
  },
);

test('GC mutations in one home refuse concurrent maintenance and name the held claim', async () => {
  const item = fixture('contention');
  const options = { projectRoot: item.root, home: item.home, env: item.env };
  let competing: Promise<unknown> | undefined;
  const result = await trackRead((signal) =>
    createStim({
      ...options,
      onProgress: () => {
        competing ??= createStim(options)
          .collectGarbage({ cache: 'fixture', delete: true, signal })
          .catch((error: unknown) => error);
      },
    }).collectGarbage({ cache: 'fixture', delete: true, signal }),
  );
  expect(result.exitCode).toBe(0);
  if (!competing) throw new Error('The competing maintenance request was not started');
  expect(await competing).toMatchObject({ code: 'STIM_CLAIM_REFUSED', remedy: expect.stringContaining(item.home) });
  const next = await trackRead((signal) =>
    createStim(options).collectGarbage({ cache: 'fixture', delete: true, signal }),
  );
  expect(next.exitCode).toBe(0);
});

test.each(['before mutation', 'between caches'] as const)(
  'cancelling GC %s keeps every remaining cache and releases maintenance admission',
  async (when) => {
    const item = fixture('cancel-caches');
    const second = join(item.home, 'second-cache');
    mkdirSync(second);
    writeFileSync(join(second, 'artifact'), 'second');
    const artifacts = [join(item.cache, 'artifact'), join(second, 'artifact')];
    writeFileSync(
      join(item.home, 'caches.json'),
      JSON.stringify({
        version: 1,
        caches: [
          { name: 'fixture-one', dir: item.cache, prune: 'entries' },
          { name: 'fixture-two', dir: second, prune: 'entries' },
        ],
      }),
    );
    const controller = new AbortController();
    const client = createStim({
      projectRoot: item.root,
      home: item.home,
      env: item.env,
      onProgress: () => {
        if (when === 'before mutation' || artifacts.some((path) => !existsSync(path))) controller.abort();
      },
    });
    await expect(
      trackRead((signal) =>
        client.collectGarbage({ cache: 'fixture', delete: true, signal: AbortSignal.any([signal, controller.signal]) }),
      ),
    ).rejects.toMatchObject({ code: 'STIM_CANCELLED' });
    expect(artifacts.filter(existsSync)).toHaveLength(when === 'before mutation' ? 2 : 1);
    const next = await trackRead((signal) => client.collectGarbage({ cache: 'fixture', delete: true, signal }));
    expect(next.exitCode).toBe(0);
    expect(artifacts.some(existsSync)).toBe(false);
  },
);

test.each([undefined, 'importer-home'])(
  'scoped GC uses the client environment for Gradle remedies with importer home=%s',
  async (importer) => {
    const item = fixture('gradle-scope');
    const gradle = join(scratch, 'gradle');
    mkdirSync(join(gradle, 'caches', '9.3.1'), { recursive: true });
    vi.stubEnv('STIM_HOME', importer ? join(scratch, importer) : undefined);
    const report = await trackRead((signal) =>
      createStim({ projectRoot: item.root, home: item.home, env: { ...item.env, GRADLE_USER_HOME: gradle } }).gc({
        signal,
      }),
    );
    expect(report.sections.machineCaches?.gradle.unusedVersions).toMatchObject([{ version: '9.3.1', remedy: null }]);
  },
);

test('GC API matches CLI JSON and ignores mutation options supplied by a JavaScript caller', async () => {
  const item = fixture('parity');
  const ctx: StimContext = {
    home: item.home,
    buildCache: null,
    projectRoot: item.root,
    cwd: item.root,
    env: item.env,
    runId: 'report-parity',
    signal: new AbortController().signal,
    output: () => {},
  };
  let json = '';
  const log = vi.spyOn(console, 'log').mockImplementation((text: unknown) => {
    json = String(text);
  });
  const error = vi.spyOn(console, 'error').mockImplementation(() => {});
  try {
    await withAmbientContext(ctx, () => runGc({ cache: 'fixture', json: true }, { operation: ctx }));
  } finally {
    log.mockRestore();
    error.mockRestore();
  }
  const request = { cache: 'fixture', delete: true, idle: 0 };
  const result = await createStim({ projectRoot: item.root, home: item.home, env: item.env }).gc(request);
  expect(result).toEqual(JSON.parse(json));
  expect(readFileSync(join(item.cache, 'artifact'), 'utf8')).toBe('parity');
});

test.each([{ cache: 'fixture', worktrees: true }, { cache: 'archived:missing-id' }])(
  'a GC refusal for %j leaves the importing process and console unchanged',
  async (request) => {
    const item = fixture('refusal');
    const exit = process.exitCode;
    const log = vi.spyOn(console, 'log');
    const error = vi.spyOn(console, 'error');
    try {
      await expect(
        createStim({ projectRoot: item.root, home: item.home, env: item.env }).gc(request),
      ).rejects.toMatchObject({ code: 'STIM_BAD_ARG' });
      expect(process.exitCode).toBe(exit);
      expect(log).not.toHaveBeenCalled();
      expect(error).not.toHaveBeenCalled();
      expect(existsSync(join(item.cache, 'artifact'))).toBe(true);
    } finally {
      process.exitCode = exit;
      log.mockRestore();
      error.mockRestore();
    }
  },
);

test('GC resolves cache environment paths relative to each client project', async () => {
  const fixtures = [fixture('environment-first'), fixture('environment-second')];
  const reports = await Promise.all(
    fixtures.map(async (item) => {
      const directory = join(item.root, 'gradle-home', 'caches', 'build-cache-1');
      mkdirSync(directory, { recursive: true });
      writeFileSync(join(directory, 'artifact'), item.root);
      const report = await createStim({
        projectRoot: item.root,
        home: item.home,
        env: { ...item.env, GRADLE_USER_HOME: 'gradle-home' },
      }).gc({ cache: 'Gradle build cache' });
      return { report, directory };
    }),
  );
  for (const { report, directory } of reports)
    expect(report.sections.caches.map((entry) => entry.dir)).toEqual([directory]);
});

test('Gradle cache age inspection lets the event loop run while reading directory metadata', async () => {
  const item = fixture('gradle-metadata');
  const gradle = join(item.home, 'gradle');
  const version = join(gradle, 'caches', '8.14');
  mkdirSync(version, { recursive: true });
  for (let i = 0; i < 100; i++) writeFileSync(join(version, `entry-${i}`), 'cached');
  const operation: StimContext = {
    home: item.home,
    buildCache: null,
    cwd: item.root,
    projectRoot: item.root,
    env: { ...item.env, GRADLE_USER_HOME: gradle },
    runId: 'metadata-proof',
    signal: new AbortController().signal,
    output: () => {},
  };
  let ticked = false;
  const executor = getExecutor();
  const original = executor.runFileAsync.bind(executor);
  const read = vi.spyOn(executor, 'runFileAsync').mockImplementation(async (file, args, options) => {
    if (file === 'ps') {
      setImmediate(() => {
        ticked = true;
      });
      return '';
    }
    return original(file, args, options);
  });
  try {
    const report = await withAmbientContext(operation, () => collectGradleVersions({ operation, measure: false }));
    expect(report.versions.some((entry) => entry.version === '8.14')).toBe(true);
    expect(ticked).toBe(true);
  } finally {
    read.mockRestore();
  }
});

test('explicit doctor checks record completed platforms in their own homes while report reads stay read-only', async () => {
  const probe = vi.spyOn(git, 'gitQuietAsync').mockResolvedValue(null);
  const first = fixture('first-check');
  const second = fixture('second-check');
  const items = [first, second];
  for (const item of items) {
    writeFileSync(join(item.root, 'package.json'), JSON.stringify({ dependencies: { 'react-native': '*' } }));
  }
  const firstClient = createStim({ projectRoot: first.root, home: first.home, env: first.env });
  const secondClient = createStim({ projectRoot: second.root, home: second.home, env: second.env });
  try {
    await trackRead((signal) => firstClient.doctor({ platform: 'ios', signal }));
    expect(JSON.parse(readFileSync(join(first.home, 'config.json'), 'utf8'))).toEqual({
      maintenance: { mode: 'off' },
    });
    await expect(firstClient.doctor({ record: true, signal: AbortSignal.abort() })).rejects.toMatchObject({
      code: 'STIM_CANCELLED',
    });
    expect(JSON.parse(readFileSync(join(first.home, 'config.json'), 'utf8'))).toEqual({
      maintenance: { mode: 'off' },
    });
    const before = Date.now();
    await Promise.all([
      trackRead((signal) => firstClient.doctor({ platform: 'ios', record: true, signal })),
      trackRead((signal) => secondClient.doctor({ platform: 'android', record: true, signal })),
    ]);
    for (const [index, item] of items.entries()) {
      const config = JSON.parse(readFileSync(join(item.home, 'config.json'), 'utf8'));
      const platform = index === 0 ? 'ios' : 'android';
      expect(Object.keys(config.projects)).toEqual([item.root]);
      const runs = config.projects[item.root].doctorRuns;
      expect(Object.keys(runs)).toEqual([platform]);
      expect(runs[platform].version).toBe(
        JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')).version,
      );
      expect(Date.parse(runs[platform].at)).toBeGreaterThanOrEqual(before);
      expect(Date.parse(runs[platform].at)).toBeLessThanOrEqual(Date.now());
    }
    expect(existsSync(join(scratch, 'caller', 'config.json'))).toBe(false);
  } finally {
    probe.mockRestore();
  }
});

test('doctor reports the selected project without synchronous children or recording a CLI run', async () => {
  const item = fixture('doctor');
  const run = vi.spyOn(getExecutor(), 'run').mockImplementation(() => {
    throw new Error('Synchronous child');
  });
  const file = vi.spyOn(getExecutor(), 'runFile').mockImplementation(() => {
    throw new Error('Synchronous child');
  });
  const quiet = vi.spyOn(getExecutor(), 'runFileQuiet').mockImplementation(() => {
    throw new Error('Synchronous child');
  });
  try {
    const report = await createStim({ projectRoot: item.root, home: item.home, env: item.env }).doctor();
    expect(report.project).toBe(item.root);
    expect(report.findings.some((finding) => finding.code === 'not-an-app')).toBe(true);
    expect(run).not.toHaveBeenCalled();
    expect(file).not.toHaveBeenCalled();
    expect(quiet).not.toHaveBeenCalled();
    expect(JSON.parse(readFileSync(join(item.home, 'config.json'), 'utf8'))).toEqual({ maintenance: { mode: 'off' } });
  } finally {
    run.mockRestore();
    file.mockRestore();
    quiet.mockRestore();
  }
});

test.each([false, true])('doctor device-cap reads stay responsive with cancellation=%s', async (cancel) => {
  const item = fixture('device-cap');
  writeFileSync(
    join(item.home, 'config.json'),
    JSON.stringify({
      version: 2,
      projects: { [item.root]: { platforms: { android: { avdName: 'stim-owned', consolePort: 5554, owned: true } } } },
      repos: {},
      maintenance: { mode: 'off' },
      concurrency: cancel ? { maxBuilds: 1 } : { maxDevices: 2 },
    }),
  );
  const controller = new AbortController();
  const executor = getExecutor();
  const original = executor.runFileAsync.bind(executor);
  const sync = vi.spyOn(executor, 'runFile').mockImplementation(() => {
    throw new Error('Synchronous child');
  });
  let pid: number | undefined;
  let ticked = false;
  const probe = vi.spyOn(executor, 'runFileAsync').mockImplementation((file, args, options) => {
    if (file === 'xcrun' && args.includes('list')) return Promise.resolve('{"devices":{}}');
    if (args.length === 1 && args[0] === 'devices') {
      return original(
        process.execPath,
        [
          '-e',
          'console.log("ready"); setTimeout(() => console.log("List of devices attached\\nemulator-5554\\tdevice\\nemulator-5556\\tdevice"), 150);',
        ],
        {
          ...options,
          onSpawn: (child) => {
            pid = child.pid;
            child.stdout?.once('data', () =>
              setImmediate(() => {
                ticked = true;
                if (cancel) controller.abort();
              }),
            );
          },
        },
      );
    }
    return original(file, args, options);
  });
  try {
    const reading = trackRead((signal) =>
      createStim({
        projectRoot: item.root,
        home: item.home,
        env: {
          ...item.env,
          PATH: dirname(process.execPath),
          ANDROID_HOME: join(item.home, 'sdk'),
          ANDROID_SDK_ROOT: join(item.home, 'sdk'),
        },
      }).doctor({ signal: AbortSignal.any([signal, controller.signal]) }),
    );
    const result = await reading.then(
      (report) => report.findings.find((entry) => entry.title === 'Concurrency limits are set')?.detail,
      (error: { code?: string }) => error.code,
    );
    expect(result).toEqual(expect.stringContaining(cancel ? 'STIM_CANCELLED' : '1 Stim device(s) are booted'));
    expect(ticked).toBe(true);
    expect(sync).not.toHaveBeenCalled();
    if (pid === undefined) throw new Error('The controlled device listing did not start');
    const ownPid = pid;
    expect(() => process.kill(ownPid, 0)).toThrow(/ESRCH/);
  } finally {
    controller.abort();
    await Promise.allSettled(activeReports);
    probe.mockRestore();
    sync.mockRestore();
  }
});

test('throwing from report progress cancels the read and preserves the original callback error', async () => {
  const item = fixture('callback');
  const failure = new Error('stop this report');
  await expect(
    createStim({
      projectRoot: item.root,
      home: item.home,
      env: item.env,
      onProgress: () => {
        throw failure;
      },
    }).gc({ cache: 'fixture' }),
  ).rejects.toBe(failure);
  expect(readFileSync(join(item.cache, 'artifact'), 'utf8')).toBe('callback');
});

test.each(['build', 'device-host'] as const)(
  'doctor cancellation interrupts a contended %s credential update',
  async (access) => {
    const item = fixture('contended-approval');
    const probe = vi.spyOn(git, 'gitQuietAsync').mockResolvedValue(null);
    writeFileSync(join(item.root, 'package.json'), JSON.stringify({ dependencies: { 'react-native': '*' } }));
    writeFileSync(join(item.home, 'config.json'), JSON.stringify({ remote: { machines: ['mini'] } }));
    const name = access === 'build' ? 'build-machines' : 'device-host-machines';
    const file = join(item.home, `${name}.json`);
    const pending = JSON.stringify({
      version: 2,
      machines: [
        {
          machine: 'mini',
          transport: 'tailscale',
          address: 'mini.tail1.ts.net',
          state: 'pending',
          requestedAt: new Date().toISOString(),
          ticket: 't'.repeat(42) + 'A',
        },
      ],
    });
    writeFileSync(file, pending);
    const lock = join(item.home, `${name}.lock`);
    mkdirSync(lock);
    const controller = new AbortController();
    let ticked = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const io = vi.spyOn(tailnet, 'doctorIo').mockReturnValue({
      status: () => ({
        BackendState: 'Running',
        Self: {},
        Peer: { mini: { ID: 'mini', DNSName: 'mini.tail1.ts.net', TailscaleIPs: ['100.64.0.7'], OS: 'macOS' } },
      }),
      hello: async () => {
        timer = setTimeout(() => {
          ticked = true;
          controller.abort();
        }, 50);
        return {
          result: { capabilities: [access], device: { id: 'worker', name: 'worker' } },
          serverKey: 's'.repeat(42) + 'A',
        };
      },
    });
    try {
      await expect(
        trackRead((signal) =>
          createStim({ projectRoot: item.root, home: item.home, env: item.env }).doctor({
            signal: AbortSignal.any([controller.signal, signal]),
            record: true,
            platform: 'ios',
          }),
        ),
      ).rejects.toMatchObject({ code: 'STIM_CANCELLED' });
      expect(ticked).toBe(true);
      expect(readFileSync(file, 'utf8')).toBe(pending);
      expect(existsSync(lock)).toBe(true);
      expect(JSON.parse(readFileSync(join(item.home, 'config.json'), 'utf8')).projects).toBeUndefined();
    } finally {
      clearTimeout(timer);
      controller.abort();
      io.mockRestore();
      probe.mockRestore();
      rmSync(lock, { recursive: true, force: true });
    }
  },
);

test('doctor preflight cannot signal a Git probe whose birth capture failed', async () => {
  const item = fixture('preflight-identity');
  const controller = new AbortController();
  const executor = getExecutor();
  const original = executor.runFileAsync.bind(executor);
  let owned: { pid: number; processToken: string } | undefined;
  const targets: { pid: number; processToken: string }[] = [];
  const targetPid = join(item.root, 'probe.pid');
  let closed: Promise<void> = Promise.resolve();
  const capture = vi
    .spyOn(identities, 'captureProcessIdentity')
    .mockReturnValue({ ok: false, reason: 'ACCESS_DENIED' });
  const probe = vi.spyOn(executor, 'runFileAsync').mockImplementation((file, args, options) => {
    if (file !== 'git' || !args.includes('--git-common-dir')) return original(file, args, options);
    return original(
      process.execPath,
      [
        '-e',
        `require('node:fs').writeFileSync(${JSON.stringify(targetPid)}, JSON.stringify({pid: process.pid, parentPid: process.ppid})); console.log("ready"); setTimeout(() => {}, 5000)`,
      ],
      {
        ...options,
        onSpawn: (child) => {
          options.onSpawn?.(child);
          if (child.pid === undefined) throw new Error('No fixture Git probe PID');
          const identity = captureProcessIdentity(child.pid);
          if (!identity.ok) throw new Error(identity.reason);
          owned = { pid: child.pid, processToken: identity.token };
          closed = new Promise<void>((resolve) => child.once('close', resolve));
          child.stdout?.once('data', () => {
            const metadata: { pid: number; parentPid: number } = JSON.parse(readFileSync(targetPid, 'utf8'));
            for (const pid of process.platform === 'win32' ? [metadata.pid, metadata.parentPid] : [metadata.pid]) {
              const born = captureProcessIdentity(pid);
              if (!born.ok) throw new Error(born.reason);
              targets.push({ pid, processToken: born.token });
            }
            controller.abort();
          });
        },
      },
    );
  });
  try {
    await expect(
      createStim({ projectRoot: item.root, home: item.home, env: item.env }).doctor({ signal: controller.signal }),
    ).rejects.toMatchObject({ code: 'STIM_CLAIM_UNAVAILABLE' });
    expect(inspectProcessIdentity(owned)).toBe('same');
    for (const record of targets) expect(inspectProcessIdentity(record)).toBe('same');
  } finally {
    capture.mockRestore();
    probe.mockRestore();
    controller.abort();
    [...targets, owned].forEach(killFixtureChild);
    await closed;
    await Promise.all(targets.map(async (record) => expect(await waitForProcessExit(record, 5000)).toBe(true)));
  }
});

test('cancelled doctor does not persist a remote approval arriving after cancellation', async () => {
  const item = fixture('late-approval');
  writeFileSync(join(item.home, 'config.json'), JSON.stringify({ remote: { machines: ['mini'] } }));
  const file = join(item.home, 'build-machines.json');
  const pending = JSON.stringify({
    version: 2,
    machines: [
      {
        machine: 'mini',
        transport: 'tailscale',
        address: 'mini.tail1.ts.net',
        state: 'pending',
        requestedAt: new Date().toISOString(),
        ticket: 't'.repeat(42) + 'A',
      },
    ],
  });
  writeFileSync(file, pending);
  const controller = new AbortController();
  const io = vi.spyOn(tailnet, 'doctorIo').mockReturnValue({
    status: () => ({
      BackendState: 'Running',
      Self: {},
      Peer: {
        mini: { ID: 'mini', DNSName: 'mini.tail1.ts.net', TailscaleIPs: ['100.64.0.7'], OS: 'macOS' },
      },
    }),
    hello: async () => {
      controller.abort();
      return {
        result: { capabilities: ['build'], device: { id: 'worker', name: 'worker' } },
        serverKey: 's'.repeat(42) + 'A',
      };
    },
  });
  try {
    await expect(
      createStim({ projectRoot: item.root, home: item.home, env: item.env }).doctor({ signal: controller.signal }),
    ).rejects.toMatchObject({ code: 'STIM_CANCELLED' });
    expect(readFileSync(file, 'utf8')).toBe(pending);
  } finally {
    io.mockRestore();
  }
});

test('concurrent doctor clients use their own maintenance and compiler-cache environment', async () => {
  const items = [fixture('doctor-env-first'), fixture('doctor-env-second')];
  for (const item of items) {
    writeFileSync(join(item.root, 'package.json'), JSON.stringify({ dependencies: { 'react-native': '0.80.0' } }));
    mkdirSync(join(item.root, 'android'));
    writeFileSync(join(item.root, 'manifest.json'), '{}');
  }
  const reports = await Promise.all(
    items.map((item, index) =>
      trackRead((signal) =>
        createStim({
          projectRoot: item.root,
          home: item.home,
          env: {
            ...item.env,
            ...(process.platform === 'win32'
              ? {
                  PATH: dirname(process.execPath),
                  JAVA_HOME: join(item.home, 'jdk'),
                  ANDROID_HOME: join(item.home, 'android-sdk'),
                  ANDROID_SDK_ROOT: join(item.home, 'android-sdk'),
                }
              : {}),
            STIM_MAINTENANCE: index === 0 ? 'report' : 'off',
            ...(index === 0 ? { STIM_ANDROID_CAS_TOOLCHAIN: 'manifest.json' } : {}),
          },
        }).doctor({ platform: 'android', signal }),
      ),
    ),
  );
  expect(reports.map((report) => report.maintenance.mode)).toEqual(['report', 'off']);
  expect(reports[0]?.findings.some((finding) => finding.detail.includes('STIM_ANDROID_CAS_TOOLCHAIN'))).toBe(true);
  expect(reports[1]?.findings.some((finding) => finding.detail.includes('STIM_ANDROID_CAS_TOOLCHAIN'))).toBe(false);
});

test(
  'GC pressure previews inspect real worktree artifacts without synchronous children',
  async () => {
    const item = fixture('pressure-preview');
    const repo = join(scratch, 'pressure-repository');
    const build = join(repo, 'android', 'build');
    mkdirSync(build, { recursive: true });
    writeFileSync(join(repo, 'package.json'), '{}');
    writeFileSync(join(build, 'keep'), 'regenerable bytes');
    const executor = getExecutor();
    const gitExecutable = executor.findExecutable('git');
    if (!gitExecutable) throw new Error('The pressure fixture requires Git');
    for (const args of [
      ['init', '-b', 'main'],
      [
        '-c',
        'commit.gpgsign=false',
        '-c',
        'user.name=Fixture',
        '-c',
        'user.email=fixture@example.test',
        'commit',
        '--allow-empty',
        '-m',
        'fixture',
      ],
    ])
      await executor.runFileAsync('git', args, { cwd: repo, timeoutMs: 10_000 });
    writeFileSync(
      join(item.home, 'config.json'),
      JSON.stringify({
        version: 2,
        projects: { [repo]: {} },
        repos: {},
        maintenance: { mode: 'report' },
      }),
    );
    const sync = vi.spyOn(executor, 'runFile');
    const quiet = vi.spyOn(executor, 'runFileQuiet');
    try {
      const report = await trackRead((signal) =>
        createStim({
          projectRoot: item.root,
          home: item.home,
          env: {
            ...item.env,
            ...(process.platform === 'win32'
              ? {
                  PATH: [dirname(process.execPath), dirname(gitExecutable)].join(delimiter),
                  JAVA_HOME: join(item.home, 'jdk'),
                  ANDROID_HOME: join(item.home, 'android-sdk'),
                  ANDROID_SDK_ROOT: join(item.home, 'android-sdk'),
                }
              : {}),
            STIM_MAINTENANCE: 'report',
            STIM_BUDGET_MIN_FREE_DISK_GB: '1000000',
            STIM_MAINTENANCE_REMOVE_FINISHED_WORKTREES: 'false',
            STIM_MAINTENANCE_GRADLE_VERSION_IDLE_DAYS: '0',
          },
        }).gc({ cache: 'fixture', signal }),
      );
      expect(report.maintenance?.mode).toBe('report');
      expect(report.maintenance?.skips.some((entry) => entry.target === build)).toBe(true);
      expect(sync).not.toHaveBeenCalled();
      expect(quiet).not.toHaveBeenCalled();
      expect(readFileSync(join(build, 'keep'), 'utf8')).toBe('regenerable bytes');
    } finally {
      sync.mockRestore();
      quiet.mockRestore();
    }
  },
  process.platform === 'win32' ? 70_000 : 5000,
);

test.each([false, true])(
  'aborting doctor drains a verified probe or refuses unavailable identity (%s)',
  { skip: process.platform === 'win32' },
  async (unavailable) => {
    const item = fixture('cancel-doctor');
    const bin = join(item.home, 'bin');
    mkdirSync(bin);
    const executable = join(bin, 'stim');
    const pidFile = join(item.home, 'probe-pid');
    writeFileSync(
      executable,
      `#!${process.execPath}\nrequire('node:fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); setTimeout(() => {}, 5000);\n`,
      {
        mode: 0o755,
      },
    );
    const controller = new AbortController();
    let pid: number | undefined;
    let owned: { pid: number; processToken: string } | undefined;
    const inspectOriginal = inspectProcessIdentity;
    const inspect = vi
      .spyOn(identities, 'inspectProcessIdentity')
      .mockImplementation((record) => (unavailable && record?.pid === pid ? 'unknown' : inspectOriginal(record)));
    const reading = createStim({ projectRoot: item.root, home: item.home, env: { ...item.env, PATH: bin } })
      .doctor({
        signal: controller.signal,
      })
      .catch((error: unknown) => error);
    try {
      const deadline = performance.now() + 3000;
      while (!owned && performance.now() < deadline) {
        try {
          pid = Number(readFileSync(pidFile, 'utf8'));
          const identity = captureProcessIdentity(pid);
          if (identity.ok) owned = { pid, processToken: identity.token };
        } catch {}
        if (!owned) await new Promise((resolve) => setTimeout(resolve, 20));
      }
      if (pid === undefined) throw new Error('The controlled version probe did not start');
      controller.abort();
      expect(await reading).toMatchObject({ code: unavailable ? 'STIM_CLAIM_UNAVAILABLE' : 'STIM_CANCELLED' });
      expect(inspectProcessIdentity(owned)).toBe(unavailable ? 'same' : 'gone');
    } finally {
      inspect.mockRestore();
      controller.abort();
      killFixtureChild(owned);
      await reading;
      const deadline = performance.now() + 2000;
      while (inspectProcessIdentity(owned) === 'same' && performance.now() < deadline)
        await new Promise((resolve) => setTimeout(resolve, 20));
      expect(inspectProcessIdentity(owned)).not.toBe('same');
    }
  },
);

test.each(
  [null, 'absolute', 'relative'].flatMap((leasePath) => [false, true].map((mutation) => ({ leasePath, mutation }))),
)(
  'unscoped GC respects runner lease paths ($leasePath, mutation=$mutation) without synchronous children',
  async ({ leasePath, mutation }) => {
    const item = fixture('unscoped-activity');
    const defaultHome = join(item.home, '.stim');
    mkdirSync(defaultHome);
    const id = 'OWNED-REPORT-SIM';
    writeFileSync(
      join(defaultHome, 'config.json'),
      JSON.stringify({
        version: 2,
        projects: { [item.root]: { platforms: { ios: { deviceUdid: id, deviceName: 'stim-report', owned: true } } } },
        repos: {},
        maintenance: { mode: 'off' },
      }),
    );
    writeFileSync(
      join(defaultHome, 'created-devices.json'),
      JSON.stringify({ version: 1, ios: [id], android: [], web: [] }),
    );
    const leaseDir = join(item.root, 'fixture-leases');
    mkdirSync(join(leaseDir, `${id}.json`), { recursive: true });
    const controller = new AbortController();
    const executor = getExecutor();
    const original = executor.runFileAsync.bind(executor);
    const sync = vi.spyOn(executor, 'runFileQuiet').mockReturnValue(null);
    let pid: number | undefined;
    let devicesListed = false;
    const probe = vi.spyOn(executor, 'runFileAsync').mockImplementation((file, args, options) => {
      if (file === 'ps' && args.includes('-axww') && devicesListed)
        return original(process.execPath, ['-e', 'setTimeout(() => {}, 150)'], {
          ...options,
          onSpawn: (child) => {
            pid = child.pid;
          },
        });
      if (file === 'xcrun' && args.includes('devices')) {
        devicesListed = true;
        return Promise.resolve(
          JSON.stringify({
            devices: {
              'com.apple.CoreSimulator.SimRuntime.iOS-26-5': [
                { udid: id, name: 'stim-report', state: 'Booted', isAvailable: true, deviceTypeIdentifier: 'iphone' },
              ],
            },
          }),
        );
      }
      return Promise.resolve('');
    });
    try {
      const client = createStim({
        projectRoot: item.root,
        env: {
          ...item.env,
          HOME: item.home,
          USERPROFILE: item.home,
          STIM_HOME: undefined,
          STIM_MAINTENANCE: 'off',
          AGENT_DEVICE_STATE_DIR: join(item.home, 'agent-device'),
          AGENT_DEVICE_IOS_RUNNER_LEASE_DIR:
            leasePath === null ? undefined : leasePath === 'relative' ? 'fixture-leases' : leaseDir,
        },
      });
      const report = mutation
        ? (await client.collectGarbage({ idleMs: 1000, signal: controller.signal })).report
        : await client.gc({ signal: controller.signal });
      expect(sync).not.toHaveBeenCalled();
      expect('sections' in report && report.sections.idleDevices.some((entry) => entry.id === id)).toBe(
        leasePath === null,
      );
      if (pid === undefined) throw new Error('The controlled activity probe did not start');
      const ownPid = pid;
      expect(() => process.kill(ownPid, 0)).toThrow(/ESRCH/);
      expect(readFileSync(join(defaultHome, 'created-devices.json'), 'utf8')).toContain(id);
    } finally {
      controller.abort();
      probe.mockRestore();
      sync.mockRestore();
    }
  },
);
