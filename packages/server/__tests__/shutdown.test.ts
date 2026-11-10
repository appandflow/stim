import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const fixture = vi.hoisted(() => ({
  close: vi.fn<() => Promise<void>>(),
  monitorStop: vi.fn<() => void>(),
}));

vi.mock('../src/server.ts', () => ({
  startServer: async () => ({ addresses: [], close: fixture.close }),
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
    createTransport: async ({ env }: { env: NodeJS.ProcessEnv }) =>
      actual.tailscaleTransport({
        env,
        snapshot,
        monitor: { current: () => snapshot, stop: fixture.monitorStop, onChange: () => () => {} },
      }),
  };
});

test.each([false, true])(
  'closing the net thread stops its transports and reports what close kept (kept claims: %s)',
  async (failed) => {
    const home = mkdtempSync(join(tmpdir(), 'stim-server-shutdown-'));
    process.env.STIM_HOME = home;
    const exitCode = process.exitCode;
    process.exitCode = undefined;
    fixture.monitorStop.mockClear();
    fixture.close.mockReset();
    if (failed) {
      fixture.close.mockRejectedValue(
        new AggregateError(
          [
            new AggregateError(
              [new Error('daemon claim /claims/daemon was kept'), new Error('runner claim /claims/runner was kept')],
              'Hosted agent drivers did not stop cleanly.',
            ),
          ],
          'Server resources did not close cleanly.',
        ),
      );
    } else fixture.close.mockResolvedValue(undefined);
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    let stderr = '';
    vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
      stderr += String(chunk);
      return true;
    });
    try {
      vi.resetModules();
      const { serve } = await import('../src/cli.ts');
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
      const outcome = await thread.close().then(
        () => null,
        (error: unknown) => error,
      );
      expect(outcome instanceof AggregateError).toBe(failed);
      expect(outcome instanceof Error ? outcome.message : null).toBe(
        failed ? 'Server resources did not close cleanly.' : null,
      );
      expect(fixture.monitorStop).toHaveBeenCalledOnce();
      expect(fixture.close).toHaveBeenCalledOnce();
      expect(process.exitCode).toBe(failed ? 1 : undefined);
      expect(stderr).toBe(
        failed
          ? 'stim-server: daemon claim /claims/daemon was kept\nstim-server: runner claim /claims/runner was kept\n'
          : '',
      );
    } finally {
      vi.restoreAllMocks();
      process.exitCode = exitCode;
      delete process.env.STIM_HOME;
      rmSync(home, { recursive: true, force: true });
    }
  },
);
