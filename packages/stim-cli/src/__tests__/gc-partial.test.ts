import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readGcLog } from '@stim-cli/core/state';
import { executeGc } from '../commands/gc.ts';
import { runMaintenanceAtLevel } from '../stimd/passes/level-run.ts';

vi.mock('../stimd/passes/level-run.ts', () => ({ runMaintenanceAtLevel: vi.fn<typeof runMaintenanceAtLevel>() }));

test('manual GC keeps a zero partial measurement in its JSON result and saved log', async () => {
  const home = mkdtempSync(join(tmpdir(), 'stim-gc-partial-'));
  vi.stubEnv('STIM_HOME', home);
  const action = {
    rung: null,
    kind: 'clear-outputs',
    target: '/project',
    outcome: 'done' as const,
    bytes: 0,
    partial: true as const,
    reason: 'idle',
    detail: '',
  };
  vi.mocked(runMaintenanceAtLevel).mockImplementation(async (options) => {
    options.onAction?.(action);
    return {
      pressure: { level: 'normal', disk: 'normal', memory: 'normal', reasons: [], memoryWarningSince: null },
      level: 'normal',
      actions: [action],
      blocked: [],
      discovered: [],
      outside: [],
      usage: [],
      cachePaths: [],
      sweptCachePaths: [],
    };
  });
  try {
    const { payload } = await executeGc({ json: true, pressure: 'normal' }, {}, () => {});
    expect('results' in payload ? payload.results : []).toContainEqual(
      expect.objectContaining({ bytes: 0, partial: true }),
    );
    const log = readGcLog();
    expect(log).toContainEqual(expect.objectContaining({ bytes: 0, partial: true }));
    expect(log.some((record) => record.msg.includes('at least 0K'))).toBe(true);
  } finally {
    vi.unstubAllEnvs();
    rmSync(home, { recursive: true, force: true });
  }
});
