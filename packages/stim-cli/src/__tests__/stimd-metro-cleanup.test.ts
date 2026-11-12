import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readClaimSet } from '@stim-cli/core/ownership-claim';
import { workspaceDir, workspaceStateFile } from '../workspace/paths.ts';
import { readWorkspaceState } from '../workspace/workspace-state.ts';
import { requestDevServerStop } from '../stimd/metro/stop-cause.ts';

const fixtures = vi.hoisted(() => ({
  token: vi.fn<() => string | null>(() => 'test-token'),
  failAfterSpawn: false,
  groupAlive: true,
  answers: true,
  extraEnv: new Array<Record<string, string>>(),
  close: vi.fn<() => Promise<void>>(async () => {
    throw new Error('Could not confirm shutdown of dev-server pid 424242.');
  }),
}));

vi.mock('@stim-cli/core/ownership-claim', async (original) => {
  const claims = await original<typeof import('@stim-cli/core/ownership-claim')>();
  return {
    ...claims,
    processGroupAlive: (pid: number) => (pid === 424242 ? fixtures.groupAlive : claims.processGroupAlive(pid)),
  };
});

vi.mock('../process-identity.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../process-identity.ts')>()),
  captureProcessToken: () => fixtures.token(),
}));
vi.mock('../workspace/settings.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../workspace/settings.ts')>()),
  runnableMetroCommand: () => ['node', 'metro.js'],
}));
vi.mock('../metro.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../metro.ts')>()),
  resolveProjectMetro: async () => ({}),
}));
vi.mock('../ports.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../ports.ts')>()),
  isMetroRunning: async () => fixtures.answers,
}));
vi.mock('../stimd/metro/server-command.ts', () => ({
  startCommandServer: async ({
    spawnFn,
    extraEnv,
  }: {
    spawnFn: (cmd: string, args: string[], options: object) => unknown;
    extraEnv: Record<string, string>;
  }) => {
    fixtures.extraEnv.push(extraEnv);
    if (fixtures.failAfterSpawn) {
      spawnFn('fixture', [], {});
      throw new Error('startup failed after spawn');
    }
    return {
      serverPid: 424242,
      processToken: fixtures.token(),
      child: { exitCode: null, signalCode: null, unref() {} },
      tail: null,
      onExit() {},
      close: fixtures.close,
    };
  },
}));
vi.mock('../engine/tunnel.ts', () => ({
  startTunnel: async () => ({ failed: true, reason: 'unused' }),
  startTunnelSequence: async () => ({ failed: true, cleanupFailed: true, reason: 'tunnel child remains alive' }),
}));

import {
  closeMetroChildren,
  ensureMetro,
  ensureTunnel,
  metroTick,
  openMetroChildren,
  stopManagedMetro,
} from '../stimd/metro/children.ts';
import { getExecutor } from '../exec.ts';
import { makeChildProcess } from './_factories.ts';

let dir: string;
let root: string;
let previousHome: string | undefined;
const log = () => {};

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'stim-metro-cleanup-'));
  mkdirSync(join(dir, 'project'));
  root = realpathSync(join(dir, 'project'));
  previousHome = process.env.STIM_HOME;
  process.env.STIM_HOME = join(dir, 'home');
  fixtures.token.mockReturnValue('test-token');
  fixtures.failAfterSpawn = false;
  fixtures.groupAlive = true;
  fixtures.answers = true;
  fixtures.close.mockClear();
  fixtures.extraEnv = [];
  openMetroChildren();
});

afterEach(() => {
  if (previousHome === undefined) delete process.env.STIM_HOME;
  else process.env.STIM_HOME = previousHome;
  rmSync(dir, { recursive: true, force: true });
});

test.skipIf(process.platform === 'win32')(
  'failed Metro stop retains its record and claim through the barrier',
  async () => {
    expect(await ensureMetro({ root, port: 8181 }, log)).toMatchObject({ op: 'metro' });
    const record = readFileSync(workspaceStateFile(root), 'utf8');
    const failure = await ensureMetro({ root, port: 8182 }, log);
    expect(failure).toMatchObject({ op: 'error', code: 'STIM_CLAIM_UNAVAILABLE' });
    expect(readClaimSet(join(workspaceDir(root), 'metro.claim')).live).toMatchObject([{ childDeclared: true }]);
    expect(readFileSync(workspaceStateFile(root), 'utf8')).toBe(record);
    await metroTick('on', log);
    await expect(closeMetroChildren()).rejects.toMatchObject({ code: 'STIM_CLAIM_UNAVAILABLE', reportCleanup: true });
    expect(fixtures.close).toHaveBeenCalledOnce();
  },
);

test.skipIf(process.platform === 'win32')(
  'an operation that ends after the readiness deadline still stops a Metro that never answered',
  async () => {
    fixtures.answers = false;
    fixtures.close.mockResolvedValueOnce();
    const operation = new AbortController();
    const started = ensureMetro({ root, port: 8181 }, log, undefined, operation.signal);
    await vi.advanceTimersByTimeAsync(121_000);
    await expect(started).resolves.toMatchObject({ op: 'metro', state: 'starting' });
    expect(fixtures.close).not.toHaveBeenCalled();
    fixtures.groupAlive = false;
    operation.abort();
    await vi.waitFor(() => expect(fixtures.close).toHaveBeenCalledOnce());
    await closeMetroChildren();
  },
);

test.skipIf(process.platform === 'win32')(
  'managed stop checks the child identity and waits for verified close',
  async () => {
    let finish = () => {};
    fixtures.close.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    expect(await ensureMetro({ root, port: 8181 }, log)).toMatchObject({ op: 'metro' });
    expect(await stopManagedMetro({ root, pid: 424243, processToken: 'test-token' }, log)).toMatchObject({
      op: 'error',
      code: 'metro-changed',
    });
    expect(fixtures.close).not.toHaveBeenCalled();
    const stopping = stopManagedMetro({ root, pid: 424242, processToken: 'test-token' }, log);
    await vi.waitFor(() => expect(fixtures.close).toHaveBeenCalledOnce());
    expect(readClaimSet(join(workspaceDir(root), 'metro.claim')).live).toHaveLength(1);
    finish();
    await expect(stopping).resolves.toMatchObject({ op: 'metro.stopped', state: 'stopped' });
    expect(readClaimSet(join(workspaceDir(root), 'metro.claim')).live).toEqual([]);
    await expect(stopManagedMetro({ root, pid: 424242, processToken: 'test-token' }, log)).resolves.toMatchObject({
      op: 'metro.stopped',
      state: 'not-owned',
    });
  },
);

test('failed startup with unreadable identity retains the pending claim', async () => {
  fixtures.token.mockReturnValue(null);
  expect(await ensureMetro({ root, port: 8183 }, log)).toMatchObject({ op: 'error', code: 'STIM_CLAIM_UNAVAILABLE' });
  expect(readClaimSet(join(workspaceDir(root), 'metro.claim')).live).toMatchObject([{ childDeclared: true }]);
  await expect(closeMetroChildren()).rejects.toMatchObject({ code: 'STIM_CLAIM_UNAVAILABLE', reportCleanup: true });
});

test.skipIf(process.platform === 'win32')(
  'a missing-token startup with no remaining group releases its claim',
  async () => {
    fixtures.token.mockReturnValue(null);
    fixtures.groupAlive = false;
    fixtures.close.mockResolvedValueOnce();
    expect(await ensureMetro({ root, port: 8183 }, log)).toMatchObject({ op: 'error', code: 'metro-start' });
    expect(readClaimSet(join(workspaceDir(root), 'metro.claim')).live).toEqual([]);
    await expect(closeMetroChildren()).resolves.toBeUndefined();
  },
);

test('startup failure after spawning retains the pending claim', async () => {
  fixtures.failAfterSpawn = true;
  const spawn = vi.spyOn(getExecutor(), 'spawn').mockReturnValue(makeChildProcess({ pid: 424242 }));
  try {
    expect(await ensureMetro({ root, port: 8185 }, log)).toMatchObject({ op: 'error', code: 'STIM_CLAIM_UNAVAILABLE' });
    expect(readClaimSet(join(workspaceDir(root), 'metro.claim')).live).toMatchObject([{ childDeclared: true }]);
    await expect(closeMetroChildren()).rejects.toMatchObject({ code: 'STIM_CLAIM_UNAVAILABLE', reportCleanup: true });
  } finally {
    spawn.mockRestore();
  }
});

test('failed tunnel startup keeps the unverified claim', async () => {
  vi.spyOn(getExecutor(), 'findExecutable').mockReturnValue('/usr/bin/cloudflared');
  expect(await ensureTunnel({ root, port: 8184, mode: 'cloudflared' }, log)).toMatchObject({
    op: 'error',
    code: 'STIM_CLAIM_UNAVAILABLE',
  });
  expect(readClaimSet(join(workspaceDir(root), 'tunnel.claim')).live).toMatchObject([{ childDeclared: true }]);
  await expect(closeMetroChildren()).rejects.toMatchObject({ code: 'STIM_CLAIM_UNAVAILABLE', reportCleanup: true });
});

test.skipIf(process.platform === 'win32')(
  "a managed tunnel's origin reaches the dev server and stays in its claim for a restart, and a cache reset does not",
  async () => {
    const origin = 'https://ready.ngrok.app';
    expect(await ensureMetro({ root, port: 8186, publicOrigin: origin, resetCache: true }, log)).toMatchObject({
      op: 'metro',
    });
    expect(fixtures.extraEnv).toEqual([
      expect.objectContaining({ STIM_METRO_PUBLIC_URL: origin, EXPO_PACKAGER_PROXY_URL: origin }),
    ]);
    const [claim] = readClaimSet(join(workspaceDir(root), 'metro.claim')).live;
    expect(claim?.details).toMatchObject({ publicOrigin: origin, tunnel: false });
    expect(claim?.details).not.toHaveProperty('resetCache');
  },
);

test.skipIf(process.platform === 'win32')(
  "a command's stop request becomes the recorded stop cause and is cleared with the dev server",
  async () => {
    fixtures.close.mockResolvedValueOnce();
    expect(await ensureMetro({ root, port: 8187 }, log)).toMatchObject({ op: 'metro' });
    requestDevServerStop(root, 'test-token', { by: 'stim stop' });
    expect(await stopManagedMetro({ root, pid: 424242, processToken: 'test-token' }, log)).toMatchObject({
      state: 'stopped',
    });
    const state = readWorkspaceState(root);
    expect(state?.devServerStop).toMatchObject({ reason: 'requested', by: 'stim stop' });
    expect(state).not.toHaveProperty('devServerStopRequest');
    expect(state).not.toHaveProperty('supervisor');
  },
);
