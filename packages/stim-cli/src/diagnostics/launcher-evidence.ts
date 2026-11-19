import { checkoutRootOf } from '../workspace/checkout-role.ts';
import { launcherDirectories } from '../workspace/launcher-directories.ts';
import {
  describeLauncherProblems,
  launcherProblemsOutcome,
  launcherReader,
  type LauncherProblem,
} from '../workspace/launchers.ts';
import type { Finding } from './doctor.ts';

const READ_BUDGET_MS = 10_000;

const FIX: Record<LauncherProblem['kind'], string> = {
  directory: 'remove the directory from PATH, or fix its permissions so it can be read',
  entry: 'remove or repair the link, or fix its permissions',
  pending: 'wait for the stalled read to finish, or disconnect the stalled mount it names',
  owner: 'fix the permissions of the checkout folder or its .git entry, or wait for the stalled read to finish',
};

/**
 * A finding when the executables on PATH cannot all be inspected: cleanup goes ahead past a directory or entry that
 * could not be read, and keeps every checkout while a read has not answered. The whole read, queue time included, ends at the deadline of `signal`, 10
 * seconds by default, and a read that ends there reports incomplete evidence, never a complete result.
 */
export async function launcherFindings(
  env: NodeJS.ProcessEnv,
  signal: AbortSignal = AbortSignal.timeout(READ_BUDGET_MS),
  projects: readonly string[] = [],
): Promise<Finding[]> {
  let problems: LauncherProblem[];
  try {
    const expired = new Promise<never>((_, reject) => {
      const stop = () => reject(signal.reason);
      if (signal.aborted) stop();
      else signal.addEventListener('abort', stop, { once: true });
    });
    const read = async (): Promise<LauncherProblem[]> => {
      const found = [...(await launcherReader(signal, { directories: launcherDirectories(env) })()).incomplete];
      for (const project of projects) {
        const owner = await checkoutRootOf(project, signal);
        if (typeof owner !== 'string') found.push(owner.problem);
      }
      return found;
    };
    problems = await Promise.race([read(), expired]);
  } catch {
    problems = [{ kind: 'pending', path: 'the launcher directories', error: 'reading them did not finish in time' }];
  }
  if (!problems.length) return [];
  const fixes = [...new Set(problems.map(({ kind }) => FIX[kind]))];
  return [
    {
      code: 'launcher-evidence-incomplete',
      level: 'cost',
      title: problems.some(({ kind }) => kind === 'pending')
        ? 'Cleanup keeps every checkout because the executables on PATH cannot all be inspected'
        : 'Some executables on PATH, or checkout owners, could not be inspected',
      detail: `${describeLauncherProblems(problems)}. ${launcherProblemsOutcome(problems)}.`,
      fix: `${fixes.join('; ')}.`.replace(/^./, (first) => first.toUpperCase()),
    },
  ];
}
