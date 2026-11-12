import { editsKeptReason, dependencyEditsOf } from '../workspace/dependency-edits.ts';
import type { Finding } from './doctor.ts';

const PATCH_FIX =
  'An edit inside node_modules or Pods is not durable: a reinstall or maintenance removes it. Turn it into a patch with `pnpm patch`, `yarn patch` or `patch-package`, then reinstall.';

/**
 * The dependency trees at the roots `roots` that maintenance found edited after the install, and the copies it saved
 * before deleting one, from its records: doctor walks no tree.
 */
export function dependencyEditsFindings(roots: readonly string[]): Finding[] {
  const seen = new Set<string>();
  return roots.flatMap((root) => {
    const { dependencyEdits = [], dependencyEditsSaved = [] } = dependencyEditsOf(root);
    return [
      ...dependencyEdits.flatMap((edits): Finding[] =>
        seen.has(edits.tree) || !seen.add(edits.tree)
          ? []
          : [
              {
                level: 'note',
                title: `Files in ${edits.tree} changed after the install`,
                detail: `${edits.tree}: ${editsKeptReason(edits)}.`,
                fix: PATCH_FIX,
              },
            ],
      ),
      ...dependencyEditsSaved.flatMap((saved): Finding[] =>
        seen.has(saved.dir) || !seen.add(saved.dir)
          ? []
          : [
              {
                level: 'note',
                title: `Edited files of ${saved.tree} were saved before it was deleted`,
                detail: `${saved.count} file${saved.count === 1 ? '' : 's'} saved to ${saved.dir}.`,
                fix: `After reinstalling, put them back with ${saved.restore}. ${PATCH_FIX}`,
              },
            ],
      ),
    ];
  });
}
