import { constants } from 'node:fs';
import { lstat, open, statfs, type FileHandle } from 'node:fs/promises';
import { once } from 'node:events';
import { basename, dirname } from 'node:path';
import { getExecutor } from '../exec.ts';

const LOCK_BUSY = 64;
const NFS_SUPER_MAGIC = 0x6969;

// flock(2) owns the lock on the open file description shared by parent and child.
// Closing the helper's inherited descriptor leaves the Node handle locked.
const flockScript = (count: number) => `
  for my $i (0 .. ${count - 1}) {
    open(my $fd, '+<&=' . ($i + 3)) or exit 1;
    flock($fd, LOCK_EX | LOCK_NB) or exit($!{EWOULDBLOCK} ? ${LOCK_BUSY} + $i : 1);
  }
`;

export async function withCargoLocks<T>(
  paths: readonly string[],
  body: () => Promise<T>,
  signal?: AbortSignal,
): Promise<{ value: T } | { kept: string }> {
  const handles: { path: string; file: FileHandle }[] = [];
  let kept: string | undefined;
  try {
    signal?.throwIfAborted();
    if (process.platform !== 'darwin' && process.platform !== 'linux')
      return { kept: 'Cargo unit locking is unavailable on this platform' };
    for (const path of paths) {
      const name = basename(path);
      kept = `its ${name} could not be locked, so the sweep stopped`;
      // Cargo skips flock on Linux NFS (rust-lang/cargo#2615).
      if (process.platform === 'linux' && (await statfs(dirname(path))).type === NFS_SUPER_MAGIC) return { kept };
      const before = await lstat(path).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== 'ENOENT') throw error;
        return null;
      });
      if (before && !before.isFile()) return { kept };
      const file = await open(path, constants.O_RDWR | constants.O_CREAT | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      handles.push({ path, file });
      if (!(await file.stat()).isFile()) return { kept };
    }
    kept = 'Cargo lock acquisition could not be verified, so the sweep stopped';
    const child = getExecutor().spawn(
      process.platform === 'darwin' ? '/usr/bin/perl' : 'perl',
      ['-T', '-MFcntl=:flock', '-e', flockScript(handles.length)],
      { stdio: ['ignore', 'ignore', 'ignore', ...handles.map(({ file }) => file.fd)] },
    );
    const timer = setTimeout(() => child.kill('SIGKILL'), 5000);
    const [status] = await once(child, 'close').finally(() => clearTimeout(timer));
    const busyPath = typeof status === 'number' ? paths[status - LOCK_BUSY] : undefined;
    if (busyPath) return { kept: `a build or sweep holds ${basename(busyPath)}, so the sweep stopped` };
    if (status !== 0) return { kept };
    for (const { path, file } of handles) {
      const current = await lstat(path, { bigint: true });
      const opened = await file.stat({ bigint: true });
      if (current.dev !== opened.dev || current.ino !== opened.ino) return { kept };
    }
    signal?.throwIfAborted();
    kept = undefined;
    return { value: await body() };
  } catch (error) {
    signal?.throwIfAborted();
    if (!kept) throw error;
    return { kept };
  } finally {
    await Promise.all(handles.map(({ file }) => file.close()));
  }
}
