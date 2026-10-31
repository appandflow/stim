import type { ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { withAmbientContext, type StimContext } from '@stim-cli/core';
import { collectEasSessionSweep, deleteEasSessions } from '../commands/gc/eas-sessions.ts';
import { getExecutor, resetExecutor, setExecutor } from '../exec.ts';
import { ensureWorkspaceStorage, workspaceStateFile } from '../workspace/paths.ts';
import { recordEasSessionClaim, readEasSessionLedger } from '../engine/eas-session-ledger.ts';
import { withEasProjectLock } from '../engine/eas-project-lock.ts';
import { withRemoteSessionLock } from '../engine/device-remote.ts';
import { takeGcResults } from '../commands/gc/results.ts';
import { runGc, withGcMaintenanceClaim } from '../commands/gc.ts';
import { operationState } from '../engine/operation-state.ts';
import { readClaimSet, releaseClaim, type ClaimHandle } from '../ownership-claim.ts';
import { captureProcessIdentity, inspectProcessIdentity, waitForProcessExit } from '@stim-cli/core/process-identity';
import * as identities from '../process-identity.ts';

let home: string;
let child: ChildProcess | undefined;

beforeEach(() => {
  home = realpathSync.native(mkdtempSync(join(tmpdir(), 'stim-gc-eas-probes-')));
  vi.stubEnv('STIM_HOME', home);
  resetExecutor();
  takeGcResults();
});

afterEach(async () => {
  if (child?.exitCode === null && child.signalCode === null) {
    const closed = once(child, 'close');
    child.kill('SIGKILL');
    await closed;
  }
  child = undefined;
  vi.useRealTimers();
  resetExecutor();
  vi.unstubAllEnvs();
  rmSync(home, { recursive: true, force: true });
});

function context(root: string, tag: string): StimContext {
  return {
    home,
    projectRoot: root,
    cwd: root,
    buildCache: null,
    runId: tag,
    signal: new AbortController().signal,
    env: {
      ...process.env,
      STIM_HOME: home,
      STIM_TEST_CONTEXT_TAG: tag,
      AGENT_DEVICE_DAEMON_BASE_URL: 'https://fixture.invalid',
      AGENT_DEVICE_DAEMON_AUTH_TOKEN: 'fixture-token',
    },
    output: () => {},
  };
}

function dependencies(root?: string) {
  return {
    findProjectRoot: (cwd: string) => root ?? cwd,
    detectIsExpo: () => true,
    resolveEasCliBin: () => ({ file: 'fixture-eas', source: 'path' as const }),
    easLedgerRoot: join(home, 'eas-ledger'),
  };
}

test('a slow EAS inventory page leaves the event loop responsive while preserving pagination', async () => {
  const root = join(home, 'app');
  mkdirSync(root);
  const executor = getExecutor();
  const pages = [
    JSON.stringify({ sessions: [], pageInfo: { hasNextPage: true, endCursor: 'next' } }),
    JSON.stringify({ sessions: [], pageInfo: { hasNextPage: false, endCursor: null } }),
  ];
  const seen: string[] = [];
  const probe = (args: string[]) => {
    const after = args.includes('--after') ? (args[args.indexOf('--after') + 1] ?? '') : 'first';
    seen.push(after);
    return [
      '-e',
      'setTimeout(() => process.stdout.write(process.argv[1]), 150)',
      (after === 'first' ? pages[0] : pages[1]) ?? '',
    ];
  };
  setExecutor({
    ...executor,
    runFile: (_file, args, options) => executor.runFile(process.execPath, probe(args), options),
    runFileAsync: (_file, args, options) => executor.runFileAsync(process.execPath, probe(args), options),
  });
  let ticked = false;
  const timer = setTimeout(() => (ticked = true), 25);
  try {
    const report = await collectEasSessionSweep(null, dependencies(root));
    expect(ticked).toBe(true);
    expect(seen).toEqual(['first', 'next']);
    expect(report).toEqual({ projectScope: root, orphaned: [], notices: [], deletionSafe: true });
  } finally {
    clearTimeout(timer);
  }
});

test('concurrent EAS report contexts use their workspace and keep proxy credentials out of the child', async () => {
  const roots = ['a', 'b'].map((tag) => join(home, tag));
  roots.forEach((root) => mkdirSync(root));
  const executor = getExecutor();
  const observations: { cwd: string; tag: string; proxy: boolean }[] = [];
  const args = [
    '-e',
    'setTimeout(() => process.stdout.write(JSON.stringify({ sessions: [], pageInfo: { hasNextPage: false, endCursor: null }, cwd: process.cwd(), tag: process.env.STIM_TEST_CONTEXT_TAG, proxy: !!(process.env.AGENT_DEVICE_DAEMON_BASE_URL || process.env.AGENT_DEVICE_DAEMON_AUTH_TOKEN) })), 150)',
  ];
  const observe = (stdout: string) => {
    observations.push(JSON.parse(stdout));
    return stdout;
  };
  setExecutor({
    ...executor,
    runFile: (_file, _args, options) => observe(executor.runFile(process.execPath, args, options)),
    runFileAsync: async (_file, _args, options) =>
      observe(await executor.runFileAsync(process.execPath, args, options)),
  });
  const cwd = process.cwd();
  const env = { ...process.env };
  const clients = roots.map((root, index) => context(root, String(index)));
  const reports = await Promise.all(
    clients.map((client) =>
      withAmbientContext(client, () => collectEasSessionSweep(null, { ...dependencies(), operation: client })),
    ),
  );
  expect(reports.map((report) => report.projectScope)).toEqual(roots);
  expect(observations.toSorted((a, b) => a.tag.localeCompare(b.tag))).toMatchObject([
    { cwd: roots[0], tag: '0', proxy: false },
    { cwd: roots[1], tag: '1', proxy: false },
  ]);
  expect(clients.map((client) => client.env.AGENT_DEVICE_DAEMON_AUTH_TOKEN)).toEqual([
    'fixture-token',
    'fixture-token',
  ]);
  expect(process.cwd()).toBe(cwd);
  expect(process.env).toEqual(env);
});

test('asynchronous EAS verification retains both deletion locks until the stop result and claim reconciliation', async () => {
  const root = join(home, 'app');
  mkdirSync(root);
  ensureWorkspaceStorage(root);
  const ledger = join(home, 'eas-ledger');
  await recordEasSessionClaim(
    {
      sessionId: 'drs_owned',
      name: 'stim-owned',
      platform: 'ios',
      workspaceRoot: root,
      workspaceHome: home,
      stateFile: workspaceStateFile(root),
    },
    ledger,
  );
  let started!: () => void;
  const ready = new Promise<void>((resolve) => (started = resolve));
  let finish!: () => void;
  const gate = new Promise<void>((resolve) => (finish = resolve));
  const calls: string[] = [];
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  const pending = deleteEasSessions(
    {
      projectScope: root,
      orphaned: [{ id: 'drs_owned', name: 'stim-owned', status: 'IN_PROGRESS', platform: 'ios', projectScope: root }],
      notices: [],
      deletionSafe: true,
    },
    {
      ...dependencies(root),
      runEasFile: async (_file, args) => {
        calls.push(args[0] ?? '');
        if (args[0] === 'simulator:get') {
          started();
          await gate;
          return JSON.stringify({ id: 'drs_owned', name: 'stim-owned', status: 'IN_PROGRESS' });
        }
        return JSON.stringify({ id: 'drs_owned', status: 'STOPPED' });
      },
    },
  );
  try {
    await ready;
    await expect(withEasProjectLock(root, async () => {}, { machineRoot: ledger, waitMs: 0 })).rejects.toMatchObject({
      code: 'STIM_LOCK_TIMEOUT',
    });
    await expect(withRemoteSessionLock(root, async () => {}, { waitMs: 0 })).rejects.toMatchObject({
      code: 'STIM_LOCK_TIMEOUT',
    });
    expect(readEasSessionLedger(ledger).claims.has('drs_owned')).toBe(true);
  } finally {
    finish();
    const failures = await pending;
    log.mockRestore();
    expect(failures).toBe(0);
  }
  expect(calls).toEqual(['simulator:get', 'simulator:stop']);
  expect(readEasSessionLedger(ledger).claims.size).toBe(0);
  expect(takeGcResults()).toMatchObject([{ kind: 'easSession', status: 'done', id: 'drs_owned' }]);
});

test('cancelling default EAS verification drains its child without stopping the session or dropping its claim', async () => {
  const root = join(home, 'app');
  mkdirSync(root);
  ensureWorkspaceStorage(root);
  const ledger = join(home, 'eas-ledger');
  await recordEasSessionClaim(
    {
      sessionId: 'drs_owned',
      name: 'stim-owned',
      platform: 'ios',
      workspaceRoot: root,
      workspaceHome: home,
      stateFile: workspaceStateFile(root),
    },
    ledger,
  );
  const controller = new AbortController();
  const operation = { ...context(root, 'cancel-delete'), signal: controller.signal };
  const executor = getExecutor();
  const calls: string[] = [];
  let started!: () => void;
  const ready = new Promise<void>((resolve) => (started = resolve));
  const program = (args: string[]) => {
    calls.push(args[0] ?? '');
    const result =
      args[0] === 'simulator:get'
        ? { id: 'drs_owned', name: 'stim-owned', status: 'IN_PROGRESS' }
        : { id: 'drs_owned', status: 'STOPPED' };
    return ['-e', 'setTimeout(() => process.stdout.write(process.argv[1]), 250)', JSON.stringify(result)];
  };
  setExecutor({
    ...executor,
    runFile: (_file, args, options) => executor.runFile(process.execPath, program(args), options),
    runFileAsync: (_file, args, options) =>
      executor.runFileAsync(process.execPath, program(args), {
        ...options,
        onSpawn: (spawned) => {
          child = spawned;
          options.onSpawn?.(spawned);
          started();
        },
      }),
  });
  const pending = withAmbientContext(operation, () =>
    deleteEasSessions(
      {
        projectScope: root,
        orphaned: [{ id: 'drs_owned', name: 'stim-owned', status: 'IN_PROGRESS', platform: 'ios', projectScope: root }],
        notices: [],
        deletionSafe: true,
      },
      { ...dependencies(root), operation },
    ),
  );
  try {
    await Promise.race([
      ready,
      pending.then(() => {
        throw new Error('Deletion returned before asynchronous verification started');
      }),
    ]);
    controller.abort();
    await expect(pending).rejects.toBe(controller.signal.reason);
    expect(process.platform === 'win32' ? (child?.exitCode ?? null) !== null : child?.signalCode === 'SIGKILL').toBe(
      true,
    );
    expect(calls).toEqual(['simulator:get']);
    expect(readEasSessionLedger(ledger).claims.has('drs_owned')).toBe(true);
    await withEasProjectLock(root, async () => {}, { machineRoot: ledger, waitMs: 0 });
    await withAmbientContext(operation, () => withRemoteSessionLock(root, async () => {}, { waitMs: 0 }));
  } finally {
    controller.abort();
    await pending.catch(() => {});
  }
});

test.each(['inventory', 'get', 'stop'] as const)(
  'unverifiable EAS %s cleanup retains its actual operation claims',
  async (phase) => {
    const root = join(home, 'app');
    mkdirSync(root);
    ensureWorkspaceStorage(root);
    const ledger = join(home, 'eas-ledger');
    await recordEasSessionClaim(
      {
        sessionId: 'drs_owned',
        name: 'stim-owned',
        platform: 'ios',
        workspaceRoot: root,
        workspaceHome: home,
        stateFile: workspaceStateFile(root),
      },
      ledger,
    );
    const controller = new AbortController();
    const operation = { ...context(root, 'unknown-cleanup'), signal: controller.signal };
    const executor = getExecutor();
    const original = executor.runFileAsync.bind(executor);
    let owned: { pid: number; processToken: string } | undefined;
    const targets: { pid: number; processToken: string }[] = [];
    let handles: ClaimHandle[] = [];
    let closed: Promise<void> = Promise.resolve();
    const previousExitCode = process.exitCode;
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const inspect = vi
      .spyOn(identities, 'inspectProcessIdentity')
      .mockImplementation((record) =>
        owned && record?.pid === owned.pid ? 'unknown' : inspectProcessIdentity(record),
      );
    setExecutor({
      ...executor,
      runFileAsync: (_file, args, options) => {
        if (phase === 'stop' && args[0] === 'simulator:get')
          return Promise.resolve(JSON.stringify({ id: 'drs_owned', name: 'stim-owned', status: 'IN_PROGRESS' }));
        return original(
          process.execPath,
          ['-e', 'console.log(JSON.stringify({pid:process.pid,parent:process.ppid}));setInterval(()=>{},1000)'],
          {
            ...options,
            onSpawn: (spawned) => {
              child = spawned;
              options.onSpawn?.(spawned);
              const birth = spawned.pid === undefined ? null : captureProcessIdentity(spawned.pid);
              if (spawned.pid === undefined || !birth?.ok) throw new Error('The fixture EAS child has no identity');
              owned = { pid: spawned.pid, processToken: birth.token };
              targets.push(owned);
              handles = [...operationState(operation).declaring];
              closed = new Promise<void>((resolve) => spawned.once('close', resolve));
              spawned.stdout?.once('data', (data) => {
                const metadata = JSON.parse(String(data));
                for (const pid of process.platform === 'win32' ? [metadata.pid, metadata.parent] : [metadata.pid]) {
                  if (targets.some((record) => record.pid === pid)) continue;
                  const captured = captureProcessIdentity(pid);
                  if (!captured.ok) throw new Error(captured.reason);
                  targets.push({ pid, processToken: captured.token });
                }
                controller.abort(new Error('cancel EAS cleanup'));
              });
            },
          },
        );
      },
    });
    try {
      const pending = withAmbientContext(operation, () =>
        phase === 'inventory'
          ? runGc({ delete: true, json: true }, { ...dependencies(root), operation })
          : deleteEasSessions(
              {
                projectScope: root,
                orphaned: [
                  { id: 'drs_owned', name: 'stim-owned', status: 'IN_PROGRESS', platform: 'ios', projectScope: root },
                ],
                notices: [],
                deletionSafe: true,
              },
              { ...dependencies(root), operation },
            ),
      );
      const failure = await pending.then(
        () => (phase === 'inventory' ? JSON.parse(String(log.mock.calls.at(-1)?.[0])) : null),
        (cause) => cause,
      );
      expect(failure).toMatchObject({ code: 'STIM_CLAIM_UNAVAILABLE' });
      const maintenanceRefusal =
        phase === 'inventory'
          ? await withGcMaintenanceClaim({ delete: true }, async () => {}).then(
              () => null,
              (cause) => cause,
            )
          : null;
      expect(maintenanceRefusal?.code ?? null).toBe(phase === 'inventory' ? 'STIM_CLAIM_REFUSED' : null);
      if (!owned) throw new Error('The controlled EAS command did not start');
      expect(inspectProcessIdentity(owned)).toBe('same');
      for (const handle of handles)
        expect(readClaimSet(handle.root).live).toMatchObject([{ child: { pid: owned.pid } }]);
      await expect(withEasProjectLock(root, async () => {}, { machineRoot: ledger, waitMs: 0 })).rejects.toMatchObject({
        code: 'STIM_LOCK_TIMEOUT',
      });
      await expect(withRemoteSessionLock(root, async () => {}, { waitMs: 0 })).rejects.toMatchObject({
        code: 'STIM_LOCK_TIMEOUT',
      });
      expect(readEasSessionLedger(ledger).claims.has('drs_owned')).toBe(true);
    } finally {
      inspect.mockRestore();
      controller.abort();
      for (const target of targets.toReversed())
        if (inspectProcessIdentity(target) === 'same') process.kill(target.pid, 'SIGKILL');
      await closed;
      for (const target of targets) expect(await waitForProcessExit(target, 5000)).toBe(true);
      for (const handle of handles) releaseClaim(handle);
      process.exitCode = previousExitCode;
      log.mockRestore();
      error.mockRestore();
    }
  },
);
