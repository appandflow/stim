import { readdirSync, statSync, watch, type FSWatcher } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, relative, resolve, sep } from 'node:path';
import type { StimContext } from '@stim-cli/core';
import type { NdjsonRecord } from '@stim-cli/core/state';
import { envDir } from './activity.ts';

interface Binding {
  directory: string;
  identity: string;
  recursive: boolean;
  watcher: FSWatcher;
}

function location(root: string, recursive: boolean): Omit<Binding, 'watcher'> {
  let directory = root;
  while (true) {
    try {
      const info = statSync(directory);
      if (info.isDirectory())
        return { directory, identity: `${info.dev}:${info.ino}`, recursive: recursive && directory === root };
    } catch {}
    const parent = dirname(directory);
    if (parent === directory) throw new Error(`Cannot watch the agent state directory ${root}.`);
    directory = parent;
  }
}

function relevant(root: string, directory: string, name: string | null): boolean {
  if (name === null || directory === root) return true;
  const parts = name.replaceAll('\\', '/').split('/');
  return parts[0] === relative(directory, root).split(sep)[0];
}

export function followAgentActions(
  context: Pick<StimContext, 'home' | 'env' | 'signal'>,
  read: () => Promise<NdjsonRecord[]>,
  onRecord: (record: NdjsonRecord) => void,
): () => void {
  const home = context.env.HOME ?? homedir();
  const override = context.env.AGENT_DEVICE_STATE_DIR?.trim();
  const workspaces = join(context.home, 'workspaces');
  const baseRoots = new Map([
    [override ? resolve(override) : join(home, '.agent-device'), true],
    [envDir('AGENT_DEVICE_CLAIMS_DIR', context.env) ?? join(home, '.agent-device', 'device-claims'), true],
    [workspaces, false],
  ]);
  let rootCount = baseRoots.size;
  const bindings = new Map<string, Binding>();
  let stopped = false;
  let reading = false;
  let pending = false;
  let repair: ReturnType<typeof setTimeout> | undefined;
  let scheduled: ReturnType<typeof setTimeout> | undefined;

  const refresh = async () => {
    if (stopped) return;
    if (reading) {
      pending = true;
      return;
    }
    reading = true;
    try {
      for (const record of await read()) {
        if (stopped) break;
        onRecord(record);
      }
    } catch {
    } finally {
      reading = false;
      if (pending) {
        pending = false;
        void refresh();
      }
    }
  };

  const scheduleRefresh = () => {
    if (stopped || scheduled !== undefined) return;
    scheduled = setTimeout(() => {
      scheduled = undefined;
      void refresh();
    }, 500);
  };

  const reconcile = () => {
    const roots = new Map(baseRoots);
    try {
      for (const entry of readdirSync(workspaces, { withFileTypes: true }))
        if (entry.isDirectory() || entry.isSymbolicLink())
          roots.set(join(workspaces, entry.name, 'agent-device'), true);
    } catch {}
    rootCount = roots.size;
    for (const [root, binding] of bindings) {
      if (roots.has(root)) continue;
      bindings.delete(root);
      binding.watcher.close();
    }
    for (const [root, recursive] of roots) {
      let next: Omit<Binding, 'watcher'>;
      try {
        next = location(root, recursive);
      } catch {
        continue;
      }
      const current = bindings.get(root);
      if (
        current?.directory === next.directory &&
        current.identity === next.identity &&
        current.recursive === next.recursive
      )
        continue;
      bindings.delete(root);
      current?.watcher.close();
      try {
        const watcher = watch(next.directory, { recursive: next.recursive }, (event, name) => {
          if (stopped || !relevant(root, next.directory, name)) return;
          if (event === 'rename' || next.directory !== root) reconcile();
          scheduleRefresh();
        });
        const binding = { ...next, watcher };
        bindings.set(root, binding);
        const lost = () => {
          if (bindings.get(root) !== binding) return;
          bindings.delete(root);
          watcher.close();
          armRepair(500);
        };
        watcher.once('error', lost);
        watcher.once('close', lost);
      } catch {}
    }
  };

  function armRepair(delay: number): void {
    clearTimeout(repair);
    if (stopped) return;
    // Node fs.watch can miss startup events and retain replaced inodes:
    // https://github.com/nodejs/node/issues/52601; https://nodejs.org/docs/latest-v22.x/api/fs.html#caveats
    repair = setTimeout(() => {
      reconcile();
      void refresh();
      armRepair(bindings.size < rootCount ? 500 : 10_000);
    }, delay);
  }

  const stop = () => {
    if (stopped) return;
    stopped = true;
    clearTimeout(repair);
    clearTimeout(scheduled);
    for (const { watcher } of bindings.values()) watcher.close();
    bindings.clear();
    context.signal.removeEventListener('abort', stop);
  };
  context.signal.addEventListener('abort', stop, { once: true });
  if (context.signal.aborted) stop();
  else {
    reconcile();
    void refresh();
    armRepair(500);
  }
  return stop;
}
