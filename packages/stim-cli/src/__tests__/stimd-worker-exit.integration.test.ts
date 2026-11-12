import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert';
import { fileURLToPath } from 'node:url';
import { readClaimSet } from '@stim-cli/core/ownership-claim';
import * as entries from '../spawn-entry.ts';
import { createThreadTable } from '../stimd/threads.ts';
import { captureProcessToken, inspectProcessIdentity } from '../process-identity.ts';
import { signalProcessTree } from '../metro.ts';
import { waitForProcessExit } from '@stim-cli/core/process-identity';

async function stopFixture(pid: number, token: string): Promise<void> {
  const status = inspectProcessIdentity({ pid, processToken: token });
  if (status === 'unknown') throw new Error(`fixture child ${pid} could not be verified`);
  if (status === 'same') {
    signalProcessTree(pid, 'SIGKILL', { group: true });
    if (!(await waitForProcessExit({ pid, processToken: token }, 2000)))
      throw new Error(`fixture child ${pid} did not stop`);
  }
}

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
        expect(existsSync(pidFile)).toBe(true);
        pid = Number(readFileSync(pidFile, 'utf8'));
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
