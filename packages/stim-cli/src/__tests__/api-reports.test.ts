import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
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
  rmSync(scratch, { recursive: true, force: true });
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

test('a GC refusal leaves the importing process exit code unchanged', async () => {
  const item = fixture('refusal');
  const exit = process.exitCode;
  await expect(
    createStim({ projectRoot: item.root, home: item.home, env: item.env }).gc({ cache: 'fixture', worktrees: true }),
  ).rejects.toMatchObject({ code: 'STIM_BAD_ARG' });
  expect(process.exitCode).toBe(exit);
  expect(existsSync(join(item.cache, 'artifact'))).toBe(true);
});

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

test('GC pressure previews inspect real worktree artifacts without synchronous children', async () => {
  const item = fixture('pressure-preview');
  const repo = join(scratch, 'pressure-repository');
  const build = join(repo, 'android', 'build');
  mkdirSync(build, { recursive: true });
  writeFileSync(join(repo, 'package.json'), '{}');
  writeFileSync(join(build, 'keep'), 'regenerable bytes');
  const executor = getExecutor();
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
});

test.skipIf(process.platform === 'win32')(
  'aborting doctor reaps a real PATH version probe before returning STIM_CANCELLED',
  async () => {
    const item = fixture('cancel-doctor');
    const bin = join(item.home, 'bin');
    mkdirSync(bin);
    const executable = join(bin, 'stim');
    writeFileSync(executable, `#!${process.execPath}\nconsole.log('ready'); setTimeout(() => {}, 3000);\n`, {
      mode: 0o755,
    });
    const controller = new AbortController();
    let pid: number | undefined;
    const executor = getExecutor();
    const original = executor.spawn.bind(executor);
    const spy = vi.spyOn(executor, 'spawn').mockImplementation((command, args, options) => {
      const child = original(command, args, options);
      if (command === executable) {
        pid = child.pid;
        child.stdout?.once('data', () => controller.abort());
      }
      return child;
    });
    try {
      await expect(
        createStim({ projectRoot: item.root, home: item.home, env: { ...item.env, PATH: bin } }).doctor({
          signal: controller.signal,
        }),
      ).rejects.toMatchObject({ code: 'STIM_CANCELLED' });
      if (pid === undefined) throw new Error('The controlled version probe did not start');
      const ownPid = pid;
      expect(() => process.kill(ownPid, 0)).toThrow(/ESRCH/);
    } finally {
      spy.mockRestore();
    }
  },
);

test('an unscoped GC read measures idle owned devices without synchronous children', async () => {
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
      },
    }).gc({ signal: controller.signal });
    expect(sync).not.toHaveBeenCalled();
    expect('sections' in report && report.sections.idleDevices.some((entry) => entry.id === id)).toBe(true);
    if (pid === undefined) throw new Error('The controlled activity probe did not start');
    const ownPid = pid;
    expect(() => process.kill(ownPid, 0)).toThrow(/ESRCH/);
    expect(readFileSync(join(defaultHome, 'created-devices.json'), 'utf8')).toContain(id);
  } finally {
    controller.abort();
    probe.mockRestore();
    sync.mockRestore();
  }
});
