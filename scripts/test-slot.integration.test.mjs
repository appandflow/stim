import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { acquireTestSlot } from './test-slot.mjs';

let dir;
let lines;
const open = [];

function take(name, slots = 1) {
  const arrival = acquireTestSlot({ dir, slots, details: { cwd: name }, log: (line) => lines.push(line), pollMs: 10 });
  const state = { name, release: null };
  state.taken = arrival.then((release) => {
    state.release = release;
    open.push(release);
    return release;
  });
  return state;
}

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'stim-testslot-'));
  lines = [];
});

afterEach(() => {
  for (const release of open.splice(0)) release();
  rmSync(dir, { recursive: true, force: true });
});

describe('acquireTestSlot', () => {
  it('admits callers in arrival order, one per slot', async () => {
    const first = take('first');
    await first.taken;
    const second = take('second');
    await pause(20);
    const third = take('third');
    await pause(100);
    expect([second.release, third.release]).toEqual([null, null]);

    first.release();
    await second.taken;
    await pause(100);
    expect(third.release).toBeNull();

    second.release();
    await third.taken;
  });

  it('lets as many callers run as there are slots', async () => {
    const [a, b] = [take('a', 2), take('b', 2)];
    await Promise.all([a.taken, b.taken]);
    const c = take('c', 2);
    await pause(100);
    expect(c.release).toBeNull();
    a.release();
    await c.taken;
  });

  it('frees a slot whose holder was killed', async () => {
    const holder = spawn(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        `const { acquireTestSlot } = await import(${JSON.stringify(pathToFileURL(fileURLToPath(new URL('./test-slot.mjs', import.meta.url))).href)});
await acquireTestSlot({ dir: ${JSON.stringify(dir)}, slots: 1, details: {}, log: () => {} });
console.log('held');
setInterval(() => {}, 1000);`,
      ],
      { stdio: ['ignore', 'pipe', 'inherit'] },
    );
    await new Promise((resolve, reject) => {
      holder.stdout.once('data', resolve);
      holder.once('error', reject);
    });
    const waiting = take('after the holder');
    await pause(100);
    expect(waiting.release).toBeNull();
    holder.kill('SIGKILL');
    await waiting.taken;
  });

  it('runs without the cap when a claim cannot be judged', async () => {
    mkdirSync(join(dir, 'slot-0', 'exclusive'), { recursive: true });
    writeFileSync(join(dir, 'slot-0', 'exclusive', 'broken.claim'), 'not json');
    await take('unjudged').taken;
    expect(lines.some((line) => line.includes('running without the cap'))).toBe(true);
  });
});
