import { ChildProcess, spawnSync } from 'node:child_process';
import { afterAll } from 'vitest';

type Tracked = { pid: number; detached: boolean; exited: boolean };

const installed = Symbol.for('stim.test.reapChildren');
const live = new Map<ChildProcess, Tracked>();

function descendants(roots: readonly number[]): number[] {
  const table = spawnSync('ps', ['-axo', 'pid=,ppid='], { encoding: 'utf8' }).stdout ?? '';
  const children = new Map<number, number[]>();
  for (const line of table.split('\n')) {
    const [pid, ppid] = line.trim().split(/\s+/).map(Number);
    if (!pid || !ppid) continue;
    children.set(ppid, [...(children.get(ppid) ?? []), pid]);
  }
  const found: number[] = [];
  const queue = [...roots];
  for (let next = queue.shift(); next !== undefined; next = queue.shift()) {
    for (const pid of children.get(next) ?? []) {
      found.push(pid);
      queue.push(pid);
    }
  }
  return found;
}

function kill(pid: number, group: boolean): void {
  try {
    process.kill(group ? -pid : pid, 'SIGKILL');
  } catch {
    return;
  }
}

export function reapChildren(): void {
  if (live.size === 0) return;
  const tracked = [...live.values()];
  live.clear();
  if (process.platform === 'win32') {
    for (const { pid, exited } of tracked) if (!exited) kill(pid, false);
    return;
  }
  const below = descendants(tracked.filter(({ exited }) => !exited).map(({ pid }) => pid));
  for (const { pid, detached } of tracked) kill(pid, detached);
  for (const pid of below) kill(pid, false);
}

type Spawnable = { spawn(this: ChildProcess, options: { detached?: boolean }): unknown; [installed]?: true };
const proto = ChildProcess.prototype as unknown as Spawnable;
if (!proto[installed]) {
  proto[installed] = true;
  const original = proto.spawn;
  proto.spawn = function (this: ChildProcess, options) {
    const result = original.call(this, options);
    if (this.pid !== undefined) {
      const entry = { pid: this.pid, detached: options?.detached === true, exited: false };
      live.set(this, entry);
      this.once('exit', () => {
        entry.exited = true;
        if (!entry.detached) live.delete(this);
      });
    }
    return result;
  };
  process.on('exit', reapChildren);
}

afterAll(reapChildren);
