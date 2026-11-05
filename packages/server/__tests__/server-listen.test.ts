import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BuildHost } from '../src/build.ts';
import { startServer } from '../src/server.ts';

const fixture = vi.hoisted(() => ({
  error: Object.assign(new Error('listen failed'), { code: 'EADDRINUSE' }),
}));

vi.mock('node:http', async (original) => {
  const actual = await original<typeof import('node:http')>();
  return {
    ...actual,
    createServer: (...args: Parameters<typeof actual.createServer>) => {
      const server = actual.createServer(...args);
      vi.spyOn(server, 'listen').mockImplementation(() => {
        queueMicrotask(() => server.emit('error', fixture.error));
        return server;
      });
      return server;
    },
  };
});

test('a cleanup failure does not replace the original listen error', async () => {
  const home = mkdtempSync(join(tmpdir(), 'stim-server-listen-'));
  process.env.STIM_HOME = home;
  const close = vi.spyOn(BuildHost.prototype, 'close').mockRejectedValue(new Error('claim was kept'));
  try {
    await expect(
      startServer({
        hosts: ['127.0.0.1'],
        port: 0,
        stimCli: 'unused',
        name: 'Test Mac',
        stimVersion: '9.9.9',
        serverVersion: '1.2.3',
        tailscale: null,
        env: process.env,
        tailscaleState: { state: 'not-running', backendState: 'Stopped' },
      }),
    ).rejects.toBe(fixture.error);
    expect(close).toHaveBeenCalledOnce();
  } finally {
    vi.restoreAllMocks();
    delete process.env.STIM_HOME;
    rmSync(home, { recursive: true, force: true });
  }
});
