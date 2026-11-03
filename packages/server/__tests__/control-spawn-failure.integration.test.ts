import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';

let home: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'stim-spawn-failure-'));
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

const url = (path: string): string => JSON.stringify(new URL(path, import.meta.url).href);

// Node signals the caller's own process group when a child that never spawned is killed, so the hub runs in a child
// Node process of its own group: a regression ends that process, not this test runner.
const SCRIPT = `
import { join } from 'node:path';
import { ControlHub } from ${url('../src/control.ts')};
import { FramePool } from ${url('../src/frames.ts')};
import { tryAcquireClaim } from ${url('../../core/ownership-claim.ts')};
const home = process.env.SPAWN_FAILURE_HOME;
const env = { ...process.env, PATH: join(home, 'no-tools') };
const claim = tryAcquireClaim({ root: join(home, 'session.claims'), mode: 'exclusive' }).acquired;
const frames = new FramePool(env);
frames.control = () => ({ send() {}, keys: () => true, clipboard: async () => null, detach() {} });
const hub = new ControlHub({
  frameHelper: () => null,
  env,
  stimCli: join(home, 'unused-cli.mjs'),
  frames,
  subscribeStatus: () => () => {},
  audit: () => {},
  lockLimits: { timeoutMs: 1000, maxOutputBytes: 1024 },
  idleMs: 60_000,
  renewMs: 60_000,
  leaseFor: '1m',
  foldHelper: async () => join(home, 'sim-fold'),
  foldTimeoutMs: 5000,
  conflict: () => {},
});
const owner = { device: { id: 'client', name: 'Client' }, send() {} };
const device = { platform: 'ios', udid: 'SIM-UDID', foldable: false };
const begun = await hub.beginHosted(owner, { workspace: '/client/app', platform: 'ios' }, home, device, frames, () => true, claim);
const refused = await hub.input(owner, begun.session, { input: 'clipboard', text: 'hello', paste: false });
process.stdout.write(JSON.stringify(refused));
await hub.close();
await frames.close();
`;

it('refuses an input whose tool cannot start while a claim is held, and keeps the server running', async () => {
  mkdirSync(join(home, 'no-tools'));
  const child = spawn(process.execPath, ['--input-type=module', '-e', SCRIPT], {
    detached: true,
    env: { ...process.env, SPAWN_FAILURE_HOME: home },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk: Buffer) => (stdout += chunk));
  child.stderr.on('data', (chunk: Buffer) => (stderr += chunk));
  const exit = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) =>
    child.on('close', (code, signal) => resolve({ code, signal })),
  );
  expect({ ...exit, stderr }).toEqual({ code: 0, signal: null, stderr: '' });
  expect(JSON.parse(stdout)).toMatchObject({
    code: 'action-failed',
    message: expect.stringContaining('simctl pbcopy'),
  });
}, 15_000);
