import { readFileSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';

/**
 * A fixture child creates its pid file and writes the pid in two steps, so the file can exist and be empty.
 * Waits for it to hold a pid and returns it.
 */
export async function readPid(file: string, timeoutMs = 10_000): Promise<number> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    let text = '';
    try {
      text = readFileSync(file, 'utf8').trim();
    } catch {}
    const pid = Number(text);
    if (text !== '' && Number.isSafeInteger(pid) && pid > 0) return pid;
    if (Date.now() > deadline) throw new Error(`${file} held no pid after ${timeoutMs} ms: ${JSON.stringify(text)}`);
    await sleep(10);
  }
}
