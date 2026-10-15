import assert from 'node:assert';
import type { ChildProcess } from 'node:child_process';
import { EventEmitter, once } from 'node:events';
import {
  closeSync,
  fstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setImmediate as nextTurn, setTimeout as delay } from 'node:timers/promises';
import { withAmbientContext, workspaceName } from '@stim-cli/core';
import { resolveWorkspaceMetroPort, startDevServer } from '../commands/start.ts';
import { getExecutor, resetExecutor, setExecutor } from '../exec.ts';
import { captureProcessToken } from '../process-identity.ts';
import { getProject, upsertProject } from '../workspace/config.ts';
import { clearWorkspaceStateKeys, readWorkspaceState, writeWorkspaceState } from '../workspace/workspace-state.ts';
import { testContext } from './_context.ts';
import { releaseClaim, tryAcquireClaim } from '../ownership-claim.ts';
import { supervisorLogFile } from '../workspace/paths.ts';
import {
  startTunnel,
  startTunnelSequence,
  withManagedTunnelLock,
  withManagedTunnelRemovalLock,
} from '../engine/tunnel.ts';

let home: string;
let root: string;
beforeEach(() => {
  home = realpathSync(mkdtempSync(join(tmpdir(), 'stim-start-context-')));
  root = join(home, 'app');
  mkdirSync(root);
  writeFileSync(join(root, 'package.json'), JSON.stringify({ dependencies: { 'react-native': '0.88.0' } }));
  vi.stubEnv('STIM_HOME', home);
});
afterEach(() => {
  resetExecutor();
  vi.unstubAllEnvs();
  rmSync(home, { recursive: true, force: true });
});

test('pinned startup port lookup leaves the event loop responsive while its native probe is pending', async () => {
  const real = getExecutor();
  setExecutor({
    ...real,
    runFileQuiet: () => {
      throw new Error('blocking startup probe');
    },
    runFileQuietAsync: () =>
      real.runFileAsync(process.execPath, ['-e', 'setTimeout(() => {}, 150)'], { timeoutMs: 2000 }),
  });
  let settled = false;
  const pending = resolveWorkspaceMetroPort(root, { metro: { port: 23456 } }, () => {}, 'start', false);
  void pending.then(
    () => (settled = true),
    () => (settled = true),
  );
  try {
    await delay(20);
    expect(settled).toBe(false);
    await expect(pending).resolves.toBe(23456);
    expect(getProject(root)).toBeNull();
  } finally {
    await pending.catch(() => {});
  }
});

test('cancelling a startup HTTP status probe refuses before reserving the pinned port', async () => {
  let requested!: () => void;
  const probing = new Promise<void>((resolve) => {
    requested = resolve;
  });
  const server = createServer(() => requested());
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert(address && typeof address === 'object');
  const real = getExecutor();
  setExecutor({ ...real, runFileQuiet: () => String(process.pid), runFileQuietAsync: async () => String(process.pid) });
  const controller = new AbortController();
  const pending = withAmbientContext(
    testContext({ home, projectRoot: root, cwd: root, signal: controller.signal }),
    () => resolveWorkspaceMetroPort(root, { metro: { port: address.port } }, () => {}, 'start', false),
  );
  const completed = pending.catch((cause: unknown) => cause);
  try {
    await probing;
    controller.abort();
    expect(await Promise.race([completed, delay(200, 'pending')])).toMatchObject({ code: 'STIM_CANCELLED' });
    expect(getProject(root)).toBeNull();
  } finally {
    controller.abort();
    server.closeAllConnections();
    await completed;
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test('cancelling readiness sleep keeps the existing supervisor and starts no replacement', async () => {
  const port = 23456;
  upsertProject(root, { metroPort: port });
  const supervisor = {
    pid: process.pid,
    processToken: captureProcessToken(process.pid),
    port,
    mode: 'bare-inproc',
    startedAt: new Date().toISOString(),
  };
  assert(supervisor.processToken);
  writeWorkspaceState(root, { supervisor });
  let probes = 0;
  let reading!: () => void;
  const ready = new Promise<void>((resolve) => {
    reading = resolve;
  });
  const inspect = () => {
    if (++probes === 2) reading();
    return '';
  };
  const spawn = vi.fn<ReturnType<typeof getExecutor>['spawn']>(() => {
    throw new Error('replacement supervisor');
  });
  setExecutor({ ...getExecutor(), runFileQuiet: inspect, runFileQuietAsync: async () => inspect(), spawn });
  const controller = new AbortController();
  const pending = withAmbientContext(
    testContext({ home, projectRoot: root, cwd: root, signal: controller.signal }),
    () =>
      startDevServer({
        root,
        settings: {},
        settingsContext: { projectPath: root, gitCommonDir: null, repoRoot: root },
        waitSeconds: 1,
        out: () => {},
        note: () => {},
      }),
  );
  const completed = pending.catch((cause: unknown) => cause);
  try {
    await ready;
    await nextTurn();
    controller.abort();
    expect(await Promise.race([completed, delay(200, 'pending')])).toMatchObject({ code: 'STIM_CANCELLED' });
    expect(spawn).not.toHaveBeenCalled();
    expect(readWorkspaceState(root)?.supervisor).toEqual(supervisor);
  } finally {
    controller.abort();
    await completed;
  }
});

test.each(['direct', 'win32'] as const)(
  'cancellation preserves %s supervisor discovery and failed-record cleanup',
  async (launch) => {
    const port = 23456;
    upsertProject(root, { metroPort: port });
    const controller = new AbortController();
    const identity = { pid: process.pid, processToken: captureProcessToken(process.pid) };
    assert(identity.processToken);
    const record = { ...identity, port, mode: 'bare-inproc', startedAt: new Date().toISOString() };
    let published: Promise<void> = Promise.resolve();
    const child = Object.assign(new EventEmitter(), { pid: process.pid, unref() {}, kill: () => true });
    setExecutor({
      ...getExecutor(),
      runFileQuiet: () => '',
      runFileQuietAsync: async () => '',
      spawn: () => {
        if (launch === 'win32') {
          published = delay(50).then(
            () => void writeWorkspaceState(root, { supervisor: { ...record, startedAt: new Date().toISOString() } }),
          );
          queueMicrotask(() => {
            controller.abort();
            child.emit('close', 0, null);
          });
        }
        return child;
      },
    });
    const terminate = vi.fn<(child: unknown) => Promise<boolean>>(async () => true);
    const writeRecord = vi.fn<() => void>(() => {
      clearWorkspaceStateKeys(root, ['supervisor']);
      controller.abort();
      throw new Error('disk full');
    });
    try {
      const result = await withAmbientContext(
        testContext({ home, projectRoot: root, cwd: root, signal: controller.signal }),
        () =>
          startDevServer(
            {
              root,
              settings: { metro: { tunnel: 'ngrok' } },
              settingsContext: { projectPath: root, gitCommonDir: null, repoRoot: root },
              remote: true,
              out: () => {},
              note: () => {},
            },
            {
              platform: launch === 'win32' ? 'win32' : 'linux',
              budgetGate: async () => ({ reclaimed: [], refusal: null }),
              providers: () => ['ngrok'],
              startTunnelSequence: async () => ({
                provider: 'ngrok',
                url: 'https://ready.ngrok.app',
                pid: 4343,
                processToken: 'linux:100',
                cleanup: async () => ({ status: 'stopped' }),
              }),
              isTunnelAlive: () => true,
              writeSupervisorRecord: writeRecord,
              terminateSupervisorChild: terminate,
            },
          ),
      );
      expect(result).toMatchObject({ ok: false, error: { code: 'STIM_SUPERVISOR_EXITED' } });
      expect(writeRecord).toHaveBeenCalledOnce();
      expect(terminate).toHaveBeenCalledOnce();
      expect(readWorkspaceState(root)?.supervisor).toBeUndefined();
    } finally {
      await published;
    }
  },
  15_000,
);

test('cancellation inside managed tunnel admission stays a cancellation and starts no supervisor', async () => {
  upsertProject(root, { metroPort: 23456 });
  const controller = new AbortController();
  const spawn = vi.fn<ReturnType<typeof getExecutor>['spawn']>(() => {
    throw new Error('cancelled start spawned a supervisor');
  });
  setExecutor({ ...getExecutor(), runFileQuiet: () => '', runFileQuietAsync: async () => '', spawn });
  const pending = withAmbientContext(
    testContext({ home, projectRoot: root, cwd: root, signal: controller.signal }),
    () =>
      startDevServer(
        {
          root,
          settings: { metro: { tunnel: 'ngrok' } },
          settingsContext: { projectPath: root, gitCommonDir: null, repoRoot: root },
          remote: true,
          out: () => {},
          note: () => {},
        },
        {
          budgetGate: async () => ({ reclaimed: [], refusal: null }),
          providers: () => ['ngrok'],
          withTunnelLock: (workspaceRoot, work, options) =>
            withManagedTunnelLock(
              workspaceRoot,
              async (claim) => {
                controller.abort();
                return work(claim);
              },
              options,
            ),
        },
      ),
  );
  await expect(pending).rejects.toMatchObject({ code: 'STIM_CANCELLED' });
  expect(spawn).not.toHaveBeenCalled();
});

test('remote startup refuses a live PID whose recorded tunnel identity no longer matches', async () => {
  const port = 23456;
  upsertProject(root, { metroPort: port });
  const tunnel = {
    kind: 'managed' as const,
    provider: 'ngrok' as const,
    pid: process.pid,
    processToken: 'old-process-instance',
    port,
    url: 'https://stale.ngrok.app',
    startedAt: new Date().toISOString(),
  };
  writeWorkspaceState(root, { metroTunnel: tunnel });
  const spawn = vi.fn<ReturnType<typeof getExecutor>['spawn']>(() => {
    throw new Error('unverified tunnel was reused');
  });
  setExecutor({ ...getExecutor(), runFileQuiet: () => '', runFileQuietAsync: async () => '', spawn });
  const result = await startDevServer(
    {
      root,
      settings: { metro: { tunnel: 'ngrok' } },
      settingsContext: { projectPath: root, gitCommonDir: null, repoRoot: root },
      remote: true,
      out: () => {},
      note: () => {},
    },
    { budgetGate: async () => ({ reclaimed: [], refusal: null }), providers: () => ['ngrok'] },
  );
  expect(result).toMatchObject({ ok: false, error: { code: 'STIM_REMOTE_START_REQUIRED' } });
  expect(spawn).not.toHaveBeenCalled();
  expect(readWorkspaceState(root)?.metroTunnel).toEqual(tunnel);
});

describe.skipIf(process.platform === 'win32')('POSIX spawned startup ownership', () => {
  test.each(['supervisor', 'tunnel'])(
    'a failed %s handoff keeps its startup claim while cleanup is unresolved',
    async (kind) => {
      const port = 23456;
      upsertProject(root, { metroPort: port });
      const real = getExecutor();
      let child: ChildProcess | undefined;
      const launch = () => {
        child = real.spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
          detached: true,
          stdio: 'ignore',
        });
        assert(child.pid);
        const processToken = captureProcessToken(child.pid);
        assert(processToken);
        return { pid: child.pid, processToken };
      };
      setExecutor({
        ...real,
        runFileQuiet: () => '',
        runFileQuietAsync: async () => '',
        spawn: (_file, _args, options) => {
          child = real.spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], options);
          return child;
        },
      });
      try {
        const result = await withAmbientContext(testContext({ home, projectRoot: root, cwd: root }), () =>
          startDevServer(
            {
              root,
              settings: { metro: { tunnel: 'ngrok' } },
              settingsContext: { projectPath: root, gitCommonDir: null, repoRoot: root },
              remote: true,
              out: () => {},
              note: () => {},
            },
            {
              budgetGate: async () => ({ reclaimed: [], refusal: null }),
              providers: () => ['ngrok'],
              startTunnelSequence: async () => ({
                provider: 'ngrok',
                url: 'https://ready.ngrok.app',
                ...(kind === 'tunnel' ? launch() : { pid: 4343, processToken: 'linux:100' }),
                cleanup: async () =>
                  kind === 'tunnel' ? { status: 'failed', reason: 'fixture refused cleanup' } : { status: 'stopped' },
              }),
              isTunnelAlive: () => true,
              ...(kind === 'tunnel'
                ? {
                    writeTunnelRecord: () => {
                      throw new Error('disk full');
                    },
                  }
                : {
                    writeSupervisorRecord: () => {
                      throw new Error('disk full');
                    },
                  }),
              terminateSupervisorChild: async () => false,
            },
          ),
        ).catch((cause: unknown) => cause);
        assert(child?.pid);
        const next = tryAcquireClaim({
          root: join(home, 'workspaces', workspaceName(root), 'metro-start.lock'),
          mode: 'exclusive',
          label: 'replacement startup',
        });
        if (next.acquired) releaseClaim(next.acquired);
        expect(result).toMatchObject({ ok: false, error: { code: 'STIM_CLAIM_UNAVAILABLE' } });
        expect(next.acquired).toBeUndefined();
        expect(next.held?.child?.pid).toBe(child.pid);
        await expect(withManagedTunnelRemovalLock(root, async () => true, { waitMs: 0 })).rejects.toMatchObject({
          code: 'STIM_LOCK_TIMEOUT',
        });
      } finally {
        if (child && child.exitCode === null && child.signalCode === null) {
          const exited = once(child, 'exit');
          child.kill('SIGTERM');
          await exited;
        }
      }
    },
    15_000,
  );

  test('a partially published supervisor keeps ownership when its registry record disagrees', async () => {
    const port = 23456;
    upsertProject(root, { metroPort: port, supervisor: { pid: 999999901, processToken: 'linux:100', port } });
    const real = getExecutor();
    let child: ChildProcess | undefined;
    setExecutor({
      ...real,
      runFileQuiet: () => '',
      runFileQuietAsync: async () => '',
      spawn: (_file, _args, options) => {
        child = real.spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], options);
        return child;
      },
    });
    try {
      const result = await startDevServer(
        {
          root,
          settings: {},
          settingsContext: { projectPath: root, gitCommonDir: null, repoRoot: root },
          out: () => {
            assert(child?.pid);
            const processToken = captureProcessToken(child.pid);
            assert(processToken);
            writeWorkspaceState(root, { supervisor: { pid: child.pid, processToken, port } });
            throw new Error('progress callback failed after partial publication');
          },
          note: () => {},
        },
        { budgetGate: async () => ({ reclaimed: [], refusal: null }) },
      );
      expect(result).toMatchObject({ ok: false, error: { code: 'STIM_CLAIM_UNAVAILABLE' } });
      assert(child);
      expect(child.exitCode === null && child.signalCode === null).toBe(true);
      await expect(withManagedTunnelRemovalLock(root, async () => true, { waitMs: 0 })).rejects.toMatchObject({
        code: 'STIM_LOCK_TIMEOUT',
      });
    } finally {
      if (child && child.exitCode === null && child.signalCode === null) {
        const exited = once(child, 'exit');
        child.kill('SIGTERM');
        await exited;
      }
    }
  });

  test('supervisor publication racing termination retains ownership after the parent exits', async () => {
    const port = 23456;
    upsertProject(root, { metroPort: port });
    const real = getExecutor();
    let child: ChildProcess | undefined;
    setExecutor({
      ...real,
      runFileQuiet: () => '',
      runFileQuietAsync: async () => '',
      spawn: (_file, _args, options) => {
        child = real.spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], options);
        return child;
      },
    });
    try {
      const result = await startDevServer(
        {
          root,
          settings: {},
          settingsContext: { projectPath: root, gitCommonDir: null, repoRoot: root },
          out: () => {
            throw new Error('progress failed before publication');
          },
          note: () => {},
        },
        {
          budgetGate: async () => ({ reclaimed: [], refusal: null }),
          terminateSupervisorChild: async () => {
            assert(child?.pid);
            const processToken = captureProcessToken(child.pid);
            assert(processToken);
            writeWorkspaceState(root, { supervisor: { pid: child.pid, processToken, port } });
            const exited = once(child, 'exit');
            child.kill('SIGTERM');
            await exited;
            return true;
          },
        },
      ).catch((cause: unknown) => cause);
      expect(result).toMatchObject({ ok: false, error: { code: 'STIM_CLAIM_UNAVAILABLE' } });
      await expect(withManagedTunnelRemovalLock(root, async () => true, { waitMs: 0 })).rejects.toMatchObject({
        code: 'STIM_LOCK_TIMEOUT',
      });
    } finally {
      if (child && child.exitCode === null && child.signalCode === null) {
        const exited = once(child, 'exit');
        child.kill('SIGTERM');
        await exited;
      }
    }
  });

  test.each(['pipes', 'file'] as const)(
    'cancelling a tunnel before its URL is published through %s drains the child before releasing startup',
    async (output) => {
      upsertProject(root, { metroPort: 23456 });
      const real = getExecutor();
      setExecutor({ ...real, runFileQuiet: () => '', runFileQuietAsync: async () => '' });
      const controller = new AbortController();
      let child: ChildProcess | undefined;
      let launched!: () => void;
      const started = new Promise<void>((resolve) => {
        launched = resolve;
      });
      const logFile = join(home, 'tunnel.log');
      writeFileSync(logFile, '');
      const pending = withAmbientContext(
        testContext({ home, projectRoot: root, cwd: root, signal: controller.signal }),
        () =>
          startDevServer(
            {
              root,
              settings: { metro: { tunnel: 'ngrok' } },
              settingsContext: { projectPath: root, gitCommonDir: null, repoRoot: root },
              remote: true,
              out: () => {},
              note: () => {},
            },
            {
              budgetGate: async () => ({ reclaimed: [], refusal: null }),
              providers: () => ['ngrok'],
              startTunnelSequence: (options) =>
                startTunnelSequence({
                  ...options,
                  start: (startOptions) =>
                    startTunnel({
                      ...startOptions,
                      urlTimeoutMs: 1000,
                      logFile: output === 'file' ? logFile : null,
                      spawnFn: () => {
                        child = real.spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
                          detached: true,
                          stdio: ['ignore', 'pipe', 'pipe'],
                        });
                        launched();
                        return child;
                      },
                    }),
                }),
            },
          ),
      ).catch((cause: unknown) => cause);
      try {
        await started;
        controller.abort();
        expect(await Promise.race([pending, delay(500, 'pending')])).toMatchObject({ code: 'STIM_CANCELLED' });
        assert(child);
        expect(child.exitCode !== null || child.signalCode !== null).toBe(true);
        await expect(withManagedTunnelRemovalLock(root, async () => true, { waitMs: 0 })).resolves.toBe(true);
      } finally {
        await pending;
        if (child && child.exitCode === null && child.signalCode === null) {
          const exited = once(child, 'exit');
          child.kill('SIGTERM');
          await exited;
        }
      }
    },
  );

  test('direct supervisor launch closes the parent log descriptor while retaining the child log output', async () => {
    upsertProject(root, { metroPort: 23456 });
    const real = getExecutor();
    let descriptor: number | null = null;
    let child: ChildProcess | undefined;
    setExecutor({
      ...real,
      runFileQuiet: () => '',
      runFileQuietAsync: async () => '',
      spawn: (_file, _args, options) => {
        const stdio = options?.stdio;
        if (Array.isArray(stdio) && typeof stdio[1] === 'number') descriptor = stdio[1];
        child = real.spawn(process.execPath, ['-e', 'console.log("fixture-started"); process.exit(1)'], options);
        return child;
      },
    });
    try {
      const result = await startDevServer(
        {
          root,
          settings: {},
          settingsContext: { projectPath: root, gitCommonDir: null, repoRoot: root },
          waitSeconds: 1,
          out: () => {},
          note: () => {},
        },
        { budgetGate: async () => ({ reclaimed: [], refusal: null }) },
      );
      expect(result).toMatchObject({ ok: false, error: { code: 'STIM_SUPERVISOR_EXITED' } });
      expect(readFileSync(supervisorLogFile(root), 'utf8')).toContain('fixture-started');
      const fd = descriptor;
      assert(fd !== null);
      assert.throws(() => fstatSync(fd), { code: 'EBADF' });
    } finally {
      if (descriptor !== null) {
        try {
          closeSync(descriptor);
        } catch {}
      }
      if (child && child.exitCode === null && child.signalCode === null) {
        const exited = once(child, 'exit');
        child.kill('SIGTERM');
        await exited;
      }
    }
  });

  test.each(['cancellation', 'progress failure'])(
    '%s before supervisor publication drains the owned child before releasing startup',
    async (failure) => {
      upsertProject(root, { metroPort: 23456 });
      const real = getExecutor();
      const controller = new AbortController();
      const callbackFailure = new Error('progress callback failed');
      let child: ChildProcess | undefined;
      setExecutor({
        ...real,
        runFileQuiet: () => '',
        runFileQuietAsync: async () => '',
        spawn: (_file, _args, options) => {
          child = real.spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], options);
          return child;
        },
      });
      try {
        const result = await withAmbientContext(
          testContext({ home, projectRoot: root, cwd: root, signal: controller.signal }),
          () =>
            startDevServer(
              {
                root,
                settings: {},
                settingsContext: { projectPath: root, gitCommonDir: null, repoRoot: root },
                out: () => {
                  if (failure === 'progress failure') throw callbackFailure;
                  controller.abort();
                },
                note: () => {},
              },
              { budgetGate: async () => ({ reclaimed: [], refusal: null }) },
            ),
        ).catch((cause: unknown) => cause);
        expect(result).toMatchObject(
          failure === 'progress failure' ? { message: callbackFailure.message } : { code: 'STIM_CANCELLED' },
        );
        assert(child);
        expect(child.exitCode !== null || child.signalCode !== null).toBe(true);
        const next = tryAcquireClaim({
          root: join(home, 'workspaces', workspaceName(root), 'metro-start.lock'),
          mode: 'exclusive',
          label: 'replacement startup',
        });
        const acquired = next.acquired;
        if (acquired) releaseClaim(acquired);
        expect(acquired).toBeDefined();
      } finally {
        if (child && child.exitCode === null && child.signalCode === null) {
          const exited = once(child, 'exit');
          child.kill('SIGTERM');
          await exited;
        }
      }
    },
  );
});
