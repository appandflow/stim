import { spawn } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { listTestSlots, tryAcquireTestSlot } from '../engine/test-slots.ts';
import { listTestWaiting } from '../engine/wait-queue.ts';

const cli = fileURLToPath(new URL('../../bin/cli.ts', import.meta.url));

const FAKE_RUNNER = `#!/usr/bin/env node
const { existsSync, writeFileSync } = require('node:fs');
const [hold] = (process.env.FAKE_HOLD ?? '').split(',').filter(Boolean);
const line = JSON.stringify({ argv: process.argv.slice(2), vitest: process.env.VITEST_MAX_WORKERS ?? null, run: process.env.STIM_TEST_RUN ?? null });
console.log(line);
if (hold) writeFileSync(hold + '.out', line);
if (hold && process.env.FAKE_WORKER) {
  const onTerm = process.env.FAKE_WORKER === 'slow' ? \`setInterval(() => require('node:fs').existsSync(\${JSON.stringify(hold + '.release')}) && process.exit(0), 20)\` : '';
  const worker = require('node:child_process').spawn(process.execPath, ['-e', \`require('node:fs').writeFileSync(\${JSON.stringify(hold + '.worker')}, String(process.pid)); process.on('SIGTERM', () => { \${onTerm} }); setInterval(() => {}, 1000);\`], { stdio: 'ignore' });
  worker.unref();
}
if (process.env.FAKE_IGNORE_TERM) process.on('SIGTERM', () => {});
if (process.env.FAKE_TERM_EXIT_0) process.on('SIGTERM', () => process.exit(0));
if (process.env.FAKE_NESTED_HOLD) {
  const inner = require('node:child_process').spawn(process.execPath, [process.env.FAKE_NESTED_HOLD, 'test', '--', 'jest'], { env: { ...process.env, FAKE_NESTED_HOLD: '', FAKE_HOLD: hold + '-inner' }, stdio: 'ignore' });
  writeFileSync(hold + '.inner-stim', String(inner.pid));
  inner.on('exit', (code, signal) => writeFileSync(hold + '.inner-exit', String(code ?? signal)));
}
if (process.env.FAKE_NESTED) {
  const r = require('node:child_process').spawnSync(process.execPath, [process.env.FAKE_NESTED, 'test', '--', 'jest'], { env: { ...process.env, FAKE_NESTED: '', FAKE_WORKER: 'ignore', FAKE_HOLD: hold + '-inner', FAKE_EXIT_AFTER_START: '1' }, stdio: 'inherit' });
  process.exit(r.status ?? 1);
}
if (hold) {
  writeFileSync(hold + '.started', String(process.pid));
  if (process.env.FAKE_EXIT_AFTER_START) setTimeout(() => process.exit(0), 200);
  const wait = setInterval(() => { if (existsSync(hold + '.go')) { clearInterval(wait); process.exit(0); } }, 20);
} else process.exit(Number(process.env.FAKE_EXIT ?? 0));
`;

let home: string;
let app: string;
let bin: string;

beforeEach(() => {
  home = realpathSync(mkdtempSync(join(tmpdir(), 'stim-test-command-')));
  app = join(home, 'app');
  bin = join(app, 'node_modules', '.bin');
  mkdirSync(bin, { recursive: true });
  for (const name of ['jest', 'vitest']) {
    writeFileSync(join(bin, name), FAKE_RUNNER);
    chmodSync(join(bin, name), 0o755);
  }
  writeFileSync(join(app, 'package.json'), JSON.stringify({ name: 'app', scripts: { test: 'jest --ci' } }));
  writeFileSync(join(app, 'package-lock.json'), '{}');
  vi.stubEnv('STIM_HOME', home);
});

afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(home, { recursive: true, force: true });
});

interface Run {
  child: ReturnType<typeof spawn>;
  done: Promise<{ code: number | null; stdout: string; stderr: string }>;
}

function start(args: string[], env: NodeJS.ProcessEnv = {}): Run {
  const childEnv: NodeJS.ProcessEnv = { ...process.env };
  delete childEnv.STIM_TEST_RUN;
  delete childEnv.VITEST_MAX_WORKERS;
  Object.assign(childEnv, {
    STIM_HOME: home,
    STIM_DAEMON: 'off',
    STIM_MAX_TESTS: '1',
    PATH: `${bin}${delimiter}${process.env.PATH ?? ''}`,
    ...env,
  });
  const child = spawn(process.execPath, [cli, 'test', ...args], { cwd: app, env: childEnv });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => (stdout += chunk));
  child.stderr.on('data', (chunk) => (stderr += chunk));
  const done = new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve) =>
    child.once('close', (code) => resolve({ code, stdout, stderr })),
  );
  return { child, done };
}

const ran = (stdout: string): { argv: string[]; vitest: string | null; run: string | null } =>
  JSON.parse(stdout.trim().split('\n').at(-1) ?? '');
const announced = (stderr: string) => /test\s+(\d+) workers \(/.exec(stderr)?.[1];
const liveSlots = () => listTestSlots().filter((slot) => slot.alive || slot.unresolved);

describe.skipIf(process.platform === 'win32')('stim test', () => {
  test('passes a direct Jest run its worker count and its exit status, and frees the slot on a failure', async () => {
    const { code, stdout, stderr } = await start(['--', 'npx', 'jest', 'src/a.test.ts'], { FAKE_EXIT: '3' }).done;
    expect(code).toBe(3);
    const workers = announced(stderr);
    expect(Number(workers)).toBeGreaterThan(0);
    expect(ran(stdout)).toMatchObject({ argv: ['src/a.test.ts', `--maxWorkers=${workers}`], vitest: null });
    expect(liveSlots()).toEqual([]);
  }, 60_000);

  test("runs the project's test script through its package manager with the count forwarded to Jest", async () => {
    const { code, stdout, stderr } = await start([]).done;
    expect(code).toBe(0);
    expect(ran(stdout).argv).toEqual(['--ci', `--maxWorkers=${announced(stderr)}`]);
  }, 60_000);

  test('Vitest gets the flag, and a serial Vitest config or a caller -w is kept', async () => {
    const vitest = await start(['--', 'vitest', 'run']).done;
    expect(ran(vitest.stdout)).toEqual({
      argv: ['run', `--maxWorkers=${announced(vitest.stderr)}`],
      vitest: null,
      run: expect.any(String),
    });
    writeFileSync(join(app, 'vitest.config.ts'), 'export default { test: { fileParallelism: false } };');
    const serial = await start(['--', 'vitest', 'run']).done;
    expect(ran(serial.stdout).argv).toEqual(['run']);
    expect(serial.stderr).toContain('no worker count passed: a Vitest config here may set its workers or run serially');
    const jest = await start(['--', 'jest', '-w', '2']).done;
    expect(ran(jest.stdout).argv).toEqual(['-w', '2']);
    expect(jest.stderr).toContain('no worker count passed: the command already sets Jest workers');
  }, 60_000);

  test('a test script that is not a plain runner command runs unchanged, with no worker variables', async () => {
    writeFileSync(
      join(app, 'package.json'),
      JSON.stringify({ name: 'app', scripts: { test: 'node -e "console.log(process.env.VITEST_MAX_WORKERS ?? 0)"' } }),
    );
    const { code, stdout, stderr } = await start([]).done;
    expect(code).toBe(0);
    expect(stdout.trim().split('\n').at(-1)).toBe('0');
    expect(stderr).toContain('the test script is not a plain jest or vitest command');
  }, 60_000);

  test('runs an unrecognised command unchanged under the slot and says so', async () => {
    const { code, stdout, stderr } = await start([
      '--',
      process.execPath,
      '-e',
      'console.log(process.argv.length)',
      'x',
    ]).done;
    expect(code).toBe(0);
    expect(stdout.trim()).toBe('2');
    expect(stderr).toContain('no worker count passed: Stim recognises no direct Jest or Vitest run in it');
  }, 60_000);

  test('a second run waits for the slot, then runs once the first exits', async () => {
    const hold = join(home, 'first');
    const first = start(['--', 'jest'], { FAKE_HOLD: hold });
    await vi.waitFor(() => expect(existsSync(`${hold}.started`)).toBe(true), { timeout: 20_000 });
    expect(liveSlots()).toHaveLength(1);
    const refused = await start(['--no-wait', '--', 'jest'], { STIM_TEST_RUN: '1' }).done;
    expect(refused.code).toBe(1);
    expect(refused.stderr).toContain('STIM_AT_CAPACITY');
    const marker = ran(readFileSync(`${hold}.out`, 'utf8')).run ?? '';
    const nested = await start(['--no-wait', '--', 'jest'], { STIM_TEST_RUN: marker }).done;
    expect(nested.code).toBe(0);
    expect(nested.stderr).toContain('inside another stim test run');
    const second = start(['--', 'jest']);
    await vi.waitFor(() => expect(listTestWaiting()).toHaveLength(1), { timeout: 20_000 });
    writeFileSync(`${hold}.go`, '');
    expect((await first.done).code).toBe(0);
    const result = await second.done;
    expect(result.code).toBe(0);
    expect(ran(result.stdout).run).not.toBe(marker);
    const stale = await start(['--no-wait', '--', 'jest'], { STIM_TEST_RUN: marker }).done;
    expect(stale.stderr).not.toContain('inside another stim test run');
    expect(listTestWaiting()).toEqual([]);
    expect(liveSlots()).toEqual([]);
  }, 60_000);

  const alive = (pid: number) => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  };
  const runnerPid = (hold: string) => Number(readFileSync(`${hold}.started`, 'utf8'));

  test.each([
    { signal: 'SIGTERM' as const, exit: 143 },
    { signal: 'SIGINT' as const, exit: 130 },
    { signal: 'SIGHUP' as const, exit: 129 },
  ])(
    '$signal to stim alone reaches the runner under the package manager and frees the slot',
    async ({ signal, exit }) => {
      const hold = join(home, 'held');
      const run = start([], { FAKE_HOLD: hold });
      await vi.waitFor(() => expect(existsSync(`${hold}.started`)).toBe(true), { timeout: 20_000 });
      const pid = runnerPid(hold);
      run.child.kill(signal);
      expect((await run.done).code).toBe(exit);
      expect(alive(pid)).toBe(false);
      expect(liveSlots()).toEqual([]);
    },
    60_000,
  );

  test('a killed stim leaves the slot held until the runner it started exits', async () => {
    const hold = join(home, 'orphan');
    const run = start(['--', 'jest'], { FAKE_HOLD: hold });
    await vi.waitFor(() => expect(existsSync(`${hold}.started`)).toBe(true), { timeout: 20_000 });
    const pid = runnerPid(hold);
    const exited = new Promise((resolve) => run.child.once('exit', resolve));
    run.child.kill('SIGKILL');
    await exited;
    expect(alive(pid)).toBe(true);
    expect(liveSlots()).toHaveLength(1);
    writeFileSync(`${hold}.go`, '');
    await vi.waitFor(() => expect(alive(pid)).toBe(false), { timeout: 20_000 });
    expect(liveSlots()).toEqual([]);
    await run.done;
  }, 60_000);

  test.each([
    { worker: 'slow', why: 'keeps stopping after SIGTERM' },
    { worker: 'ignore', why: 'ignores SIGTERM' },
  ])(
    'the slot stays taken while a worker that $why outlives the runner',
    async ({ worker }) => {
      const hold = join(home, `worker-${worker}`);
      const run = start(['--', 'jest'], { FAKE_HOLD: hold, FAKE_WORKER: worker });
      await vi.waitFor(() => expect(existsSync(`${hold}.worker`)).toBe(true), { timeout: 20_000 });
      const workerPid = Number(readFileSync(`${hold}.worker`, 'utf8'));
      run.child.kill('SIGTERM');
      await vi.waitFor(() => expect(alive(runnerPid(hold))).toBe(false), { timeout: 20_000 });
      expect(alive(workerPid)).toBe(true);
      expect(tryAcquireTestSlot({ max: 1 })).toBeNull();
      writeFileSync(`${hold}.release`, '');
      await run.done;
      expect(alive(workerPid)).toBe(false);
      expect(liveSlots()).toEqual([]);
    },
    60_000,
  );

  test('a cancelled run exits with the signal code even when its runner exits 0', async () => {
    const hold = join(home, 'trap');
    const run = start(['--', 'jest'], { FAKE_HOLD: hold, FAKE_TERM_EXIT_0: '1' });
    await vi.waitFor(() => expect(existsSync(`${hold}.started`)).toBe(true), { timeout: 20_000 });
    run.child.kill('SIGTERM');
    expect((await run.done).code).toBe(143);
    expect(liveSlots()).toEqual([]);
  }, 60_000);

  test('a second interrupt kills the whole group before stim exits', async () => {
    const hold = join(home, 'twice');
    const run = start(['--', 'jest'], { FAKE_HOLD: hold, FAKE_WORKER: 'ignore' });
    await vi.waitFor(() => expect(existsSync(`${hold}.worker`)).toBe(true), { timeout: 20_000 });
    const workerPid = Number(readFileSync(`${hold}.worker`, 'utf8'));
    run.child.kill('SIGTERM');
    await vi.waitFor(() => expect(alive(runnerPid(hold))).toBe(false), { timeout: 20_000 });
    run.child.kill('SIGTERM');
    expect((await run.done).code).toBe(143);
    await vi.waitFor(() => expect(alive(workerPid)).toBe(false), { timeout: 20_000 });
    expect(liveSlots()).toEqual([]);
  }, 60_000);

  test('a leader that ignores SIGTERM gets SIGKILL after the grace period', async () => {
    const hold = join(home, 'stubborn');
    const run = start(['--', 'jest'], { FAKE_HOLD: hold, FAKE_IGNORE_TERM: '1' });
    await vi.waitFor(() => expect(existsSync(`${hold}.started`)).toBe(true), { timeout: 20_000 });
    run.child.kill('SIGTERM');
    expect((await run.done).code).toBe(143);
    expect(alive(runnerPid(hold))).toBe(false);
    expect(liveSlots()).toEqual([]);
  }, 120_000);

  test("a nested run's surviving worker keeps the outer slot held", async () => {
    const hold = join(home, 'outer');
    const run = start(['--', 'jest'], { FAKE_HOLD: hold, FAKE_NESTED: cli, STIM_HOME: home });
    await vi.waitFor(() => expect(existsSync(`${hold}-inner.worker`)).toBe(true), { timeout: 30_000 });
    const workerPid = Number(readFileSync(`${hold}-inner.worker`, 'utf8'));
    const exited = new Promise((resolve) => run.child.once('exit', resolve));
    await exited;
    expect(alive(workerPid)).toBe(true);
    expect(liveSlots()).toHaveLength(1);
    const blocked = await start(['--no-wait', '--', 'jest']).done;
    expect(blocked.stderr).toContain('STIM_AT_CAPACITY');
    process.kill(workerPid, 'SIGKILL');
    await vi.waitFor(() => expect(liveSlots()).toEqual([]), { timeout: 20_000 });
    await run.done;
  }, 180_000);

  test('a signal to a nested stim alone stops its runner and leaves the outer run going', async () => {
    const hold = join(home, 'nest');
    const run = start(['--', 'jest'], { FAKE_HOLD: hold, FAKE_NESTED_HOLD: cli });
    await vi.waitFor(() => expect(existsSync(`${hold}-inner.started`)).toBe(true), { timeout: 30_000 });
    const innerRunner = runnerPid(`${hold}-inner`);
    process.kill(Number(readFileSync(`${hold}.inner-stim`, 'utf8')), 'SIGTERM');
    await vi.waitFor(() => expect(existsSync(`${hold}.inner-exit`)).toBe(true), { timeout: 30_000 });
    expect(readFileSync(`${hold}.inner-exit`, 'utf8')).toBe('143');
    expect(alive(innerRunner)).toBe(false);
    expect(alive(runnerPid(hold))).toBe(true);
    expect(liveSlots()).toHaveLength(1);
    writeFileSync(`${hold}.go`, '');
    expect((await run.done).code).toBe(0);
    expect(liveSlots()).toEqual([]);
  }, 120_000);

  test('stim test -- npm test is the script form and gets the count too', async () => {
    const { code, stdout, stderr } = await start(['--', 'npm', 'test']).done;
    expect(code).toBe(0);
    expect(ran(stdout).argv).toEqual(['--ci', `--maxWorkers=${announced(stderr)}`]);
  }, 60_000);
});
