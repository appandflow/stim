import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { WebSocketServer } from 'ws';
import { serverLocalSocket } from '@stim-cli/core/state';
import { startShareServer, type ShareServerStart } from '../local-server.ts';

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
});
