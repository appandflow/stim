import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { runCommand } from '../command.ts';

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'stim-ci-command-'));
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

it('preserves argv and streams while returning the actual command exit status', async () => {
  const chunks: string[] = [];
  const result = await runCommand({
    command: [
      process.execPath,
      '-e',
      'console.log(JSON.stringify(process.argv.slice(1))); console.error(process.env.CI_TEST_VALUE); process.exitCode = 23;',
      'a b',
      '$(not-a-command)',
    ],
    cwd: root,
    env: { ...process.env, CI_TEST_VALUE: 'diagnostic' },
    artifactsDir: root,
    onOutput: ({ message }) => chunks.push(message),
  });
  expect(result.exitCode).toBe(23);
  expect(JSON.parse(readFileSync(result.stdout, 'utf8'))).toEqual(['a b', '$(not-a-command)']);
  expect(readFileSync(result.stderr, 'utf8')).toBe('diagnostic\n');
  expect(chunks.join('')).toContain('diagnostic');
});

it('reports a missing executable without hanging or reporting success', async () => {
  const result = await runCommand({
    command: [join(root, 'missing-executable')],
    cwd: root,
    env: process.env,
    artifactsDir: root,
  });
  expect(result.exitCode).not.toBe(0);
  expect(result.error).toContain('ENOENT');
});

test.skipIf(process.platform === 'win32')(
  'cancellation kills a test process and its resistant descendant',
  async () => {
    const pidFile = join(root, 'descendant.pid');
    const descendant = `require('node:fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); process.on('SIGTERM', () => {}); setInterval(() => {}, 1000);`;
    const script = `require('node:child_process').spawn(process.execPath, ['-e', ${JSON.stringify(descendant)}], {stdio:'inherit'}); process.on('SIGTERM', () => {}); setInterval(() => {}, 1000);`;
    const controller = new AbortController();
    const running = runCommand({
      command: [process.execPath, '-e', script],
      cwd: root,
      env: process.env,
      artifactsDir: root,
      signal: controller.signal,
    });
    try {
      const deadline = Date.now() + 2000;
      while (!existsSync(pidFile) && Date.now() < deadline) await delay(10);
      expect(existsSync(pidFile)).toBe(true);
      const pid = Number(readFileSync(pidFile, 'utf8'));
      controller.abort();
      const result = await running;
      expect(result.signal).toBe('SIGKILL');
      expect(() => process.kill(pid, 0)).toThrow(/ESRCH/);
    } finally {
      controller.abort();
      await running;
    }
  },
);

test.skipIf(process.platform === 'win32')('reaps a background child when the test leader exits', async () => {
  const script = `require('node:child_process').spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {stdio:'inherit'}); process.exit(0);`;
  const result = await runCommand({
    command: [process.execPath, '-e', script],
    cwd: root,
    env: process.env,
    artifactsDir: root,
    signal: AbortSignal.timeout(3000),
  });
  expect(result.exitCode).toBe(0);
  expect(result.durationMs).toBeLessThan(2500);
});
