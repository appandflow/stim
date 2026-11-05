import { statSync, watch, type FSWatcher } from 'node:fs';
import { workspaceStateFile } from './paths.ts';

/** Filesystem events are hints; callers retain their own bounded repair and state verification. */
export function watchWorkspaceState(root: string, changed: () => void): { refresh(): void; close(): void } {
  let stopped = false;
  let current: { watcher: FSWatcher; dev: number; ino: number } | undefined;
  let startup: ReturnType<typeof setTimeout> | undefined;
  const clear = () => {
    clearTimeout(startup);
    const previous = current;
    current = undefined;
    previous?.watcher.close();
  };
  const refresh = () => {
    if (stopped) return;
    try {
      const file = workspaceStateFile(root);
      const stat = statSync(file);
      if (current?.dev === stat.dev && current.ino === stat.ino) return;
      clear();
      const watcher = watch(file, { persistent: false }, () => {
        if (stopped || current?.watcher !== watcher) return;
        refresh();
        changed();
      });
      current = { watcher, dev: stat.dev, ino: stat.ino };
      const lost = () => {
        if (current?.watcher === watcher) clear();
      };
      watcher.once('error', lost);
      watcher.once('close', lost);
      // macOS fs.watch exposes no ready event: https://github.com/nodejs/node/issues/52601
      startup = setTimeout(() => {
        if (stopped) return;
        refresh();
        changed();
      }, 500);
    } catch {
      clear();
    }
  };
  refresh();
  return {
    refresh,
    close: () => {
      stopped = true;
      clear();
    },
  };
}
