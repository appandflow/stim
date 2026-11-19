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
import { listTestSlots } from '../engine/test-slots.ts';
import { listTestWaiting } from '../engine/wait-queue.ts';

const cli = fileURLToPath(new URL('../../bin/cli.ts', import.meta.url));

const FAKE_RUNNER = `#!/usr/bin/env node
const { existsSync, writeFileSync } = require('node:fs');
const [hold] = (process.env.FAKE_HOLD ?? '').split(',').filter(Boolean);
console.log(JSON.stringify({ argv: process.argv.slice(2), vitest: process.env.VITEST_MAX_WORKERS ?? null, run: process.env.STIM_TEST_RUN ?? null }));
if (hold) {
  writeFileSync(hold + '.started', String(process.pid));
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
  const childEnv: NodeJS.ProcessEnv = {
    ...process.env,
    STIM_HOME: home,
    STIM_DAEMON: 'off',
    STIM_MAX_TESTS: '1',
    PATH: `${bin}${delimiter}${process.env.PATH ?? ''}`,
    ...env,
  };
  delete childEnv.STIM_TEST_RUN;
  delete childEnv.VITEST_MAX_WORKERS;
  if (env.VITEST_MAX_WORKERS) childEnv.VITEST_MAX_WORKERS = env.VITEST_MAX_WORKERS;
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
    expect(ran(stdout)).toEqual({ argv: [`--maxWorkers=${workers}`, 'src/a.test.ts'], vitest: workers, run: '1' });
    expect(liveSlots()).toEqual([]);
  });

  test("runs the project's test script through its package manager with the count forwarded to Jest", async () => {
    const { code, stdout, stderr } = await start([]).done;
    expect(code).toBe(0);
    expect(ran(stdout).argv).toEqual(['--ci', `--maxWorkers=${announced(stderr)}`]);
  });

  test('Vitest gets the variable', async () => {
    const { code, stdout, stderr } = await start(['--', 'vitest', 'run']).done;
    expect(code).toBe(0);
    expect(ran(stdout)).toMatchObject({ argv: ['run'], vitest: announced(stderr) });
  });

  test("a caller's VITEST_MAX_WORKERS and Jest -w are kept", async () => {
    const vitest = await start(['--', 'vitest', 'run'], { VITEST_MAX_WORKERS: '7' }).done;
    expect(ran(vitest.stdout)).toMatchObject({ argv: ['run'], vitest: '7' });
    expect(vitest.stderr).toContain('no worker count passed: the command already sets Vitest workers');
    const jest = await start(['--', 'jest', '-w', '2']).done;
    expect(ran(jest.stdout).argv).toEqual(['-w', '2']);
    expect(jest.stderr).toContain('no worker count passed: the command already sets Jest workers');
  });

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
    expect(stderr).toContain('no worker count passed: Stim recognises no Jest or Vitest in it');
  });

  test('a second run waits for the slot, then runs once the first exits', async () => {
    const hold = join(home, 'first');
    const first = start(['--', 'jest'], { FAKE_HOLD: hold });
    await vi.waitFor(() => expect(existsSync(`${hold}.started`)).toBe(true), { timeout: 20_000 });
    expect(liveSlots()).toHaveLength(1);
    const refused = await start(['--no-wait', '--', 'jest']).done;
    expect(refused.code).toBe(1);
    expect(refused.stderr).toContain('STIM_AT_CAPACITY');
    const second = start(['--', 'jest']);
    await vi.waitFor(() => expect(listTestWaiting()).toHaveLength(1), { timeout: 20_000 });
    writeFileSync(`${hold}.go`, '');
    expect((await first.done).code).toBe(0);
    const result = await second.done;
    expect(result.code).toBe(0);
    expect(ran(result.stdout).run).toBe('1');
    expect(listTestWaiting()).toEqual([]);
    expect(liveSlots()).toEqual([]);
  });

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

  test('stim test -- npm test is the script form and gets the count too', async () => {
    const { code, stdout, stderr } = await start(['--', 'npm', 'test']).done;
    expect(code).toBe(0);
    expect(ran(stdout).argv).toEqual(['--ci', `--maxWorkers=${announced(stderr)}`]);
  });
});
