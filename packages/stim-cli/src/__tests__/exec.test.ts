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
  expect(Date.now() - started).toBeLessThan(3000);
  expect(failure.pid).toBeGreaterThan(1);
  expect(() => process.kill(failure.pid!, 0)).toThrow(/ESRCH/);
});
