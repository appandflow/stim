import { readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, normalize, relative, sep } from 'node:path';
import { parseWatchRoots, runWatchman, type WatchmanCommand } from '../watchman.ts';
import { listWorktrees, repoRoot } from '../workspace/worktree.ts';
import type { Finding } from './doctor.ts';

export const WATCHMAN_NESTED_WORKTREES = 'watchman-nested-worktrees';

type WatchmanConfig = Record<string, unknown>;
export type WatchmanConfigRead = { kind: 'absent' } | { kind: 'invalid' } | { kind: 'object'; value: WatchmanConfig };

export interface NestedWorktrees {
  checkout: string;
  configPath: string;
  config: WatchmanConfigRead;
  nested: string[];
  add: string[];
}

function isPlainObject(value: unknown): value is WatchmanConfig {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function ignoreDirsOf(config: WatchmanConfigRead): string[] {
  if (config.kind !== 'object' || !Array.isArray(config.value.ignore_dirs)) return [];
  return config.value.ignore_dirs.filter((entry): entry is string => typeof entry === 'string');
}

function normalizeEntry(entry: string): string {
  return normalize(entry).split(sep).join('/').replace(/\/+$/, '');
}

function covered(path: string, ignoreDirs: string[]): boolean {
  return ignoreDirs.map(normalizeEntry).some((entry) => path === entry || path.startsWith(`${entry}/`));
}

/**
 * The linked worktrees inside `checkout` that a Watchman root there would crawl, as paths relative to it, and the
 * `ignore_dirs` entries that exclude them: their shared parent when they have one below the checkout root, otherwise
 * each worktree. All paths are canonical.
 */
export function nestedWorktreeIgnores(
  checkout: string,
  worktrees: string[],
  ignoreDirs: string[],
): { nested: string[]; add: string[] } {
  const nested = worktrees
    .map((path) => relative(checkout, path))
    .filter((rel) => rel !== '' && !rel.startsWith('..') && !isAbsolute(rel))
    .map((rel) => rel.split(sep).join('/'))
    .filter((rel) => !covered(rel, ignoreDirs))
    .toSorted();
  const parents = new Set(nested.map((rel) => dirname(rel)));
  const [parent] = parents;
  const add = parents.size === 1 && parent !== undefined && parent !== '.' ? [parent] : nested;
  return { nested, add };
}

export type IgnoreDirsMerge = { value: WatchmanConfig } | { refusal: string };

/** `ignore_dirs` with `add` appended once, every other key and existing entry kept, or why the file cannot take it. */
export function mergeIgnoreDirs(config: WatchmanConfigRead, add: string[]): IgnoreDirsMerge {
  if (config.kind === 'invalid') return { refusal: 'is not a JSON object' };
  const existing = config.kind === 'object' ? config.value : {};
  if ('ignore_dirs' in existing && !Array.isArray(existing.ignore_dirs)) {
    return { refusal: 'holds an ignore_dirs that is not an array' };
  }
  const current = Array.isArray(existing.ignore_dirs) ? existing.ignore_dirs : [];
  return { value: { ...existing, ignore_dirs: [...new Set([...current, ...add])] } };
}

function readWatchmanConfig(path: string): WatchmanConfigRead {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf-8');
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT' ? { kind: 'absent' } : { kind: 'invalid' };
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    return isPlainObject(parsed) ? { kind: 'object', value: parsed } : { kind: 'invalid' };
  } catch {
    return { kind: 'invalid' };
  }
}

function canonical(path: string): string | null {
  try {
    return realpathSync(path);
  } catch {
    return null;
  }
}

/** Every checkout of this repository that holds linked worktrees its `.watchmanconfig` does not ignore. */
export function inspectNestedWorktrees(projectRoot: string): NestedWorktrees[] {
  const worktrees = listWorktrees(repoRoot(projectRoot) ?? projectRoot)
    .filter((entry) => !entry.prunable && !entry.bare)
    .flatMap((entry) => canonical(entry.path) ?? []);
  return worktrees.flatMap((checkout) => {
    const configPath = join(checkout, '.watchmanconfig');
    const config = readWatchmanConfig(configPath);
    const { nested, add } = nestedWorktreeIgnores(checkout, worktrees, ignoreDirsOf(config));
    return nested.length > 0 ? [{ checkout, configPath, config, nested, add }] : [];
  });
}

/** The checkouts among `checkouts` that Watchman watches as a root now, or none when it cannot be asked. */
export async function watchedCheckouts(
  checkouts: string[],
  watchman: WatchmanCommand = runWatchman,
): Promise<Set<string>> {
  if (checkouts.length === 0) return new Set();
  try {
    const roots = parseWatchRoots(await watchman(['watch-list'], 5000)) ?? [];
    const canonicalRoots = new Set(roots.map((root) => canonical(root) ?? root));
    return new Set(checkouts.filter((checkout) => canonicalRoots.has(checkout)));
  } catch {
    return new Set();
  }
}

function list(items: string[]): string {
  return items.map((item) => `\`${item}\``).join(', ');
}

export function nestedWorktreeFinding(entry: NestedWorktrees, watched: boolean): Finding {
  const count = entry.nested.length;
  const now = watched
    ? ` Watchman watches ${entry.checkout} now; \`watchman watch-del ${entry.checkout}\` and a watchman restart free that memory.`
    : '';
  const merge = mergeIgnoreDirs(entry.config, entry.add);
  const fix =
    'refusal' in merge
      ? `${entry.configPath} ${merge.refusal}, so Stim will not edit it. Add ${list(entry.add)} to its ignore_dirs by hand, then commit it.`
      : `Run \`stim doctor --fix\` to add ${list(entry.add)} to ignore_dirs in ${entry.configPath}, then commit that file. Watchman reads it only when it adds a root, so an existing root needs \`watchman watch-del ${entry.checkout}\` before the ignore applies.`;
  return {
    code: WATCHMAN_NESTED_WORKTREES,
    level: 'cost',
    title: `${count} linked worktree${count === 1 ? ' sits' : 's sit'} inside a checkout that Watchman would crawl`,
    detail: `${list(entry.nested)} ${count === 1 ? 'is' : 'are'} inside ${entry.checkout}, and its .watchmanconfig does not ignore them. A Watchman root at that checkout, as Jest or a Metro started there registers, crawls every worktree's files, node_modules and build output, which grows the shared daemon's memory and its recrawls.${now}`,
    fix,
  };
}

export type IgnoreDirsWrite = { status: 'created' | 'updated' } | { status: 'refused'; reason: string };

export function writeIgnoreDirs(entry: NestedWorktrees): IgnoreDirsWrite {
  const merge = mergeIgnoreDirs(entry.config, entry.add);
  if ('refusal' in merge) return { status: 'refused', reason: `${entry.configPath} ${merge.refusal}` };
  const tmp = `${entry.configPath}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(merge.value, null, 2)}\n`);
  try {
    renameSync(tmp, entry.configPath);
  } catch (error) {
    rmSync(tmp, { force: true });
    throw error;
  }
  return { status: entry.config.kind === 'absent' ? 'created' : 'updated' };
}
