import { rm } from 'node:fs/promises';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { withAmbientContext, type StimContext } from '@stim-cli/core';
import { getExecutor } from '../exec.ts';
import { runReport as executeReport } from '../report-runtime.ts';

function runReport<T>(scope: StimContext, work: (operation: StimContext) => Promise<T>): Promise<T> {
  const result = executeReport(scope, (operation) => withAmbientContext(operation, () => work(operation)));
  pending.add(result);
  void result.then(
    () => pending.delete(result),
    () => pending.delete(result),
  );
  return result;
}
import { WebSocketServer } from 'ws';
import { openAuthenticated } from '../offload/tailnet.ts';
import { gitAsync } from '../workspace/git.ts';
import * as identities from '../process-identity.ts';
import { captureProcessIdentity, inspectProcessIdentity } from '@stim-cli/core/process-identity';
import { inspectStimVersions } from '../diagnostics/stim-installations.ts';

let scratch: string;
let fixtureAbort: AbortController;
let pending: Set<Promise<unknown>>;
beforeEach(() => {
  scratch = realpathSync(mkdtempSync(join(tmpdir(), 'stim-report-runtime-')));
  fixtureAbort = new AbortController();
  pending = new Set();
});
afterEach(async () => {
  vi.useRealTimers();
  fixtureAbort.abort();
  await Promise.allSettled(pending);
  // https://github.com/nodejs/node/issues/64016: Windows rmSync can ignore retryDelay.
  await rm(scratch, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});

function context(signal: AbortSignal): StimContext {
  return {
    home: join(scratch, 'home'),
    buildCache: null,
    projectRoot: scratch,
    cwd: scratch,
    env: { ...process.env, HOME: scratch, USERPROFILE: scratch, STIM_HOME: join(scratch, 'home') },
    runId: 'report-fixture',
    signal: AbortSignal.any([signal, fixtureAbort.signal]),
    output: () => {},
  };
}

function reapFixtureChild(record: { pid: number; processToken: string } | undefined): void {
  if (!record || inspectProcessIdentity(record) !== 'same') return;
  try {
    process.kill(record.pid, 'SIGKILL');
  } catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'ESRCH')) throw error;
  }
}

test('cancelling a report reaps its child and leaves another client running', async () => {
  const controller = new AbortController();
  let pid: number | undefined;
  const one = runReport(context(controller.signal), async () =>
    getExecutor().runFileAsync(process.execPath, ['-e', 'console.log("ready"); setTimeout(() => {}, 3000)'], {
      timeoutMs: 10_000,
      onSpawn: (child) => {
        pid = child.pid;
        child.stdout?.once('data', () => controller.abort());
      },
    }),
  );
  const failure = one.then(
    () => null,
    (error: unknown) => error,
  );
  const other = runReport(context(new AbortController().signal), async () =>
    getExecutor().runFileAsync(process.execPath, ['-e', 'setTimeout(() => console.log("other client"), 150)'], {
      timeoutMs: 10_000,
    }),
  );
  const otherResult = other.then(
    (value) => value,
    (error: unknown) => error,
  );
  expect(await failure).toBe(controller.signal.reason);
  if (pid === undefined) throw new Error('The controlled child did not start');
  const ownPid = pid;
  expect(() => process.kill(ownPid, 0)).toThrow(/ESRCH/);
  expect(await otherResult).toBe('other client');
});

test('the aggregate deadline stops an unbounded probe and rejects after it exits', async () => {
  vi.useFakeTimers();
  let pid: number | undefined;
  let started: () => void = () => {};
  const ready = new Promise<void>((resolve) => {
    started = resolve;
  });
  const result = runReport(context(new AbortController().signal), async () =>
    getExecutor().runFileAsync(process.execPath, ['-e', 'console.log("ready"); setTimeout(() => {}, 3000)'], {
      timeoutMs: 'unbounded',
      onSpawn: (child) => {
        pid = child.pid;
        child.stdout?.once('data', started);
      },
    }),
  ).then(
    () => null,
    (error: unknown) => error,
  );
  await ready;
  await vi.advanceTimersByTimeAsync(60_000);
  expect(await result).toMatchObject({ code: 'STIM_REPORT_TIMEOUT' });
  if (pid === undefined) throw new Error('The controlled child did not start');
  const ownPid = pid;
  expect(() => process.kill(ownPid, 0)).toThrow(/ESRCH/);
});

test('a report rejects an overdue result even before its timer callback runs', async () => {
  const clock = vi.spyOn(performance, 'now').mockReturnValueOnce(0).mockReturnValue(60_001);
  try {
    await expect(runReport(context(new AbortController().signal), async () => 'late result')).rejects.toMatchObject({
      code: 'STIM_REPORT_TIMEOUT',
    });
  } finally {
    clock.mockRestore();
  }
});

test.each(['caller', 'deadline'])('a %s cancellation rejects while a read remains pending', async (kind) => {
  vi.useFakeTimers();
  const controller = new AbortController();
  let resume: () => void = () => {};
  const read = new Promise<void>((resolve) => {
    resume = resolve;
  });
  const progress = vi.fn<StimContext['output']>();
  const scope = { ...context(controller.signal), output: progress };
  let settled = false;
  const result = runReport(scope, async (operation) => {
    await read;
    operation.output('stderr', 'late progress');
    return 'late result';
  }).then(
    () => {
      settled = true;
      return null;
    },
    (error: unknown) => {
      settled = true;
      return error;
    },
  );
  if (kind === 'caller') controller.abort(new Error('caller cancelled'));
  else await vi.advanceTimersByTimeAsync(60_000);
  await vi.advanceTimersByTimeAsync(0);
  const rejectedBeforeRead = settled;
  resume();
  expect(rejectedBeforeRead).toBe(true);
  const error = await result;
  expect(error instanceof Error && 'code' in error ? error.code : error).toBe(
    kind === 'deadline' ? 'STIM_REPORT_TIMEOUT' : controller.signal.reason,
  );
  expect(progress).not.toHaveBeenCalled();
});

test('cancellation does not signal a child whose captured identity no longer matches', async () => {
  const controller = new AbortController();
  let exit: number | null | undefined;
  let signal: NodeJS.Signals | null | undefined;
  const inspect = vi.spyOn(identities, 'inspectProcessIdentity').mockReturnValue('different');
  try {
    const failure = await runReport(context(controller.signal), async () =>
      getExecutor().runFileAsync(process.execPath, ['-e', 'console.log("ready"); setTimeout(() => {}, 150)'], {
        timeoutMs: 10_000,
        onSpawn: (child) => {
          child.once('exit', (code, endedBy) => {
            exit = code;
            signal = endedBy;
          });
          child.stdout?.once('data', () => controller.abort());
        },
      }),
    ).then(
      () => null,
      (error: unknown) => error,
    );
    expect(failure).toBe(controller.signal.reason);
    expect(exit).toBe(0);
    expect(signal).toBeNull();
  } finally {
    inspect.mockRestore();
  }
});

test.each([
  { recover: true, timeout: false },
  { recover: false, timeout: false },
  { recover: false, timeout: true },
])('unavailable child identity yields bounded cleanup for %j', async ({ recover, timeout }) => {
  const controller = new AbortController();
  const original = inspectProcessIdentity;
  let inspections = 0;
  const inspect = vi
    .spyOn(identities, 'inspectProcessIdentity')
    .mockImplementation((record) => (recover && ++inspections > 2 ? original(record) : 'unknown'));
  let owned: { pid: number; processToken: string } | undefined;
  let nativeClosed: Promise<void> = Promise.resolve();
  let reading: Promise<unknown> = Promise.resolve();
  try {
    reading = runReport(context(controller.signal), async () =>
      getExecutor().runFileAsync(process.execPath, ['-e', 'console.log("ready"); setTimeout(() => {}, 3000)'], {
        timeoutMs: timeout ? 100 : 'unbounded',
        onSpawn: (child) => {
          if (child.pid === undefined) throw new Error('No fixture child PID');
          const identity = captureProcessIdentity(child.pid);
          if (!identity.ok) throw new Error(identity.reason);
          owned = { pid: child.pid, processToken: identity.token };
          nativeClosed = new Promise<void>((resolve) => child.once('close', resolve));
          child.stdout?.once('data', () => {
            if (!timeout) controller.abort(new Error('cancel fixture'));
          });
        },
      }),
    ).then(
      () => null,
      (error: unknown) => error,
    );
    const failure = await reading;
    expect(failure instanceof Error && 'code' in failure ? failure.code : failure).toBe(
      recover ? controller.signal.reason : 'STIM_CLAIM_UNAVAILABLE',
    );
    expect(inspectProcessIdentity(owned)).toBe(recover ? 'gone' : 'same');
  } finally {
    inspect.mockRestore();
    reapFixtureChild(owned);
    await nativeClosed;
    await reading;
  }
});

test('failed initial birth capture never signals the unverifiable child', async () => {
  const controller = new AbortController();
  let started: () => void = () => {};
  const ready = new Promise<void>((resolve) => {
    started = resolve;
  });
  let owned: { pid: number; processToken: string } | undefined;
  let nativeClosed: Promise<void> = Promise.resolve();
  const capture = vi.spyOn(identities, 'captureProcessIdentity').mockImplementation((pid) => {
    const identity = captureProcessIdentity(pid);
    if (!identity.ok) throw new Error(identity.reason);
    owned = { pid, processToken: identity.token };
    started();
    return { ok: false, reason: 'ACCESS_DENIED' };
  });
  try {
    const reading = runReport(context(controller.signal), async () =>
      getExecutor().runFileAsync(process.execPath, ['-e', 'setTimeout(() => {}, 5000)'], {
        timeoutMs: 'unbounded',
        onSpawn: (child) => {
          nativeClosed = new Promise<void>((resolve) => child.once('close', resolve));
        },
      }),
    ).catch((error: unknown) => error);
    await ready;
    controller.abort(new Error('cancel fixture'));
    const failure = await reading;
    expect(failure).toMatchObject({ code: 'STIM_CLAIM_UNAVAILABLE' });
    expect(inspectProcessIdentity(owned)).toBe('same');
  } finally {
    capture.mockRestore();
    reapFixtureChild(owned);
    await nativeClosed;
  }
});

test(
  'a version probe cannot signal an unverifiable child after report refusal',
  { skip: process.platform === 'win32' },
  async () => {
    const bin = join(scratch, 'bin');
    mkdirSync(bin);
    const executable = join(bin, 'stim');
    const pidFile = join(scratch, 'probe-pid');
    writeFileSync(
      executable,
      `#!${process.execPath}\nrequire('node:fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); setTimeout(() => {}, 6000);\n`,
    );
    chmodSync(executable, 0o755);
    const controller = new AbortController();
    const scope = context(controller.signal);
    scope.env.PATH = bin;
    const inspect = vi.spyOn(identities, 'inspectProcessIdentity').mockReturnValue('unknown');
    let owned: { pid: number; processToken: string } | undefined;
    const reading = runReport(scope, async (operation) =>
      inspectStimVersions('1.0.0', {
        cwd: scratch,
        env: scope.env,
        runningPath: executable,
        probeTimeoutMs: 2200,
        operation,
      }),
    ).catch((error: unknown) => error);
    try {
      const deadline = performance.now() + 3000;
      while (!owned && performance.now() < deadline) {
        try {
          const pid = Number(readFileSync(pidFile, 'utf8'));
          const identity = captureProcessIdentity(pid);
          if (identity.ok) owned = { pid, processToken: identity.token };
        } catch {}
        if (!owned) await new Promise((resolve) => setTimeout(resolve, 20));
      }
      expect(owned).toBeDefined();
      controller.abort(new Error('cancel fixture'));
      expect(await reading).toMatchObject({ code: 'STIM_CLAIM_UNAVAILABLE' });
      await new Promise((resolve) => setTimeout(resolve, 1400));
      expect(inspectProcessIdentity(owned)).toBe('same');
    } finally {
      inspect.mockRestore();
      controller.abort();
      reapFixtureChild(owned);
      await reading;
    }
  },
);

test.each([false, true])(
  'a launcher gone before identity capture requires its process group to be gone (%s)',
  { skip: process.platform === 'win32' },
  async (descendant) => {
    const capture = vi.spyOn(identities, 'captureProcessIdentity').mockReturnValue({ ok: false, reason: 'NOT_FOUND' });
    let owned: { pid: number; processToken: string } | undefined;
    try {
      const result = await runReport(context(new AbortController().signal), async () =>
        getExecutor().runFileAsync('/bin/sh', ['-c', descendant ? 'sleep 3 >/dev/null 2>&1 & echo $!' : 'exit 0'], {
          timeoutMs: 5000,
          onSpawn: (child) =>
            child.stdout?.once('data', (chunk) => {
              const pid = Number(String(chunk).trim());
              const identity = captureProcessIdentity(pid);
              if (!identity.ok) throw new Error(identity.reason);
              owned = { pid, processToken: identity.token };
            }),
        }),
      ).then(
        () => 'complete',
        (error: unknown) => error,
      );
      expect(result instanceof Error && 'code' in result ? result.code : result).toBe(
        descendant ? 'STIM_CLAIM_UNAVAILABLE' : 'complete',
      );
      expect(owned ? inspectProcessIdentity(owned) : null).toBe(descendant ? 'same' : null);
    } finally {
      capture.mockRestore();
      reapFixtureChild(owned);
    }
  },
);

test.each(['timeout', 'overflow', 'exit'])(
  'a report drains descendants after the launcher %s, even with ignored stdio',
  async (ending) => {
    let owned: { pid: number; processToken: string } | undefined;
    try {
      const result = await runReport(context(new AbortController().signal), async () =>
        getExecutor()
          .runFileAsync(
            process.execPath,
            [
              '-e',
              `
          const c = require('node:child_process').spawn(process.execPath,
            ['-e', 'setTimeout(() => {}, 10000)'], { stdio: 'ignore' });
          console.log(c.pid);
          setTimeout(() => {
            if ('${ending}' === 'overflow') process.stdout.write(Buffer.alloc(65 * 1024 * 1024));
            if ('${ending}' === 'exit') process.exit(0);
          }, 30);
          setTimeout(() => {}, 10000);
        `,
            ],
            {
              timeoutMs: ending === 'timeout' ? (process.platform === 'win32' ? 6500 : 300) : 10_000,
              onSpawn: (child) =>
                child.stdout?.once('data', (chunk) => {
                  const pid = Number(String(chunk).split('\n')[0]);
                  const identity = captureProcessIdentity(pid);
                  if (!identity.ok) throw new Error(identity.reason);
                  owned = { pid, processToken: identity.token };
                }),
            },
          )
          .then(
            () => 'complete',
            (error: unknown) => error,
          ),
      );
      expect(result instanceof Error && 'code' in result ? result.code : result).toBe(
        ending === 'timeout' ? 'ETIMEDOUT' : ending === 'overflow' ? 'ENOBUFS' : 'complete',
      );
      if (!owned) throw new Error('The controlled descendant did not start');
      const record = owned;
      await vi.waitFor(() => expect(() => process.kill(record.pid, 0)).toThrow(/ESRCH/), { timeout: 500 });
    } finally {
      reapFixtureChild(owned);
    }
  },
);

test.skipIf(process.platform !== 'win32')(
  'a native launcher cannot leave an uncontained report descendant',
  async () => {
    const script = join(scratch, 'native-launcher.ps1');
    const childScript = join(scratch, 'descendant.cjs');
    writeFileSync(childScript, 'setTimeout(() => {}, 15000)');
    const quoted = (text: string) => `'${text.replaceAll("'", "''")}'`;
    writeFileSync(
      script,
      `$p = Start-Process -FilePath ${quoted(process.execPath)} -ArgumentList ${quoted(`"${childScript}"`)} -PassThru -RedirectStandardOutput ${quoted(join(scratch, 'child.out'))} -RedirectStandardError ${quoted(join(scratch, 'child.err'))}
Write-Output $p.Id
`,
    );
    let owned: { pid: number; processToken: string } | undefined;
    try {
      const pid = Number(
        await runReport(context(new AbortController().signal), async () =>
          getExecutor().runFileAsync(
            'powershell.exe',
            ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script],
            {
              timeoutMs: 10_000,
              onSpawn: (child) =>
                child.stdout?.once('data', (chunk) => {
                  const descendantPid = Number(String(chunk).trim());
                  const identity = captureProcessIdentity(descendantPid);
                  if (!identity.ok) throw new Error(identity.reason);
                  owned = { pid: descendantPid, processToken: identity.token };
                }),
            },
          ),
        ),
      );
      expect(Number.isSafeInteger(pid) && pid > 1).toBe(true);
      await vi.waitFor(() => expect(() => process.kill(pid, 0)).toThrow(/ESRCH/), { timeout: 1500 });
    } finally {
      reapFixtureChild(owned);
    }
  },
);

test.skipIf(process.platform !== 'win32')('contained probes preserve argv, client environment and stdin', async () => {
  const args = ['space and & percent %', 'quote " and slash \\', 'café'];
  const input = 'input café\nwith lines';
  const result = await runReport(context(new AbortController().signal), async () =>
    getExecutor().runFileAsync(
      process.execPath,
      [
        '-e',
        'let input=""; process.stdin.setEncoding("utf8"); process.stdin.on("data", x => input += x); process.stdin.on("end", () => console.log(JSON.stringify({args:process.argv.slice(1),input,value:process.env.FIXTURE_VALUE,control:process.env.STIM_REPORT_CHILD})));',
        ...args,
      ],
      { input, env: { FIXTURE_VALUE: 'scoped value' }, timeoutMs: 10_000 },
    ),
  );
  expect(JSON.parse(result)).toEqual({ args, input, value: 'scoped value' });
});

test.skipIf(process.platform === 'win32')(
  'cancellation ends the owned process group when a helper holds stdout',
  async () => {
    const controller = new AbortController();
    let descendant: number | undefined;
    const result = runReport(context(controller.signal), async () =>
      getExecutor().runFileAsync(
        process.execPath,
        [
          '-e',
          'const c = require("node:child_process").spawn(process.execPath, ["-e", "setTimeout(() => {}, 3000)"], { stdio: ["ignore", "inherit", "inherit"] }); console.log(c.pid); setTimeout(() => {}, 3000);',
        ],
        {
          timeoutMs: 10_000,
          onSpawn: (child) => {
            child.stdout?.once('data', (chunk) => {
              descendant = Number(String(chunk).trim());
              controller.abort();
            });
          },
        },
      ),
    ).then(
      () => null,
      (error: unknown) => error,
    );
    expect(await result).toBe(controller.signal.reason);
    if (descendant === undefined || !Number.isSafeInteger(descendant) || descendant < 2)
      throw new Error('The controlled descendant did not start');
    const pid = descendant;
    await vi.waitFor(() => expect(() => process.kill(pid, 0)).toThrow(/ESRCH/), { timeout: 2500 });
  },
);

test('a cancelled report closes its in-progress authenticated connection before returning', async () => {
  const server = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const address = server.address();
  if (typeof address === 'string' || !address) throw new Error('The controlled server did not listen');
  const controller = new AbortController();
  let clientClosed: Promise<void> | undefined;
  server.once('connection', (socket) => {
    clientClosed = new Promise<void>((resolve) => socket.once('close', () => resolve()));
    controller.abort();
  });
  try {
    const result = runReport(context(controller.signal), (operation) =>
      openAuthenticated(
        {
          url: `ws://127.0.0.1:${address.port}`,
          host: '127.0.0.1',
          servername: 'localhost',
        },
        { access: 'build', serverKey: Buffer.alloc(32, 1).toString('base64url') },
        10_000,
        operation.signal,
        operation,
      ),
    ).then(
      () => null,
      (error: unknown) => error,
    );
    expect(await result).toBe(controller.signal.reason);
    expect(clientClosed).toBeDefined();
    await clientClosed;
  } finally {
    for (const socket of server.clients) socket.terminate();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test.skipIf(process.platform === 'win32')(
  'a queued Git read inherits report cancellation and releases its queue entry',
  async () => {
    const bin = join(scratch, 'bin');
    mkdirSync(bin);
    writeFileSync(join(bin, 'git'), '#!/bin/sh\nexec /bin/sleep 3\n', { mode: 0o755 });
    const activeController = new AbortController();
    const activeContext = context(activeController.signal);
    activeContext.env.PATH = bin;
    let started = 0;
    let ready: () => void = () => {};
    const sixStarted = new Promise<void>((resolve) => {
      ready = resolve;
    });
    const active = runReport(activeContext, () =>
      Promise.allSettled(
        Array.from({ length: 6 }, () =>
          gitAsync(scratch, ['status'], {
            timeoutMs: 10_000,
            onSpawn: () => {
              if (++started === 6) ready();
            },
          }),
        ),
      ),
    ).then(
      () => null,
      (error: unknown) => error,
    );
    await sixStarted;
    const queuedController = new AbortController();
    const queuedContext = context(queuedController.signal);
    queuedContext.env.PATH = bin;
    let spawned = false;
    const queued = runReport(queuedContext, () =>
      gitAsync(scratch, ['status'], {
        timeoutMs: 10_000,
        onSpawn: () => {
          spawned = true;
        },
      }),
    ).then(
      () => null,
      (error: unknown) => error,
    );
    try {
      queuedController.abort();
      expect(await queued).toBe(queuedController.signal.reason);
      expect(spawned).toBe(false);
    } finally {
      activeController.abort();
      await active;
    }
    expect(await gitAsync(scratch, ['--version'])).toMatch(/^git version/);
  },
);
