import { spawnSync } from 'node:child_process';
import { basename } from 'node:path';

// macOS and procps `ps e` append each process's environment to its command column.
export function killRunProcesses(root: string | undefined): void {
  if (process.platform === 'win32' || !root || !basename(root).startsWith('stim-vitest-')) return;
  const table = spawnSync('ps', ['axeww', '-o', 'pid=,ppid=,command='], {
    encoding: 'utf8',
    maxBuffer: 256 * 1024 * 1024,
  });
  for (const line of (table.stdout ?? '').split('\n')) {
    const [pid, ppid] = line.trim().split(/\s+/, 2).map(Number);
    if (!pid || ppid === process.pid || pid === process.pid || pid === table.pid || !line.includes(root)) continue;
    try {
      process.kill(pid, 'SIGKILL');
    } catch {}
  }
}
