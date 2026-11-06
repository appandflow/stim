import { randomBytes } from 'node:crypto';
import { renameSync, rmSync, writeFileSync } from 'node:fs';
import type { Readable } from 'node:stream';
import { desktopKeyFile } from '@stim-cli/core/state';

const KEY = /^[A-Za-z0-9_-]{43}$/;
const INPUT_ERROR = 'Desktop bootstrap input is invalid or unavailable.';

/**
 * Writes `run/desktop.key`, mode 0600 beside `run/stimd.json`: `key`, or a new random one. Stim Desktop reads it and
 * proves it to the net thread with `desktop.authenticate`; only this user can read it.
 */
export function writeDesktopKey(key: string = randomBytes(32).toString('base64url')): string {
  const file = desktopKeyFile();
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, `${key}\n`, { mode: 0o600 });
  try {
    renameSync(tmp, file);
  } catch (error) {
    rmSync(tmp, { force: true });
    throw error;
  }
  return key;
}

/**
 * Reads the newline-terminated key a Stim Desktop that launches `stim serve` writes on stdin; the open pipe then
 * tracks that parent's lifetime, so `closed` resolves when it ends.
 */
export function readDesktopInput(input: Readable, timeoutMs = 5000): Promise<{ key: string; closed: Promise<void> }> {
  return new Promise((resolve, reject) => {
    let bytes = Buffer.alloc(0);
    let ready = false;
    let close!: () => void;
    const closed = new Promise<void>((done) => (close = done));
    const ended = () => {
      clearTimeout(timer);
      input.off('data', data);
      input.destroy();
      close();
      if (!ready) reject(new Error(INPUT_ERROR));
    };
    const data = (chunk: Buffer | string) => {
      if (ready) return ended();
      bytes = Buffer.concat([bytes, typeof chunk === 'string' ? Buffer.from(chunk) : chunk]);
      if (bytes.length > 44) return ended();
      if (bytes.length < 44) return;
      const key = bytes.subarray(0, 43).toString('utf8');
      if (bytes[43] !== 10 || !KEY.test(key)) return ended();
      ready = true;
      clearTimeout(timer);
      resolve({ key, closed });
    };
    const timer = setTimeout(ended, timeoutMs);
    input.on('data', data);
    input.once('end', ended);
    input.once('error', ended);
    input.once('close', ended);
  });
}
