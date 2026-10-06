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
  loginShellEnvironment: () => process.env,
}));
vi.mock('../src/tailscale.ts', () => ({
  findTailscale: () => null,
  tailscaleStatus: () => ({ state: 'unavailable', reason: 'fixture' }),
}));
vi.mock('../src/tailscale-monitor.ts', () => ({
  watchTailscale: () => ({ stop: fixture.monitorStop, onChange: () => {} }),
}));

test.each([false, true])('SIGTERM exits after close (kept claims: %s)', async (failed) => {
  const home = mkdtempSync(join(tmpdir(), 'stim-server-shutdown-'));
  process.env.STIM_HOME = home;
  const argv = process.argv;
  const exitCode = process.exitCode;
  process.argv = [process.execPath, join(import.meta.dirname, '../bin/stim-server.ts')];
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
  let shutdown: (() => void) | undefined;
  const on = process.on.bind(process);
  vi.spyOn(process, 'on').mockImplementation((event, listener) => {
    if (event === 'SIGTERM') shutdown = listener;
    if (typeof event === 'string' && ['SIGINT', 'SIGTERM', 'SIGHUP'].includes(event)) return process;
    return on(event, listener);
  });
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  let stderr = '';
  vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
    stderr += String(chunk);
    return true;
  });
  let didExit: () => void;
  const exited = new Promise<void>((resolve) => {
    didExit = resolve;
  });
  const exit = vi.spyOn(process, 'exit').mockImplementation(() => {
    didExit();
    return undefined as never;
  });
  try {
    vi.resetModules();
    await import('../bin/stim-server.ts');
    expect(shutdown).toBeDefined();
    shutdown!();
    await exited;
    expect(fixture.monitorStop).toHaveBeenCalledOnce();
    expect(fixture.close).toHaveBeenCalledOnce();
    expect(exit).toHaveBeenCalledOnce();
    expect(process.exitCode).toBe(failed ? 1 : undefined);
    expect(stderr).toBe(
      failed
        ? 'stim-server: daemon claim /claims/daemon was kept\nstim-server: runner claim /claims/runner was kept\n'
        : '',
    );
  } finally {
    vi.restoreAllMocks();
    process.argv = argv;
    process.exitCode = exitCode;
    delete process.env.STIM_HOME;
    rmSync(home, { recursive: true, force: true });
  }
});
