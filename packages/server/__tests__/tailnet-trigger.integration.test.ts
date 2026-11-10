import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Tailnet } from '../src/tailnet-helper.ts';

const fixture = vi.hoisted(() => {
  const options: { tailnet?: Tailnet }[] = [];
  return { options, created: vi.fn<() => void>() };
});

vi.mock('../src/server.ts', () => ({
  startServer: async (options: { tailnet?: Tailnet }) => {
    fixture.options.push(options);
    return { addresses: [], close: async () => {} };
  },
}));
vi.mock('../src/environment.ts', () => ({
  bundledStim: () => ({ cli: 'unused', version: '1.0.0' }),
}));
vi.mock('@stim-cli/core/toolchain', () => ({
  discoverToolchain: (env: NodeJS.ProcessEnv) => ({ env: { ...env }, entries: [] }),
}));
vi.mock('@stim-cli/transport-tailscale', async (original) => {
  const actual = await original<typeof import('@stim-cli/transport-tailscale')>();
  const snapshot = { binary: null, state: { state: 'unavailable' as const, reason: 'fixture' } };
  return {
    ...actual,
    createTransport: async ({ env }: { env: NodeJS.ProcessEnv }) => {
      fixture.created();
      return actual.tailscaleTransport({
        env,
        snapshot,
        monitor: { current: () => snapshot, stop: () => {}, onChange: () => () => {} },
      });
    },
  };
});

test('a net thread on a fresh home loads the Tailscale transport once another process writes the tailnet marker', async () => {
  const home = mkdtempSync(join(tmpdir(), 'stim-server-trigger-'));
  process.env.STIM_HOME = home;
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  try {
    vi.resetModules();
    const { serve, markTailnet } = await import('../src/cli.ts');
    const thread = await serve(
      {
        port: 7787,
        extraEnv: [],
        pathPrepend: [],
        loopbackOnly: false,
        shareOnly: false,
        desktopKey: Buffer.alloc(32, 7).toString('base64url'),
        script: 'unused',
      },
      () => {},
    );
    const tailnet = fixture.options[0]?.tailnet;
    expect(tailnet?.current()).toBeNull();
    expect(fixture.created).not.toHaveBeenCalled();
    markTailnet('pair');
    await vi.waitFor(() => expect(tailnet?.current()).not.toBeNull(), { timeout: 5000 });
    expect(fixture.created).toHaveBeenCalledOnce();
    await thread.close();
  } finally {
    vi.restoreAllMocks();
    delete process.env.STIM_HOME;
    rmSync(home, { recursive: true, force: true });
  }
});
