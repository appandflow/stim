import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { WebSocketServer } from 'ws';
import { serverLocalSocket } from '@stim-cli/core/state';
import { configDir } from '@stim-cli/core';
import { releaseClaim, tryAcquireClaim } from '@stim-cli/core/ownership-claim';
import { startShareServer, stopIdleShareServer, type ShareServerStart } from '../local-server.ts';
import { serveShareList } from './_share-list-server.ts';

/** A stim-server on this home's local socket that reports `port` in hello, as Desktop's or another one would. */
function otherServer(port: number): Promise<Server> {
  const path = serverLocalSocket();
  mkdirSync(dirname(path), { recursive: true });
  const http = createServer();
  const wss = new WebSocketServer({ server: http });
  wss.on('connection', (socket) =>
    socket.on('message', (data) => {
      const { id } = JSON.parse(String(data));
      socket.send(JSON.stringify(id === 1 ? { id, result: { server: { port } } } : { id, result: { shares: [] } }));
    }),
  );
  return new Promise((resolve) => http.listen(path, () => resolve(http)));
}

describe('starting a stim-server for a share', () => {
  let home: string;
  let sleeper: { file: string; args: string[] };
  const previous = process.env.STIM_HOME;
  const spawned: number[] = [];
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'stim-share-server-'));
    process.env.STIM_HOME = home;
    const script = join(home, 'sleeper.mjs');
    writeFileSync(script, 'setInterval(() => {}, 1000);\n');
    sleeper = { file: process.execPath, args: [script] };
  });
  afterEach(() => {
    for (const pid of spawned.splice(0)) {
      try {
        process.kill(pid, 'SIGKILL');
      } catch {}
    }
    if (previous === undefined) delete process.env.STIM_HOME;
    else process.env.STIM_HOME = previous;
    rmSync(home, { recursive: true, force: true });
  });

  test.skipIf(process.platform === 'win32')(
    'stops its own server and joins the one that won the local socket; skipped on win32',
    async () => {
      const winner = await otherServer(1);
      const kill = vi.spyOn(process, 'kill');
      let result: ShareServerStart | null = null;
      void startShareServer(sleeper, '1.0.0').then((value) => (result = value));
      await vi.waitFor(() => expect(result).not.toBeNull(), { timeout: 20_000, interval: 250 });
      expect(result).toEqual({ started: false, reason: 'joined' });
      const [pid, signal] = kill.mock.calls[0] ?? [];
      spawned.push(Number(pid));
      expect(signal).toBe('SIGTERM');
      winner.close();
    },
  );

  it('stops its own server and reports the log when no server answers within 60 s', async () => {
    const kill = vi.spyOn(process, 'kill');
    let result: ShareServerStart | null = null;
    void startShareServer(sleeper, '1.0.0').then((value) => (result = value));
    await vi.advanceTimersByTimeAsync(61_000);
    expect(result).not.toBeNull();
    expect(result).toMatchObject({
      started: false,
      reason: 'failed',
      message: expect.stringContaining('60 s'),
      log: join(home, 'server', 'share-server.log'),
    });
    const [pid, signal] = kill.mock.calls[0] ?? [];
    spawned.push(Number(pid));
    expect(signal).toBe('SIGTERM');
  });

  it('waits for the server it stopped to exit before returning, so a share started next does not meet it stopping', async () => {
    const server = await serveShareList(() => ({ shares: [] }));
    const claim = tryAcquireClaim({
      root: join(configDir(), 'server', 'share-server'),
      mode: 'exclusive',
      details: { port: 1 },
    });
    let exited = false;
    const kill = vi.spyOn(process, 'kill').mockImplementation((_pid, signal) => {
      if (signal === 0 && exited) throw Object.assign(new Error('no such process'), { code: 'ESRCH' });
      return true;
    });
    let stopped: Awaited<ReturnType<typeof stopIdleShareServer>> | undefined;
    void stopIdleShareServer('1.0.0').then((pid) => (stopped = pid));
    await vi.waitFor(() => expect(kill).toHaveBeenCalledWith(process.pid, 'SIGTERM'));
    await vi.advanceTimersByTimeAsync(5000);
    expect(stopped).toBeUndefined();
    exited = true;
    await vi.advanceTimersByTimeAsync(100);
    expect(stopped).toEqual({ pid: process.pid, exited: true });
    releaseClaim(claim.acquired);
    await server.close();
  });

  it('leaves a server with a share start in flight running, and names the pid and the count', async () => {
    const server = await serveShareList(() => ({ shares: [], starting: 2 }));
    const claim = tryAcquireClaim({
      root: join(configDir(), 'server', 'share-server'),
      mode: 'exclusive',
      details: { port: 1 },
    });
    const kill = vi.spyOn(process, 'kill').mockImplementation(() => true);
    expect(await stopIdleShareServer('1.0.0')).toEqual({ pid: process.pid, starting: 2 });
    expect(kill).not.toHaveBeenCalled();
    releaseClaim(claim.acquired);
    await server.close();
  });

  it('stops a server that reports no starting count, as one before share-starting does', async () => {
    const server = await serveShareList(() => ({ shares: [] }));
    const claim = tryAcquireClaim({
      root: join(configDir(), 'server', 'share-server'),
      mode: 'exclusive',
      details: { port: 1 },
    });
    let exited = false;
    const kill = vi.spyOn(process, 'kill').mockImplementation((_pid, signal) => {
      if (signal === 0 && exited) throw Object.assign(new Error('no such process'), { code: 'ESRCH' });
      if (signal === 'SIGTERM') exited = true;
      return true;
    });
    expect(await stopIdleShareServer('1.0.0')).toEqual({ pid: process.pid, exited: true });
    expect(kill).toHaveBeenCalledWith(process.pid, 'SIGTERM');
    releaseClaim(claim.acquired);
    await server.close();
  });

  it('says the server has not exited when it is still there after 15 s', async () => {
    const server = await serveShareList(() => ({ shares: [] }));
    const claim = tryAcquireClaim({
      root: join(configDir(), 'server', 'share-server'),
      mode: 'exclusive',
      details: { port: 1 },
    });
    const kill = vi.spyOn(process, 'kill').mockImplementation(() => true);
    let stopped: Awaited<ReturnType<typeof stopIdleShareServer>> | undefined;
    void stopIdleShareServer('1.0.0').then((result) => (stopped = result));
    await vi.waitFor(() => expect(kill).toHaveBeenCalledWith(process.pid, 'SIGTERM'));
    await vi.advanceTimersByTimeAsync(14_000);
    expect(stopped).toBeUndefined();
    await vi.advanceTimersByTimeAsync(2000);
    expect(stopped).toEqual({ pid: process.pid, exited: false });
    releaseClaim(claim.acquired);
    await server.close();
  });
});
