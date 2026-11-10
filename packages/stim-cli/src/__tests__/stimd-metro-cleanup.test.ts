import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readClaimSet } from '@stim-cli/core/ownership-claim';
import { workspaceDir, workspaceStateFile } from '../workspace/paths.ts';

const fixtures = vi.hoisted(() => ({
  token: vi.fn<() => string | null>(() => 'test-token'),
  failAfterSpawn: false,
  groupAlive: true,
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
  isMetroRunning: async () => true,
}));
vi.mock('../stimd/metro/server-command.ts', () => ({
  startCommandServer: async ({ spawnFn }: { spawnFn: (cmd: string, args: string[], options: object) => unknown }) => {
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
  startTunnel: async () => ({ failed: true, cleanupFailed: true, reason: 'tunnel child remains alive' }),
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
  fixtures.close.mockClear();
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
    await metroTick(true, log);
    await expect(closeMetroChildren()).rejects.toMatchObject({ code: 'STIM_CLAIM_UNAVAILABLE', reportCleanup: true });
    expect(fixtures.close).toHaveBeenCalledOnce();
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
    expect(await stopManagedMetro({ root, pid: 424243, processToken: 'test-token' })).toMatchObject({
      op: 'error',
      code: 'metro-changed',
    });
    expect(fixtures.close).not.toHaveBeenCalled();
    const stopping = stopManagedMetro({ root, pid: 424242, processToken: 'test-token' });
    await vi.waitFor(() => expect(fixtures.close).toHaveBeenCalledOnce());
    expect(readClaimSet(join(workspaceDir(root), 'metro.claim')).live).toHaveLength(1);
    finish();
    await expect(stopping).resolves.toMatchObject({ op: 'metro.stopped', state: 'stopped' });
    expect(readClaimSet(join(workspaceDir(root), 'metro.claim')).live).toEqual([]);
    await expect(stopManagedMetro({ root, pid: 424242, processToken: 'test-token' })).resolves.toMatchObject({
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
  expect(await ensureTunnel({ root, port: 8184, provider: 'cloudflared' })).toMatchObject({
    op: 'error',
    code: 'STIM_CLAIM_UNAVAILABLE',
  });
  expect(readClaimSet(join(workspaceDir(root), 'tunnel.claim')).live).toMatchObject([{ childDeclared: true }]);
  await expect(closeMetroChildren()).rejects.toMatchObject({ code: 'STIM_CLAIM_UNAVAILABLE', reportCleanup: true });
});
