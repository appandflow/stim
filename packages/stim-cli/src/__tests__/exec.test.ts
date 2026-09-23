import { setExecutor, getExecutor, resetExecutor } from '../exec.ts';

test('default executor runs commands and returns stdout trimmed', () => {
  resetExecutor();
  const out = getExecutor().run('echo hello');
  expect(out).toBe('hello');
});

test('runQuiet returns null on failure', () => {
  resetExecutor();
  const out = getExecutor().runQuiet('false');
  expect(out).toBe(null);
});

test('setExecutor replaces the active executor', () => {
  setExecutor({
    run: () => 'mocked',
    runQuiet: () => 'mocked-quiet',
    spawn: () => ({ pid: 999 }),
  });
  expect(getExecutor().run('anything')).toBe('mocked');
  expect(getExecutor().runQuiet('anything')).toBe('mocked-quiet');
  resetExecutor();
});

test('runFileQuiet returns trimmed stdout and null on failure', () => {
  resetExecutor();
  expect(getExecutor().runFileQuiet('echo', ['hello'])).toBe('hello');
  expect(getExecutor().runFileQuiet('false')).toBe(null);
});

test('runFileQuiet passes arguments without a shell, so metacharacters stay literal', () => {
  resetExecutor();
  expect(getExecutor().runFileQuiet('echo', ['$HOME `id` "x"'])).toBe('$HOME `id` "x"');
});

test('an opt-in hard deadline terminates a child that ignores SIGTERM before returning', () => {
  resetExecutor();
  const started = Date.now();
  let failure: NodeJS.ErrnoException & { pid?: number; signal?: string } = new Error('did not fail');
  try {
    getExecutor().runFile(process.execPath, ['-e', 'process.on("SIGTERM", () => {}); setInterval(() => {}, 1000)'], {
      timeoutMs: 200,
      killSignal: 'SIGKILL',
    });
  } catch (error) {
    failure = error as typeof failure;
  }
  expect(failure.code).toBe('ETIMEDOUT');
  expect(failure.signal).toBe('SIGKILL');
  expect(failure.message).toMatch(/^Command timed out after 200ms: .*node/);
  expect(Date.now() - started).toBeLessThan(3000);
  expect(failure.pid).toBeGreaterThan(1);
  expect(() => process.kill(failure.pid!, 0)).toThrow(/ESRCH/);
});

test('a shell command that outlives its deadline fails with a message naming the command and the deadline', () => {
  resetExecutor();
  let failure: NodeJS.ErrnoException = new Error('did not fail');
  try {
    getExecutor().run(`"${process.execPath}" -e "setInterval(() => {}, 1000)"`, {
      timeoutMs: 200,
      killSignal: 'SIGKILL',
    });
  } catch (error) {
    failure = error as typeof failure;
  }
  expect(failure.code).toBe('ETIMEDOUT');
  expect(failure.message).toMatch(/^Command timed out after 200ms: .*setInterval/);
});

test('a non-zero exit throws with status, stdout and stderr, the fields callers read', () => {
  resetExecutor();
  let failure: Error & { status?: number; stdout?: string; stderr?: string } = new Error('did not fail');
  try {
    getExecutor().runFile(process.execPath, ['-e', 'console.log("out"); console.error("err"); process.exit(3)']);
  } catch (error) {
    failure = error as typeof failure;
  }
  expect(failure.status).toBe(3);
  expect(failure.stdout).toBe('out\n');
  expect(failure.stderr).toBe('err\n');
  expect(failure.message).toMatch(/^Command failed: .*\nerr/);
});

test('a missing executable throws ENOENT', () => {
  resetExecutor();
  let failure: NodeJS.ErrnoException = new Error('did not fail');
  try {
    getExecutor().runFile('stim-definitely-not-installed', ['--version']);
  } catch (error) {
    failure = error as typeof failure;
  }
  expect(failure.code).toBe('ENOENT');
});

test.skipIf(process.platform !== 'win32')('runFile launches a .cmd shim on Windows', { timeout: 30_000 }, () => {
  resetExecutor();
  const npm = getExecutor().findExecutable('npm');
  expect(npm).toMatch(/\.cmd$/i);
  expect(getExecutor().runFile(npm!, ['--version'])).toMatch(/^\d+\.\d+/);
});
