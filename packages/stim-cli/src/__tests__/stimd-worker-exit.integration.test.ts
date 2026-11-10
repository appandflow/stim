import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
