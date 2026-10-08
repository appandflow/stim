import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const fixture = vi.hoisted(() => ({
  options: [] as Array<Record<string, unknown>>,
}));

vi.mock('../src/server.ts', () => ({
  startServer: async (options: Record<string, unknown>) => {
    fixture.options.push(options);
    return { addresses: [], close: async () => {} };
  },
}));
vi.mock('../src/environment.ts', () => ({
  bundledStim: () => ({ cli: 'unused', version: '1.0.0' }),
  loginShellEnvironment: () => process.env,
}));
vi.mock('../src/tailscale.ts', () => ({
  findTailscale: () => null,
  tailscaleStatus: () => ({ state: 'unavailable', reason: 'fixture' }),
}));
vi.mock('../src/tailscale-monitor.ts', () => ({
  watchTailscale: () => ({ stop: () => {}, onChange: () => {} }),
}));

async function serve(...flags: string[]): Promise<Record<string, unknown>> {
  const home = mkdtempSync(join(tmpdir(), 'stim-server-loopback-'));
  const previousHome = process.env.STIM_HOME;
  process.env.STIM_HOME = home;
  const argv = process.argv;
  process.argv = [process.execPath, join(import.meta.dirname, '../bin/stim-server.ts'), ...flags];
  fixture.options.length = 0;
  vi.spyOn(process, 'on').mockImplementation(() => process);
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  try {
    vi.resetModules();
    await import('../bin/stim-server.ts');
    await vi.waitFor(() => expect(fixture.options).toHaveLength(1));
    return fixture.options[0]!;
  } finally {
    process.argv = argv;
    if (previousHome === undefined) delete process.env.STIM_HOME;
    else process.env.STIM_HOME = previousHome;
    rmSync(home, { recursive: true, force: true });
    vi.restoreAllMocks();
  }
}

test('--loopback-only tells the server to listen on 127.0.0.1 alone and to refuse forwarded peers', async () => {
  const options = await serve('--loopback-only');
  expect(options.hosts).toEqual(['127.0.0.1']);
  expect(options.loopbackOnly).toBe(true);
});

test('without the flag the server is not loopback only', async () => {
  const options = await serve();
  expect(options.loopbackOnly).toBeUndefined();
});
