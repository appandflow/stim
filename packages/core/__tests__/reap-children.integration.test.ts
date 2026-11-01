import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { killRunProcesses } from '../../../vitest.kill-run-processes.ts';
import { reapChildren } from '../../../vitest.reap-children.ts';

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function until(check: () => boolean): Promise<boolean> {
  for (let i = 0; i < 100; i += 1) {
    if (check()) return true;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return check();
}

describe('reapChildren', () => {
  it.skipIf(process.platform === 'win32')(
    'kills a SIGTERM-ignoring child, its detached group, a grandchild it started and an orphan of an exited detached leader',
    async () => {
      const grandchild = "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)";
      const parent = `
      const { spawn } = require('node:child_process');
      process.on('SIGTERM', () => {});
      const child = spawn(process.execPath, ['-e', ${JSON.stringify(grandchild)}], { stdio: 'inherit' });
      console.log(child.pid);
      setInterval(() => {}, 1000);
    `;
      const fixture = spawn(process.execPath, ['-e', parent], { stdio: ['ignore', 'pipe', 'inherit'] });
      const grandchildPid = await new Promise<number>((resolve) => {
        fixture.stdout.once('data', (data: Buffer) => resolve(Number(data.toString().trim())));
      });
      const sleeper = spawn(process.execPath, ['-e', grandchild], { detached: true, stdio: 'ignore' });
      const leaderScript = `
      const { spawn } = require('node:child_process');
      const child = spawn(process.execPath, ['-e', ${JSON.stringify(grandchild)}], { stdio: 'inherit' });
      child.unref();
      console.log(child.pid);
    `;
      const leader = spawn(process.execPath, ['-e', leaderScript], {
        detached: true,
        stdio: ['ignore', 'pipe', 'inherit'],
      });
      const orphanPid = await new Promise<number>((resolve) => {
        leader.stdout.once('data', (data: Buffer) => resolve(Number(data.toString().trim())));
      });
      if (leader.exitCode === null) await new Promise((resolve) => leader.once('exit', resolve));
      const fixturePid = fixture.pid as number;
      const sleeperPid = sleeper.pid as number;

      expect([alive(fixturePid), alive(grandchildPid), alive(sleeperPid), alive(orphanPid)]).toEqual([
        true,
        true,
        true,
        true,
      ]);

      reapChildren();

      expect(
        await until(() => !alive(fixturePid) && !alive(grandchildPid) && !alive(sleeperPid) && !alive(orphanPid)),
      ).toBe(true);
    },
  );

  it.skipIf(process.platform === 'win32')(
    'kills a reparented descendant that carries the run root in its environment and spares one that does not',
    async () => {
      const root = join(tmpdir(), 'stim-vitest-reaptest');
      const sleeper = 'setInterval(() => {}, 1000)';
      const leaderScript = `
      const { spawn } = require('node:child_process');
      const child = spawn(process.execPath, ['-e', ${JSON.stringify(sleeper)}], { detached: true, stdio: 'ignore' });
      console.log(child.pid);
      child.unref();
    `;
      const leader = spawn(process.execPath, ['-e', leaderScript], {
        env: { ...process.env, TMPDIR: root },
        stdio: ['ignore', 'pipe', 'inherit'],
      });
      const orphanPid = await new Promise<number>((resolve) => {
        leader.stdout.once('data', (data: Buffer) => resolve(Number(data.toString().trim())));
      });
      await new Promise((resolve) => leader.once('exit', resolve));
      const bystander = spawn(process.execPath, ['-e', sleeper], { detached: true, stdio: 'ignore' });
      const bystanderPid = bystander.pid as number;

      killRunProcesses(root);

      expect(await until(() => !alive(orphanPid))).toBe(true);
      expect(alive(bystanderPid)).toBe(true);
      reapChildren();
    },
  );
});
