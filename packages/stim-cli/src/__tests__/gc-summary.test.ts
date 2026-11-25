import { formatGcSummary, gcDetailLines } from '../commands/gc/summary.ts';
import type { LevelRun } from '../stimd/passes/level-run.ts';

test.each([0, 1024 * 1024])('plain GC reports keep a partial %i-byte measurement visible', (bytes) => {
  const action = {
    rung: null,
    kind: 'clear-outputs',
    target: '/project',
    outcome: 'done' as const,
    bytes,
    partial: true as const,
    reason: 'idle',
    detail: '',
  };
  const run: LevelRun = {
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
  const size = bytes ? '1M' : '0K';
  const lines = formatGcSummary(run, { act: true, chosen: false, detail: '/report' });
  expect(lines).toContain(`Removed at least ${size} in 1 action; kept 0; 0 failed.`);
  expect(lines).toContain(`  Workspace build outputs (1, at least ${size})`);
  expect(lines).toContain(`    at least ${size}  /project`);
  expect(gcDetailLines(run)[1]).toContain(`\tat least ${size}\t`);
});
