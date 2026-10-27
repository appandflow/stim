import { readStatsReport, statsProjectKey, type StatsReport } from '@stim-cli/core/state';
import { gitPath } from '../workspace/git-read.ts';

/** The stats report for the project at `root`, keyed like the run recorders; Git runs with `env` and dies when `signal` aborts. */
export async function readProjectStats(
  root: string | null,
  env: NodeJS.ProcessEnv,
  signal?: AbortSignal,
): Promise<{ report: StatsReport; note: string | null }> {
  if (!root) return readStatsReport(null, Date.now());
  const [commonDir, repoRoot] = await Promise.all([
    gitPath(root, ['--path-format=absolute', '--git-common-dir'], env, signal),
    gitPath(root, ['--show-toplevel'], env, signal),
  ]);
  signal?.throwIfAborted();
  return readStatsReport(statsProjectKey({ root, commonDir, repoRoot }), Date.now());
}
