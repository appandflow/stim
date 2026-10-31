import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { runCommand } from '../command.ts';

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'stim-ci-command-'));
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

test.skipIf(process.platform === 'win32')(
  'cancellation kills a test process and its resistant descendant',
  async () => {
    const pidFile = join(root, 'descendant.pid');
    const descendant = `process.on('SIGTERM', () => {}); const fs = require('node:fs'); fs.writeFileSync(${JSON.stringify(`${pidFile}.tmp`)}, String(process.pid)); fs.renameSync(${JSON.stringify(`${pidFile}.tmp`)}, ${JSON.stringify(pidFile)}); setInterval(() => {}, 1000);`;
    const script = `process.on('SIGTERM', () => {}); require('node:child_process').spawn(process.execPath, ['-e', ${JSON.stringify(descendant)}], {stdio:'inherit'}); setInterval(() => {}, 1000);`;
    const controller = new AbortController();
    const running = runCommand({
      command: [process.execPath, '-e', script],
      cwd: root,
      env: process.env,
      artifactsDir: root,
      signal: controller.signal,
    });
    try {
      const deadline = Date.now() + 2000;
      while (!existsSync(pidFile) && Date.now() < deadline) await delay(10);
      expect(existsSync(pidFile)).toBe(true);
      const pid = Number(readFileSync(pidFile, 'utf8'));
      controller.abort();
      const result = await running;
      expect(result.signal).toBe('SIGKILL');
      expect(() => process.kill(pid, 0)).toThrow(/ESRCH/);
    } finally {
      controller.abort();
      await running;
    }
  },
);

test.skipIf(process.platform === 'win32')(
  'reports failure when process group disappearance cannot be verified',
  async () => {
    const originalKill = process.kill;
    const kill = vi.spyOn(process, 'kill').mockImplementation((pid, signal) => {
      if (pid < 0 && signal === 0) throw Object.assign(new Error('kill EPERM'), { code: 'EPERM' });
      return originalKill(pid, signal);
    });
    try {
      const result = await runCommand({
        command: [process.execPath, '-e', 'process.exit(0)'],
        cwd: root,
        env: process.env,
        artifactsDir: root,
      });
      expect(result.exitCode).toBe(0);
      expect(result.error).toContain('EPERM');
    } finally {
      kill.mockRestore();
    }
  },
);
