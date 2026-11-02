import assert from 'node:assert';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { connect, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { daemonClaimRoot, daemonNdjsonFile, daemonSocket, readDaemonSnapshot } from '@stim-cli/core/state';
import { getExecutor } from '../exec.ts';
import { readClaimSet } from '../ownership-claim.ts';
import { releaseBuildSlot, tryAcquireBuildSlot } from '../engine/build-slots.ts';
import { runDaemon } from '../daemon/run.ts';
import { requestDaemonTick } from '../daemon/client.ts';

const entry = fileURLToPath(new URL('../daemon/run.ts', import.meta.url));
let home: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'stim-test-'));
  process.env.STIM_HOME = home;
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
  delete process.env.STIM_HOME;
});

function daemonLog(): string {
  return existsSync(daemonNdjsonFile()) ? readFileSync(daemonNdjsonFile(), 'utf8') : '';
}

function startDaemonProcess() {
  const child = getExecutor().spawn(process.execPath, [entry], { env: { ...process.env }, stdio: 'ignore' });
  const exited = new Promise<number | null>((done) => child.once('exit', (code) => done(code)));
  return { child, exited };
}

async function listening(): Promise<void> {
  await vi.waitFor(() => expect(daemonLog()).toContain('"event":"daemon_started"'), { timeout: 10_000, interval: 20 });
}

function lines(socket: Socket): string[] {
  const received: string[] = [];
  let buffer = '';
  socket.setEncoding('utf8');
  socket.on('data', (chunk: string) => {
    buffer += chunk;
    for (let end = buffer.indexOf('\n'); end >= 0; end = buffer.indexOf('\n')) {
      received.push(buffer.slice(0, end));
      buffer = buffer.slice(end + 1);
    }
  });
  return received;
}

async function waiter(resource: 'slot' | 'boot' = 'slot'): Promise<{ socket: Socket; received: string[] }> {
  const socket = connect(daemonSocket());
  onTestFinished(() => {
    socket.destroy();
  });
  const received = lines(socket);
  socket.write(`${JSON.stringify({ op: `${resource}.wait` })}\n`);
  await vi.waitFor(() => expect(received.join()).toContain(`"op":"${resource}.waiting"`), {
    timeout: 10_000,
    interval: 20,
  });
  return { socket, received };
}

function release(resource: 'slot' | 'boot' = 'slot'): void {
  const socket = connect(daemonSocket());
  socket.once('connect', () => socket.end(`${JSON.stringify({ op: `${resource}.released` })}\n`));
}

test('one daemon per home: a second one exits and leaves the first one holding the claim and socket', async () => {
  const first = startDaemonProcess();
  onTestFinished(async () => {
    first.child.kill('SIGTERM');
    await first.exited;
  });
  await listening();
  const second = startDaemonProcess();
  expect(await second.exited).toBe(0);
  expect(daemonLog()).toContain('"event":"daemon_claim_held"');
  expect(readClaimSet(daemonClaimRoot()).live.map((holder) => holder.owner.pid)).toEqual([first.child.pid]);
  expect(existsSync(daemonSocket())).toBe(true);
}, 20_000);

test('a released build slot wakes the oldest waiter at once, and the next release the one after it', async () => {
  const daemon = startDaemonProcess();
  onTestFinished(async () => {
    daemon.child.kill('SIGTERM');
    await daemon.exited;
  });
  await listening();
  const holder = tryAcquireBuildSlot({ max: 1 });
  assert(holder);
  const first = await waiter();
  const second = await waiter();
  expect(releaseBuildSlot(holder)).toBe(true);
  await vi.waitFor(() => expect(first.received.join()).toContain('"op":"slot.changed"'), {
    timeout: 10_000,
    interval: 20,
  });
  expect(second.received.join()).not.toContain('"op":"slot.changed"');
  first.socket.destroy();
  release();
  await vi.waitFor(() => expect(second.received.join()).toContain('"op":"slot.changed"'), {
    timeout: 10_000,
    interval: 20,
  });
}, 20_000);

test('a finished boot wakes the oldest boot waiter only, never a build waiter', async () => {
  const daemon = startDaemonProcess();
  onTestFinished(async () => {
    daemon.child.kill('SIGTERM');
    await daemon.exited;
  });
  await listening();
  const build = await waiter('slot');
  const first = await waiter('boot');
  const second = await waiter('boot');
  release('boot');
  await vi.waitFor(() => expect(first.received.join()).toContain('"op":"boot.changed"'), {
    timeout: 10_000,
    interval: 20,
  });
  expect(second.received.join()).not.toContain('"op":"boot.changed"');
  expect(build.received.join()).not.toContain('changed');
  first.socket.destroy();
  release('boot');
  await vi.waitFor(() => expect(second.received.join()).toContain('"op":"boot.changed"'), {
    timeout: 10_000,
    interval: 20,
  });
}, 20_000);

test('a tick request is answered when a tick finishes, and the snapshot carries the pressure level', async () => {
  const daemon = startDaemonProcess();
  onTestFinished(async () => {
    daemon.child.kill('SIGTERM');
    await daemon.exited;
  });
  await listening();
  await expect(requestDaemonTick({ STIM_DAEMON: 'on' })).resolves.toBe(true);
  expect(readDaemonSnapshot()).toMatchObject({
    pressure: { level: expect.stringMatching(/^(normal|high|critical)$/) },
    actions: expect.any(Array),
    waiting: [],
  });
}, 20_000);

test('exits after two ticks with nothing running in its home, releasing its claim and removing its socket', async () => {
  await runDaemon({ tickMs: 50 });
  expect(readClaimSet(daemonClaimRoot()).live).toEqual([]);
  expect(existsSync(daemonSocket())).toBe(false);
  expect(daemonLog().match(/"event":"daemon_tick"/g)).toHaveLength(2);
  expect(readDaemonSnapshot()).toMatchObject({ mode: 'on', intervalMs: 50, workspaces: [] });
}, 20_000);

test('a tick that fails hands the timers back: the daemon releases its claim and exits instead of holding it idle', async () => {
  writeFileSync(join(home, 'config.json'), '{ not json');
  await runDaemon({ tickMs: 50 });
  expect(readClaimSet(daemonClaimRoot()).live).toEqual([]);
  expect(existsSync(daemonSocket())).toBe(false);
}, 20_000);
