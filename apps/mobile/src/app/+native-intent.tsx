import { workspaceIntentPath } from '@/lib/workspace-links';

export function redirectSystemPath({ path }: { path: string; initial: boolean }): string {
  return workspaceIntentPath(path);
}
