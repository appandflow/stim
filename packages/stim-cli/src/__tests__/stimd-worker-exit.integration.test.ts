import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert';
import { fileURLToPath } from 'node:url';
import { readClaimSet } from '@stim-cli/core/ownership-claim';
import * as entries from '../spawn-entry.ts';
import { createThreadTable } from '../stimd/threads.ts';
import { LADDER_CLOCK_SLOTS } from '../daemon/disk-owner.ts';
import type { DiskPassInput } from '../daemon/passes.ts';
import { captureProcessToken, inspectProcessIdentity } from '../process-identity.ts';
import { signalProcessTree } from '../metro.ts';
import { waitForProcessExit } from '@stim-cli/core/process-identity';
import { waitForPid } from './_pid-file.ts';

async function stopFixture(pid: number, token: string): Promise<void> {
  const status = inspectProcessIdentity({ pid, processToken: token });
  if (status === 'unknown') throw new Error(`fixture child ${pid} could not be verified`);
  if (status === 'same') {
    signalProcessTree(pid, 'SIGKILL', { group: true });
    if (!(await waitForProcessExit({ pid, processToken: token }, 2000)))
      throw new Error(`fixture child ${pid} did not stop`);
  }
}

const diskInput = (reasons: string[]): DiskPassInput => ({
  act: true,
  pressure: { level: 'critical', disk: 'critical', memory: 'normal', reasons, memoryWarningSince: null },
  devices: [],
  sims: [],
  requested: false,
});

function fakeWorker(source: string): { root: string; restore: () => void } {
  const root = mkdtempSync(join(tmpdir(), 'stim-worker-fake-'));
  const fixture = join(root, 'worker.mjs');
  writeFileSync(fixture, source);
  const entry = vi.spyOn(entries, 'spawnEntry').mockReturnValue(fixture);
  return {
    root,
    restore: () => {
      entry.mockRestore();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

test('the hourly dependency check survives retirement of the worker that started it', async () => {
  const home = mkdtempSync(join(tmpdir(), 'stim-dependency-cadence-'));
  vi.stubEnv('STIM_HOME', home);
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  const entry = vi
    .spyOn(entries, 'spawnEntry')
    .mockReturnValue(fileURLToPath(new URL('./fixtures/dependency-cadence-worker.ts', import.meta.url)));
  const traces: Record<string, unknown>[] = [];
  const threads = createThreadTable((_level, event, _message, fields) => {
    if (event === 'fixture' && fields) traces.push(fields);
  });
  const start = Date.now();
  const run = (minutes: number, options: { disabled?: boolean; fail?: boolean; force?: boolean } = {}) => {
    const input = { cwd: home, now: start + minutes * 60_000, ...options };
    return threads.run('passes', input);
  };
  try {
    await run(-1, { disabled: true });
    await expect(run(0, { fail: true })).rejects.toThrow('inventory failed');
    await vi.advanceTimersByTimeAsync(120_001);
    await run(3);
    await run(4, { force: true });
    await run(60);

    const [disabled, first, replacement, forced, due] = traces;
    expect(first?.threadId).not.toBe(replacement?.threadId);
    expect([disabled, first, replacement, forced, due].map((trace) => trace?.inspected)).toEqual([
      false,
      true,
      false,
      true,
      true,
    ]);
  } finally {
    await threads.close();
    entry.mockRestore();
    vi.useRealTimers();
    vi.unstubAllEnvs();
    rmSync(home, { recursive: true, force: true });
  }
});

test('an idle worker whose bounded read is still pending is kept, so a stuck folder holds one read', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  const entry = vi
    .spyOn(entries, 'spawnEntry')
    .mockReturnValue(fileURLToPath(new URL('./fixtures/bounded-read-worker.ts', import.meta.url)));
  const traces: Record<string, unknown>[] = [];
  const threads = createThreadTable((_level, event, _message, fields) => {
    if (event === 'fixture' && fields) traces.push(fields);
  });
  const release = { cwd: process.cwd(), release: true };
  try {
    await threads.run('measure', { cwd: process.cwd() });
    await vi.advanceTimersByTimeAsync(120_001);
    await threads.run('measure', { cwd: process.cwd() });
    await threads.run('measure', release);
    await vi.advanceTimersByTimeAsync(120_001);
    await threads.run('measure', { cwd: process.cwd() });

    const [first, kept, released, replacement] = traces;
    expect([kept?.threadId, released?.threadId]).toEqual([first?.threadId, first?.threadId]);
    expect(replacement?.threadId).not.toBe(first?.threadId);
    expect(traces.map((trace) => trace.started)).toEqual([1, 1, 1, 1]);
  } finally {
    await threads.close();
    entry.mockRestore();
    vi.useRealTimers();
  }
});

test('a kept worker that exits before answering settle leaves no idle poll behind', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  const root = mkdtempSync(join(tmpdir(), 'stim-worker-settle-'));
  const fixture = join(root, 'worker.mjs');
  writeFileSync(
    fixture,
    `
import { parentPort } from 'node:worker_threads';
parentPort.on('message', (message) => {
  if (message.type === 'settle') process.exit(1);
  parentPort.postMessage({ type: 'done', result: [], reading: true });
});
`,
  );
  const entry = vi.spyOn(entries, 'spawnEntry').mockReturnValue(fixture);
  const threads = createThreadTable(() => {});
  const timers = vi.getTimerCount();
  try {
    await threads.run('measure', { cwd: root });
    await vi.advanceTimersByTimeAsync(120_001);
    await vi.waitFor(() => expect(vi.getTimerCount()).toBe(timers));
  } finally {
    await threads.close();
    entry.mockRestore();
    vi.useRealTimers();
    rmSync(root, { recursive: true, force: true });
  }
});

test('a disk pass asked of a passes worker that ends fails as unverified cleanup, and the next one starts a new worker', async () => {
  const fake = fakeWorker(`
import { parentPort } from 'node:worker_threads';
parentPort.on('message', (message) => {
  if (message.type !== 'ladder') return;
  if (message.input.pressure.reasons.length === 0) process.exit(1);
  parentPort.postMessage({ type: 'ladderDone', id: message.id, reading: false, result: { actions: [], pressure: message.input.pressure } });
});
`);
  const threads = createThreadTable(() => {});
  try {
    const ladder = threads.ladder?.bind(threads);
    if (!ladder) throw new Error('no ladder');
    await expect(ladder(diskInput([]))).rejects.toMatchObject({
      message: 'the passes thread ended during a disk pass',
      code: 'STIM_CLAIM_UNAVAILABLE',
      reportCleanup: true,
    });
    await expect(ladder(diskInput(['answer']))).resolves.toMatchObject({ actions: [] });
  } finally {
    await threads.close();
    fake.restore();
  }
});

test('a passes worker whose job ends while its disk pass runs stays up for the next job', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  const fake = fakeWorker(`
import { parentPort } from 'node:worker_threads';
let asked = null;
let holding = false;
parentPort.on('message', (message) => {
  if (message.type === 'ladder' && asked === null) asked = message.id;
  else if (message.type === 'ladder') {
    parentPort.postMessage({ type: 'done', result: [], reading: false });
    parentPort.postMessage({ type: 'ladderDone', id: message.id, reading: false, result: { actions: [], pressure: message.input.pressure } });
  } else if (message.type === 'run' && message.input.hold) holding = true;
  else if (message.type === 'run') {
    parentPort.postMessage({ type: 'done', result: [], reading: false });
    setTimeout(() => parentPort.postMessage({ type: 'ladderDone', id: asked, reading: false, result: { actions: [], pressure: { level: 'normal' } } }), 20);
  }
});
`);
  const threads = createThreadTable(() => {});
  const job = { cwd: fake.root };
  const held = { cwd: fake.root, hold: true };
  try {
    const ladder = threads.ladder?.bind(threads);
    if (!ladder) throw new Error('no ladder');
    const first = ladder(diskInput(['first']));
    await threads.run('passes', job);
    await first;
    const next = threads.run('passes', held);
    await vi.advanceTimersByTimeAsync(120_001);
    await ladder(diskInput(['release']));
    await expect(next).resolves.toEqual([]);
  } finally {
    vi.useRealTimers();
    await threads.close();
    fake.restore();
  }
});

test('the ladder clocks survive retirement of the worker that ran the disk pass', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  const fake = fakeWorker(`
import { parentPort, threadId, workerData } from 'node:worker_threads';
parentPort.on('message', (message) => {
  if (message.type !== 'ladder') return;
  const runs = Array.from(workerData.ladderClocks, (_, slot) => Number(Atomics.add(workerData.ladderClocks, slot, 1n)) + 1);
  parentPort.postMessage({ type: 'log', level: 'info', event: 'fixture', msg: '', fields: { threadId, runs } });
  parentPort.postMessage({ type: 'ladderDone', id: message.id, reading: false, result: { actions: [], pressure: message.input.pressure } });
});
`);
  const traces: Record<string, unknown>[] = [];
  const threads = createThreadTable((_level, event, _message, fields) => {
    if (event === 'fixture' && fields) traces.push(fields);
  });
  try {
    const ladder = threads.ladder?.bind(threads);
    if (!ladder) throw new Error('no ladder');
    await ladder(diskInput(['first']));
    await vi.advanceTimersByTimeAsync(120_001);
    await ladder(diskInput(['replacement']));
    const slots = Object.keys(LADDER_CLOCK_SLOTS).length;
    expect(traces.map((trace) => trace.runs)).toEqual([Array(slots).fill(1), Array(slots).fill(2)]);
    expect(traces[0]?.threadId).not.toBe(traces[1]?.threadId);
  } finally {
    vi.useRealTimers();
    await threads.close();
    fake.restore();
  }
});

describe.skipIf(process.platform === 'win32')('a disk pass on the passes worker', () => {
  test('stops when the passes thread is aborted, with no lane job running', async () => {
    const entry = vi
      .spyOn(entries, 'spawnEntry')
      .mockReturnValue(fileURLToPath(new URL('./fixtures/thread-jobs-worker.ts', import.meta.url)));
    const threads = createThreadTable(() => {});
    try {
      const ladder = threads.ladder?.bind(threads);
      if (!ladder) throw new Error('no ladder');
      const running = ladder(diskInput(['wait']));
      void running.catch(() => {});
      await new Promise((done) => setTimeout(done, 500));
      threads.abort('passes');
      await expect(running).rejects.toThrow('aborted');
    } finally {
      entry.mockRestore();
      await threads.close();
    }
  }, 10_000);

  test("a gc request's operation protects the caller's project, not stimd's working directory", async () => {
    const root = mkdtempSync(join(tmpdir(), 'stim-worker-gc-'));
    writeFileSync(join(root, 'package.json'), '{}');
    const entry = vi
      .spyOn(entries, 'spawnEntry')
      .mockReturnValue(fileURLToPath(new URL('./fixtures/thread-jobs-worker.ts', import.meta.url)));
    const threads = createThreadTable(() => {});
    try {
      const asked = threads.gc({ client: 'manual', cwd: root }, () => {});
      expect(await asked.result).toMatchObject({ protectedRoot: realpathSync(root) });
    } finally {
      entry.mockRestore();
      await threads.close();
      rmSync(root, { recursive: true, force: true });
    }
  }, 10_000);

  test('closing the threads waits for a gc request its requester left to settle', async () => {
    const root = mkdtempSync(join(tmpdir(), 'stim-worker-gc-'));
    const settled = join(root, 'settled');
    const entry = vi
      .spyOn(entries, 'spawnEntry')
      .mockReturnValue(fileURLToPath(new URL('./fixtures/thread-jobs-worker.ts', import.meta.url)));
    const threads = createThreadTable(() => {});
    try {
      const request = { client: 'manual' as const, cwd: root, settled };
      const asked = threads.gc(request, () => {});
      void asked.result.catch(() => {});
      asked.leave();
      await threads.close();
      expect(readFileSync(settled, 'utf8')).toBe('settled');
    } finally {
      entry.mockRestore();
      rmSync(root, { recursive: true, force: true });
    }
  }, 10_000);

  test('whose child cleanup is unverified crosses as the named child, and the claim stays until it has stopped', async () => {
    const root = mkdtempSync(join(tmpdir(), 'stim-worker-ladder-'));
    const entry = vi
      .spyOn(entries, 'spawnEntry')
      .mockReturnValue(fileURLToPath(new URL('./fixtures/thread-jobs-worker.ts', import.meta.url)));
    const threads = createThreadTable(() => {});
    let sleeper: { pid: number; token: string | null } | undefined;
    try {
      const ladder = threads.ladder?.bind(threads);
      if (!ladder) throw new Error('no ladder');
      const failure: unknown = await ladder(diskInput(['refuse', root])).catch((error: unknown) => error);
      const pid = Number(readFileSync(join(root, 'pids'), 'utf8'));
      sleeper = { pid, token: captureProcessToken(pid) };
      assert(sleeper.token);
      expect(failure).toMatchObject({
        code: 'STIM_CLAIM_UNAVAILABLE',
        reportCleanup: true,
        reportChild: { pid, processToken: sleeper.token },
      });
      const settled = Reflect.get(Object(failure), 'cleanupSettled');
      assert(typeof settled === 'function');
      const claimRoot = join(root, 'work.lock');
      threads.settle();
      await new Promise((done) => setTimeout(done, 200));
      expect(settled()).toBe(false);
      expect(readClaimSet(claimRoot).live).toHaveLength(1);
      await stopFixture(pid, sleeper.token);
      await vi.waitFor(
        () => {
          threads.settle();
          expect(settled()).toBe(true);
          expect(readClaimSet(claimRoot).live).toHaveLength(0);
        },
        { timeout: 5000, interval: 100 },
      );
    } finally {
      entry.mockRestore();
      await threads.close();
      if (sleeper?.token) await stopFixture(sleeper.pid, sleeper.token);
      rmSync(root, { recursive: true, force: true });
    }
  }, 20_000);
});

describe.skipIf(process.platform === 'win32')('unexpected worker exit', () => {
  test.each(['exit', 'abort'])(
    'a worker %s with an outstanding job reports a surviving child',
    async (mode) => {
      const root = mkdtempSync(join(tmpdir(), 'stim-worker-exit-'));
      const fixture = join(root, 'worker.mjs');
      const pidFile = join(root, 'child-pid');
      writeFileSync(
        fixture,
        `
import { parentPort } from 'node:worker_threads';
import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
parentPort.on('message', (message) => {
  if (message.type === 'abort') process.exit(1);
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { detached: true, stdio: 'ignore' });
  child.unref();
  writeFileSync(${JSON.stringify(pidFile)}, String(child.pid));
  if (${JSON.stringify(mode)} === 'exit') process.exit(1);
});
`,
      );
      const entry = vi.spyOn(entries, 'spawnEntry').mockReturnValue(fixture);
      const threads = createThreadTable(() => {});
      let pid = 0;
      let token: string | null = null;
      try {
        const running = threads.run('passes', { cwd: root });
        void running.catch(() => {});
        if (mode === 'abort') {
          await vi.waitFor(() => {
            if (!existsSync(pidFile)) throw new Error('fixture child has not started');
          });
          threads.abort('passes');
        }
        await expect(running).rejects.toMatchObject({
          code: 'STIM_CLAIM_UNAVAILABLE',
          reportCleanup: true,
        });
        pid = await waitForPid(pidFile);
        token = captureProcessToken(pid);
        expect(token).toBeTruthy();
        expect(inspectProcessIdentity({ pid, processToken: token ?? undefined })).toBe('same');
      } finally {
        entry.mockRestore();
        await threads.close();
        if (!pid && existsSync(pidFile)) {
          pid = Number(readFileSync(pidFile, 'utf8'));
          token = captureProcessToken(pid);
        }
        if (pid && token) await stopFixture(pid, token);
        rmSync(root, { recursive: true, force: true });
      }
    },
    15_000,
  );
});

describe('a cleanup a thread watches', () => {
  test('crosses as the named child, settles once the thread finds it stopped, and is reported lost when the thread ends first', async () => {
    const root = mkdtempSync(join(tmpdir(), 'stim-worker-watch-'));
    const fixture = join(root, 'worker.mjs');
    writeFileSync(
      fixture,
      `
import { parentPort } from 'node:worker_threads';
let settles = 0;
parentPort.on('message', (message) => {
  if (message.type === 'run') {
    parentPort.postMessage({
      type: 'failed',
      message: 'Report child 4242 did not close within the cleanup budget.',
      code: 'STIM_CLAIM_UNAVAILABLE',
      reportCleanup: true,
      remedy: 'Check whether the report child 4242 is still running.',
      contained: { pid: 4242, processToken: 'fixture' },
    });
  } else if (message.type === 'settle') {
    settles++;
    if (settles === 3) process.exit(1);
    parentPort.postMessage({ type: 'settled', pending: settles === 1 ? ['4242:fixture'] : [] });
  }
});
`,
    );
    const entry = vi.spyOn(entries, 'spawnEntry').mockReturnValue(fixture);
    const lost: Error[] = [];
    const threads = createThreadTable(
      () => {},
      (error) => lost.push(error),
    );
    try {
      const failure: unknown = await threads.run('measure', { cwd: root }).catch((error: unknown) => error);
      expect(failure).toMatchObject({
        code: 'STIM_CLAIM_UNAVAILABLE',
        reportCleanup: true,
        reportChild: { pid: 4242, processToken: 'fixture' },
      });
      const settled = Reflect.get(Object(failure), 'cleanupSettled');
      assert(typeof settled === 'function');
      expect(settled()).toBe(false);
      threads.settle();
      await new Promise((done) => setTimeout(done, 200));
      expect(settled()).toBe(false);
      threads.settle();
      await vi.waitFor(() => expect(settled()).toBe(true));
      expect(lost).toEqual([]);

      await threads.run('measure', { cwd: root }).catch(() => {});
      threads.settle();
      await vi.waitFor(() => expect(lost).toHaveLength(1));
      expect(lost[0]).toMatchObject({ code: 'STIM_CLAIM_UNAVAILABLE', reportCleanup: true });
    } finally {
      entry.mockRestore();
      await threads.close();
      rmSync(root, { recursive: true, force: true });
    }
  }, 15_000);
});

describe.skipIf(process.platform === 'win32')('a job whose child cleanup is unverified', () => {
  test.each([
    [1, 'is watched on its thread, which keeps the claim until the child has stopped'],
    [2, 'is not contained while another child of the operation runs, and keeps the claim'],
  ])(
    'with %i declared children it %s',
    async (children) => {
      const root = mkdtempSync(join(tmpdir(), 'stim-worker-job-'));
      const entry = vi
        .spyOn(entries, 'spawnEntry')
        .mockReturnValue(fileURLToPath(new URL('./fixtures/thread-jobs-worker.ts', import.meta.url)));
      const threads = createThreadTable(() => {});
      const sleepers: { pid: number; token: string | null }[] = [];
      try {
        const input = { cwd: root, children };
        const failure: unknown = await threads.run('measure', input).catch((error: unknown) => error);
        for (const pid of readFileSync(join(root, 'pids'), 'utf8').split(' ').map(Number))
          sleepers.push({ pid, token: captureProcessToken(pid) });
        expect(failure).toMatchObject({ code: 'STIM_CLAIM_UNAVAILABLE', reportCleanup: true });
        const claimRoot = join(root, 'work.lock');
        expect(readClaimSet(claimRoot).live).toHaveLength(1);
        const named = sleepers[0];
        assert(named?.token);
        expect(Reflect.get(Object(failure), 'reportChild')).toEqual(
          children === 1 ? { pid: named.pid, processToken: named.token } : undefined,
        );
        threads.settle();
        await new Promise((done) => setTimeout(done, 200));
        expect(readClaimSet(claimRoot).live).toHaveLength(1);
        await stopFixture(named.pid, named.token);
        const settledLength = children === 1 ? 0 : 1;
        await vi.waitFor(
          () => {
            threads.settle();
            expect(readClaimSet(claimRoot).live).toHaveLength(settledLength);
          },
          { timeout: 5000, interval: 100 },
        );
        threads.settle();
        await new Promise((done) => setTimeout(done, 300));
        expect(readClaimSet(claimRoot).live).toHaveLength(settledLength);
      } finally {
        entry.mockRestore();
        await threads.close();
        for (const { pid, token } of sleepers) if (token) await stopFixture(pid, token);
        rmSync(root, { recursive: true, force: true });
      }
    },
    20_000,
  );
});
