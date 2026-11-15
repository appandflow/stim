import { readdir } from 'node:fs/promises';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, parse, resolve, sep } from 'node:path';
import { isScopedHome, type StimContext } from '@stim-cli/core';
import { machineSettingValue, readDiscoveryScan, type Config } from '@stim-cli/core/state';
import { canonicalPath } from '../commands/gc/paths.ts';
import { projectRegistry } from '../integrations/projects.ts';
import { isProtectedLocation } from './protected-locations.ts';
import { scanEntryValid, scanSkipper } from './scan-rules.ts';
import { matchWorktreeEntry, resolveSourceCheckoutAsync } from './worktree.ts';

const DISCOVER_ROOTS_SETTING = 'maintenance.discoverRoots';

type DiscoveryOrigin = 'worktree' | 'sibling' | 'root' | 'scan';

// @ref LLP 0004#tool-folders-and-the-full-scan -- reduce-only tool folders
/**
 * Folders under the home folder where another tool puts linked worktrees of the user's repositories. Stim discovers
 * those worktrees of known repositories and reduces their outputs, and never removes them.
 */
const TOOL_FOLDERS = ['.codex/worktrees'];

export interface DiscoveredCheckout {
  /** The canonical path of the checkout. */
  path: string;
  origin: DiscoveryOrigin;
  /** The repository, folder or `maintenance.discoverRoots` entry that led to it. */
  from: string;
  /** Found through a tool folder or the full scan: Stim reduces its outputs and never removes it. */
  reduceOnly?: boolean;
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
  worktrees: readonly { path: string; from: string; reduceOnly?: boolean }[];
  children: readonly DiscoveryChild[];
}): DiscoveredCheckout[] {
  const found = new Map<string, DiscoveredCheckout>();
  const covered = (path: string) =>
    known.some((root) => path === root || path.startsWith(`${root}${sep}`) || root.startsWith(`${path}${sep}`));
  for (const { path, from, reduceOnly } of worktrees)
    if (!covered(path)) found.set(path, { path, origin: 'worktree', from, ...(reduceOnly ? { reduceOnly } : {}) });
  for (const { path, origin, from, recognised } of children)
    if (recognised && !found.has(path) && !covered(path))
      found.set(path, { path, origin, from, ...(origin === 'scan' ? { reduceOnly: true } : {}) });
  return [...found.values()].toSorted((a, b) => a.path.localeCompare(b.path));
}

const PROJECT_FOLDERS = ['apps', 'examples', 'packages'];
const PROJECT_FOLDER_ENTRIES = 50;
const READ_TIMEOUT_MS = 3000;

function isProject(path: string): boolean {
  try {
    return projectRegistry.selectDoctor(path).problem === null;
  } catch {
    return false;
  }
}

/**
 * Whether Stim's project detection recognises the folder: it is a project itself, or a direct child of its `apps/`,
 * `examples/` or `packages/` is, as in a monorepo whose root holds no app.
 */
export function recognises(path: string): boolean {
  if (isProject(path)) return true;
  return PROJECT_FOLDERS.some((folder) => {
    try {
      return readdirSync(join(path, folder), { withFileTypes: true })
        .filter((entry) => entry.isDirectory() && !entry.isSymbolicLink())
        .slice(0, PROJECT_FOLDER_ENTRIES)
        .some((entry) => isProject(join(path, folder, entry.name)));
    } catch {
      return false;
    }
  });
}

/** `read`'s result, or null when it fails or has not answered within the timeout, as a hung mount would not. */
async function within<T>(read: Promise<T>, ms = READ_TIMEOUT_MS): Promise<T | null> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      read.catch(() => null),
      new Promise<null>((done) => {
        timer = setTimeout(() => done(null), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function childrenOf(
  folder: string,
  origin: DiscoveryChild['origin'],
  from: string,
  operation?: StimContext,
): Promise<DiscoveryChild[]> {
  const entries = await within(readdir(folder, { withFileTypes: true }));
  operation?.signal.throwIfAborted();
  const children: DiscoveryChild[] = [];
  for (const entry of entries ?? []) {
    operation?.signal.throwIfAborted();
    if (!entry.isDirectory() || entry.isSymbolicLink() || entry.name.startsWith('.')) continue;
    const path = canonicalPath(join(folder, entry.name));
    const answered = (await within(readdir(path))) !== null;
    children.push({ path, origin, from, recognised: answered && recognises(path) });
  }
  return children;
}

function expandHome(path: string): string {
  return path === '~' || path.startsWith('~/') ? join(homedir(), path.slice(1)) : path;
}

/** The `maintenance.discoverRoots` entries, a leading `~` expanded, and the entries that are not absolute paths. */
function configuredRoots(config: Config | null, env: NodeJS.ProcessEnv): { roots: string[]; invalid: string[] } {
  const { value, error } = machineSettingValue(DISCOVER_ROOTS_SETTING, { config, env });
  if (error || !Array.isArray(value)) return { roots: [], invalid: error ? [error] : [] };
  const all = value.map((entry) => expandHome(String(entry)));
  return {
    roots: all.filter((entry) => isAbsolute(entry)).map((entry) => resolve(entry)),
    invalid: all.filter((entry) => !isAbsolute(entry)),
  };
}

/** The existing `maintenance.discoverRoots` folders discovery uses: symlinks resolved, too broad ones left out. */
function canonicalDiscoverRoots(config: Config | null, env: NodeJS.ProcessEnv): string[] {
  return configuredRoots(config, env)
    .roots.filter((root) => existsSync(root))
    .map(canonicalPath)
    .filter((root) => !isBroadFolder(root));
}

/** The `maintenance.discoverRoots` entries that do not name a folder, for doctor to report. */
export function missingDiscoverRoots(config: Config | null, env: NodeJS.ProcessEnv): string[] {
  return configuredRoots(config, env).roots.filter((root) => {
    try {
      return !statSync(root).isDirectory();
    } catch {
      return true;
    }
  });
}

/** The home directory, any folder holding it (such as `/Users`) and the filesystem root are too broad to manage. */
export function isBroadFolder(folder: string, home: string = canonicalPath(homedir())): boolean {
  return folder === parse(folder).root || home === folder || home.startsWith(`${folder}${sep}`);
}

/** The `maintenance.discoverRoots` entries that name a too broad folder once symlinks resolve, which discovery ignores. */
export function broadDiscoverRoots(config: Config | null, env: NodeJS.ProcessEnv): string[] {
  return configuredRoots(config, env).roots.filter((root) => existsSync(root) && isBroadFolder(canonicalPath(root)));
}

const inside = (path: string, folder: string): boolean => path === folder || path.startsWith(`${folder}${sep}`);

/** Whether `path` lies inside a tool folder (see `TOOL_FOLDERS`) of the home folder `home`. */
export function inToolFolder(path: string, home: string): boolean {
  return TOOL_FOLDERS.some((folder) => inside(path, join(home, folder)));
}

/**
 * Whether Stim acts on a discovered linked worktree: it lies in its repository's own main checkout folder, in a folder
 * that holds a known project, or in a `maintenance.discoverRoots` folder, and not in a protected location. A path inside
 * a `maintenance.discoverRoots` folder is never protected.
 */
export function worktreeInScope(
  path: string,
  { main, folders, roots }: { main: string; folders: readonly string[]; roots: readonly string[] },
  isProtected: (path: string) => boolean = isProtectedLocation,
): boolean {
  return (
    roots.some((folder) => inside(path, folder)) ||
    (!isProtected(path) && [main, ...folders].some((folder) => inside(path, folder)))
  );
}

interface Discovery {
  found: DiscoveredCheckout[];
  /** Worktrees and folders the discovery reached that Stim does not manage: listed, never acted on. */
  outside: { path: string; from: string }[];
}

/**
 * The checkouts this Stim home discovers beyond its registered workspaces: linked worktrees of the repositories of its
 * projects (`git worktree list`) inside the folders Stim manages, recognised direct children of the folders holding
 * those checkouts, and recognised direct children of `maintenance.discoverRoots`. Nothing under the system temporary
 * directory or a dot-folder of the home directory is included unless it lies inside a `maintenance.discoverRoots`
 * folder, or is a worktree in a tool folder or a checkout of the last full scan, which are reduce-only. A scoped
 * STIM_HOME discovers only from that setting, so a scratch home never reaches the repositories of another. Discovery
 * registers and writes nothing; the full scan's result is read from the file the daemon wrote.
 */
export async function discoverCheckouts(
  config: Config | null,
  known: readonly string[],
  operation?: StimContext,
): Promise<DiscoveredCheckout[]> {
  return (await discovery(config, known, operation)).found;
}

/** What discovery reached outside the folders Stim manages. */
export async function discoveredOutside(
  config: Config | null,
  known: readonly string[],
  operation?: StimContext,
): Promise<Discovery['outside']> {
  return (await discovery(config, known, operation)).outside;
}

const memo = new WeakMap<StimContext, Promise<Discovery>>();

function discovery(config: Config | null, known: readonly string[], operation?: StimContext): Promise<Discovery> {
  if (!operation) return computeDiscovered(config, known, operation);
  let found = memo.get(operation);
  if (!found) memo.set(operation, (found = computeDiscovered(config, known, operation)));
  return found;
}

/** The checkouts of the last full scan that are still what the scan found, see `scanEntryValid`. */
async function revalidatedScan(): Promise<DiscoveryChild[]> {
  const home = canonicalPath(homedir());
  const rules = { home, isCheckout: recognises, skip: scanSkipper(home) };
  const valid: DiscoveryChild[] = [];
  const ancestors = new Map();
  for (const path of readDiscoveryScan()?.found ?? [])
    if (isAbsolute(path) && (await scanEntryValid(path, { ...rules, ancestors })) === 'valid')
      valid.push({ path, origin: 'scan', from: 'full scan', recognised: true });
  return valid;
}

async function computeDiscovered(
  config: Config | null,
  known: readonly string[],
  operation?: StimContext,
): Promise<Discovery> {
  const env = operation?.env ?? {};
  const scoped = isScopedHome(operation?.env);
  const canonicalRoots = canonicalDiscoverRoots(config, env);
  const repositories: { entries: { path: string }[]; main: string }[] = [];
  const folders = new Map<string, string>();
  const children: DiscoveryChild[] = [];
  const options = { env, signal: operation?.signal, declareFor: operation };
  const read = async (root: string) => {
    operation?.signal.throwIfAborted();
    const { entries, ...source } = await resolveSourceCheckoutAsync(root, options);
    if ('refusal' in source) return null;
    return {
      entries: entries.filter((entry) => !entry.bare && !entry.prunable && existsSync(entry.path)),
      main: source.path,
    };
  };
  if (!scoped) {
    const seen = new Set<string>();
    for (const root of Object.keys(config?.projects ?? {}).filter(isAbsolute)) {
      if (!existsSync(root)) continue;
      const repository = await read(root);
      if (!repository) continue;
      const holder = matchWorktreeEntry(repository.entries, root);
      for (const folder of [
        dirname(canonicalPath(holder?.path ?? repository.main)),
        dirname(canonicalPath(repository.main)),
      ])
        if (!isBroadFolder(folder)) folders.set(folder, repository.main);
      if (!seen.has(repository.main)) {
        seen.add(repository.main);
        repositories.push(repository);
      }
    }
  }
  for (const [folder, from] of folders) children.push(...(await childrenOf(folder, 'sibling', from, operation)));
  for (const root of canonicalRoots) children.push(...(await childrenOf(root, 'root', root, operation)));
  if (!scoped) {
    const seen = new Set(repositories.map(({ main }) => main));
    for (const child of children) {
      if (!child.recognised) continue;
      const repository = await read(child.path);
      if (!repository || seen.has(repository.main)) continue;
      seen.add(repository.main);
      repositories.push(repository);
    }
  }
  const worktrees: { path: string; from: string; reduceOnly?: boolean }[] = [];
  const outside: Discovery['outside'] = [];
  for (const { entries, main } of repositories) {
    for (const entry of entries) {
      const path = canonicalPath(entry.path);
      if (path === canonicalPath(main)) continue;
      if (worktreeInScope(path, { main: canonicalPath(main), folders: [...folders.keys()], roots: canonicalRoots }))
        worktrees.push({ path, from: main });
      else if (inToolFolder(path, canonicalPath(homedir()))) worktrees.push({ path, from: main, reduceOnly: true });
      else outside.push({ path, from: main });
    }
  }
  const scanned: DiscoveryChild[] = scoped ? [] : await revalidatedScan();
  const allowed = [...children, ...scanned].filter(
    (child) => canonicalRoots.some((root) => inside(child.path, root)) || !isProtectedLocation(child.path),
  );
  const knownRoots = known.map(canonicalPath);
  const everything = selectDiscovered({ known: knownRoots, worktrees, children: allowed });
  const listed = new Set(everything.map(({ path }) => path));
  const coveredByKnown = (path: string) => knownRoots.some((root) => inside(path, root) || inside(root, path));
  return {
    found: everything,
    outside: outside.filter(({ path }) => !listed.has(path) && !coveredByKnown(path)),
  };
}

/** What the last full scan found that this Stim home does not fully manage. */
export interface UnmanagedScanFinds {
  /** Scan finds discovery selects and no other route reaches: Stim reduces their outputs and never removes them. */
  reduceOnly: string[];
  /** Scan finds under a home dot-folder that no route reaches: Stim does nothing with them. */
  dotFolder: string[];
}

const touches = (path: string, other: string): boolean =>
  path === other || path.startsWith(`${other}${sep}`) || other.startsWith(`${path}${sep}`);

/**
 * The scan finds that are not managed through another route, classified from the complete discovery list: the finds
 * discovery selects with origin `scan` are reduce-only, and the find of a home dot-folder, which discovery never selects,
 * is unmanaged unless a registered project, a folder of `maintenance.discoverRoots`, a tool folder or any discovered
 * checkout covers it. Each dot-folder find is revalidated like a scan find, and one that does not answer is left out.
 * A scoped STIM_HOME scans nothing and so finds nothing.
 */
export async function unmanagedScanFinds(
  config: Config | null,
  known: readonly string[],
  operation: StimContext,
): Promise<UnmanagedScanFinds> {
  const { found } = await discovery(config, known, operation);
  const reduceOnly = found.filter(({ origin }) => origin === 'scan').map(({ path }) => path);
  if (isScopedHome(operation.env)) return { reduceOnly, dotFolder: [] };
  const home = canonicalPath(homedir());
  const roots = canonicalDiscoverRoots(config, operation.env);
  const knownRoots = known.map(canonicalPath);
  const rules = { home, isCheckout: recognises, skip: scanSkipper(home) };
  const ancestors = new Map();
  const dotFolder: string[] = [];
  for (const path of readDiscoveryScan()?.dotFolderFound ?? []) {
    operation.signal.throwIfAborted();
    if (
      !isAbsolute(path) ||
      roots.some((root) => inside(path, root)) ||
      inToolFolder(path, home) ||
      knownRoots.some((root) => touches(path, root)) ||
      found.some((checkout) => touches(path, checkout.path))
    )
      continue;
    if ((await scanEntryValid(path, { ...rules, ancestors })) === 'valid') dotFolder.push(path);
  }
  return { reduceOnly, dotFolder: dotFolder.toSorted() };
}
