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
 * the unread ones could point into one. The whole read, queue time included, ends at the deadline of `signal`, 10
 * seconds by default, and a read that ends there reports incomplete evidence, never a complete result.
 */
export async function launcherFindings(
  env: NodeJS.ProcessEnv,
  signal: AbortSignal = AbortSignal.timeout(READ_BUDGET_MS),
): Promise<Finding[]> {
  let problems: LauncherProblem[];
  try {
    const expired = new Promise<never>((_, reject) => {
      const stop = () => reject(signal.reason);
      if (signal.aborted) stop();
      else signal.addEventListener('abort', stop, { once: true });
    });
    problems = (await Promise.race([launcherReader(signal, { directories: launcherDirectories(env) })(), expired]))
      .incomplete;
  } catch {
    problems = [{ kind: 'pending', path: 'the launcher directories', error: 'reading them did not finish in time' }];
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
