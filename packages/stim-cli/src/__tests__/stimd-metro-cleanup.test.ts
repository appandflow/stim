import { existsSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ChildProcess } from 'node:child_process';
import { readClaimSet } from '@stim-cli/core/ownership-claim';
import { workspaceDir, workspaceLogsDir, workspaceStateFile } from '../workspace/paths.ts';
import { readWorkspaceState } from '../workspace/workspace-state.ts';
import { requestDevServerStop } from '../stimd/metro/stop-cause.ts';

const HELPER = 515151;
const SERVER = 424242;

const fixtures = vi.hoisted(() => ({
  token: vi.fn<() => string | null>(() => 'test-token'),
  groupAlive: true,
  answers: true,
  helper: 'same' as 'same' | 'gone' | 'different' | 'unknown',
  helperReads: new Array<'same' | 'gone' | 'different' | 'unknown'>(),
  report: 'registered' as 'registered' | 'failed' | 'killed',
  extraEnv: new Array<Record<string, string>>(),
  kills: new Array<string>(),
  onTerm: () => {},
}));

vi.mock('@stim-cli/core/ownership-claim', async (original) => {
  const claims = await original<typeof import('@stim-cli/core/ownership-claim')>();
  return {
    ...claims,
    processGroupAlive: (pid: number) => (pid === 424242 ? fixtures.groupAlive : claims.processGroupAlive(pid)),
  };
});

vi.mock('../process-identity.ts', async (importOriginal) => {
  const real = await importOriginal<typeof import('../process-identity.ts')>();
  return {
    ...real,
    captureProcessToken: () => fixtures.token(),
    inspectProcessIdentity: (record: Parameters<typeof real.inspectProcessIdentity>[0]) =>
      record?.pid === 515151
        ? (fixtures.helperReads.shift() ?? fixtures.helper)
        : record?.pid === 424242
          ? 'same'
          : real.inspectProcessIdentity(record),
  };
});
vi.mock('../workspace/settings.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../workspace/settings.ts')>()),
  runnableMetroCommand: () => ['node', 'metro.js'],
}));
vi.mock('../metro.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../metro.ts')>()),
  resolveProjectMetro: async () => ({}),
  signalProcessTree: () => true,
}));
vi.mock('../ports.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../ports.ts')>()),
  isMetroRunning: async () => fixtures.answers,
}));
vi.mock('../stimd/metro/server-command.ts', () => ({
  commandServerLaunch: ({ extraEnv }: { extraEnv: Record<string, string> }) => {
    fixtures.extraEnv.push(extraEnv);
    return { command: 'node', args: ['metro.js'], env: {}, observesRequests: false };
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

/** A helper that reports its dev server, reports that none runs, or is killed before it reports. */
function fakeHelper(): ChildProcess {
  const child = makeChildProcess({ pid: HELPER });
  const end = (code: number | null, signal: NodeJS.Signals | null) => {
    Object.assign(child, { exitCode: code, signalCode: signal });
    child.emit('exit', code, signal);
  };
  queueMicrotask(() => {
    if (fixtures.report === 'registered')
      child.emit('message', { type: 'registered', pid: SERVER, processToken: 'test-token' });
    else if (fixtures.report === 'failed') {
      child.emit('message', { type: 'failed', message: 'spawn metro.js ENOENT' });
      end(1, null);
    } else end(null, 'SIGKILL');
  });
  return child;
}

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
  fixtures.groupAlive = true;
  fixtures.answers = true;
  fixtures.helper = 'same';
  fixtures.helperReads = [];
  fixtures.report = 'registered';
  fixtures.extraEnv = [];
  fixtures.kills = [];
  fixtures.onTerm = () => {
    fixtures.helper = 'gone';
    fixtures.groupAlive = false;
  };
  const kill = process.kill.bind(process);
  vi.spyOn(process, 'kill').mockImplementation((pid, signal) => {
    if (pid !== HELPER) return kill(pid, signal);
    fixtures.kills.push(String(signal));
    if (signal === 'SIGTERM') fixtures.onTerm();
    return true;
  });
  vi.spyOn(getExecutor(), 'spawn').mockImplementation(fakeHelper);
  openMetroChildren();
});

afterEach(() => {
  vi.restoreAllMocks();
  if (previousHome === undefined) delete process.env.STIM_HOME;
  else process.env.STIM_HOME = previousHome;
  rmSync(dir, { recursive: true, force: true });
});

const claims = () => readClaimSet(join(workspaceDir(root), 'metro.claim'));

test.skipIf(process.platform === 'win32')(
  'failed Metro stop retains its record and claim through the barrier',
  async () => {
    fixtures.onTerm = () => {};
    expect(await ensureMetro({ root, port: 8181 }, log)).toMatchObject({ op: 'metro' });
    const record = readFileSync(workspaceStateFile(root), 'utf8');
    const failing = ensureMetro({ root, port: 8182 }, log);
    const progress = { settled: false };
    void failing.finally(() => (progress.settled = true));
    for (let step = 0; step < 300 && !progress.settled; step++) await vi.advanceTimersByTimeAsync(100);
    expect(await failing).toMatchObject({
      op: 'error',
      code: 'STIM_CLAIM_UNAVAILABLE',
      remedy: expect.stringMatching(/pgrep -g 424242.*kill -TERM -424242/),
    });
    expect(claims().live).toMatchObject([{ childDeclared: true, child: { pid: SERVER } }]);
    expect(readFileSync(workspaceStateFile(root), 'utf8')).toBe(record);
    await metroTick('on', log);
    await expect(closeMetroChildren()).rejects.toMatchObject({ code: 'STIM_CLAIM_UNAVAILABLE', reportCleanup: true });
    expect(fixtures.kills).toEqual(['SIGTERM']);
  },
);

test.skipIf(process.platform === 'win32')(
  'an operation that ends after the readiness deadline still stops a Metro that never answered',
  async () => {
    fixtures.answers = false;
    const operation = new AbortController();
    const started = ensureMetro({ root, port: 8181 }, log, undefined, operation.signal);
    await vi.advanceTimersByTimeAsync(121_000);
    await expect(started).resolves.toMatchObject({ op: 'metro', state: 'starting' });
    expect(fixtures.kills).toEqual([]);
    operation.abort();
    await vi.waitFor(async () => {
      await vi.advanceTimersByTimeAsync(100);
      expect(fixtures.kills).toEqual(['SIGTERM']);
    });
    await closeMetroChildren();
  },
);

test.skipIf(process.platform === 'win32')(
  'managed stop checks the child identity and waits for the helper to end',
  async () => {
    let finish = () => {};
    fixtures.onTerm = () => {
      finish = () => {
        fixtures.helper = 'gone';
        fixtures.groupAlive = false;
      };
    };
    expect(await ensureMetro({ root, port: 8181 }, log)).toMatchObject({ op: 'metro' });
    expect(await stopManagedMetro({ root, pid: 424243, processToken: 'test-token' }, log)).toMatchObject({
      op: 'error',
      code: 'metro-changed',
    });
    expect(fixtures.kills).toEqual([]);
    const stopping = stopManagedMetro({ root, pid: SERVER, processToken: 'test-token' }, log);
    await vi.waitFor(() => expect(fixtures.kills).toEqual(['SIGTERM']));
    await vi.advanceTimersByTimeAsync(1000);
    expect(claims().live).toHaveLength(1);
    finish();
    await vi.advanceTimersByTimeAsync(100);
    await expect(stopping).resolves.toMatchObject({ op: 'metro.stopped', state: 'stopped' });
    expect(claims().live).toEqual([]);
    await expect(stopManagedMetro({ root, pid: SERVER, processToken: 'test-token' }, log)).resolves.toMatchObject({
      op: 'metro.stopped',
      state: 'not-owned',
    });
  },
);

test.skipIf(process.platform === 'win32')(
  'a helper killed before it reports leaves the claim pending, and start and stop name the port and the claim',
  async () => {
    fixtures.report = 'killed';
    const claimPath = () => claims().live[0]?.path;
    const refusal = {
      op: 'error',
      code: 'STIM_CLAIM_UNAVAILABLE',
      message: expect.stringContaining(`helper pid ${HELPER} ended before it reported`),
      remedy: expect.stringMatching(/lsof -nP -iTCP:8183 -sTCP:LISTEN.*rm -f /),
    };
    expect(await ensureMetro({ root, port: 8183 }, log)).toMatchObject(refusal);
    expect(claims().live).toMatchObject([{ childDeclared: true, child: null }]);
    const path = claimPath();
    expect(await ensureMetro({ root, port: 8183 }, log)).toMatchObject(refusal);
    expect(await stopManagedMetro({ root, pid: SERVER, processToken: 'test-token' }, log)).toMatchObject(refusal);
    fixtures.report = 'registered';
    rmSync(String(path), { force: true });
    rmSync(`${String(path).replace(/\.claim$/, '')}.child`, { force: true });
    expect(existsSync(String(path))).toBe(false);
    expect(await ensureMetro({ root, port: 8183 }, log)).toMatchObject({ op: 'metro', state: 'started' });
    await closeMetroChildren();
  },
);

test.skipIf(process.platform === 'win32')(
  'a stop signals the helper only while its identity reads same, and refuses when it cannot be read',
  async () => {
    expect(await ensureMetro({ root, port: 8181 }, log)).toMatchObject({ op: 'metro' });
    fixtures.groupAlive = false;
    fixtures.helperReads = ['same', 'same'];
    fixtures.helper = 'different';
    expect(await stopManagedMetro({ root, pid: SERVER, processToken: 'test-token' }, log)).toMatchObject({
      state: 'stopped',
    });
    expect(fixtures.kills).toEqual([]);

    fixtures.groupAlive = true;
    fixtures.helper = 'same';
    expect(await ensureMetro({ root, port: 8182 }, log)).toMatchObject({ op: 'metro' });
    fixtures.helper = 'unknown';
    expect(await stopManagedMetro({ root, pid: SERVER, processToken: 'test-token' }, log)).toMatchObject({
      op: 'error',
      code: 'STIM_CLAIM_UNAVAILABLE',
    });
    expect(fixtures.kills).toEqual([]);
    await expect(closeMetroChildren()).rejects.toMatchObject({ code: 'STIM_CLAIM_UNAVAILABLE', reportCleanup: true });
  },
);

test.skipIf(process.platform === 'win32')(
  'a helper that ends without an exit file leaves the end of its own log in metro.ndjson',
  async () => {
    expect(await ensureMetro({ root, port: 8181 }, log)).toMatchObject({ op: 'metro' });
    writeFileSync(join(workspaceLogsDir(root), 'metro-run.log'), 'noise\nFATAL helper crash 5580\n');
    fixtures.helper = 'gone';
    fixtures.groupAlive = false;
    await metroTick('on', log);
    const lines = readFileSync(join(workspaceLogsDir(root), 'metro.ndjson'), 'utf8');
    expect(lines).toMatch(/ended without recording[^\n]*FATAL helper crash 5580/);
    expect(claims().live).toEqual([]);
  },
);

test('a helper that reports no dev server releases its claim', async () => {
  fixtures.report = 'failed';
  expect(await ensureMetro({ root, port: 8183 }, log)).toMatchObject({
    op: 'error',
    code: 'metro-start',
    message: expect.stringContaining('ENOENT'),
  });
  expect(claims().live).toEqual([]);
  await expect(closeMetroChildren()).resolves.toBeUndefined();
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
    expect(await ensureMetro({ root, port: 8187 }, log)).toMatchObject({ op: 'metro' });
    requestDevServerStop(root, 'test-token', { by: 'stim stop' });
    expect(await stopManagedMetro({ root, pid: SERVER, processToken: 'test-token' }, log)).toMatchObject({
      state: 'stopped',
    });
    const state = readWorkspaceState(root);
    expect(state?.devServerStop).toMatchObject({ reason: 'requested', by: 'stim stop' });
    expect(state).not.toHaveProperty('devServerStopRequest');
    expect(state).not.toHaveProperty('supervisor');
  },
);
