import { captureProcessIdentity, inspectProcessIdentity, waitForProcessExit } from '@stim-cli/core/process-identity';
import * as identities from '../process-identity.ts';
import * as git from '../workspace/git.ts';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import { withAmbientContext, type StimContext } from '@stim-cli/core';
import { createStim } from '../api.ts';
import { runGc } from '../commands/gc.ts';
import { recordGcResult, takeGcResults } from '../commands/gc/results.ts';
import { getExecutor } from '../exec.ts';
import { collectGradleVersions } from '../commands/gc/gradle-versions.ts';
import * as tailnet from '../offload/tailnet.ts';

let scratch: string;
let fixtureAbort: AbortController;
let activeReports: Set<Promise<unknown>>;
beforeEach(() => {
  scratch = realpathSync(mkdtempSync(join(tmpdir(), 'stim-api-reports-')));
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
    PATH: process.platform === 'win32' ? process.env.PATH : `${dirname(process.execPath)}:/usr/bin:/bin`,
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
    [...targets, owned].forEach((record) => {
      if (!record || inspectProcessIdentity(record) !== 'same') return;
      try {
        process.kill(record.pid, 'SIGKILL');
      } catch (error) {
        if (!(error instanceof Error && 'code' in error && error.code === 'ESRCH')) throw error;
      }
    });
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
      if (owned && inspectProcessIdentity(owned) === 'same') process.kill(owned.pid, 'SIGKILL');
      await reading;
      const deadline = performance.now() + 2000;
      while (inspectProcessIdentity(owned) === 'same' && performance.now() < deadline)
        await new Promise((resolve) => setTimeout(resolve, 20));
      expect(inspectProcessIdentity(owned)).not.toBe('same');
    }
  },
);

test.each([null, 'absolute', 'relative'])(
  'an unscoped GC read respects runner lease paths (%s) without synchronous children',
  async (leasePath) => {
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
      const report = await createStim({
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
      }).gc({ signal: controller.signal });
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
