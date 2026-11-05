import { execFileSync } from 'node:child_process';
import { realpathSync } from 'node:fs';

export function ownedMetroListeners(worktree, execute = execFileSync) {
  const run = (file, args) =>
    execute(file, args, { encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'pipe'] });
  let root, listing;
  try {
    root = realpathSync(worktree);
    listing = run('/usr/sbin/lsof', ['-nP', '-iTCP', '-sTCP:LISTEN', '-Fpn']);
  } catch {
    return [];
  }
  let listedPid;
  const candidates = new Map();
  for (const line of listing.split('\n')) {
    if (/^p\d+$/.test(line)) listedPid = Number(line.slice(1));
    const port = /^n.*:(\d+)$/.exec(line)?.[1];
    if (Number.isSafeInteger(listedPid) && listedPid > 0 && port && Number(port) > 0 && Number(port) < 65536)
      candidates.set(`${listedPid}:${port}`, { pid: listedPid, port: Number(port) });
  }
  return [...candidates.values()].filter(({ pid, port }) => {
    try {
      const cwd = run('/usr/sbin/lsof', ['-a', '-p', String(pid), '-d', 'cwd', '-Fn'])
        .split('\n')
        .find((line) => line.startsWith('n'))
        ?.slice(1);
      return (
        cwd &&
        realpathSync(cwd) === root &&
        run('curl', [
          '--noproxy',
          '*',
          '--fail',
          '--silent',
          '--max-time',
          '2',
          `http://127.0.0.1:${port}/status`,
        ]).trim() === 'packager-status:running'
      );
    } catch {
      return false;
    }
  });
}
