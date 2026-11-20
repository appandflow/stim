import { readdir } from 'node:fs/promises';
import { existsSync, lstatSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, parse, resolve, sep } from 'node:path';
import { isScopedHome, type StimContext } from '@stim-cli/core';
import { machineSettingValue, readDiscoveryScan, type Config, type DiscoveryScan } from '@stim-cli/core/state';
import { canonicalPath } from '../commands/gc/paths.ts';
import { projectRegistry } from '../integrations/projects.ts';
import { answered } from './bounded-read.ts';
import { isProtectedLocation } from './protected-locations.ts';
import { absent, scanEntryValid, scanSkipper } from './scan-rules.ts';
import { matchWorktreeEntry, resolveSourceCheckoutAsync } from './worktree.ts';

const DISCOVER_ROOTS_SETTING = 'maintenance.discoverRoots';
const AUTO_DISCOVER_SETTING = 'maintenance.autoDiscover';

// @ref LLP 0004#automatic-discovery-is-off-by-default -- only registered workspaces and discoverRoots unless turned on
/** Whether `maintenance.autoDiscover` is on: discovery then also reaches past `maintenance.discoverRoots`. */
export function autoDiscoverEnabled(config: Config | null, env: NodeJS.ProcessEnv): boolean {
  return machineSettingValue(AUTO_DISCOVER_SETTING, { config, env }).value === true;
}

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
  /** A plain Node checkout, a source checkout or a linked worktree: only finished worktree removal applies, to a linked one. */
  node?: NodeCheckout;
}

type NodeCheckout = 'source' | 'linked';

export interface DiscoveryChild {
  path: string;
  origin: Exclude<DiscoveryOrigin, 'worktree'>;
  from: string;
  /** Stim's project detection recognises it as a project it handles. */
  recognised: boolean;
  /** Not recognised, but a git checkout root with a package.json. */
  node?: NodeCheckout;
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
  worktrees: readonly { path: string; from: string; reduceOnly?: boolean; node?: NodeCheckout }[];
  children: readonly DiscoveryChild[];
}): DiscoveredCheckout[] {
  const found = new Map<string, DiscoveredCheckout>();
  const covered = (path: string) =>
    known.some((root) => path === root || path.startsWith(`${root}${sep}`) || root.startsWith(`${path}${sep}`));
  for (const { path, from, reduceOnly, node } of worktrees)
    if (!covered(path))
      found.set(path, {
        path,
        origin: 'worktree',
        from,
        ...(reduceOnly ? { reduceOnly } : {}),
        ...(node ? { node } : {}),
      });
  // @ref LLP 0004#plain-node-checkouts -- a scan find keeps its reduce-only entry over a Node one
  for (const { path, origin, from, recognised, node } of children)
    if ((recognised || node) && (!found.has(path) || (recognised && found.get(path)?.node)) && !covered(path))
      found.set(path, {
        path,
        origin,
        from,
        ...(origin === 'scan' ? { reduceOnly: true } : {}),
        ...(node ? { node } : {}),
      });
  return [...found.values()].toSorted((a, b) => a.path.localeCompare(b.path));
}

const PROJECT_FOLDERS = ['apps', 'examples', 'packages'];
const PROJECT_FOLDER_ENTRIES = 50;
const READ_TIMEOUT_MS = 3000;

/** Whether project detection recognises the folder as a project; `'unknown'` when it could not read what decides that. */
function projectState(path: string): boolean | 'unknown' {
  try {
    const { problem } = projectRegistry.selectDoctor(path);
    return problem === null ? true : problem.kind === 'unreadable' ? 'unknown' : false;
  } catch {
    return 'unknown';
  }
}

/**
 * Whether Stim's project detection recognises the folder: it is a project itself, or a direct child of its `apps/`,
 * `examples/` or `packages/` is, as in a monorepo whose root holds no app. `'unknown'` when nothing recognised it and
 * some read that decides this failed (a manifest that does not parse, a listing that cannot be read), so it may be one.
 */
export function recognition(path: string): boolean | 'unknown' {
  let unknown = false;
  const own = projectState(path);
  if (own === true) return true;
  if (own === 'unknown') unknown = true;
  for (const folder of PROJECT_FOLDERS) {
    let names: string[];
    try {
      names = readdirSync(join(path, folder), { withFileTypes: true })
        .filter((entry) => entry.isDirectory() && !entry.isSymbolicLink())
        .slice(0, PROJECT_FOLDER_ENTRIES)
        .map((entry) => entry.name);
    } catch (error) {
      if (!absent(error)) unknown = true;
      continue;
    }
    for (const name of names) {
      const child = projectState(join(path, folder, name));
      if (child === true) return true;
      if (child === 'unknown') unknown = true;
    }
  }
  return unknown ? 'unknown' : false;
}

/** The recognition the walks, the sibling and root children and the deleting passes use: only a proven project counts. */
function recognises(path: string): boolean {
  return recognition(path) === true;
}

// @ref LLP 0004#plain-node-checkouts -- a git checkout root with a package.json
/** Whether the folder is a git checkout with a regular `package.json` at its root, and which kind: `.git` a directory or a file. */
function nodeCheckout(path: string): NodeCheckout | undefined {
  try {
    if (!lstatSync(join(path, 'package.json')).isFile()) return undefined;
    const git = lstatSync(join(path, '.git'));
    return git.isDirectory() ? 'source' : git.isFile() ? 'linked' : undefined;
  } catch {
    return undefined;
  }
}

/** `read`'s result, or null when it fails, has not answered within the timeout, or waits on another hung read. */
async function within<T>(path: string, read: () => Promise<T>): Promise<T | null> {
  try {
    return await answered(path, read, READ_TIMEOUT_MS);
  } catch {
    return null;
  }
}

async function childrenOf(
  folder: string,
  origin: DiscoveryChild['origin'],
  from: string,
  operation?: StimContext,
): Promise<DiscoveryChild[]> {
  const entries = await within(folder, () => readdir(folder, { withFileTypes: true }));
  operation?.signal.throwIfAborted();
  const children: DiscoveryChild[] = [];
  for (const entry of entries ?? []) {
    operation?.signal.throwIfAborted();
    if (!entry.isDirectory() || entry.isSymbolicLink() || entry.name.startsWith('.')) continue;
    const path = canonicalPath(join(folder, entry.name));
    const listed = (await within(path, () => readdir(path))) !== null;
    const recognised = listed && recognises(path);
    const node = listed && !recognised ? nodeCheckout(path) : undefined;
    children.push({ path, origin, from, recognised, ...(node ? { node } : {}) });
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
  /** Scan finds whose validity could not be established this time: neither selected nor dropped. */
  scanPending: string[];
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
 * registers and writes nothing; the full scan's result is read from the file the daemon wrote. A plain Node checkout
 * is never returned, except a linked worktree of a Node repository with `nodeWorktrees`.
 */
export async function discoverCheckouts(
  config: Config | null,
  known: readonly string[],
  operation?: StimContext,
  { nodeWorktrees = false }: { nodeWorktrees?: boolean } = {},
): Promise<DiscoveredCheckout[]> {
  // @ref LLP 0004#plain-node-checkouts -- only the finished-worktree check asks for them
  return (await discovery(config, known, operation)).found.filter(
    (checkout) => !checkout.node || (nodeWorktrees && checkout.node === 'linked'),
  );
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
  if (!operation) return computeDiscovered(config, known, readDiscoveryScan(), operation);
  let found = memo.get(operation);
  if (!found) memo.set(operation, (found = computeDiscovered(config, known, readDiscoveryScan(), operation)));
  return found;
}

/** The checkouts of the last full scan that are still what the scan found, see `scanEntryValid`. */
async function revalidatedScan(scan: DiscoveryScan | null): Promise<{ valid: DiscoveryChild[]; pending: string[] }> {
  const home = canonicalPath(homedir());
  const rules = { home, isCheckout: recognition, skip: scanSkipper(home) };
  const valid: DiscoveryChild[] = [];
  const pending: string[] = [];
  const ancestors = new Map();
  for (const path of scan?.found ?? []) {
    if (!isAbsolute(path)) continue;
    const state = await scanEntryValid(path, { ...rules, ancestors });
    if (state === 'valid') valid.push({ path, origin: 'scan', from: 'full scan', recognised: true });
    else if (state === 'pending') pending.push(path);
  }
  return { valid, pending };
}

async function computeDiscovered(
  config: Config | null,
  known: readonly string[],
  scan: DiscoveryScan | null,
  operation?: StimContext,
  automaticOverride?: boolean,
): Promise<Discovery> {
  const env = operation?.env ?? {};
  const scoped = isScopedHome(operation?.env);
  const automatic = !scoped && (automaticOverride ?? autoDiscoverEnabled(config, env));
  const canonicalRoots = canonicalDiscoverRoots(config, env);
  const repositories: { entries: { path: string }[]; main: string; node?: true }[] = [];
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
  if (automatic) {
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
    const reached = new Set(repositories.flatMap(({ entries }) => entries.map(({ path }) => canonicalPath(path))));
    const byKind = (node?: NodeCheckout) => children.filter((child) => (node ? child.node === node : child.recognised));
    for (const child of [...byKind(), ...byKind('source'), ...byKind('linked')]) {
      if (reached.has(child.path)) continue;
      const repository = await read(child.path);
      if (!repository || seen.has(repository.main)) continue;
      seen.add(repository.main);
      for (const { path } of repository.entries) reached.add(canonicalPath(path));
      repositories.push(child.node ? { ...repository, node: true } : repository);
    }
  }
  const worktrees: { path: string; from: string; reduceOnly?: boolean; node?: NodeCheckout }[] = [];
  const outside: Discovery['outside'] = [];
  for (const { entries, main, node } of repositories) {
    const kind = node ? { node: 'linked' as const } : {};
    for (const entry of entries) {
      const path = canonicalPath(entry.path);
      if (path === canonicalPath(main)) continue;
      if (
        automatic
          ? worktreeInScope(path, { main: canonicalPath(main), folders: [...folders.keys()], roots: canonicalRoots })
          : canonicalRoots.some((root) => inside(path, root))
      )
        worktrees.push({ path, from: main, ...kind });
      else if (automatic && inToolFolder(path, canonicalPath(homedir())))
        worktrees.push({ path, from: main, reduceOnly: true, ...kind });
      else if (!node) outside.push({ path, from: main });
    }
  }
  const { valid: scanned, pending: scanPending } = automatic ? await revalidatedScan(scan) : { valid: [], pending: [] };
  const allowed = [...children, ...scanned].filter(
    (child) => canonicalRoots.some((root) => inside(child.path, root)) || !isProtectedLocation(child.path),
  );
  const knownRoots = known.map(canonicalPath);
  const everything = selectDiscovered({ known: knownRoots, worktrees, children: allowed });
  // @ref LLP 0004#plain-node-checkouts -- a scan find not yet revalidated keeps the Node worktree that holds it
  for (const checkout of everything)
    if (checkout.node && scanPending.some((path) => inside(path, checkout.path))) checkout.reduceOnly = true;
  const listed = new Set(everything.map(({ path }) => path));
  const coveredByKnown = (path: string) => knownRoots.some((root) => inside(path, root) || inside(root, path));
  return {
    found: everything,
    scanPending,
    outside: outside.filter(({ path }) => !listed.has(path) && !coveredByKnown(path)),
  };
}

/** What the last full scan found that this Stim home does not fully manage. */
export interface UnmanagedScanFinds {
  /** The `ranAt` of the scan result these were classified from. */
  scanRanAt: number;
  /** Scan finds discovery selects and no other route reaches: Stim reduces their outputs and never removes them. */
  reduceOnly: string[];
  /** Scan finds under a home dot-folder that no route reaches: Stim does nothing with them. */
  dotFolder: string[];
  /**
   * With `maintenance.autoDiscover` off, the checkouts automatic discovery would reach (siblings, linked worktrees of
   * known repositories, tool folder worktrees, scan finds) that no route reaches now: Stim does nothing with them.
   */
  untracked: string[];
  /** Finds, of either kind, whose validity a read that did not answer left unestablished: neither managed nor gone. */
  unchecked: string[];
  /** The existing, non-broad `maintenance.discoverRoots` folders with symlinks resolved, as this classification used. */
  canonicalRoots: string[];
  /** The `maintenance.autoDiscover` value this classification used. */
  autoDiscover: boolean;
}

const touches = (path: string, other: string): boolean =>
  path === other || path.startsWith(`${other}${sep}`) || other.startsWith(`${path}${sep}`);

/**
 * The scan finds that are not managed through another route, classified from the complete discovery list: the finds
 * discovery selects with origin `scan` are reduce-only, and the find of a home dot-folder, which discovery never selects,
 * is unmanaged unless a registered project or a discovered checkout touches it. With `maintenance.autoDiscover` off it
 * also computes what automatic discovery would select and lists what it adds as `untracked`; this is the one place that
 * runs automatic discovery while the setting is off, in the daemon's census, not in a pass. Lying inside a `maintenance.discoverRoots`
 * folder or a tool folder is not coverage: discovery reaches only the direct children of a root and the worktrees git
 * lists, and a find it did not select stays listed. (The scan prunes `.codex`, so a find under the tool folder cannot
 * come from it.) Each dot-folder find is revalidated like a scan find. A find of either kind whose revalidation did
 * not answer is `unchecked` (when no route covers it), never dropped. A scoped STIM_HOME scans nothing and so finds
 * nothing. Null when there is no usable scan result.
 *
 * It computes discovery anew from the one scan result it reads and returns that result's `ranAt`, not through the
 * per-operation memo the passes share: the memo can hold a discovery computed from an older scan result, and the census
 * must classify the scan it records. The passes' own use of the memo is unchanged.
 */
export async function unmanagedScanFinds(
  config: Config | null,
  known: readonly string[],
  operation: StimContext,
): Promise<UnmanagedScanFinds | null> {
  const scan = readDiscoveryScan();
  if (!scan) return null;
  const automatic = autoDiscoverEnabled(config, operation.env);
  const { found: all, scanPending: pendingNow } = await computeDiscovered(config, known, scan, operation);
  const found = all.filter((checkout) => !checkout.node);
  const reduceOnly = found.filter(({ origin }) => origin === 'scan').map(({ path }) => path);
  if (isScopedHome(operation.env))
    return {
      scanRanAt: scan.ranAt,
      reduceOnly,
      dotFolder: [],
      untracked: [],
      unchecked: [],
      canonicalRoots: [],
      autoDiscover: automatic,
    };
  const managed = new Set(found.map(({ path }) => path));
  // @ref LLP 0004#automatic-discovery-is-off-by-default -- the census lists what turning it on would add
  const wouldFind = automatic ? null : await computeDiscovered(config, known, scan, operation, true);
  const untracked = (wouldFind?.found ?? [])
    .filter((checkout) => !checkout.node && !managed.has(checkout.path))
    .map(({ path }) => path);
  const scanPending = wouldFind?.scanPending ?? pendingNow;
  const home = canonicalPath(homedir());
  const roots = canonicalDiscoverRoots(config, operation.env);
  const knownRoots = known.map(canonicalPath);
  const rules = { home, isCheckout: recognition, skip: scanSkipper(home) };
  const ancestors = new Map();
  const covered = (path: string): boolean =>
    !isAbsolute(path) ||
    knownRoots.some((root) => touches(path, root)) ||
    found.some((checkout) => touches(path, checkout.path)) ||
    untracked.some((checkout) => touches(path, checkout));
  const dotFolder: string[] = [];
  const unchecked = scanPending.filter((path) => !covered(path));
  for (const path of scan.dotFolderFound) {
    operation.signal.throwIfAborted();
    if (covered(path)) continue;
    const state = await scanEntryValid(path, { ...rules, ancestors });
    if (state === 'valid') dotFolder.push(path);
    else if (state === 'pending') unchecked.push(path);
  }
  return {
    scanRanAt: scan.ranAt,
    reduceOnly,
    dotFolder: dotFolder.toSorted(),
    untracked,
    unchecked: unchecked.toSorted(),
    canonicalRoots: roots,
    autoDiscover: automatic,
  };
}
