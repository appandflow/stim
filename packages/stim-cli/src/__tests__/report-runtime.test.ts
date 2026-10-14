import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { withAmbientContext, type StimContext } from '@stim-cli/core';
import { getExecutor } from '../exec.ts';
import { runReport as executeReport } from '../report-runtime.ts';

function runReport<T>(scope: StimContext, work: (operation: StimContext) => Promise<T>): Promise<T> {
  return executeReport(scope, (operation) => withAmbientContext(operation, () => work(operation)));
}
import { WebSocketServer } from 'ws';
import { openAuthenticated } from '../offload/tailnet.ts';
import { gitAsync } from '../workspace/git.ts';
import * as identities from '../process-identity.ts';

let scratch: string;
beforeEach(() => {
  scratch = realpathSync(mkdtempSync(join(tmpdir(), 'stim-report-runtime-')));
});
afterEach(() => {
  vi.useRealTimers();
  rmSync(scratch, { recursive: true, force: true });
});

function context(signal: AbortSignal): StimContext {
  return {
    home: join(scratch, 'home'),
    buildCache: null,
    projectRoot: scratch,
    cwd: scratch,
    env: { ...process.env, HOME: scratch, USERPROFILE: scratch, STIM_HOME: join(scratch, 'home') },
    runId: 'report-fixture',
    signal,
    output: () => {},
  };
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
  expect(await failure).toBe(controller.signal.reason);
  if (pid === undefined) throw new Error('The controlled child did not start');
  const ownPid = pid;
  expect(() => process.kill(ownPid, 0)).toThrow(/ESRCH/);
  expect(await other).toBe('other client');
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
              timeoutMs: ending === 'timeout' ? 300 : 5000,
              onSpawn: (child) =>
                child.stdout?.once('data', (chunk) => {
                  const pid = Number(String(chunk).split('\n')[0]);
                  const identity = identities.captureProcessIdentity(pid);
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
      if (owned && identities.inspectProcessIdentity(owned) === 'same') process.kill(owned.pid, 'SIGKILL');
    }
  },
);

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
