import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startServer } from '../src/server.ts';

vi.mock('@stim-cli/agent-driver-agent-device', () => new Promise(() => {}));

test('startup does not wait on a driver package import', async () => {
  const home = mkdtempSync(join(tmpdir(), 'stim-server-driver-startup-'));
  process.env.STIM_HOME = home;
  try {
    const server = await startServer({
      hosts: ['127.0.0.1'],
      port: 0,
      stimCli: 'unused',
      name: 'Test Mac',
      stimVersion: '9.9.9',
      serverVersion: '1.2.3',
      tailscale: null,
      env: process.env,
      tailscaleState: { state: 'not-running', backendState: 'Stopped' },
    });
    expect(server.addresses).not.toEqual([]);
    await server.close();
  } finally {
    delete process.env.STIM_HOME;
    rmSync(home, { recursive: true, force: true });
  }
}, 5000);
