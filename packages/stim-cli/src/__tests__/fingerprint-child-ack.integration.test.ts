import { spawn, spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { workspaceName } from '@stim-cli/core';
import { NATIVE_RUN_LOCK } from '../engine/native-run.ts';
import { workspaceProcessLockPath } from '../engine/workspace-process-lock.ts';
import { getExecutor, observeDetachedChildren, resetExecutor, setExecutor } from '../exec.ts';
import { detectFingerprintParity, fingerprintReportGate } from '../diagnostics/doctor.ts';
import { readFingerprint } from '../fingerprint-precompute.ts';
import { runReport } from '../report-runtime.ts';
import { readClaimSet } from '../ownership-claim.ts';
import { markObserving, recordDetachedGroups } from '../fingerprint/detached-groups.ts';
import { captureProcessIdentity, inspectProcessIdentity } from '../process-identity.ts';
import { testContext } from './_context.ts';
import { goneClaimOwner, recycledClaimOwner } from './_factories.ts';

const MOBILE_MODULES = fileURLToPath(new URL('../../../../apps/mobile/node_modules', import.meta.url));
const BOOTSTRAP = fileURLToPath(new URL('../../dist/fingerprint-precompute.mjs', import.meta.url));
const load = vi.hoisted(() => ({ high: false }));
vi.mock('../stimd/passes/measure.ts', async (original) => ({
  ...(await original<typeof import('../stimd/passes/measure.ts')>()),
  sizeScanDeferred: () => load.high,
}));

const SLOW = { timeout: 120_000 };
const temps: string[] = [];

beforeEach(() => {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'stim-fp-ack-home-')));
  temps.push(home);
  process.env.STIM_HOME = home;
});

afterEach(() => {
  delete process.env.STIM_HOME;
  resetExecutor();
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function write(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
}

function expoApp(files: Record<string, string>): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'stim-fp-ack-')));
  temps.push(root);
  write(
    join(root, 'package.json'),
    JSON.stringify({ name: 'fp-app', version: '1.0.0', dependencies: { expo: '*', 'react-native': '*' } }),
  );
  write(join(root, 'pnpm-lock.yaml'), readFileSync(join(MOBILE_MODULES, '..', '..', '..', 'pnpm-lock.yaml'), 'utf8'));
  write(join(root, 'app.json'), JSON.stringify({ expo: { name: 'fp', slug: 'fp' } }));
  for (const [path, text] of Object.entries(files)) write(join(root, path), text);
  symlinkSync(MOBILE_MODULES, join(root, 'node_modules'));
  return root;
}

const env = (): NodeJS.ProcessEnv => ({ PATH: process.env.PATH, STIM_HOME: process.env.STIM_HOME });
const lockOf = (home: string, root: string) =>
  workspaceProcessLockPath(join(home, 'workspaces', workspaceName(root)), NATIVE_RUN_LOCK, true);

async function until(check: () => boolean, ms: number): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (!check() && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 20));
  return check();
}

test.skipIf(process.platform === 'win32')(
  'a SIGTERM that arrives while the child loads its modules still writes the acknowledgement',
  async () => {
    const area = realpathSync(mkdtempSync(join(tmpdir(), 'stim-fp-boot-')));
    temps.push(area);
    const loading = join(area, 'loading');
    const acknowledgement = join(area, 'settled.json');
    const source = readFileSync(BOOTSTRAP, 'utf8');
    const chunk = /import\("(\.\/precompute-child-[^"]+\.mjs)"\)/.exec(source)?.[1];
    if (!chunk) throw new Error('the child bootstrap does not import its main module');
    write(join(area, 'boot.mjs'), source);
    write(
      join(area, chunk),
      `import { writeFileSync } from 'node:fs';
writeFileSync(${JSON.stringify(loading)}, '');
await new Promise((resolve) => setTimeout(resolve, 15000));
export const runPrecomputeChild = async () => {};`,
    );
    const child = spawn(process.execPath, [join(area, 'boot.mjs')], { stdio: ['pipe', 'ignore', 'ignore'] });
    const exited = new Promise<number | null>((resolve) => child.once('exit', (code) => resolve(code)));
    child.stdin.end(JSON.stringify({ ownership: { directory: area, acknowledgement, nonce: 'n1' } }));
    try {
      expect(await until(() => existsSync(loading), 20_000)).toBe(true);
      child.kill('SIGTERM');
      expect(await exited).toBe(0);
      expect(JSON.parse(readFileSync(acknowledgement, 'utf8'))).toEqual({ nonce: 'n1', settled: true });
    } finally {
      child.kill('SIGKILL');
    }
  },
  30_000,
);

test.skipIf(process.platform === 'win32')(
  'an abort while the child evaluates a project config ends acknowledged and releases the claim',
  SLOW,
  async () => {
    const root = expoApp({});
    const marker = join(root, 'evaluator-pid');
    write(
      join(root, 'app.config.js'),
      `require('node:fs').writeFileSync(${JSON.stringify(marker)}, String(process.pid));
Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 60000);
module.exports = { name: 'fp', slug: 'fp' };`,
    );
    const controller = new AbortController();
    const context = testContext({ projectRoot: root, env: env(), signal: controller.signal });
    const running = readFingerprint(context, { root, platform: 'ios', embedMode: 'development' }).catch(
      (error: unknown) => error,
    );
    expect(await until(() => existsSync(marker), 60_000)).toBe(true);
    const evaluator = Number(readFileSync(marker, 'utf8'));
    controller.abort(new Error('the report budget ended'));
    const outcome = await running;
    expect(outcome).not.toMatchObject({ reportCleanup: true });
    expect(() => process.kill(evaluator, 0)).toThrow(/ESRCH/);
    const lock = lockOf(context.home, root);
    expect(readClaimSet(lock)).toMatchObject({ live: [], dead: [], unresolved: [] });
    expect(existsSync(lock)).toBe(false);
  },
);

async function killedChild(
  root: string,
  ledger: (directory: string) => void | Promise<void>,
  { observing = true }: { observing?: boolean } = {},
) {
  const context = testContext({ projectRoot: root, env: env() });
  setExecutor({
    ...getExecutor(),
    runFileAsync: async (_file, _args, options) => {
      const request: { ownership: { directory: string } } = JSON.parse(String(options.input));
      temps.push(request.ownership.directory);
      const child = spawn('sleep', ['30'], { detached: true, stdio: 'ignore' });
      const exited = new Promise((resolve) => child.once('exit', resolve));
      options.onSpawn?.(child);
      if (observing) markObserving(request.ownership.directory);
      await ledger(request.ownership.directory);
      child.kill('SIGKILL');
      await exited;
      throw Object.assign(new Error('the child was killed'), { code: 'ABORT_ERR' });
    },
  });
  return { context, run: () => readFingerprint(context, { root, platform: 'ios', embedMode: 'development' }) };
}

async function detachedSleep(): Promise<{ pid: number; processToken: string }> {
  const child = spawn('sleep', ['30'], { detached: true, stdio: 'ignore' });
  child.unref();
  const pid = child.pid;
  const captured = pid === undefined ? null : captureProcessIdentity(pid);
  if (pid === undefined || !captured?.ok) throw new Error('the fixture process has no identity');
  return { pid, processToken: captured.token };
}

test.skipIf(process.platform === 'win32')('a child killed before it started anything releases the claim', async () => {
  const root = expoApp({});
  const { context, run } = await killedChild(root, () => {});
  await expect(run()).rejects.toThrow('the child was killed');
  expect(existsSync(lockOf(context.home, root))).toBe(false);
});

test.skipIf(process.platform === 'win32')(
  'a child killed with every recorded process group gone releases the claim',
  async () => {
    const root = expoApp({});
    const { context, run } = await killedChild(root, (directory) =>
      write(join(directory, 'group-1.json'), JSON.stringify({ record: goneClaimOwner() })),
    );
    await expect(run()).rejects.toThrow('the child was killed');
    expect(existsSync(lockOf(context.home, root))).toBe(false);
  },
);

test.skipIf(process.platform === 'win32')(
  'the owner stops a recorded group that still runs and releases the claim',
  async () => {
    const root = expoApp({});
    const group = await detachedSleep();
    const { context, run } = await killedChild(root, (directory) =>
      write(join(directory, 'group-1.json'), JSON.stringify({ record: group })),
    );
    await expect(run()).rejects.toThrow('the child was killed');
    expect(inspectProcessIdentity(group)).not.toBe('same');
    expect(existsSync(lockOf(context.home, root))).toBe(false);
  },
);

test.each([
  [
    'a group that cannot be proven gone',
    (directory: string) => write(join(directory, 'group-1.json'), JSON.stringify({ record: recycledClaimOwner() })),
    true,
  ],
  [
    'a group recorded before its spawn finished',
    (directory: string) => write(join(directory, 'group-1.json'), JSON.stringify({ record: null })),
    true,
  ],
  ['a record that cannot be read', (directory: string) => write(join(directory, 'group-1.json'), '{'), true],
  ['no evidence that the child observed its groups', () => {}, false],
])('a child killed with %s retains the claim', async (_name, ledger, observing) => {
  const root = expoApp({});
  const { context, run } = await killedChild(root, ledger, { observing });
  await expect(run()).rejects.toMatchObject({ code: 'STIM_CLAIM_UNAVAILABLE', reportCleanup: true });
  expect(readClaimSet(lockOf(context.home, root)).live[0]).toMatchObject({ childDeclared: true, child: null });
});

test.skipIf(process.platform === 'win32')(
  'the observer records a detached child before it can run and removes the record once its group is gone',
  async () => {
    const directory = realpathSync(mkdtempSync(join(tmpdir(), 'stim-fp-ledger-')));
    temps.push(directory);
    observeDetachedChildren(recordDetachedGroups(directory));
    try {
      const controller = new AbortController();
      const entries = () => readdirSync(directory).filter((name) => name.startsWith('group-'));
      let recorded: unknown;
      const running = getExecutor().runFileAsync('/bin/sleep', ['30'], {
        timeoutMs: 'unbounded',
        signal: controller.signal,
        onSpawn: () => {
          recorded = JSON.parse(readFileSync(join(directory, entries()[0] ?? 'missing'), 'utf8'));
          controller.abort(new Error('stop'));
        },
      });
      await expect(running).rejects.toThrow('stop');
      expect(recorded).toMatchObject({ record: { pid: expect.any(Number), processToken: expect.any(String) } });
      expect(entries()).toEqual([]);
    } finally {
      observeDetachedChildren(null);
    }
  },
);

test.skipIf(process.platform === 'win32')(
  'an observer that throws after the spawn does not stop exec supervising the child',
  async () => {
    const directory = realpathSync(mkdtempSync(join(tmpdir(), 'stim-fp-ledger-')));
    temps.push(directory);
    const real = recordDetachedGroups(directory);
    observeDetachedChildren({
      begin: () => real.begin(),
      started: () => {
        throw new Error('disk full');
      },
      settled: () => {
        throw new Error('disk full');
      },
    });
    try {
      const controller = new AbortController();
      let pid = 0;
      const running = getExecutor().runFileAsync('/bin/sleep', ['30'], {
        timeoutMs: 'unbounded',
        signal: controller.signal,
        onSpawn: (child) => {
          pid = child.pid ?? 0;
          controller.abort(new Error('stop'));
        },
      });
      await expect(running).rejects.toThrow('stop');
      expect(() => process.kill(pid, 0)).toThrow(/ESRCH/);
      const entries = readdirSync(directory).filter((name) => name.startsWith('group-'));
      expect(entries).toHaveLength(1);
      expect(JSON.parse(readFileSync(join(directory, entries[0] ?? 'missing'), 'utf8'))).toEqual({ record: null });
    } finally {
      observeDetachedChildren(null);
    }
  },
);

test('a report with too little time left skips the parity check and says so', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'stim-fp-parity-')));
  temps.push(root);
  const git = (...args: string[]) => spawnSync('git', args, { cwd: root });
  git('init', '-q');
  const context = testContext({ projectRoot: root, env: env() });
  const finding = await runReport(context, (operation) => detectFingerprintParity(root, { operation }), 5_000);
  expect(finding).toMatchObject({ title: 'Fingerprint parity was not checked' });
});

test('a report on a loaded host skips the parity check and the fingerprint notes', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'stim-fp-parity-')));
  temps.push(root);
  spawnSync('git', ['init', '-q'], { cwd: root });
  const context = testContext({ projectRoot: root, env: env() });
  load.high = true;
  try {
    const [finding, gate] = await runReport(
      context,
      (operation) => Promise.all([detectFingerprintParity(root, { operation }), fingerprintReportGate(operation)]),
      120_000,
    );
    expect(finding).toMatchObject({ title: 'Fingerprint parity was not checked' });
    expect(gate).toMatch(/host load is too high/);
    expect(fingerprintReportGate(context)).toBeNull();
  } finally {
    load.high = false;
  }
});
