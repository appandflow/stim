import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const fixture = vi.hoisted(() => ({
  options: [] as Array<Record<string, unknown>>,
  watch: vi.fn<(...args: unknown[]) => void>(),
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
  watchTailscale: (...args: unknown[]) => {
    fixture.watch(...args);
    return { stop: () => {}, onChange: () => {} };
  },
}));

async function serve(...flags: string[]): Promise<Record<string, unknown>> {
  process.env.STIM_HOME = mkdtempSync(join(tmpdir(), 'stim-server-loopback-'));
  const argv = process.argv;
  process.argv = [process.execPath, join(import.meta.dirname, '../bin/stim-server.ts'), ...flags];
  fixture.options.length = 0;
  fixture.watch.mockClear();
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
    vi.restoreAllMocks();
  }
}

test('--loopback-only watches no Tailscale address, so the server never listens beyond 127.0.0.1', async () => {
  const options = await serve('--loopback-only');
  expect(options.hosts).toEqual(['127.0.0.1']);
  expect(options.tailscaleMonitor).toBeUndefined();
  expect(fixture.watch).not.toHaveBeenCalled();
});

test('without the flag the server follows Tailscale', async () => {
  const options = await serve();
  expect(options.tailscaleMonitor).toBeDefined();
});
