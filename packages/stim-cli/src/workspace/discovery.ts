import { readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, isAbsolute, join, sep } from 'node:path';
import { isScopedHome, type StimContext } from '@stim-cli/core';
import { machineSettingValue, type Config } from '@stim-cli/core/state';
import { canonicalPath } from '../commands/gc/paths.ts';
import { projectRegistry } from '../integrations/projects.ts';
import { resolveSourceCheckoutAsync } from './worktree.ts';

const DISCOVER_ROOTS_SETTING = 'maintenance.discoverRoots';

type DiscoveryOrigin = 'worktree' | 'sibling' | 'root';

export interface DiscoveredCheckout {
  /** The canonical path of the checkout. */
  path: string;
  origin: DiscoveryOrigin;
  /** The repository, folder or `maintenance.discoverRoots` entry that led to it. */
  from: string;
}

export interface DiscoveryChild {
  path: string;
  origin: Exclude<DiscoveryOrigin, 'worktree'>;
  from: string;
  /** Stim's project detection recognises it as a project it handles. */
  recognised: boolean;
}

/**
 * The checkouts to manage without a registered workspace: linked worktrees of known repositories as they are, and
 * children of a folder only when recognised as a project. A path a registered workspace or recorded root covers, or one
 * inside such a path, is left to that workspace.
 */
export function selectDiscovered({
  known,
  worktrees,
  children,
}: {
  known: readonly string[];
  worktrees: readonly { path: string; from: string }[];
  children: readonly DiscoveryChild[];
}): DiscoveredCheckout[] {
  const found = new Map<string, DiscoveredCheckout>();
  const covered = (path: string) =>
    known.some((root) => path === root || path.startsWith(`${root}${sep}`) || root.startsWith(`${path}${sep}`));
  for (const { path, from } of worktrees) if (!covered(path)) found.set(path, { path, origin: 'worktree', from });
  for (const { path, origin, from, recognised } of children)
    if (recognised && !found.has(path) && !covered(path)) found.set(path, { path, origin, from });
  return [...found.values()].toSorted((a, b) => a.path.localeCompare(b.path));
}

function recognises(path: string): boolean {
  try {
    return projectRegistry.selectDoctor(path).problem === null;
  } catch {
    return false;
  }
}

async function childrenOf(
  folder: string,
  origin: DiscoveryChild['origin'],
  from: string,
  operation?: StimContext,
): Promise<DiscoveryChild[]> {
  let entries;
  try {
    entries = await readdir(folder, { withFileTypes: true });
  } catch {
    operation?.signal.throwIfAborted();
    return [];
  }
  const children: DiscoveryChild[] = [];
  for (const entry of entries) {
    operation?.signal.throwIfAborted();
    if (!entry.isDirectory() || entry.isSymbolicLink() || entry.name.startsWith('.')) continue;
    const path = canonicalPath(join(folder, entry.name));
    children.push({ path, origin, from, recognised: recognises(path) });
  }
  return children;
}

function configuredRoots(config: Config | null, env: NodeJS.ProcessEnv): string[] {
  const { value, error } = machineSettingValue(DISCOVER_ROOTS_SETTING, { config, env });
  return error || !Array.isArray(value) ? [] : value.filter((entry): entry is string => isAbsolute(String(entry)));
}

/**
 * The checkouts this Stim home discovers beyond its registered workspaces: linked worktrees of the repositories of its
 * projects (`git worktree list`), recognised direct children of the folders holding those checkouts, and recognised
 * direct children of `maintenance.discoverRoots`. A scoped STIM_HOME discovers only from that setting, so a scratch
 * home never reaches the repositories of another. Nothing is registered, written or persisted.
 */
export async function discoverCheckouts(
  config: Config | null,
  known: readonly string[],
  operation?: StimContext,
): Promise<DiscoveredCheckout[]> {
  const env = operation?.env ?? {};
  const worktrees: { path: string; from: string }[] = [];
  const children: DiscoveryChild[] = [];
  const folders = new Map<string, string>();
  if (!isScopedHome(operation?.env)) {
    const options = { env, signal: operation?.signal, declareFor: operation };
    const seen = new Set<string>();
    for (const root of Object.keys(config?.projects ?? {}).filter(isAbsolute)) {
      operation?.signal.throwIfAborted();
      if (!existsSync(root)) continue;
      const { entries, ...source } = await resolveSourceCheckoutAsync(root, options);
      if ('refusal' in source || seen.has(source.path)) continue;
      seen.add(source.path);
      for (const entry of entries) {
        if (entry.bare || entry.prunable || !existsSync(entry.path)) continue;
        const path = canonicalPath(entry.path);
        if (entry.path !== source.path) worktrees.push({ path, from: source.path });
        folders.set(dirname(path), source.path);
      }
    }
  }
  for (const [folder, from] of folders) children.push(...(await childrenOf(folder, 'sibling', from, operation)));
  for (const root of configuredRoots(config, env))
    children.push(...(await childrenOf(canonicalPath(root), 'root', root, operation)));
  return selectDiscovered({ known: known.map(canonicalPath), worktrees, children });
}
