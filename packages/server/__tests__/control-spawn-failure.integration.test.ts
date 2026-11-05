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

// Node signals the caller's own process group when a child that never spawned is killed, so each scenario runs in a
// child Node process of its own group: a regression ends that process, not this test runner.
const HUB_SCRIPT = `
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

async function runDetached(
  script: string,
): Promise<{ code: number | null; signal: NodeJS.Signals | null; stdout: string; stderr: string }> {
  const child = spawn(process.execPath, ['--input-type=module', '-e', script], {
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
  return { ...exit, stdout, stderr };
}

it('reports the spawn error of an input whose tool cannot start while a claim is held', async () => {
  mkdirSync(join(home, 'no-tools'));
  const { stdout, ...rest } = await runDetached(HUB_SCRIPT);
  expect(rest).toEqual({ code: 0, signal: null, stderr: '' });
  expect(JSON.parse(stdout)).toMatchObject({
    code: 'action-failed',
    message: expect.stringMatching(/^simctl pbcopy could not start \(spawn xcrun ENOENT\)/),
  });
}, 15_000);

const GUARDS_SCRIPT = `
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { signalChild, terminate } from ${url('../src/stim-command.ts')};
const missing = () => spawn(join(process.env.SPAWN_FAILURE_HOME, 'missing-tool'), [], { stdio: 'ignore' });
const result = {};
const first = missing();
first.on('error', () => {});
result.signalChild = signalChild(first, 'SIGTERM');
const second = missing();
let errored = false;
second.on('error', () => (errored = true));
await terminate(second);
result.terminateReturnedBeforeError = !errored;
await new Promise((resolve) => setTimeout(resolve, 100));
process.stdout.write(JSON.stringify(result));
`;

it('does not signal a child that never spawned, and does not wait for it to exit', async () => {
  const { stdout, ...rest } = await runDetached(GUARDS_SCRIPT);
  expect(rest).toEqual({ code: 0, signal: null, stderr: '' });
  expect(JSON.parse(stdout)).toEqual({ signalChild: false, terminateReturnedBeforeError: true });
}, 15_000);
