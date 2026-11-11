import assert from 'node:assert';
import type { ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setImmediate as nextTurn, setTimeout as delay } from 'node:timers/promises';
import { withAmbientContext, workspaceName } from '@stim-cli/core';
import { resolveWorkspaceMetroPort, startDevServer } from '../commands/start.ts';
import { getExecutor, resetExecutor, setExecutor } from '../exec.ts';
import { captureProcessToken, inspectProcessIdentity } from '../process-identity.ts';
import { getProject, upsertProject } from '../workspace/config.ts';
import { readWorkspaceState, writeWorkspaceState } from '../workspace/workspace-state.ts';
import { testContext } from './_context.ts';
import { readClaimSet, releaseClaim, tryAcquireClaim } from '../ownership-claim.ts';
import {
  startTunnel,
  startTunnelSequence,
  withManagedTunnelLock,
  withManagedTunnelRemovalLock,
} from '../engine/tunnel.ts';

let home: string;
let root: string;
const noMetro = async (): Promise<null> => {
  throw new Error('this start must not ask stimd for Metro');
};
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

test('a hosted dev-client run moves a recorded Metro port the host uses and refuses a pinned one', async () => {
  upsertProject(root, { metroPort: 24567 });
  const busy = new Set([24567, ...Array.from({ length: 18 }, (_, index) => 8082 + index)]);
  const hostedPorts = {
    machine: 'mini',
    free: async (port: number) => !busy.has(port),
    busy: (port: number) => ({ code: 'STIM_HOSTING_REFUSED', message: `busy ${port}`, remedy: null }),
  };
  const notes: string[] = [];
  const port = await resolveWorkspaceMetroPort(root, {}, (line) => notes.push(line), 'start', true, hostedPorts);
  assert(typeof port === 'number');
  expect(busy.has(port)).toBe(false);
  expect(getProject(root)?.metroPort).toBe(port);
  expect(notes.join('\n')).toContain('Port 24567 is in use on mini');
  expect(
    await resolveWorkspaceMetroPort(root, { metro: { port: 24567 } }, () => {}, 'start', true, hostedPorts),
  ).toMatchObject({ code: 'STIM_HOSTING_REFUSED', message: 'busy 24567' });
  expect(getProject(root)?.metroPort).toBe(port);
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
      startDevServer(
        {
          root,
          settings: {},
          settingsContext: { projectPath: root, gitCommonDir: null, repoRoot: root },
          waitSeconds: 1,
          out: () => {},
          note: () => {},
        },
        { ensureMetro: noMetro },
      ),
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
          diskFloorGate: async () => ({ refusal: null }),
          providers: () => ['ngrok'],
          ensureMetro: noMetro,
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
    { diskFloorGate: async () => ({ refusal: null }), providers: () => ['ngrok'], ensureMetro: noMetro },
  );
  expect(result).toMatchObject({ ok: false, error: { code: 'STIM_REMOTE_START_REQUIRED' } });
  expect(spawn).not.toHaveBeenCalled();
  expect(readWorkspaceState(root)?.metroTunnel).toEqual(tunnel);
});

describe.skipIf(process.platform === 'win32')('POSIX spawned startup ownership', () => {
  test('CLI interruption drains its tunnel before releasing startup claims', async () => {
    const marker = join(home, 'child.json');
    const script = join(home, 'interrupted-start.mjs');
    writeFileSync(join(root, '.stim.json'), JSON.stringify({ metro: { tunnel: 'ngrok' } }));
    writeFileSync(
      script,
      `
      import { writeFileSync } from 'node:fs';
      import { Command } from ${JSON.stringify(import.meta.resolve('commander'))};
      import { registerStart } from ${JSON.stringify(new URL('../commands/start.ts', import.meta.url).href)};
      import { CliExit } from ${JSON.stringify(new URL('../cli-operation.ts', import.meta.url).href)};
      import { getExecutor, setExecutor } from ${JSON.stringify(new URL('../exec.ts', import.meta.url).href)};
      import { captureProcessToken } from ${JSON.stringify(new URL('../process-identity.ts', import.meta.url).href)};
      const real = getExecutor();
      setExecutor({ ...real, runFileQuiet: () => '', runFileQuietAsync: async () => '',
        spawn: (_file, _args, options) => {
          const child = real.spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], options);
          writeFileSync(${JSON.stringify(marker)}, JSON.stringify({pid:child.pid, processToken:captureProcessToken(child.pid)}));
          return child;
        }
      });
      const program = new Command();
      registerStart(program, {
        providers: () => ['ngrok'],
        diskFloorGate: async () => ({ refusal: null }),
        ensureMetro: () => new Promise(() => {}),
      });
      try {
        await program.parseAsync(['node', 'stim', 'start', '--json', '--wait', '30', '--remote']);
      } catch (error) {
        if (!(error instanceof CliExit)) throw error;
        process.exit(error.exitCode);
      }
    `,
    );
    const runner = getExecutor().spawn(process.execPath, [script], {
      cwd: root,
      env: { ...process.env, STIM_DAEMON: 'off' },
      stdio: 'ignore',
    });
    const exited = once(runner, 'exit');
    let child: { pid: number; processToken: string } | undefined;
    const claimRoot = join(home, 'workspaces', workspaceName(root), 'metro-start.lock');
    try {
      await vi.waitFor(
        () => {
          child = JSON.parse(readFileSync(marker, 'utf8'));
          expect(readClaimSet(claimRoot).live.some((claim) => claim.child?.pid === child?.pid)).toBe(true);
        },
        { timeout: 5000 },
      );
      runner.kill('SIGINT');
      const [code, signal] = await exited;
      expect({ code, signal }).toEqual({ code: 130, signal: null });
      expect(child && inspectProcessIdentity(child)).not.toBe('same');
      expect(await withManagedTunnelLock(root, async () => 'acquired', { waitMs: 100 })).toBe('acquired');
      const claim = tryAcquireClaim({ root: claimRoot, mode: 'exclusive', label: 'next startup' });
      expect(claim.acquired).toBeTruthy();
      if (claim.acquired) releaseClaim(claim.acquired);
    } finally {
      if (runner.exitCode === null && runner.signalCode === null) {
        runner.kill('SIGKILL');
        await exited;
      }
      if (child && inspectProcessIdentity(child) === 'same') {
        try {
          process.kill(-child.pid, 'SIGKILL');
        } catch {}
      }
    }
  }, 15_000);

  test('a failed tunnel handoff keeps its startup claim while cleanup is unresolved', async () => {
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
            diskFloorGate: async () => ({ refusal: null }),
            providers: () => ['ngrok'],
            startTunnelSequence: async () => ({
              provider: 'ngrok',
              url: 'https://ready.ngrok.app',
              ...launch(),
              cleanup: async () => ({ status: 'failed', reason: 'fixture refused cleanup' }),
            }),
            isTunnelAlive: () => true,
            writeTunnelRecord: () => {
              throw new Error('disk full');
            },
            ensureMetro: noMetro,
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
      expect(result).toMatchObject({
        retainedClaimRoots: expect.arrayContaining([join(home, 'workspaces', workspaceName(root), 'metro-start.lock')]),
      });
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
  }, 15_000);

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
              diskFloorGate: async () => ({ refusal: null }),
              providers: () => ['ngrok'],
              ensureMetro: noMetro,
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
});
