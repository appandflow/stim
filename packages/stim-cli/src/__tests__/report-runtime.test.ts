import { spawnDeclared } from '../engine/spawn-claims.ts';
import { withWorkspaceProcessLock } from '../engine/workspace-process-lock.ts';
import { readClaimSet, releaseClaim, type ClaimHandle } from '../ownership-claim.ts';
import { rm } from 'node:fs/promises';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { withAmbientContext, type StimContext } from '@stim-cli/core';
import { getExecutor } from '../exec.ts';
import { runReport as executeReport, trackReportResource } from '../report-runtime.ts';

vi.mock('../process-group-exit.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../process-group-exit.ts')>()),
  groupExitBudgetMs: () => 1000,
}));

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
import { captureProcessIdentity, inspectProcessIdentity, waitForProcessExit } from '@stim-cli/core/process-identity';
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

// https://github.com/appandflow/stim/issues/3865
test.skipIf(process.platform === 'win32' && Boolean(process.env.CI))(
  'cancelling a report reaps its child and leaves another client running',
  async () => {
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
  },
);

test('a report refuses cleanup whose resource never closes', async () => {
  vi.useFakeTimers();
  let release: () => void = () => {};
  const resource = new Promise<void>((resolve) => {
    release = resolve;
  });
  let failure: unknown;
  const reading = runReport(context(new AbortController().signal), async (operation) => {
    trackReportResource(operation, resource, () => {});
    return 'complete';
  }).catch((error: unknown) => {
    failure = error;
  });
  try {
    await vi.advanceTimersByTimeAsync(35_000);
    expect(failure).toMatchObject({ code: 'STIM_CLAIM_UNAVAILABLE' });
  } finally {
    release();
    await reading;
  }
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
  let nativeClosed: Promise<void> = Promise.resolve();
  const inspect = vi.spyOn(identities, 'inspectProcessIdentity').mockReturnValue('different');
  try {
    const failure = await runReport(context(controller.signal), async () =>
      getExecutor().runFileAsync(process.execPath, ['-e', 'console.log("ready"); setTimeout(() => {}, 150)'], {
        timeoutMs: 10_000,
        onSpawn: (child) => {
          nativeClosed = new Promise<void>((resolve) => child.once('close', resolve));
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
    expect(failure).toBeInstanceOf(Error);
    await nativeClosed;
    expect(exit).toBe(0);
    expect(signal).toBeNull();
  } finally {
    inspect.mockRestore();
    await nativeClosed;
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

test.each([true, false])(
  'failed initial birth capture never signals the unverifiable child (report=%s)',
  async (report) => {
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
      const work = () =>
        getExecutor().runFileAsync(process.execPath, ['-e', 'setTimeout(() => {}, 5000)'], {
          timeoutMs: 'unbounded',
          signal: controller.signal,
          onSpawn: (child) => {
            nativeClosed = new Promise<void>((resolve) => child.once('close', resolve));
          },
        });
      const reading = (report ? runReport(context(controller.signal), work) : work()).catch((error: unknown) => error);
      await ready;
      controller.abort(new Error('cancel fixture'));
      const failure = await Promise.race([
        reading,
        new Promise((resolve) => setTimeout(() => resolve('pending'), 1800)),
      ]);
      expect(failure).toMatchObject({ code: 'STIM_CLAIM_UNAVAILABLE' });
      expect(inspectProcessIdentity(owned)).toBe('same');
    } finally {
      capture.mockRestore();
      reapFixtureChild(owned);
      await nativeClosed;
    }
  },
);

test('report cancellation refuses a verified child that does not close after termination', async () => {
  const controller = new AbortController();
  let owned: { pid: number; processToken: string } | undefined;
  let nativeClosed: Promise<void> = Promise.resolve();
  let started: () => void = () => {};
  const ready = new Promise<void>((resolve) => {
    started = resolve;
  });
  const killOriginal = process.kill.bind(process);
  const kill = vi.spyOn(process, 'kill').mockImplementation((pid, signal) => {
    if (pid === -(owned?.pid ?? 0) && signal === 'SIGKILL') return true;
    return killOriginal(pid, signal);
  });
  const reading = runReport(context(controller.signal), async () =>
    getExecutor().runFileAsync(process.execPath, ['-e', 'setTimeout(() => {}, 5000)'], {
      timeoutMs: 'unbounded',
      onSpawn: (child) => {
        if (child.pid === undefined) throw new Error('No fixture child PID');
        const identity = captureProcessIdentity(child.pid);
        if (!identity.ok) throw new Error(identity.reason);
        owned = { pid: child.pid, processToken: identity.token };
        nativeClosed = new Promise<void>((resolve) => child.once('close', resolve));
        if (process.platform === 'win32') vi.spyOn(child, 'kill').mockReturnValue(true);
        started();
      },
    }),
  ).catch((error: unknown) => error);
  try {
    await ready;
    controller.abort(new Error('cancel fixture'));
    const failure = await Promise.race([reading, new Promise((resolve) => setTimeout(() => resolve('pending'), 1800))]);
    expect(failure).toMatchObject({ code: 'STIM_CLAIM_UNAVAILABLE' });
    expect(inspectProcessIdentity(owned)).toBe('same');
  } finally {
    kill.mockRestore();
    reapFixtureChild(owned);
    await nativeClosed;
    await reading;
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

test.each([true, false])(
  'a claimed launcher stays declared after exit until its descendants are drained (report=%s)',
  async (boundedReport) => {
    let owned: { pid: number; processToken: string } | undefined;
    let declaredAtExit: boolean | undefined;
    const scope = context(new AbortController().signal);
    try {
      const work = async (operation: StimContext) =>
        withWorkspaceProcessLock(
          scratch,
          'gc-fixture',
          async (claim) => {
            await getExecutor().runFileAsync(
              process.execPath,
              [
                '-e',
                `
          const c = require('node:child_process').spawn(process.execPath, ['-e', 'setTimeout(() => {}, 10000)'], { stdio: 'ignore' });
          console.log(c.pid);
          setTimeout(() => process.exit(0), 100);
        `,
              ],
              {
                timeoutMs: 10_000,
                declareFor: operation,
                signal: operation.signal,
                onSpawn: (child) => {
                  child.stdout?.once('data', (chunk) => {
                    const pid = Number(String(chunk).trim());
                    const identity = captureProcessIdentity(pid);
                    if (!identity.ok) throw new Error(identity.reason);
                    owned = { pid, processToken: identity.token };
                  });
                  child.once('exit', () => {
                    declaredAtExit = readClaimSet(claim.root).live[0]?.childDeclared;
                  });
                },
              },
            );
            expect(declaredAtExit).toBe(true);
            if (!owned) throw new Error('The controlled descendant did not start');
            expect(inspectProcessIdentity(owned)).toBe('gone');
          },
          { declareSpawnsFor: operation, signal: operation.signal },
        );
      if (boundedReport) await runReport(scope, work);
      else await withAmbientContext(scope, () => work(scope));
    } finally {
      reapFixtureChild(owned);
    }
  },
);

test.each(['file', 'spawn'] as const)(
  'unverifiable claimed report cleanup retains the exact claim and names its recovery path (%s)',
  async (kind) => {
    const controller = new AbortController();
    const inspect = vi.spyOn(identities, 'inspectProcessIdentity').mockReturnValue('unknown');
    let owned: { pid: number; processToken: string } | undefined;
    let claim: ClaimHandle | undefined;
    try {
      const failure = await runReport(context(controller.signal), async (operation) =>
        withWorkspaceProcessLock(
          scratch,
          'gc-fixture',
          async (held) => {
            claim = held;
            const observe = (child: import('node:child_process').ChildProcess) => {
              const identity = child.pid === undefined ? null : captureProcessIdentity(child.pid);
              if (child.pid === undefined || !identity?.ok) throw new Error('The controlled child has no identity');
              owned = { pid: child.pid, processToken: identity.token };
              child.stdout?.once('data', () => controller.abort());
            };
            const args = ['-e', 'console.log("ready"); setTimeout(() => {}, 10000)'];
            if (kind === 'file') {
              await getExecutor().runFileAsync(process.execPath, args, {
                timeoutMs: 10_000,
                declareFor: operation,
                onSpawn: observe,
              });
            } else {
              const child = spawnDeclared(
                operation,
                () =>
                  getExecutor().spawn(process.execPath, args, {
                    stdio: ['ignore', 'pipe', 'pipe'],
                  }),
                { until: 'close' },
              );
              observe(child);
              await new Promise<void>((resolve) => child.once('close', () => resolve()));
            }
          },
          { declareSpawnsFor: operation, signal: operation.signal },
        ),
      ).catch((error: unknown) => error);
      if (!claim) throw new Error('The controlled claim was not acquired');
      expect(failure).toMatchObject({
        code: 'STIM_CLAIM_UNAVAILABLE',
        claims: [claim],
        remedy: expect.stringContaining(claim.path),
      });
      expect(readClaimSet(claim.root).live).toMatchObject([{ path: claim.path, childDeclared: true, child: owned }]);
      expect(owned ? inspectProcessIdentity(owned) : null).toBe('same');
    } finally {
      inspect.mockRestore();
      controller.abort();
      reapFixtureChild(owned);
      if (!owned || (await waitForProcessExit(owned, 2000))) releaseClaim(claim);
    }
  },
);

test('a cleanup refusal aborts its operation before a failed probe can continue with another action', async () => {
  const inspect = vi.spyOn(identities, 'inspectProcessIdentity').mockReturnValue('unknown');
  const marker = join(scratch, 'late-action');
  let owned: { pid: number; processToken: string } | undefined;
  let abortedBeforeContinuation = false;
  try {
    const failure = await runReport(context(new AbortController().signal), async (operation) => {
      try {
        await getExecutor().runFileAsync(process.execPath, ['-e', 'setTimeout(() => {}, 10000)'], {
          timeoutMs: 200,
          onSpawn: (child) => {
            const identity = child.pid === undefined ? null : captureProcessIdentity(child.pid);
            if (child.pid === undefined || !identity?.ok) throw new Error('The controlled child has no identity');
            owned = { pid: child.pid, processToken: identity.token };
          },
        });
      } catch (cause) {
        abortedBeforeContinuation = operation.signal.aborted;
        if (!operation.signal.aborted) writeFileSync(marker, 'another mutation');
        throw cause;
      }
    }).catch((error: unknown) => error);
    expect(failure).toMatchObject({ code: 'STIM_CLAIM_UNAVAILABLE' });
    expect(abortedBeforeContinuation).toBe(true);
    expect(existsSync(marker)).toBe(false);
  } finally {
    inspect.mockRestore();
    reapFixtureChild(owned);
    if (owned) await waitForProcessExit(owned, 2000);
  }
});
