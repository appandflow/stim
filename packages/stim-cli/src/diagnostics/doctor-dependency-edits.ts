import { editsKeptReason, dependencyEditsOf } from '../workspace/dependency-edits.ts';
import type { Finding } from './doctor.ts';

/** The dependency trees at the roots `roots` that maintenance keeps for hand edits, from its records: no tree is walked. */
export function dependencyEditsFindings(roots: readonly string[]): Finding[] {
  const seen = new Set<string>();
  return roots.flatMap((root) =>
    (dependencyEditsOf(root).dependencyEdits ?? []).flatMap((edits): Finding[] =>
      seen.has(edits.tree) || !seen.add(edits.tree)
        ? []
        : [
            {
              level: 'note',
              title: `Files in ${edits.tree} changed after the install`,
              detail: `${edits.tree}: ${editsKeptReason(edits)}. Maintenance and stim gc never delete it, even at critical disk pressure, so the disk it uses is not freed.`,
              fix: 'An edit inside node_modules or Pods is not durable: a reinstall removes it. Turn it into a patch with `pnpm patch`, `yarn patch` or `patch-package`, or reinstall the dependencies, to let maintenance free the folder.',
            },
          ],
    ),
  );
}
