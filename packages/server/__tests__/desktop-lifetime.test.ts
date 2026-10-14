import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { captureProcessToken, inspectProcessIdentity, waitForProcessExit } from '@stim-cli/core/process-identity';

const BIN = join(import.meta.dirname, '..', 'bin', 'stim-server.ts');
const PARENT = `
const { spawn } = require('node:child_process');
const { randomBytes } = require('node:crypto');
const mode = process.argv[2];
const env = { ...process.env };
if (mode !== 'none') env.STIM_DESKTOP_BOOTSTRAP_FD = '0';
const child = spawn(process.execPath, [process.argv[1], '--port', '0', '--loopback-only'], {
  env, stdio: ['pipe', 'pipe', 'pipe'],
});
const send = (message) => { if (process.connected) process.send(message); };
send({ pid: child.pid });
child.stdout.on('data', (data) => send({ output: data.toString() }));
child.stderr.on('data', (data) => send({ error: data.toString() }));
child.on('exit', (code) => send({ exit: code }));
child.stdin.on('error', () => {});
if (mode !== 'none') child.stdin.write(randomBytes(32).toString('base64url') + '\\n');
if (mode === 'ended') child.stdin.end();
setInterval(() => {}, 60000);
`;

async function parent(mode: 'live' | 'ended' | 'none') {
  const home = mkdtempSync(join(tmpdir(), 'stim-desktop-lifetime-'));
  const process = spawn(globalThis.process.execPath, ['-e', PARENT, BIN, mode], {
    env: { ...globalThis.process.env, STIM_HOME: home, PATH: '' },
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  let pid = 0;
  let output = '';
  let error = '';
  let exit: number | null | undefined;
  process.on('message', (message: { pid?: number; output?: string; error?: string; exit?: number | null }) => {
    pid = message.pid ?? pid;
    output += message.output ?? '';
    error += message.error ?? '';
    if ('exit' in message) exit = message.exit;
  });
  process.stderr?.on('data', (data: Buffer) => (error += data.toString()));
  let record: { pid: number; processToken: string } | undefined;
  const cleanup = async () => {
    process.kill('SIGKILL');
    if (record && inspectProcessIdentity(record) === 'same') {
      globalThis.process.kill(record.pid, 'SIGTERM');
      if (!(await waitForProcessExit(record, 5000)) && inspectProcessIdentity(record) === 'same') {
        globalThis.process.kill(record.pid, 'SIGKILL');
        await waitForProcessExit(record, 5000);
      }
    }
    rmSync(home, { recursive: true, force: true });
  };
  try {
    await expect.poll(() => pid, { timeout: 5000 }).toBeGreaterThan(0);
    const processToken = captureProcessToken(pid);
    expect(processToken).not.toBeNull();
    if (!processToken) throw new Error('Cannot verify fixture child identity.');
    record = { pid, processToken };
    return {
      process,
      record,
      port: () => Number(/listening on ws:\/\/127\.0\.0\.1:(\d+)/.exec(output)?.[1] ?? 0),
      exit: () => exit,
      error: () => error,
      cleanup,
    };
  } catch (failure) {
    await cleanup();
    throw failure;
  }
}

test('a bundled server releases its listener after its owning parent is killed', async () => {
  const fixture = await parent('live');
  try {
    await expect.poll(fixture.port, { timeout: 10000 }).toBeGreaterThan(0);
    const endpoint = `http://127.0.0.1:${fixture.port()}/health`;
    await expect.poll(async () => (await fetch(endpoint)).status, { timeout: 5000 }).toBe(200);
    fixture.process.kill('SIGKILL');
    expect(await waitForProcessExit(fixture.record, 5000)).toBe(true);
    await expect(fetch(endpoint)).rejects.toThrow('fetch failed');
  } finally {
    await fixture.cleanup();
  }
}, 20000);

test('parent EOF before server startup cannot leave a bundled server behind', async () => {
  const fixture = await parent('ended');
  try {
    await expect.poll(fixture.exit, { timeout: 10000 }).toBe(0);
    expect(await waitForProcessExit(fixture.record, 5000)).toBe(true);
    expect(fixture.error()).not.toContain('Desktop bootstrap input is invalid');
  } finally {
    await fixture.cleanup();
  }
}, 20000);

test('a standalone server keeps serving when its launcher exits', async () => {
  const fixture = await parent('none');
  try {
    await expect.poll(fixture.port, { timeout: 10000 }).toBeGreaterThan(0);
    const endpoint = `http://127.0.0.1:${fixture.port()}/health`;
    await expect.poll(async () => (await fetch(endpoint)).status, { timeout: 5000 }).toBe(200);
    fixture.process.kill('SIGKILL');
    await new Promise<void>((resolve) => fixture.process.once('exit', () => resolve()));
    expect(inspectProcessIdentity(fixture.record)).toBe('same');
    expect((await fetch(endpoint)).status).toBe(200);
  } finally {
    await fixture.cleanup();
  }
}, 20000);
