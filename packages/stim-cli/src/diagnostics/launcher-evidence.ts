import { launcherDirectories } from '../workspace/launcher-directories.ts';
import { describeLauncherProblems, launcherReader, type LauncherProblem } from '../workspace/launchers.ts';
import type { Finding } from './doctor.ts';

const READ_BUDGET_MS = 10_000;

const FIX: Record<LauncherProblem['kind'], string> = {
  directory: 'remove the directory from PATH, or fix its permissions so it can be read',
  entry: 'remove or repair the link, or fix its permissions',
  pending: 'wait for the stalled read to finish, or disconnect the stalled mount it names',
};

/**
 * A finding when the executables on PATH cannot all be inspected: cleanup then keeps every checkout, because any of
 * the unread ones could point into one. The read is bounded by the reader's 3 seconds per call and a 10 second budget
 * in all.
 */
export async function launcherFindings(env: NodeJS.ProcessEnv): Promise<Finding[]> {
  let problems: LauncherProblem[];
  try {
    const signal = AbortSignal.timeout(READ_BUDGET_MS);
    problems = (await launcherReader(signal, { directories: launcherDirectories(env) })()).incomplete;
  } catch {
    problems = [
      { kind: 'pending', path: 'the launcher directories', error: 'reading them did not finish in 10 seconds' },
    ];
  }
  if (!problems.length) return [];
  const fixes = [...new Set(problems.map(({ kind }) => FIX[kind]))];
  return [
    {
      code: 'launcher-evidence-incomplete',
      level: 'cost',
      title: 'Cleanup keeps every checkout because the executables on PATH cannot all be inspected',
      detail: `${describeLauncherProblems(problems)}. An executable there could point into any checkout, so stim gc and the daemon keep every checkout, registered or discovered, until it can be read in full.`,
      fix: `${fixes.join('; ')}.`.replace(/^./, (first) => first.toUpperCase()),
    },
  ];
}
