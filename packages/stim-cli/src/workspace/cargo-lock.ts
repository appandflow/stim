import { constants } from 'node:fs';
import { lstat, open, type FileHandle } from 'node:fs/promises';
import { once } from 'node:events';
import { basename } from 'node:path';
import { getExecutor } from '../exec.ts';

const LOCK_BUSY = 64;

// flock(2) owns the lock on the open file description shared by parent and child.
// Closing the helper's inherited descriptor leaves the Node handle locked.
// An exit status keeps only 8 bits, so the busy index goes to stderr.
const flockScript = (count: number) => `
  for my $i (0 .. ${count - 1}) {
    open(my $fd, '+<&=' . ($i + 3)) or exit 1;
    flock($fd, LOCK_EX | LOCK_NB) or do { exit 1 unless $!{EWOULDBLOCK}; print STDERR $i; exit ${LOCK_BUSY} };
  }
`;

/**
 * Runs `body` while this process holds an exclusive, non-blocking `flock` on each of `paths` that exists, the way Cargo
 * locks a build directory; a missing file is skipped and never created. A lock another process holds, a path that is
 * not a regular file, a platform or file system where the lock cannot be verified, or a failure to take it keeps
 * everything and says why.
 */
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
      return { kept: 'Cargo build locks cannot be taken on this platform' };
    for (const path of paths) {
      const name = basename(path);
      kept = `its ${name} could not be locked`;
      const before = await lstat(path).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== 'ENOENT') throw error;
        return null;
      });
      if (!before) continue;
      if (!before.isFile()) return { kept };
      let file: FileHandle;
      try {
        file = await open(path, constants.O_RDWR | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      } catch (error) {
        if (error instanceof Error && 'code' in error && error.code === 'ENOENT') continue;
        throw error;
      }
      handles.push({ path, file });
      if (!(await file.stat()).isFile()) return { kept };
    }
    if (!handles.length) {
      kept = undefined;
      return { value: await body() };
    }
    kept = 'Cargo lock acquisition could not be verified';
    const child = getExecutor().spawn(
      process.platform === 'darwin' ? '/usr/bin/perl' : 'perl',
      ['-T', '-MFcntl=:flock', '-e', flockScript(handles.length)],
      { stdio: ['ignore', 'ignore', 'pipe', ...handles.map(({ file }) => file.fd)] },
    );
    let busyIndex = '';
    child.stderr?.on('data', (chunk: Buffer) => (busyIndex += chunk.toString()));
    const timer = setTimeout(() => child.kill('SIGKILL'), 5000);
    const [status] = await once(child, 'close').finally(() => clearTimeout(timer));
    if (status === LOCK_BUSY) {
      const busy = /^\d+$/.test(busyIndex) ? handles[Number(busyIndex)]?.path : undefined;
      return { kept: `a build holds ${busy ?? 'one of its Cargo locks'}` };
    }
    if (status !== 0) return { kept };
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
