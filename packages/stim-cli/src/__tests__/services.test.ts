import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildSlotPath } from '@stim-cli/core/state';
import { releaseBuildSlot, tryAcquireBuildSlot } from '../engine/build-slots.ts';
import { liveWaiters } from '../engine/wait-queue.ts';
import { readClaimSet } from '../ownership-claim.ts';
import * as daemon from '../daemon/client.ts';
import { goneClaimOwner, plantClaim } from './_factories.ts';
import { testContext } from './_context.ts';
import { runCli } from '../cli/define-op.ts';
import servicesOp from '../commands/services.ts';
import { resetExecutor, setExecutor, type Executor } from '../exec.ts';
import {
  declaredServicesFrom,
  resumeServices,
  serviceId,
  serviceRecords,
  startOrder,
  startServices,
  stopServices,
  substitute,
  teardownServices,
} from '../services.ts';
import { updateWorkspaceState } from '../workspace/workspace-state.ts';

test('plain services output shows a failed teardown and its recovery command', async () => {
  const home = mkdtempSync(join(tmpdir(), 'stim-services-output-'));
  const previousHome = process.env.STIM_HOME;
  const previousCwd = process.cwd();
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  try {
    process.env.STIM_HOME = join(home, 'stim');
    process.chdir(home);
    const root = process.cwd();
    writeFileSync(join(root, 'package.json'), '{}');
    writeFileSync(join(root, '.stim.json'), JSON.stringify({ services: { db: { start: 'db up', stop: 'db stop' } } }));
    const failure = `teardown command exited with status 1; run by hand in ${root}: db destroy`;
    updateWorkspaceState(root, (state) => ({
      ...state,
      services: {
        db: {
          kind: 'commands',
          cwd: root,
          env: {},
          dependsOn: [],
          ports: {},
          reverse: [],
          start: ['db', 'up'],
          stop: ['db', 'stop'],
          state: 'stopped',
          at: new Date().toISOString(),
          teardownFailure: failure,
        },
      },
    }));
    await runCli(servicesOp, [], { version: '0.0.0' });
    expect(log).toHaveBeenCalledWith(`db  stopped; teardown failed: ${failure}`);
  } finally {
    log.mockRestore();
    process.chdir(previousCwd);
    if (previousHome === undefined) delete process.env.STIM_HOME;
    else process.env.STIM_HOME = previousHome;
    rmSync(home, { recursive: true, force: true });
  }
});

const values = { web: '8900', api: '8901', id: 'web-0123456789abcdef', dir: '/w/app', 'db.pg': '8902' };

test.each<[string, string, string]>([
  ['a port', 'python -m http.server {web}', 'python -m http.server 8900'],
  ['several ports in one value', 'http://127.0.0.1:{api}/x?web={web}', 'http://127.0.0.1:8901/x?web=8900'],
  ["another service's port", 'postgres://127.0.0.1:{db.pg}/app', 'postgres://127.0.0.1:8902/app'],
  ['the workspace id and the working directory', '{id}:{dir}', 'web-0123456789abcdef:/w/app'],
  ['doubled braces as literal braces', '{{"port": {web}}}', '{"port": 8900}'],
])('substitute replaces %s', (_name, text, expected) => {
  expect(substitute(text, values, 'services.web.start')).toBe(expected);
});

test.each<[string, string, RegExp]>([
  ['an unknown name', '{nope}', /names \{nope\}, which is not one of its ports/],
  ['an unmatched open brace', 'x{web', /unmatched \{/],
  ['an unmatched close brace', 'x}', /unmatched \}/],
])('substitute refuses %s', (_name, text, error) => {
  expect(() => substitute(text, values, 'services.web.start')).toThrow(error);
});

test('a one-line service is a supervised process: its string command splits on spaces and its placeholder is checked', () => {
  const [web] = declaredServicesFrom({ services: { web: { ports: ['web'], start: 'python -m http.server {web}' } } });
  expect(web).toMatchObject({ name: 'web', ports: { web: null }, start: ['python', '-m', 'http.server', '{web}'] });
  expect(web?.stop).toBeUndefined();
});

test.each<[string, Record<string, unknown>, RegExp]>([
  ['a placeholder that names no port', { web: { start: ['serve', '-l', '{web}'] } }, /names \{web\}/],
  ['shell syntax in a string command', { web: { start: 'serve -l $PORT' } }, /argv array/],
  ['a teardown without a stop command', { web: { start: 'serve', teardown: 'rm -rf data' } }, /without a stop command/],
  ['the managed Metro label', { web: { ports: ['metro'], start: 'serve' } }, /exclude metro/],
  ['a port two services own', { a: { ports: ['p'], start: 'a' }, b: { ports: ['p'], start: 'b' } }, /a also owns/],
  ['a dependency on an unknown service', { a: { start: 'a', dependsOn: ['b'] } }, /not another declared service/],
  [
    'a dependency cycle through references',
    { a: { ports: ['pa'], start: ['a', '{b.pb}'] }, b: { ports: ['pb'], start: ['b', '{a.pa}'] } },
    /depends on itself through a -> b -> a/,
  ],
])('the services setting refuses %s', (_name, services, error) => {
  expect(() => declaredServicesFrom({ services })).toThrow(error);
});

test('a service that names another service starts after it, and selecting one includes what it depends on', () => {
  const definitions = declaredServicesFrom({
    services: {
      webhooks: { start: ['listen', '--forward-to', 'localhost:{api.http}/hook'] },
      api: { ports: ['http'], start: ['api', '--port', '{http}'], dependsOn: ['db'] },
      db: { ports: { pg: 'PG_PORT' }, start: 'db up', stop: 'db stop' },
    },
  });
  const order = (selected: string[]) =>
    startOrder(
      definitions,
      definitions.filter((each) => selected.includes(each.name)),
    ).map((each) => each.name);
  expect(order(['webhooks', 'api', 'db'])).toEqual(['db', 'api', 'webhooks']);
  expect(order(['webhooks'])).toEqual(['db', 'api', 'webhooks']);
});

describe('teardown after the workspace folder is gone', () => {
  let home: string;
  let root: string;

  beforeEach(() => {
    home = realpathSync(mkdtempSync(join(tmpdir(), 'stim-services-')));
    root = join(home, 'app');
    mkdirSync(root);
    writeFileSync(join(root, 'package.json'), '{}');
    process.env.STIM_HOME = join(home, 'stim');
  });

  afterEach(() => {
    resetExecutor();
    rmSync(home, { recursive: true, force: true });
    delete process.env.STIM_HOME;
  });

  test.each([
    { name: 'reuses teardown naming {id}', teardown: 'db down --id {id}', expected: ['down', '--id'] },
    { name: 'skips teardown without {id}', teardown: 'db down', expected: null },
    {
      name: 'prefers an explicit orphanTeardown',
      teardown: 'db down --id {id}',
      orphanTeardown: 'db orphan --id {id}',
      expected: ['orphan', '--id'],
    },
    { name: 'skips teardown with literal {{id}}', teardown: 'db down --id {{id}}', expected: null },
  ])('$name', async ({ teardown, orphanTeardown, expected }) => {
    writeFileSync(
      join(root, '.stim.json'),
      JSON.stringify({ services: { db: { start: 'db up', stop: 'db stop', teardown, orphanTeardown } } }),
    );
    const runFile = vi.fn<Executor['runFile']>(() => '');
    setExecutor({ runFile, runFileQuiet: () => '', findExecutable: (file) => (file === 'db' ? file : null) });
    expect(await startServices(root, 'db')).toMatchObject([{ outcome: 'started' }]);
    runFile.mockClear();
    rmSync(root, { recursive: true });

    const outcomes = await teardownServices(root);
    const notTornDown = expect.stringContaining('not torn down: no orphanTeardown');
    const fromHome = expect.objectContaining({ cwd: homedir() });
    const detail = expected ? 'torn down' : notTornDown;
    const calls = expected ? [['db', [...expected, serviceId(root, 'db')], fromHome]] : [];
    expect(outcomes).toEqual([{ name: 'db', outcome: 'torn-down', detail }]);
    expect(runFile.mock.calls).toEqual(calls);
    expect(serviceRecords(root)).toEqual({});
  });
});

describe('service start admission', () => {
  function deferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((done) => {
      resolve = done;
    });
    return { promise, resolve };
  }

  let home: string;
  let root: string;
  let runFileAsync: ReturnType<typeof vi.fn<Executor['runFileAsync']>>;

  function declare(dir: string) {
    mkdirSync(dir);
    writeFileSync(join(dir, 'package.json'), '{}');
    writeFileSync(
      join(dir, '.stim.json'),
      JSON.stringify({ services: { db: { start: 'db up', stop: 'db stop', teardown: 'db down', ready: 'db ready' } } }),
    );
  }

  const holders = () => readClaimSet(buildSlotPath(0)).live;

  beforeEach(() => {
    home = realpathSync(mkdtempSync(join(tmpdir(), 'stim-services-slots-')));
    root = join(home, 'app');
    process.env.STIM_HOME = join(home, 'stim');
    mkdirSync(process.env.STIM_HOME);
    writeFileSync(join(process.env.STIM_HOME, 'config.json'), JSON.stringify({ concurrency: { maxBuilds: 1 } }));
    declare(root);
    runFileAsync = vi.fn<Executor['runFileAsync']>(async () => '');
    setExecutor({ runFileAsync, runFileQuiet: () => '', findExecutable: (file) => file });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    resetExecutor();
    rmSync(home, { recursive: true, force: true });
    delete process.env.STIM_HOME;
  });

  test('holds the shared build slot throughout the start command and readiness, releasing when ready', async () => {
    const start = deferred<string>();
    let isReady = false;
    const readyChecked = deferred<void>();
    runFileAsync.mockImplementation(async (_file, args) => {
      expect(holders()).toMatchObject([{ details: { projectRoot: root, service: 'db' } }]);
      if (args[0] === 'up') return start.promise;
      readyChecked.resolve();
      if (!isReady) throw new Error('not ready');
      return '';
    });
    const pending = startServices(root, undefined);
    await vi.waitFor(() => expect(runFileAsync).toHaveBeenCalled());
    expect(tryAcquireBuildSlot({ max: 1 })).toBeNull();
    start.resolve('');
    await readyChecked.promise;
    expect(tryAcquireBuildSlot({ max: 1 })).toBeNull();
    isReady = true;
    await vi.advanceTimersByTimeAsync(1000);
    expect(await pending).toMatchObject([{ outcome: 'started' }]);
    expect(holders()).toEqual([]);
  });

  test('a failed start releases its slot without waiting for readiness', async () => {
    runFileAsync.mockImplementation(async () => {
      expect(holders()).toHaveLength(1);
      throw Object.assign(new Error('failed'), { status: 1 });
    });
    expect(await startServices(root, 'db')).toMatchObject([
      { outcome: 'failed', detail: expect.stringContaining('status 1') },
    ]);
    expect(runFileAsync).toHaveBeenCalledOnce();
    expect(holders()).toEqual([]);
  });

  test('readiness timeout releases the slot at 60 seconds and leaves no poll timer', async () => {
    const readyChecked = deferred<void>();
    runFileAsync.mockImplementation(async (_file, args) => {
      if (args[0] === 'up') return '';
      readyChecked.resolve();
      throw new Error('not ready');
    });
    const pending = startServices(root, 'db');
    await readyChecked.promise;
    await vi.advanceTimersByTimeAsync(59_999);
    expect(holders()).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(await pending).toMatchObject([
      { outcome: 'failed', detail: expect.stringContaining('did not become ready') },
    ]);
    expect(holders()).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
  });

  test('a second workspace start queues behind the first at cap 1 and reports build queue progress on stderr', async () => {
    const other = join(home, 'other');
    declare(other);
    const releaseFirst = deferred<string>();
    runFileAsync.mockImplementation(async (_file, args, options) => {
      if (args[0] === 'up' && options.cwd === root) return releaseFirst.promise;
      return '';
    });
    const first = startServices(root, 'db');
    await vi.waitFor(() => expect(runFileAsync).toHaveBeenCalled());
    const output = vi.fn<(stream: 'stdout' | 'stderr', text: string) => void>();
    const second = startServices(other, 'db', { operation: testContext({ output }) });
    await vi.waitFor(() => expect(liveWaiters('build')).toHaveLength(1));
    await vi.advanceTimersByTimeAsync(10_000);
    expect(runFileAsync.mock.calls.some(([, args, options]) => args[0] === 'up' && options.cwd === other)).toBe(false);
    expect(output).toHaveBeenCalledWith(
      'stderr',
      expect.stringContaining('waiting for a build slot: queue position 1 of 1'),
    );
    releaseFirst.resolve('');
    expect(await first).toMatchObject([{ outcome: 'started' }]);
    await vi.advanceTimersByTimeAsync(1000);
    expect(await second).toMatchObject([{ outcome: 'started' }]);
    expect(holders()).toEqual([]);
    expect(liveWaiters('build')).toEqual([]);
  });

  test.each(['queue', 'start', 'readiness'] as const)(
    'cancellation during %s clears only this start slot and wait ticket',
    async (stage) => {
      const held = stage === 'queue' ? tryAcquireBuildSlot({ max: 1, root: '/other/build' }) : null;
      const controller = new AbortController();
      const entered = deferred<void>();
      runFileAsync.mockImplementation(async (_file, args, options) => {
        if (stage === 'start') {
          entered.resolve();
          return new Promise((_resolve, reject) =>
            options.signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true }),
          );
        }
        if (args[0] === 'ready') {
          entered.resolve();
          throw new Error('not ready');
        }
        return '';
      });
      const pending = startServices(root, 'db', { operation: testContext({ signal: controller.signal }) });
      const outcome = pending.then(
        () => null,
        (error: Error) => error,
      );
      if (stage === 'queue') await vi.waitUntil(() => liveWaiters('build').length === 1);
      else await entered.promise;
      controller.abort();
      expect(await outcome).toBeInstanceOf(Error);
      expect(liveWaiters('build')).toEqual([]);
      expect(holders()).toHaveLength(held ? 1 : 0);
      expect(runFileAsync.mock.calls.length === 0).toBe(stage === 'queue');
      releaseBuildSlot(held);
    },
  );

  test.each(['stop', 'teardown'] as const)(
    '%s proceeds while the only build slot is held by another workspace',
    async (action) => {
      await startServices(root, 'db');
      const held = tryAcquireBuildSlot({ max: 1, root: '/other/build' });
      expect(held).not.toBeNull();
      runFileAsync.mockClear();
      try {
        const outcomes = action === 'stop' ? await stopServices(root, 'db', 'command') : await teardownServices(root);
        expect(outcomes).toMatchObject([{ outcome: action === 'stop' ? 'stopped' : 'torn-down' }]);
        expect(holders()).toMatchObject([{ details: { projectRoot: '/other/build' } }]);
        expect(liveWaiters('build')).toEqual([]);
      } finally {
        releaseBuildSlot(held);
      }
    },
  );

  test('JSON service start keeps queue progress on stderr and prints exactly one result', async () => {
    const held = tryAcquireBuildSlot({ max: 1 });
    const previousCwd = process.cwd();
    const stdout = vi.spyOn(console, 'log').mockImplementation(() => {});
    const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(daemon, 'ensurePersistentStimd').mockResolvedValue(false);
    process.chdir(root);
    try {
      const pending = runCli(servicesOp, ['start', 'db', '--json'], { version: '0.0.0' });
      await vi.waitFor(() => expect(liveWaiters('build')).toHaveLength(1));
      await vi.advanceTimersByTimeAsync(10_000);
      expect(stdout).not.toHaveBeenCalled();
      expect(stderr).toHaveBeenCalledWith(expect.stringContaining('waiting for a build slot'));
      releaseBuildSlot(held);
      await vi.advanceTimersByTimeAsync(1000);
      await pending;
      expect(stdout).toHaveBeenCalledOnce();
      expect(JSON.parse(stdout.mock.calls[0]?.[0])).toMatchObject({ services: [{ outcome: 'started' }] });
    } finally {
      process.chdir(previousCwd);
      releaseBuildSlot(held);
    }
  });

  test.each(['queue', 'start'] as const)(
    'Ctrl-C during the %s exits 130 with one STIM_CANCELLED payload',
    async (stage) => {
      const held = stage === 'queue' ? tryAcquireBuildSlot({ max: 1, root: '/other/build' }) : null;
      runFileAsync.mockImplementation(async (_file, args, options) => {
        if (args[0] !== 'up') return '';
        const aborted = new Promise<string>((_resolve, reject) =>
          options.signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true }),
        );
        process.emit('SIGINT');
        return aborted;
      });
      const previousCwd = process.cwd();
      const previousExitCode = process.exitCode;
      const stdout = vi.spyOn(console, 'log').mockImplementation(() => {});
      vi.spyOn(console, 'error').mockImplementation(() => {});
      vi.spyOn(daemon, 'ensurePersistentStimd').mockResolvedValue(false);
      process.chdir(root);
      try {
        const pending = runCli(servicesOp, ['start', 'db', '--json'], { version: '0.0.0' });
        if (stage === 'queue') {
          await vi.waitUntil(() => liveWaiters('build').length === 1);
          process.emit('SIGINT');
        }
        await pending;
        expect(process.exitCode).toBe(130);
        expect(stdout).toHaveBeenCalledOnce();
        expect(JSON.parse(stdout.mock.calls[0]?.[0])).toMatchObject({ code: 'STIM_CANCELLED' });
      } finally {
        process.chdir(previousCwd);
        process.exitCode = previousExitCode;
        releaseBuildSlot(held);
      }
    },
  );

  test('recovers a dead build holder but refuses a pending child with its claim removal remedy in JSON', async () => {
    plantClaim(buildSlotPath(0), 'exclusive', goneClaimOwner(), { details: { index: 0 } });
    expect(await startServices(root, 'db')).toMatchObject([{ outcome: 'started' }]);
    await stopServices(root, 'db', 'command');
    const unresolved = plantClaim(buildSlotPath(0), 'exclusive', goneClaimOwner(), { child: { record: null } });
    const previousCwd = process.cwd();
    const previousExitCode = process.exitCode;
    const stdout = vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    runFileAsync.mockClear();
    process.chdir(root);
    try {
      await runCli(servicesOp, ['start', 'db', '--json'], { version: '0.0.0' });
      expect(stdout).toHaveBeenCalledOnce();
      expect(JSON.parse(stdout.mock.calls[0]?.[0])).toMatchObject({
        code: 'STIM_CLAIM_REFUSED',
        remedy: expect.stringContaining(unresolved),
      });
      expect(runFileAsync).not.toHaveBeenCalled();
      expect(readClaimSet(buildSlotPath(0)).unresolved).toHaveLength(1);
    } finally {
      process.chdir(previousCwd);
      process.exitCode = previousExitCode;
    }
  });

  test.each([
    ['without cancellation', false],
    ['when the start was cancelled', true],
  ])('unverified command cleanup keeps the build slot for claim recovery %s', async (_name, cancelled) => {
    const error = Object.assign(new Error('child cleanup cannot be verified'), { reportCleanup: true });
    const controller = new AbortController();
    runFileAsync.mockImplementation(async () => {
      if (cancelled) controller.abort(new Error('cancelled'));
      throw error;
    });
    await expect(startServices(root, 'db', { operation: testContext(), signal: controller.signal })).rejects.toBe(
      error,
    );
    expect(holders()).toMatchObject([{ details: { projectRoot: root, service: 'db' } }]);
  });

  test('revive waits for build capacity before running the recorded start again', async () => {
    await startServices(root, 'db');
    await stopServices(root, 'db', 'idle');
    runFileAsync.mockClear();
    const held = tryAcquireBuildSlot({ max: 1 });
    expect(held).not.toBeNull();
    const pending = resumeServices(root);
    await vi.waitFor(() => expect(liveWaiters('build')).toHaveLength(1));
    expect(runFileAsync).not.toHaveBeenCalled();
    releaseBuildSlot(held);
    await vi.advanceTimersByTimeAsync(1000);
    expect(await pending).toMatchObject([{ outcome: 'started' }]);
    expect(holders()).toEqual([]);
    expect(serviceRecords(root).db?.stoppedBy).toBeUndefined();
  });
});
