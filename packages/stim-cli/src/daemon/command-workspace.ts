import { canonicalPath } from '../commands/gc/paths.ts';
import { getProject } from '../workspace/config.ts';
import { findProjectRoot } from '../workspace/project.ts';
import { recordWorkspaceUse } from '../workspace/workspace-state.ts';

/**
 * The registered workspace a command runs in, which no pass the command starts may take, or null outside one. With
 * `recordUse`, the command's use is recorded first, so the daemon and the command's own passes see the workspace in use
 * from the moment the command starts.
 */
export function commandWorkspace(
  recordUse: boolean,
  env: NodeJS.ProcessEnv = process.env,
  cwd: string = process.cwd(),
): string | null {
  const found = findProjectRoot(cwd);
  if (!found) return null;
  let root: string;
  try {
    root = canonicalPath(found);
  } catch {
    return null;
  }
  if (!getProject(root)) return root;
  if (recordUse) recordWorkspaceUse(root, new Date(), env);
  return root;
}
