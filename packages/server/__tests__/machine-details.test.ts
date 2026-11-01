import { BuildMachinesCache, buildClients } from '../src/machine-details.ts';

describe('buildClients', () => {
  const build = (id: string, name: string, when: string, ok: boolean, durationMs: number) => ({
    at: when,
    device: { id, name },
    action: 'build',
    workspace: 'github.com/acme/app',
    ok,
    durationMs,
  });

  it('groups build records per client, counts today on the local day, and ignores other actions', () => {
    const now = new Date(2026, 8, 30, 15, 0).getTime();
    const today = new Date(2026, 8, 30, 9, 0).toISOString();
    const yesterday = new Date(2026, 8, 29, 9, 0).toISOString();
    const records = [
      build('ab12', 'old-name', yesterday, true, 200_000),
      build('cd34', 'laptop-2', yesterday, true, 100_000),
      build('ab12', 'laptop', today, false, 50_000),
      { at: today, device: { id: 'ab12', name: 'laptop' }, action: 'reload', workspace: null, ok: true },
    ];

    expect(buildClients(records, now)).toEqual([
      {
        id: 'ab12',
        name: 'laptop',
        builds: 2,
        failed: 1,
        buildMs: 250_000,
        today: { builds: 1, failed: 1, buildMs: 50_000 },
        lastAt: today,
      },
      {
        id: 'cd34',
        name: 'laptop-2',
        builds: 1,
        failed: 0,
        buildMs: 100_000,
        today: { builds: 0, failed: 0, buildMs: 0 },
        lastAt: yesterday,
      },
    ]);
  });
});

describe('BuildMachinesCache', () => {
  const run = () => Promise.resolve({ ok: true as const, report: {} });

  it('runs no doctor when remote.machines names none, and says why when no workspace can run it', () => {
    const calls: string[] = [];
    const counted = () => {
      calls.push('doctor');
      return run();
    };
    const cache = new BuildMachinesCache();
    expect(cache.snapshot(counted, null)).toEqual({ buildMachines: [] });
    expect(cache.snapshot(counted, { cwd: null })).toEqual({
      buildMachines: null,
      buildMachinesError: 'no Stim workspace is registered to check them from',
    });
    expect(cache.snapshot(counted, { error: 'config.json is not JSON' })).toEqual({
      buildMachines: null,
      buildMachinesError: 'config.json is not JSON',
    });
    expect(calls).not.toContain('doctor');
  });
});
