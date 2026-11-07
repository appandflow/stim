import { createHash } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, realpathSync, rmSync } from 'node:fs';
import { connect, createServer, type Server } from 'node:net';
import { basename, dirname, join } from 'node:path';

/** A lock the kernel holds for this process: a bound socket, gone when the process exits. */
export interface StoreLock {
  release(): Promise<void>;
}

/**
 * Binds `<root>/<name>`, or a named pipe on Windows. Node's `fs` has no `flock(2)`, so a listening socket stands in:
 * a bind fails with `EADDRINUSE` while another process listens, and a connect to a leftover socket file whose owner
 * died fails with `ECONNREFUSED`. Returns null while another process holds the lock.
 */
export async function takeLock(root: string, name: '.lock.sock' | '.flip.sock'): Promise<StoreLock | null> {
  mkdirSync(root, { recursive: true });
  const path = lockPath(join(realpathSync(root), name));
  if (process.platform !== 'win32' && path.startsWith('/tmp/stim-sockets-')) {
    const dir = dirname(path);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const owner = lstatSync(dir);
    if (!owner.isDirectory() || owner.uid !== (process.getuid?.() ?? 0))
      throw new Error(`${dir} is not a directory this user owns, so the engine lock is not bound there.`);
  }
  for (let attempt = 0; attempt < 3; attempt++) {
    const server = createServer();
    const bound = await new Promise<NodeJS.ErrnoException | null>((resolve) => {
      server.once('error', resolve);
      server.listen(path, () => resolve(null));
    });
    if (!bound) return { release: () => closeLock(server) };
    if (bound.code !== 'EADDRINUSE') throw Object.assign(bound, { socketPath: path });
    if (process.platform === 'win32') return null;
    const leftover = lstatSync(path, { throwIfNoEntry: false })?.ino;
    const stale = await new Promise<boolean>((resolve) => {
      const socket = connect(path);
      socket.once('connect', () => (socket.destroy(), resolve(false)));
      socket.once('error', (error: NodeJS.ErrnoException) =>
        resolve(error.code === 'ECONNREFUSED' || error.code === 'ENOENT'),
      );
    });
    if (!stale) return null;
    if (lstatSync(path, { throwIfNoEntry: false })?.ino === leftover) rmSync(path, { force: true });
  }
  return null;
}

/**
 * sun_path holds 103 bytes on macOS and 107 on Linux, so a longer path binds `/tmp/stim-sockets-<uid>/<sha-256 of the
 * path>.sock`, the directory stimd's own socket falls back to; `$TMPDIR` can itself be too long (#5363).
 */
function lockPath(path: string): string {
  const hash = createHash('sha256').update(path).digest('hex');
  if (process.platform === 'win32') return `\\\\.\\pipe\\stim-engine-${hash.slice(0, 32)}`;
  if (Buffer.byteLength(path) <= (process.platform === 'linux' ? 107 : 103)) return path;
  const uid = process.getuid?.() ?? 0;
  return join('/tmp', `stim-sockets-${uid}`, `${hash}.sock`);
}

/** The socket used for the engine store's short lock, including its long-path fallback. */
export function engineLockSocket(root: string): string {
  let existing = root;
  const missing: string[] = [];
  while (!existsSync(existing) && dirname(existing) !== existing) {
    missing.unshift(basename(existing));
    existing = dirname(existing);
  }
  let canonical = root;
  try {
    canonical = join(realpathSync(existing), ...missing);
  } catch {}
  return lockPath(join(canonical, '.lock.sock'));
}

function closeLock(server: Server): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()));
}
