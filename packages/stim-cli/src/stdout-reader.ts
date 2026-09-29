import { fstatSync } from 'node:fs';

const READER_CHECK_MS = 2_000;

/**
 * Calls `onGone` once the process reading stdout is gone, for a streaming command that can stay quiet for a long
 * time. Returns a function that stops watching.
 */
export function watchStdoutReader(onGone: () => void): () => void {
  const parent = process.ppid;
  const stdout = fstatSync(1);
  const linuxPipe = process.platform === 'linux' && (stdout.isFIFO() || stdout.isSocket());
  // A zero-length write to a pipe or socket whose reader is gone fails with EPIPE, except to a
  // Linux pipe(2), which returns 0 without checking the reader; there the parent's exit stands in.
  const timer = setInterval(() => {
    if (linuxPipe && process.ppid !== parent) onGone();
    else process.stdout.write('');
  }, READER_CHECK_MS);
  process.stdout.on('error', onGone);
  return () => {
    clearInterval(timer);
    process.stdout.off('error', onGone);
  };
}
