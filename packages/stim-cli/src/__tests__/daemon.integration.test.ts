import assert from 'node:assert';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { connect, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { daemonClaimRoot, daemonSocket } from '@stim-cli/core/state';
import { getExecutor } from '../exec.ts';
import { readClaimSet } from '../ownership-claim.ts';
import { releaseBuildSlot, tryAcquireBuildSlot } from '../engine/build-slots.ts';
import { runDaemon } from '../daemon/run.ts';

const entry = fileURLToPath(new URL('../daemon/run.ts', import.meta.url));
let home: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'stim-test-'));
  process.env.STIM_HOME = home;
  process.env.STIM_DAEMON = '1';
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
  delete process.env.STIM_HOME;
  delete process.env.STIM_DAEMON;
});

function startDaemonProcess() {
  const child = getExecutor().spawn(process.execPath, [entry], {
    env: { ...process.env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout?.on('data', (chunk) => (output += String(chunk)));
  const exited = new Promise<number | null>((done) => child.once('exit', (code) => done(code)));
  return { child, exited, output: () => output };
}

async function listening(output: () => string): Promise<void> {
  await vi.waitFor(() => expect(output()).toContain('listening on'), { timeout: 10_000, interval: 20 });
}

function readLine(socket: Socket, op: string): Promise<void> {
  return new Promise((done, fail) => {
    let buffer = '';
    socket.setEncoding('utf8');
    socket.on('data', (chunk: string) => {
      buffer += chunk;
      if (buffer.includes(`"op":"${op}"`)) done();
    });
    socket.once('error', fail);
  });
}

test('one daemon per home: a second one exits and leaves the first one holding the claim and socket', async () => {
  const first = startDaemonProcess();
  onTestFinished(async () => {
    first.child.kill('SIGTERM');
    await first.exited;
  });
  await listening(first.output);
  const second = startDaemonProcess();
  expect(await second.exited).toBe(0);
  expect(second.output()).toContain('another daemon holds the claim');
  expect(readClaimSet(daemonClaimRoot()).live.map((holder) => holder.owner.pid)).toEqual([first.child.pid]);
  expect(existsSync(daemonSocket())).toBe(true);
}, 20_000);

test('a released build slot wakes a registered waiter at once instead of on its next poll', async () => {
  const daemon = startDaemonProcess();
  onTestFinished(async () => {
    daemon.child.kill('SIGTERM');
    await daemon.exited;
  });
  await listening(daemon.output);
  const holder = tryAcquireBuildSlot({ max: 1 });
  assert(holder);
  const waiter = connect(daemonSocket());
  onTestFinished(() => {
    waiter.destroy();
  });
  const registered = readLine(waiter, 'slot.waiting');
  waiter.write(`${JSON.stringify({ op: 'slot.wait' })}\n`);
  await registered;
  const woken = readLine(waiter, 'slot.changed');
  expect(releaseBuildSlot(holder)).toBe(true);
  await woken;
  expect(tryAcquireBuildSlot({ max: 1 })).not.toBeNull();
}, 20_000);

test('exits once nothing runs in its home, releasing its claim and removing its socket', async () => {
  await runDaemon({ tickMs: 50 });
  expect(readClaimSet(daemonClaimRoot()).live).toEqual([]);
  expect(existsSync(daemonSocket())).toBe(false);
}, 20_000);
