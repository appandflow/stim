import assert from 'node:assert';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { withAmbientContext } from '@stim-cli/core';
import { runId } from '@stim-cli/core/state';
import { getExecutor, isUnsafeBatchSpawn, resetExecutor } from '../exec.ts';

vi.mock('../process-group-exit.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../process-group-exit.ts')>()),
  groupExitBudgetMs: () => 1000,
}));

test('default executor runs commands and returns stdout trimmed', () => {
  resetExecutor();
  const out = getExecutor().run('echo hello', { timeoutMs: 60_000 });
  expect(out).toBe('hello');
});

test('executable selection resolves a relative PATH against the supplied project directory', () => {
  resetExecutor();
  const root = mkdtempSync(join(tmpdir(), 'stim-executable-cwd-'));
  const name = process.platform === 'win32' ? 'project-tool.CMD' : 'project-tool';
  try {
    for (const directory of ['one', 'two']) {
      const cwd = join(root, directory);
      mkdirSync(join(cwd, 'tools'), { recursive: true });
      const executable = join(cwd, 'tools', name);
      writeFileSync(executable, '', { mode: 0o755 });
      expect(getExecutor().findExecutable('project-tool', { cwd, env: { PATH: 'tools', PATHEXT: '.CMD' } })).toBe(
        executable,
      );
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
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

test('file commands write the given input to stdin and preserve raw stdout when requested', async () => {
  resetExecutor();
  const echo = ['-e', 'process.stdin.pipe(process.stdout)'];
  const input = ' \t<plist/> \n';
  const executor = getExecutor();
  expect(await executor.runFileAsync(process.execPath, echo, { input, timeoutMs: 60_000 })).toBe('<plist/>');
  expect(await executor.runFileAsync(process.execPath, echo, { input, untrimmed: true, timeoutMs: 60_000 })).toBe(
    input,
  );
  expect(executor.runFile(process.execPath, echo, { input, untrimmed: true, timeoutMs: 60_000 })).toBe(input);
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

test.skipIf(process.platform !== 'win32')(
  'a contained Windows child gets its whole budget after the report job starts',
  async () => {
    resetExecutor();
    const out = await getExecutor().runFileAsync(process.execPath, ['-e', 'process.stdout.write("ran")'], {
      timeoutMs: 1000,
      signal: new AbortController().signal,
    });
    expect(out).toBe('ran');
  },
  60_000,
);

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

test('an unbounded call runs to completion, and a budget that is not positive is refused before anything runs', async () => {
  resetExecutor();
  const executor = getExecutor();
  const script = ['-e', 'setTimeout(() => console.log("done"), 300)'];
  const timers = vi.spyOn(globalThis, 'setTimeout');
  const unbounded = executor.runFileAsync(process.execPath, script, { timeoutMs: 'unbounded' });
  expect(timers).not.toHaveBeenCalled();
  timers.mockRestore();
  expect(await unbounded).toBe('done');
  expect(executor.runFile(process.execPath, script, { timeoutMs: 'unbounded' })).toBe('done');
  for (const timeoutMs of [0, -1, Number.NaN]) {
    expect(() => executor.runFile(process.execPath, script, { timeoutMs })).toThrow(RangeError);
    expect(() => executor.runFileQuiet(process.execPath, script, { timeoutMs })).toThrow(RangeError);
    expect(() => executor.runQuiet('true', { timeoutMs })).toThrow(RangeError);
    await expect(executor.runFileAsync(process.execPath, script, { timeoutMs })).rejects.toThrow(RangeError);
  }
});

test("children started inside an ambient operation context inherit its environment, not the host's", async () => {
  resetExecutor();
  const host = process.env.STIM_HOME;
  process.env.STIM_HOME = '/host/home';
  const printEnv = ['-e', 'process.stdout.write(`${process.env.STIM_HOME} ${process.env.STIM_RUN_ID}`)'];
  const context = {
    home: '/client/home',
    buildCache: null,
    projectRoot: process.cwd(),
    cwd: process.cwd(),
    runId: 'client-run',
    env: { ...process.env, STIM_HOME: '/client/home', STIM_RUN_ID: 'client-run' },
    signal: new AbortController().signal,
    output: () => {},
  };
  try {
    const spawned = (args: string[]) =>
      new Promise<string>((resolve) => {
        let out = '';
        const child = getExecutor().spawn(process.execPath, args, { stdio: ['ignore', 'pipe', 'ignore'] });
        child.stdout?.on('data', (chunk: Buffer) => (out += chunk));
        child.on('close', () => resolve(out));
      });
    await withAmbientContext(context, async () => {
      expect(getExecutor().runFile(process.execPath, printEnv, { timeoutMs: 60_000 })).toBe('/client/home client-run');
      expect(await getExecutor().runFileAsync(process.execPath, printEnv, { timeoutMs: 60_000 })).toBe(
        '/client/home client-run',
      );
      expect(await spawned(printEnv)).toBe('/client/home client-run');
      expect(runId()).toBe('client-run');
    });
    expect(getExecutor().runFile(process.execPath, printEnv, { timeoutMs: 60_000 })).toMatch(/^\/host\/home /);
  } finally {
    if (host === undefined) delete process.env.STIM_HOME;
    else process.env.STIM_HOME = host;
  }
});

test('async file output is bounded across both streams and overflow terminates the child before rejection', async () => {
  let pid: number | undefined;
  const failure = await getExecutor()
    .runFileAsync(
      process.execPath,
      [
        '-e',
        'process.on("SIGTERM", () => {}); process.stdout.write(Buffer.alloc(40 * 1024 * 1024, "a")); process.stderr.write(Buffer.alloc(40 * 1024 * 1024, "b")); setInterval(() => {}, 1000);',
      ],
      {
        timeoutMs: 10_000,
        killSignal: 'SIGKILL',
        onSpawn: (child) => {
          pid = child.pid;
        },
      },
    )
    .then(
      () => {
        throw new Error('expected output overflow');
      },
      (error: NodeJS.ErrnoException & { stdout: string; stderr: string }) => error,
    );
  expect(failure.code).toBe('ENOBUFS');
  expect(Buffer.byteLength(failure.stdout) + Buffer.byteLength(failure.stderr)).toBeLessThanOrEqual(64 * 1024 * 1024);
  const startedPid = pid;
  if (startedPid === undefined) throw new Error('The child did not start.');
  expect(startedPid).toBeGreaterThan(1);
  expect(() => process.kill(startedPid, 0)).toThrow(/ESRCH/);
}, 30_000);

test('a Git timeout reaps Git without waiting for a transport descendant to close its pipes', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'stim-git-transport-timeout-'));
  const helper = join(dir, 'ssh.cjs');
  const marker = join(dir, 'started');
  writeFileSync(
    helper,
    `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'started'); require('node:child_process').spawn(process.execPath, ['-e', 'setTimeout(() => {}, 3000)'], { stdio: ['ignore', 'ignore', 'inherit'] });`,
  );
  let pid: number | undefined;
  const startedAt = Date.now();
  try {
    await expect(
      getExecutor().runFileAsync('git', ['ls-remote', 'ssh://fixture.invalid/repo'], {
        timeoutMs: 1000,
        env: { GIT_SSH_COMMAND: `"${process.execPath}" "${helper}"`, GIT_SSH_VARIANT: 'ssh', GIT_TERMINAL_PROMPT: '0' },
        onSpawn: (child) => {
          pid = child.pid;
        },
      }),
    ).rejects.toMatchObject({ code: 'ETIMEDOUT' });
    expect(readFileSync(marker, 'utf-8')).toBe('started');
    expect(Date.now() - startedAt).toBeLessThan(2300);
    const startedPid = pid;
    if (startedPid === undefined) throw new Error('Git did not start.');
    expect(() => process.kill(startedPid, 0)).toThrow(/ESRCH/);
  } finally {
    await new Promise((resolve) => setTimeout(resolve, 3500));
    rmSync(dir, { recursive: true, force: true });
  }
}, 30_000);

test('an overflowing child cannot expose a secret cut off at the output boundary', async () => {
  const secret = '0123456789abcdefghijklmnopqrstuv';
  const script =
    'process.stdout.write(Buffer.alloc(64 * 1024 * 1024 - process.argv[1].length + 1, "x")); process.stdout.write(process.argv[1]);';
  const failure = await getExecutor()
    .runFileAsync(process.execPath, ['-e', script, secret], { timeoutMs: 10_000, redact: [secret] })
    .then(
      () => {
        throw new Error('expected output overflow');
      },
      (error: NodeJS.ErrnoException & { stdout: string; stderr: string }) => error,
    );
  expect(failure.code).toBe('ENOBUFS');
  expect(failure.message).not.toContain(secret);
  expect(failure.stdout).toBe('');
  expect(failure.stderr).toBe('');
}, 30_000);

test('a timed-out child cannot expose an incomplete redacted secret', async () => {
  const secret = '0123456789abcdefghijklmnopqrstuv';
  const failure = await getExecutor()
    .runFileAsync(
      process.execPath,
      ['-e', 'process.stdout.write(process.argv[1].slice(0, -1)); setInterval(() => {}, 1000);', secret],
      { timeoutMs: 500, redact: [secret] },
    )
    .then(
      () => {
        throw new Error('expected timeout');
      },
      (error: NodeJS.ErrnoException & { stdout: string; stderr: string }) => error,
    );
  expect(failure.code).toBe('ETIMEDOUT');
  expect(failure.message).not.toContain(secret);
  expect(failure.stdout).toBe('');
  expect(failure.stderr).toBe('');
});

function blockEventLoop(ms: number): void {
  if (ms > 0) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function exitedWithoutBeingReaped(pid: number): boolean {
  if (process.platform === 'win32') {
    try {
      process.kill(pid, 0);
      return false;
    } catch {
      return true;
    }
  }
  const state = getExecutor().runFileQuiet('ps', ['-o', 'stat=', '-p', String(pid)], { timeoutMs: 5000 });
  return state === null || state.startsWith('Z');
}

test('a cancelled child whose exit is seen only after a stalled event loop is not a cleanup failure', async () => {
  const controller = new AbortController();
  const reason = new Error('cancelled');
  let pid: number | undefined;
  const call = getExecutor()
    .runFileAsync(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
      timeoutMs: 60_000,
      signal: controller.signal,
      onSpawn: (child) => {
        pid = child.pid;
      },
    })
    .catch((error: unknown) => error);
  const startedPid = pid;
  assert(startedPid);
  controller.abort(reason);
  const stallUntil = performance.now() + 1500;
  const giveUpAt = performance.now() + 20_000;
  while (!exitedWithoutBeingReaped(startedPid)) {
    assert(performance.now() < giveUpAt, `child ${startedPid} survived SIGKILL`);
    blockEventLoop(25);
  }
  blockEventLoop(stallUntil - performance.now());
  expect(await call).toBe(reason);
  expect(() => process.kill(startedPid, 0)).toThrow(/ESRCH/);
}, 30_000);
