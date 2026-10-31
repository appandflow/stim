import {
  startTunnel,
  startTunnelSequence,
  stopTunnel,
  parseNgrokLine,
  terminateChild,
  type TunnelRecord,
} from '../engine/tunnel.ts';
import { getExecutor, resetExecutor, setExecutor } from '../exec.ts';
import {
  processGroupAlive,
  readClaimSet,
  releaseClaim,
  tryAcquireClaim,
  type ClaimHandle,
} from '../ownership-claim.ts';
import { writeWorkspaceState } from '../workspace/workspace-state.ts';
import { readMetroTunnel } from '../supervisor/state.ts';
import assert from 'node:assert';
import type { ChildProcess } from 'node:child_process';
import { resolve4 } from 'node:dns/promises';
import { EventEmitter, once } from 'node:events';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  renameSync,
  rmSync,
  writeFileSync,
  type PathLike,
  type WatchListener,
} from 'node:fs';
import type { ClientRequest, IncomingMessage } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { vi } from 'vitest';
import { IMPOSSIBLE_PID, makeChildProcess } from './_factories.ts';

vi.mock('node:dns/promises', () => ({ resolve4: vi.fn<typeof resolve4>() }));
vi.mock('node:https', () => ({ request: vi.fn<typeof httpsRequest>() }));
const watcher = vi.hoisted(() => ({ unavailable: false }));
vi.mock('node:fs', async (importOriginal) => {
  const fs = await importOriginal<typeof import('node:fs')>();
  return {
    ...fs,
    watch: (file: PathLike, listener: WatchListener<string>) => {
      if (watcher.unavailable) throw Object.assign(new Error('watch unavailable'), { code: 'ENOSYS' });
      return fs.watch(file, listener);
    },
  };
});

afterEach(() => {
  resetExecutor();
  vi.unstubAllGlobals();
  vi.mocked(resolve4).mockReset();
  vi.mocked(httpsRequest).mockReset();
  watcher.unavailable = false;
});

function clock(start = 1_000) {
  let t = start;
  return { now: () => t, sleep: async (ms: number) => void (t += ms) };
}

const successfulTunnelCleanup = async () => ({ status: 'stopped' as const });

function startVerified(options: Parameters<typeof startTunnel>[0]) {
  return startTunnel({ isChildAlive: () => false, ...options, readProcessToken: () => 'linux:100' });
}

describe('parseNgrokLine', () => {
  test('a JSON line that is not an object (a bare array or scalar) is not a match', () => {
    expect(parseNgrokLine('42')).toBeNull();
    expect(parseNgrokLine('[1,2,3]')).toBeNull();
  });
});

describe('startTunnel: the happy path', () => {
  test.each(['tailscale', '/Applications/Tailscale.app/Contents/MacOS/Tailscale'])(
    'tailscale resolves %s and reads piped output without creating a log file',
    async (binary) => {
      const resolvedBinary = binary === 'tailscale' ? '/usr/local/bin/tailscale' : binary;
      const home = mkdtempSync(join(tmpdir(), 'stim-tailscale-test-'));
      const previousHome = process.env.STIM_HOME;
      process.env.STIM_HOME = home;
      const child = makeChildProcess();
      const spawn = vi.fn<NonNullable<Parameters<typeof startTunnel>[0]['spawnFn']>>(() => child);
      const probe = vi.fn<(url: string, signal: AbortSignal) => Promise<boolean>>(async () => false);
      setExecutor({
        findExecutable: (bin: string) => (bin === binary ? resolvedBinary : null),
        spawn,
        runFileQuiet: () => '',
      });
      try {
        const promise = startVerified({
          provider: 'tailscale',
          port: 8081,
          requireReachable: false,
          probeReachable: probe,
        });
        child.stdout?.emit(
          'data',
          'Available within your tailnet:\n\nhttps://host.tail123.ts.net:8081/\n|-- proxy http://127.0.0.1:8081\n',
        );
        const result = await promise;
        expect(result).toMatchObject({ url: 'https://host.tail123.ts.net:8081/', pid: IMPOSSIBLE_PID, logFile: null });
        expect(spawn).toHaveBeenCalledExactlyOnceWith(
          resolvedBinary,
          ['serve', '--https=8081', 'http://127.0.0.1:8081'],
          {
            stdio: ['ignore', 'pipe', 'pipe'],
            detached: true,
          },
        );
        expect(existsSync(join(home, 'tunnel-logs'))).toBe(false);
        expect(probe).not.toHaveBeenCalled();
        assert(!('failed' in result));
        const root = join(home, 'project');
        mkdirSync(root);
        const record = {
          kind: 'managed' as const,
          provider: 'tailscale' as const,
          pid: result.pid,
          processToken: result.processToken,
          url: result.url,
          port: 8081,
          startedAt: 'T',
        };
        writeWorkspaceState(root, { metroTunnel: { ...record, logFile: result.logFile } });
        expect(readMetroTunnel(root)).toEqual(record);
        await expect(result.cleanup()).resolves.toEqual({ status: 'stopped' });
      } finally {
        if (previousHome === undefined) delete process.env.STIM_HOME;
        else process.env.STIM_HOME = previousHome;
        rmSync(home, { recursive: true, force: true });
      }
    },
  );
  test('cloudflared checks HTTPS through a fresh DNS answer when system lookup is stale', async () => {
    const child = makeChildProcess();
    const fetchError = new TypeError('fetch failed', {
      cause: Object.assign(new Error('lookup failed'), { code: 'ENOTFOUND' }),
    });
    vi.stubGlobal('fetch', vi.fn<typeof fetch>().mockRejectedValue(fetchError));
    vi.mocked(resolve4).mockResolvedValue(['203.0.113.1', '203.0.113.2']);
    const response = { statusCode: 200, resume: vi.fn<() => void>() } as unknown as IncomingMessage;
    vi.mocked(httpsRequest).mockImplementation((...args: unknown[]) => {
      const callback = args[2] as (response: IncomingMessage) => void;
      const request = new EventEmitter() as EventEmitter & { end: () => void };
      request.end = () => callback(response);
      return request as ClientRequest;
    });

    const promise = startVerified({ provider: 'cloudflared', port: 8081, spawnFn: () => child });
    child.stderr?.emit('data', 'https://random-words.trycloudflare.com\n');
    await expect(promise).resolves.toMatchObject({ url: 'https://random-words.trycloudflare.com' });
    expect(resolve4).toHaveBeenCalledWith('random-words.trycloudflare.com');
    expect(response.resume).toHaveBeenCalled();

    const [url, options] = vi.mocked(httpsRequest).mock.calls[0] as unknown as [string, { lookup: Function }];
    expect(url).toBe('https://random-words.trycloudflare.com');
    const all = vi.fn<(error: unknown, addresses: unknown) => void>();
    Reflect.apply(options.lookup, null, ['random-words.trycloudflare.com', { all: true }, all]);
    expect(all).toHaveBeenCalledWith(null, [
      { address: '203.0.113.1', family: 4 },
      { address: '203.0.113.2', family: 4 },
    ]);
    const one = vi.fn<(error: unknown, address: string, family: number) => void>();
    Reflect.apply(options.lookup, null, ['random-words.trycloudflare.com', { all: false }, one]);
    expect(one).toHaveBeenCalledWith(null, '203.0.113.1', 4);
  });

  test('does not record a PID reused after spawn with a different process token', async () => {
    let token = 'linux:100';
    const signals: Array<NodeJS.Signals | number | undefined> = [];
    const child = makeChildProcess({
      kill(signal) {
        signals.push(signal);
        return true;
      },
    });
    const promise = startTunnel({
      provider: 'ngrok',
      port: 8081,
      spawnFn: () => child,
      probeReachable: async () => true,
      readProcessToken: () => token,
      isChildAlive: () => true,
      cleanupTimeoutMs: 1,
    });
    child.stdout?.emit('data', `${JSON.stringify({ url: 'https://replacement.ngrok.app' })}\n`);
    token = 'linux:200';
    child.emit('exit', 0, null);

    await expect(promise).resolves.toEqual({
      failed: true,
      reason: expect.stringContaining('process identity changed'),
    });
    expect(signals).toEqual([]);
  });

  test('does not record a replacement after the retained child exits with the same process token', async () => {
    const signals: Array<NodeJS.Signals | number | undefined> = [];
    const child = makeChildProcess({
      kill(signal) {
        signals.push(signal);
        return true;
      },
    });
    const promise = startTunnel({
      provider: 'ngrok',
      port: 8081,
      spawnFn: () => child,
      probeReachable: async () => true,
      readProcessToken: () => 'ps-lstart:Fri Aug 28 06:00:00 2026',
      isChildAlive: () => true,
      cleanupTimeoutMs: 1,
    });
    child.stdout?.emit('data', `${JSON.stringify({ url: 'https://replacement.ngrok.app' })}\n`);
    child.emit('exit', 0, null);

    await expect(promise).resolves.toEqual({
      failed: true,
      reason: expect.stringContaining('exited before its tunnel could be recorded'),
    });
    expect(signals).toEqual([]);
  });
});

describe('startTunnel: nothing here throws -- every failure is a returned value', () => {
  test('reads a URL from atomic log replacements without a polling tick', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'stim-tunnel-watch-test-'));
    const logFile = join(dir, 'ngrok.log');
    writeFileSync(logFile, '');
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    let writing: NodeJS.Timeout | undefined;
    try {
      const promise = startVerified({
        provider: 'ngrok',
        port: 8081,
        logFile,
        spawnFn: () => makeChildProcess(),
        urlTimeoutMs: 2000,
        requireReachable: false,
      });
      const replacement = join(dir, 'replacement.log');
      const replace = () => {
        writeFileSync(replacement, `${JSON.stringify({ url: 'https://watched.ngrok.app' })}\n`);
        renameSync(replacement, logFile);
        writing = setTimeout(replace, 100);
      };
      replace();
      const result = await promise;
      expect(result).toMatchObject({ url: 'https://watched.ngrok.app' });
      if ('cleanup' in result) await result.cleanup();
    } finally {
      clearTimeout(writing);
      vi.useRealTimers();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('exiting before printing a URL is a failure, not a hang', async () => {
    let killed = false;
    const child = makeChildProcess({
      kill() {
        killed = true;
        return true;
      },
    });
    const promise = startVerified({ provider: 'cloudflared', port: 8081, spawnFn: () => child });
    child.emit('exit', 1, null);
    const result = await promise;
    expect(result).toEqual({ failed: true, reason: expect.stringContaining('exited before printing') });
    expect(killed).toBe(false);
  });

  test('does not fall back when SIGKILL cannot confirm child exit', async () => {
    const providers: string[] = [];
    const child = makeChildProcess({ kill: () => true });

    const result = await startTunnelSequence({
      providers: ['ngrok', 'cloudflared'],
      port: 8081,
      start: async ({ provider }) => {
        providers.push(provider);
        if (provider === 'cloudflared') {
          return {
            url: 'https://fallback.trycloudflare.com',
            pid: 4243,
            processToken: 'linux:100',
            cleanup: successfulTunnelCleanup,
          };
        }
        return startVerified({
          provider,
          port: 8081,
          spawnFn: () => child,
          urlTimeoutMs: 1,
          cleanupTimeoutMs: 1,
          isChildAlive: () => true,
        } as Parameters<typeof startTunnel>[0]);
      },
    });

    expect(providers).toEqual(['ngrok']);
    expect(result).toEqual({ failed: true, reason: expect.stringContaining('could not confirm'), cleanupFailed: true });
  });

  test('a URL that never becomes reachable fails on the INJECTED clock, not a real one', async () => {
    const c = clock();
    const child = makeChildProcess();
    const promise = startVerified({
      provider: 'cloudflared',
      port: 8081,
      spawnFn: () => child,
      probeReachable: async () => false,
      reachableTimeoutMs: 5_000,
      now: c.now,
      sleep: c.sleep,
    });
    child.stderr?.emit('data', 'https://x.trycloudflare.com\n');
    const result = await promise;
    expect(result).toEqual({
      failed: true,
      reason: expect.stringContaining('did not become reachable'),
    });
  });

  test('a process whose start token cannot be captured is cleaned up and not returned as owned', async () => {
    const signals: Array<NodeJS.Signals | number | undefined> = [];
    const child = makeChildProcess({
      kill(signal) {
        signals.push(signal);
        child.emit('exit', null, signal);
        return true;
      },
    });
    const promise = startTunnel({
      provider: 'ngrok',
      port: 8081,
      spawnFn: () => child,
      probeReachable: async () => true,
      readProcessToken: () => null,
    });
    child.stdout?.emit('data', `${JSON.stringify({ url: 'https://x.ngrok-free.app' })}\n`);
    const result = await promise;
    expect(result).toEqual({ failed: true, reason: expect.stringContaining('process identity token') });
    expect(signals).toEqual(['SIGTERM']);
  });
});

function fixtureRecord(overrides: Partial<TunnelRecord> = {}): TunnelRecord {
  return {
    provider: 'cloudflared',
    pid: 4242,
    url: 'https://x.trycloudflare.com',
    port: 8081,
    startedAt: new Date(0).toISOString(),
    processToken: 'linux:100',
    ...overrides,
  };
}

function stopVerified(record: TunnelRecord, options: Parameters<typeof stopTunnel>[1] = {}) {
  return stopTunnel(record, { inspectIdentity: () => 'same', ...options });
}

describe('stopTunnel: idempotent, never throws', () => {
  test('a legacy record without a process token fails closed and is not signalled', async () => {
    const signalled: number[] = [];
    const record = fixtureRecord();
    delete (record as Partial<TunnelRecord>).processToken;
    const result = await stopTunnel(record, {
      isAlive: () => true,
      kill: (pid) => signalled.push(pid),
    });
    expect(signalled).toEqual([]);
    expect(result).toEqual({ status: 'failed', reason: expect.stringMatching(/process identity token.*retry/i) });
  });

  test('on win32 the default kill reaches the tree, because a shim on PATH runs the real tunnel as a child', async () => {
    const taskkill: string[][] = [];
    let alive = true;
    setExecutor({
      runFileQuiet: (file: string, args: string[]) => {
        taskkill.push([file, ...args]);
        alive = false;
        return '';
      },
    });
    try {
      const result = await stopVerified(fixtureRecord(), { isAlive: () => alive, platform: 'win32' });
      expect(result.status).toBe('stopped');
      expect(taskkill).toEqual([['taskkill', '/PID', '4242', '/T', '/F']]);
    } finally {
      resetExecutor();
    }
  });

  test("a kill racing the process's own exit (ESRCH) reads as missing, not failed", async () => {
    const previousHome = process.env.STIM_HOME;
    const home = mkdtempSync(join(tmpdir(), 'stim-tunnel-stop-test-'));
    const logFile = join(home, 'tunnel-logs', 'cloudflared.log');
    mkdirSync(join(home, 'tunnel-logs'));
    writeFileSync(logFile, '');
    process.env.STIM_HOME = home;
    try {
      const result = await stopVerified(fixtureRecord({ logFile }), {
        isAlive: () => true,
        kill: () => {
          throw Object.assign(new Error('no such process'), { code: 'ESRCH' });
        },
      });
      expect(result).toEqual({ status: 'missing' });
      expect(existsSync(logFile)).toBe(false);
    } finally {
      if (previousHome === undefined) delete process.env.STIM_HOME;
      else process.env.STIM_HOME = previousHome;
      rmSync(home, { recursive: true, force: true });
    }
  });

  test('a kill that fails for another reason is a returned failed status, not a throw', async () => {
    const result = await stopVerified(fixtureRecord(), {
      isAlive: () => true,
      kill: () => {
        throw new Error('operation not permitted');
      },
    });
    expect(result.status).toBe('failed');
    expect(result.reason).toContain('not permitted');
  });

  test('a pid that never exits fails after the INJECTED timeout, not a real one', async () => {
    const c = clock();
    const result = await stopVerified(fixtureRecord(), {
      isAlive: () => true,
      kill: () => {},
      now: c.now,
      sleep: c.sleep,
      timeoutMs: 1_000,
    });
    expect(result.status).toBe('failed');
    expect(result.reason).toContain('did not exit');
  });
});

describe('owned child cleanup', () => {
  test.skipIf(process.platform === 'win32').each([
    { delay: 10, timeoutMs: 1000, status: 'stopped' },
    { delay: 1000, timeoutMs: 50, status: 'failed' },
  ])('keeps a claimed group until its descendant drains: $status', async ({ delay, timeoutMs, status }) => {
    const home = mkdtempSync(join(tmpdir(), 'stim-tunnel-group-'));
    const previousHome = process.env.STIM_HOME;
    process.env.STIM_HOME = home;
    const claimRoot = join(home, 'claim');
    let claim: ClaimHandle | undefined;
    let child: ChildProcess | undefined;
    let closed: Promise<unknown> | undefined;
    const descendant = `
      process.on('SIGTERM', () => setTimeout(() => process.exit(0), ${delay}));
      process.stdout.write('ready\\n');
      setTimeout(() => process.exit(13), 5000);
    `;
    const leader = `
      const { spawn } = require('node:child_process');
      const child = spawn(process.execPath, ['-e', ${JSON.stringify(descendant)}], { stdio: ['ignore', 'pipe', 'ignore'] });
      child.stdout.once('data', () => console.log(JSON.stringify({ url: 'https://group.ngrok.app' })));
      setTimeout(() => process.exit(13), 5000);
    `;
    try {
      const attempt = tryAcquireClaim({ root: claimRoot, mode: 'exclusive', label: 'tunnel test' });
      assert(attempt.acquired);
      claim = attempt.acquired;
      const result = await startTunnel({
        claims: [claim],
        provider: 'ngrok',
        port: 8081,
        requireReachable: false,
        cleanupTimeoutMs: timeoutMs,
        spawnFn: (_file, _args, options) => {
          child = getExecutor().spawn(process.execPath, ['-e', leader], options);
          closed = once(child, 'close');
          return child;
        },
      });
      assert(!('failed' in result));
      expect((await result.cleanup()).status).toBe(status);
      expect(processGroupAlive(result.pid)).toBe(status === 'failed');
      const recorded = readClaimSet(claimRoot).live[0];
      expect(recorded?.child?.pid ?? null).toBe(status === 'failed' ? result.pid : null);
    } finally {
      if (child?.pid && processGroupAlive(child.pid)) process.kill(-child.pid, 'SIGKILL');
      await closed;
      await vi.waitFor(() => expect(child?.pid && processGroupAlive(child.pid)).toBeFalsy(), { timeout: 2000 });
      releaseClaim(claim);
      if (previousHome === undefined) delete process.env.STIM_HOME;
      else process.env.STIM_HOME = previousHome;
      rmSync(home, { recursive: true, force: true });
    }
  });
});

describe('terminateChild on win32', () => {
  afterEach(() => resetExecutor());

  test('signals the tree through taskkill before child.kill', async () => {
    const taskkill: string[][] = [];
    const child = makeChildProcess({ pid: 4242 });
    setExecutor({
      runFileQuiet: (file: string, args: string[]) => {
        taskkill.push([file, ...args]);
        child.emit('exit', null, 'SIGKILL');
        return '';
      },
    });
    const stopped = await terminateChild(child, {
      alreadyExited: false,
      timeoutMs: 10,
      isAlive: () => true,
      platform: 'win32',
    });
    expect(stopped).toBe(true);
    expect(taskkill).toEqual([['taskkill', '/PID', '4242', '/T', '/F']]);
  });
});
