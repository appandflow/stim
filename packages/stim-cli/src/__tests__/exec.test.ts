import { fileURLToPath } from 'node:url';
import { getExecutor, isUnsafeBatchSpawn, resetExecutor } from '../exec.ts';

test('default executor runs commands and returns stdout trimmed', () => {
  resetExecutor();
  const out = getExecutor().run('echo hello', { timeoutMs: 60_000 });
  expect(out).toBe('hello');
});

test('runQuiet returns null on failure', () => {
  resetExecutor();
  const out = getExecutor().runQuiet('false', { timeoutMs: 60_000 });
  expect(out).toBe(null);
});

test('runFileQuiet returns trimmed stdout and null on failure', () => {
  resetExecutor();
  expect(getExecutor().runFileQuiet('echo', ['hello'], { timeoutMs: 60_000 })).toBe('hello');
  expect(getExecutor().runFileQuiet('false', [], { timeoutMs: 60_000 })).toBe(null);
});

test('runFileQuiet passes arguments without a shell, so metacharacters stay literal', () => {
  resetExecutor();
  expect(getExecutor().runFileQuiet('echo', ['$HOME `id` "x"'], { timeoutMs: 60_000 })).toBe('$HOME `id` "x"');
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
    getExecutor().runFile(process.execPath, ['-e', 'console.log("out"); console.error("err"); process.exit(3)'], {
      timeoutMs: 60_000,
    });
  } catch (error) {
    failure = error as typeof failure;
  }
  expect(failure.status).toBe(3);
  expect(failure.stdout).toBe('out\n');
  expect(failure.stderr).toBe('err\n');
  expect(failure.message).toMatch(/^Command failed: .*\nerr/);
});

test('a failure redacts the given values from every field of the thrown error', async () => {
  resetExecutor();
  const secret = 'hunter2-secret';
  const args = ['-e', 'console.log(process.argv[1]); console.error(process.argv[1]); process.exit(1)', secret];
  let failure: Error & { stdout?: string; stderr?: string } = new Error('did not fail');
  try {
    getExecutor().runFile(process.execPath, args, { redact: [secret], timeoutMs: 60_000 });
  } catch (error) {
    failure = error as typeof failure;
  }
  const asyncFailure: typeof failure = await getExecutor()
    .runFileAsync(process.execPath, args, { redact: [secret], timeoutMs: 60_000 })
    .then(
      () => new Error('did not fail'),
      (error: unknown) => error as typeof failure,
    );
  for (const error of [failure, asyncFailure]) {
    expect(error.message).toMatch(/^Command failed: /);
    expect(JSON.stringify({ ...error, message: error.message, stack: error.stack })).not.toContain(secret);
    expect(error.stderr).toBe('***\n');
  }
});

test('a missing executable throws ENOENT', () => {
  resetExecutor();
  let failure: NodeJS.ErrnoException = new Error('did not fail');
  try {
    getExecutor().runFile('stim-definitely-not-installed', ['--version'], { timeoutMs: 60_000 });
  } catch (error) {
    failure = error as typeof failure;
  }
  expect(failure.code).toBe('ENOENT');
});

test('file commands can reject stderr on a successful exit without changing the default', async () => {
  resetExecutor();
  const args = [fileURLToPath(new URL('./fixtures/stderr-success.mts', import.meta.url))];
  const executor = getExecutor();
  expect(executor.runFile(process.execPath, args, { timeoutMs: 60_000 })).toBe('partial output');
  expect(() => executor.runFile(process.execPath, args, { rejectStderr: true, timeoutMs: 60_000 })).toThrow(
    'inspection failed',
  );
  expect(await executor.runFileAsync(process.execPath, args, { timeoutMs: 60_000 })).toBe('partial output');
  await expect(
    executor.runFileAsync(process.execPath, args, { rejectStderr: true, timeoutMs: 60_000 }),
  ).rejects.toMatchObject({
    status: 0,
    stdout: 'partial output',
    stderr: 'inspection failed',
  });
});

test.skipIf(process.platform !== 'win32')('runFile launches a .cmd shim on Windows', () => {
  resetExecutor();
  expect(getExecutor().findExecutable('npm')).toMatch(/\.cmd$/i);
  const shim = fileURLToPath(new URL('./fixtures/cmd-shim/echo-first-arg.cmd', import.meta.url));
  expect(getExecutor().runFile(shim, ['--version'], { timeoutMs: 60_000 })).toBe('--version');
});

test.each([
  ['avdmanager.bat', ['--device', 'pixel_6"&calc&"'], 'win32', true],
  ['eas.CMD', ['say "hi"'], 'win32', true],
  ['avdmanager.bat', ['a\rcalc'], 'win32', true],
  ['avdmanager.bat', ['a\ncalc'], 'win32', true],
  ['agent-device.cmd', ['open', 'scheme://x/?url=http%3A%2F%2Flocalhost'], 'win32', false],
  ['adb.exe', ['"quoted"'], 'win32', false],
  ['avdmanager.bat', ['"quoted"'], 'darwin', false],
  ['avdmanager.bat', ['--device', 'Nexus 5X'], 'win32', false],
  ['avdmanager.bat', ['a&b'], 'win32', false],
] as const)('isUnsafeBatchSpawn(%s, %j, %s) is %s', (target, args, platform, unsafe) => {
  expect(isUnsafeBatchSpawn(target, args, platform)).toBe(unsafe);
});
