import { randomBytes } from 'node:crypto';
import { readdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, relative, sep } from 'node:path';
import { ensurePrivateDir } from '@stim-cli/core';
import { fingerprintEnvDir, fingerprintIndexDir, LOCKFILES } from '@stim-cli/core/state';
import { gitLocation } from './git-index.ts';
import { canonicalJson, FINGERPRINT_SCHEMA, sha256, type Input, type Layout, type Platform } from './key.ts';
import { within, type Roots } from './walk.ts';

const RECORDS_PER_DIR = 8;
const DIRS_PER_PLATFORM = 256;
/** Bumped when the record shape or what a part record derives from its trace changes. */
const INDEX_FORMAT = 1;
const INSTALL_STAMPS = ['.modules.yaml', '.package-lock.json', '.yarn-integrity', '.yarn-state.yml'];
/** Where `patch-package` and the yarn and pnpm patch commands keep patches, which change installed files. */
const PATCH_DIRS = ['patches', 'cng-patches', '.yarn/patches'];

export type ReadKind = 'file' | 'module' | 'dir' | 'present' | 'absent' | 'package';
/** What one evaluation read, with a path relative to the app or the install root so a sibling checkout can reuse it. */
export interface Read {
  path: string;
  kind: ReadKind;
  /** `size:mtimeNs:ctimeNs:ino` at record time, or null when the path was absent. */
  stat?: string | null;
  /** The content (file, module, `package.json`) or sorted listing (dir) hash; null never validates by content. */
  hash?: string | null;
  /** Where a file or module resolved to, so a retargeted symlink with equal bytes still fails. */
  real?: string;
}

/** What a part needs from its trace once its output is known; every path is relocated. */
export interface Derived {
  rows: Input[];
  packages: string[];
  modules: string[];
  opaque: string[];
  enumerated: boolean;
  autolinking: string | null;
}

export interface PartRecord {
  startedAtNs: string;
  /** Hashes of the env values the part read, `*` for an enumeration of the whole env. */
  env: [name: string, hash: string | null][];
  envNames: string[];
  reads: Read[];
  output: unknown;
  wrapped: boolean;
  derived: Derived;
}

export interface PackageEntry {
  read: Read;
  name?: string | null;
  version?: string;
  scan?: string[];
  template?: string[];
  provenance?: Provenance;
}

export interface Provenance {
  mode: 'identity' | 'content';
  integrity?: string;
  resolved?: string;
  patch?: string;
}

export interface EvalRecord {
  format: number;
  schema: number;
  evaluator: string;
  runtime: string;
  checkout: string;
  writtenAtNs: string;
  stamps: Read[];
  packages: Record<string, PackageEntry>;
  closure: { dirs: string[]; missing: string[] } | null;
  parts: Record<string, PartRecord>;
}

/** Wall-clock nanoseconds, comparable with file times. */
export const nowNs = (): bigint => BigInt(Date.now()) * 1_000_000n;

/** The start of a computation, a millisecond early, so a file written during it has a time at or after it. */
export const startedAt = (): bigint => nowNs() - 1_000_000n;

/**
 * Whether a file time is too close to a computation's start to trust. Kernels stamp files from a coarse clock that
 * can trail the wall clock by a few milliseconds, and some filesystems keep whole seconds, so a time within 50 ms of
 * the start, or within 2 s for a whole-second time, counts as during the computation.
 */
export function racy(time: bigint, start: bigint): boolean {
  return time >= start - (time % 1_000_000_000n === 0n ? 2_000_000_000n : 50_000_000n);
}

const statKey = (path: string): { key: string; mtime: bigint; ctime: bigint } | null => {
  const info = statSync(path, { bigint: true, throwIfNoEntry: false });
  return info ? { key: `${info.size}:${info.mtimeNs}:${info.ctimeNs}:${info.ino}`, ...times(info) } : null;
};
const times = (info: { mtimeNs: bigint; ctimeNs: bigint }) => ({ mtime: info.mtimeNs, ctime: info.ctimeNs });

function readHash(path: string): string | null {
  try {
    return sha256(readFileSync(path));
  } catch {
    return null;
  }
}

function realOf(path: string): string | null {
  try {
    return realpathSync.native(path);
  } catch {
    return null;
  }
}

/** A path relative to the app (`p:`) or the install root (`i:`), else absolute (`a:`). */
export function relocate(path: string, roots: Roots): string {
  if (within(path, roots.project)) return `p:${relative(roots.project, path)}`;
  if (within(path, roots.install)) return `i:${relative(roots.install, path)}`;
  return `a:${path}`;
}

export function locate(form: string, roots: Roots): string {
  const rest = form.slice(2);
  if (form.startsWith('p:')) return join(roots.project, rest);
  if (form.startsWith('i:')) return join(roots.install, rest);
  return rest;
}

const PLACED = '\u0000';

/** A JSON value with every absolute path inside the app or install root relocated, and back. */
export function relocateValue(value: unknown, roots: Roots): unknown {
  if (typeof value === 'string')
    return isAbsolute(value) && (within(value, roots.project) || within(value, roots.install))
      ? PLACED + relocate(value, roots)
      : value;
  if (Array.isArray(value)) return value.map((item) => relocateValue(item, roots));
  if (value && typeof value === 'object')
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, relocateValue(item, roots)]));
  return value;
}

export function locateValue(value: unknown, roots: Roots): unknown {
  if (typeof value === 'string') return value.startsWith(PLACED) ? locate(value.slice(1), roots) : value;
  if (Array.isArray(value)) return value.map((item) => locateValue(item, roots));
  if (value && typeof value === 'object')
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, locateValue(item, roots)]));
  return value;
}

/** The record of one path as it is now, or null when it changed during the computation that started at `since`. */
export function takeRead(path: string, kind: ReadKind, roots: Roots, since: bigint, hash?: string | null): Read | null {
  if (kind === 'present' || kind === 'absent') return { path: relocate(path, roots), kind };
  const target = kind === 'package' ? join(path, 'package.json') : path;
  const stat = statKey(target);
  if (stat && (racy(stat.mtime, since) || racy(stat.ctime, since))) return null;
  const read: Read = { path: relocate(path, roots), kind, stat: stat?.key ?? null };
  if (kind === 'dir') read.hash = hash ?? null;
  else if (stat) {
    read.hash = kind === 'module' ? (hash ?? null) : readHash(target);
    const real = kind === 'package' ? null : realOf(target);
    if (real) read.real = relocate(real, roots);
  }
  return read;
}

function listNames(path: string): string[] | null {
  try {
    return readdirSync(path)
      .map(String)
      .filter((name) => name !== '.DS_Store')
      .toSorted();
  } catch {
    return null;
  }
}

const listing = (path: string): string | null => {
  const names = listNames(path);
  return names && sha256(JSON.stringify(names));
};

export type Validity = 'stat' | 'content' | false;

/**
 * Whether a recorded read still holds: by its stat (size, mtime, ctime, inode), else by content, listing or
 * resolved path. A read that cannot be checked is invalid.
 */
export function checkRead(read: Read, roots: Roots): Validity {
  const path = locate(read.path, roots);
  if (read.kind === 'present') return statSync(path, { throwIfNoEntry: false }) ? 'stat' : false;
  if (read.kind === 'absent') return statSync(path, { throwIfNoEntry: false }) ? false : 'stat';
  const target = read.kind === 'package' ? join(path, 'package.json') : path;
  const stat = statKey(target);
  if ((stat?.key ?? null) === read.stat) return 'stat';
  if (!stat || read.stat === null || !read.hash) return false;
  if (read.kind === 'dir') return listing(path) === read.hash ? 'content' : false;
  if (read.real && relocate(realOf(target) ?? '', roots) !== read.real) return false;
  return readHash(target) === read.hash ? 'content' : false;
}

/** Install stamps of the app and the install root, and the lockfile, as reads. */
export function stampReads(roots: Roots, since: bigint): Read[] | null {
  const paths = [...new Set([roots.project, roots.install])].flatMap((dir) =>
    INSTALL_STAMPS.map((name) => join(dir, 'node_modules', name)),
  );
  paths.push(...LOCKFILES.map((name) => join(roots.install, name)));
  const reads: Read[] = [];
  for (const path of paths) {
    const read = takeRead(path, statSync(path, { throwIfNoEntry: false }) ? 'file' : 'absent', roots, since);
    if (!read) return null;
    reads.push(read);
  }
  for (const dir of [...new Set([roots.project, roots.install])].flatMap((root) =>
    PATCH_DIRS.map((name) => join(root, name)),
  )) {
    const names = listNames(dir);
    const read = takeRead(dir, names ? 'dir' : 'absent', roots, since, names && sha256(JSON.stringify(names)));
    if (!read) return null;
    reads.push(read);
    for (const name of names ?? []) {
      const file = takeRead(join(dir, name), 'file', roots, since);
      if (!file) return null;
      reads.push(file);
    }
  }
  return reads;
}

/**
 * The index directory of a checkout and layout: keyed by the git common dir and the app's path inside the work
 * tree, so every worktree of a repository shares it, or by the app's real path outside git.
 */
export function indexDir(platform: Platform, project: string, layout: Layout): string {
  const git = gitLocation(project);
  const identity = git
    ? [realOf(git.commonDir) ?? git.commonDir, relative(git.top, project).split(sep).join('/')]
    : [project];
  return join(fingerprintIndexDir(platform), sha256(canonicalJson([...identity, layout])));
}

/** Writes a file owner-only through a temporary file and a rename. */
export function writePrivate(path: string, text: string): void {
  const temp = `${path}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
  try {
    writeFileSync(temp, text, { mode: 0o600, flag: 'wx' });
    renameSync(temp, path);
  } finally {
    rmSync(temp, { force: true });
  }
}

function readJson(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
}

/** The record files of an index directory, newest first, those this checkout wrote ahead of a sibling's. */
export function recordFiles(dir: string): string[] {
  let names: string[];
  try {
    names = readdirSync(dir).filter((name) => /^r-\d+-[0-9a-f]{8}\.json$/.test(name));
  } catch {
    return [];
  }
  return names.toSorted((a, b) => b.length - a.length || (a < b ? 1 : a > b ? -1 : 0)).map((name) => join(dir, name));
}

export interface RecordKey {
  evaluator: string;
  runtime: string;
}

/** A record of the current format, schema, evaluators and runtime, or null. */
export function loadRecord(file: string, key: RecordKey): EvalRecord | null {
  const value = readJson(file);
  if (!value || typeof value !== 'object') return null;
  const record = value as Partial<EvalRecord>;
  return record.format === INDEX_FORMAT &&
    record.schema === FINGERPRINT_SCHEMA &&
    record.evaluator === key.evaluator &&
    record.runtime === key.runtime &&
    typeof record.checkout === 'string' &&
    Array.isArray(record.stamps) &&
    record.parts &&
    typeof record.parts === 'object' &&
    record.packages &&
    typeof record.packages === 'object'
    ? (record as EvalRecord)
    : null;
}

export function newRecord(key: RecordKey, checkout: string, stamps: Read[]): EvalRecord {
  return {
    format: INDEX_FORMAT,
    schema: FINGERPRINT_SCHEMA,
    ...key,
    checkout,
    writtenAtNs: '0',
    stamps,
    packages: {},
    closure: null,
    parts: {},
  };
}

/**
 * Writes a record owner-only, keeps the newest records of the directory and the newest directories of the
 * platform. Records hold the evaluated config, which can carry values derived from secrets. A failure to write
 * leaves the key unaffected.
 */
let lastWritten = 0n;

export function writeRecord(dir: string, record: EvalRecord, tag: string): void {
  try {
    const created = statSync(dir, { throwIfNoEntry: false }) === undefined;
    ensurePrivateDir(dir);
    lastWritten = nowNs() > lastWritten ? nowNs() : lastWritten + 1n;
    const writtenAtNs = String(lastWritten);
    writePrivate(join(dir, `r-${writtenAtNs}-${tag}.json`), JSON.stringify({ ...record, writtenAtNs }));
    for (const file of recordFiles(dir).slice(RECORDS_PER_DIR)) rmSync(file, { force: true });
    if (created) evictDirs(join(dir, '..'));
  } catch {}
}

function evictDirs(platformDir: string): void {
  const dirs = readdirSync(platformDir).map((name) => {
    const path = join(platformDir, name);
    return { path, mtime: statSync(path, { throwIfNoEntry: false })?.mtimeMs ?? 0 };
  });
  for (const { path } of dirs.toSorted((a, b) => b.mtime - a.mtime).slice(DIRS_PER_PLATFORM))
    rmSync(path, { recursive: true, force: true });
}

/** Removes every record of an index directory, as a disagreeing verification does. */
export function dropRecords(dir: string): void {
  rmSync(dir, { recursive: true, force: true });
}

/**
 * Content hashes of the walked files of one checkout, by stat. An entry is added only when the file had not changed
 * since the computation started, so an edit racing the hash is rehashed next time.
 */
export class FileHashes {
  private readonly file: string;
  private readonly entries: Record<string, [string, string]>;
  private dirty = false;
  private readonly roots: Roots;
  private readonly since: bigint;

  constructor(dir: string, roots: Roots, since: bigint) {
    this.roots = roots;
    this.since = since;
    this.file = join(dir, `h-${sha256(roots.project).slice(0, 16)}.json`);
    const value = readJson(this.file);
    this.entries = value && typeof value === 'object' ? (value as Record<string, [string, string]>) : {};
  }

  hash(path: string, compute: () => string): string {
    const info = statSync(path, { bigint: true, throwIfNoEntry: false });
    if (!info) return compute();
    const key = `${info.size}:${info.mtimeNs}:${info.ctimeNs}:${info.ino}`;
    const form = relocate(path, this.roots);
    const known = this.entries[form];
    if (known?.[0] === key) return known[1];
    const hash = compute();
    if (!racy(info.mtimeNs, this.since) && !racy(info.ctimeNs, this.since)) {
      this.entries[form] = [key, hash];
      this.dirty = true;
    }
    return hash;
  }

  save(dir: string): void {
    if (!this.dirty) return;
    try {
      ensurePrivateDir(dir);
      writePrivate(this.file, JSON.stringify(this.entries));
    } catch {}
  }
}

/** Writes the env a workspace computed its fingerprint under, owner-only, when it changed; returns its digest. */
export function writeWorkspaceEnv(project: string, env: Record<string, string>): string {
  const text = canonicalJson(env);
  const digest = sha256(text);
  const file = workspaceEnvFile(project);
  try {
    if (readHash(file) !== digest) {
      ensurePrivateDir(fingerprintEnvDir());
      writePrivate(file, text);
    }
  } catch {}
  return digest;
}

export const workspaceEnvFile = (project: string): string => join(fingerprintEnvDir(), `${sha256(project)}.json`);

/** The env a workspace last computed its fingerprint under, with its digest, or null. */
export function readWorkspaceEnv(project: string): { env: Record<string, string>; digest: string } | null {
  let text: string;
  try {
    text = readFileSync(workspaceEnvFile(project), 'utf8');
  } catch {
    return null;
  }
  const env = readJson(workspaceEnvFile(project));
  if (!env || typeof env !== 'object' || Object.values(env).some((value) => typeof value !== 'string')) return null;
  return { env: env as Record<string, string>, digest: sha256(text) };
}

const checkoutTag = (project: string) => sha256(project).slice(0, 8);

const mtime = (path: string) => statSync(path, { throwIfNoEntry: false })?.mtimeMs;

/**
 * A patch or the lockfile written after the newest install stamp, which an install has not applied yet; null when
 * every one is older, or no package manager wrote a stamp to compare with.
 */
export function newerThanInstall(roots: Roots): string | null {
  const dirs = [...new Set([roots.project, roots.install])];
  const stamps = dirs.flatMap((dir) => INSTALL_STAMPS.flatMap((name) => mtime(join(dir, 'node_modules', name)) ?? []));
  if (stamps.length === 0) return null;
  const installed = Math.max(...stamps);
  const inputs = [
    ...LOCKFILES.map((name) => join(roots.install, name)),
    ...dirs.flatMap((dir) =>
      PATCH_DIRS.flatMap((name) => (listNames(join(dir, name)) ?? []).map((file) => join(dir, name, file))),
    ),
  ];
  return inputs.find((path) => (mtime(path) ?? 0) > installed) ?? null;
}

/** Whether any package manager's install stamp exists for the app, so it covers what an install writes. */
export function installStamped(roots: Roots): boolean {
  return [roots.project, roots.install].some((dir) =>
    INSTALL_STAMPS.some((name) => statSync(join(dir, 'node_modules', name), { throwIfNoEntry: false })),
  );
}

/**
 * The reads of one evaluator part from its trace. A read inside an install tree (a path through `node_modules` in the
 * app or install root whose nearest existing real path stays under `node_modules`) is left to the install stamps
 * when the package manager writes one, else collapses to its package's `package.json`; a hand edit inside an
 * installed package is out of the key. A workspace link resolves outside `node_modules` and keeps its own reads.
 * Null when a read changed during the computation.
 */
export function traceReads(
  entries: Iterable<{ path: string; kind: ReadKind; hash?: string | null }>,
  roots: Roots,
  since: bigint,
  stamped: boolean,
  packageRoot: (path: string) => string | null,
): Read[] | null {
  const reads = new Map<string, Read>();
  const reals = new Map<string, string | null>();
  const real = (path: string): string | null => {
    if (!reals.has(path)) {
      const found = realOf(path);
      const parent = join(path, '..');
      reals.set(path, found ?? (parent === path ? null : real(parent)));
    }
    return reals.get(path) ?? null;
  };
  for (const { path, kind, hash } of entries) {
    const inside = within(path, roots.project) || within(path, roots.install);
    const anchor = packageRoot(path) ?? path;
    const installed =
      inside &&
      path.split(sep).includes('node_modules') &&
      (real(anchor)?.split(sep).includes('node_modules') ?? false);
    if (installed && stamped) continue;
    const [target, as]: [string, ReadKind] = installed ? [anchor, realOf(anchor) ? 'package' : 'absent'] : [path, kind];
    const id = `${as}\0${target}`;
    if (reads.has(id)) continue;
    const read = takeRead(target, as, roots, since, installed ? undefined : hash);
    if (!read) return null;
    reads.set(id, read);
  }
  return [...reads.values()];
}

/**
 * One computation's view of an index directory: the newest records that still hold, part by part, the package
 * facts and the entry-point closure valid under the install stamps, and the record written at the end.
 */
export class IndexSession {
  readonly hashes: FileHashes;
  private readonly loaded: { record: EvalRecord; stamps: boolean }[] = [];
  private files: string[] | null = null;
  private readonly parts: Record<string, PartRecord> = {};
  private readonly packages: Record<string, PackageEntry> = {};
  private closureEntry: EvalRecord['closure'] = null;
  private fresh = false;
  private sibling = false;

  readonly dir: string;
  readonly since: bigint;
  readonly stamped: boolean;
  private readonly roots: Roots;
  private readonly key: RecordKey;

  constructor(dir: string, roots: Roots, key: RecordKey, since: bigint) {
    this.dir = dir;
    this.roots = roots;
    this.key = key;
    this.since = since;
    this.stamped = installStamped(roots);
    this.hashes = new FileHashes(dir, roots, since);
  }

  private record(index: number): { record: EvalRecord; stamps: boolean } | null {
    this.files ??= recordFiles(this.dir).toSorted((a, b) => {
      const own = `-${checkoutTag(this.roots.project)}.json`;
      return Number(b.endsWith(own)) - Number(a.endsWith(own));
    });
    while (this.loaded.length <= index && this.loaded.length < this.files.length) {
      const record = loadRecord(this.files[this.loaded.length] ?? '', this.key);
      const stamps = record !== null && record.stamps.every((read) => checkRead(read, this.roots) !== false);
      this.loaded.push(record ? { record, stamps } : { record: newRecord(this.key, '', []), stamps: false });
    }
    return this.loaded[index] ?? null;
  }

  /** The newest record whose install stamps still hold, which the package facts and closure come from. */
  private base(): EvalRecord | null {
    for (let index = 0; this.record(index); index++) {
      const loaded = this.record(index);
      if (loaded?.stamps) return loaded.record;
    }
    return null;
  }

  private holds(reads: Read[]): boolean {
    for (const [index, read] of reads.entries()) {
      const validity = checkRead(read, this.roots);
      if (!validity) return false;
      if (validity === 'content') {
        const kind = read.kind;
        const refreshed = takeRead(locate(read.path, this.roots), kind, this.roots, this.since, read.hash);
        if (refreshed) reads[index] = { ...refreshed, hash: read.hash };
        this.sibling = true;
      }
    }
    return true;
  }

  /** A recorded part whose env digests and reads all hold, with its paths placed in this checkout. */
  part(slot: string, envDigest: (name: string) => string | null): PartRecord | null {
    for (let index = 0; this.record(index); index++) {
      const loaded = this.record(index);
      const recorded = loaded?.stamps ? loaded.record.parts[slot] : undefined;
      if (!recorded) continue;
      if (!recorded.env.every(([name, hash]) => envDigest(name) === hash)) continue;
      if (!this.holds(recorded.reads)) continue;
      if (loaded?.record.checkout !== this.roots.project) this.sibling = true;
      this.parts[slot] = recorded;
      return {
        ...recorded,
        output: locateValue(recorded.output, this.roots),
        derived: { ...recorded.derived, packages: recorded.derived.packages.map((dir) => locate(dir, this.roots)) },
      };
    }
    return null;
  }

  /** Keeps a part computed now; its derived packages are absolute and are stored relocated. */
  keep(slot: string, part: PartRecord): void {
    this.fresh = true;
    this.parts[slot] = {
      ...part,
      output: relocateValue(part.output, this.roots),
      derived: { ...part.derived, packages: part.derived.packages.map((dir) => relocate(dir, this.roots)) },
    };
  }

  private known(form: string): PackageEntry | null {
    const known = this.packages[form] ?? this.base()?.packages[form];
    if (!known || !this.holds([known.read])) return null;
    return (this.packages[form] = known);
  }

  /** The facts about an installed package this record keeps, valid while its `package.json` holds. */
  pkg(dir: string): PackageEntry {
    const form = relocate(dir, this.roots);
    const known = this.known(form);
    if (known) return known;
    const read = takeRead(dir, 'package', this.roots, this.since);
    const entry: PackageEntry = { read: read ?? { path: form, kind: 'package', stat: null, hash: null } };
    if (read) {
      this.fresh = true;
      this.packages[form] = entry;
    }
    return entry;
  }

  /** The entry points and their dependencies, kept while every one of their `package.json` files holds. */
  closure(compute: () => { dirs: string[]; missing: string[] }): { dirs: string[]; missing: string[] } {
    const known = this.closureEntry ?? this.base()?.closure;
    if (known && known.dirs.every((form) => this.known(form))) {
      this.closureEntry = known;
      return { dirs: known.dirs.map((dir) => locate(dir, this.roots)), missing: known.missing };
    }
    const computed = compute();
    this.closureEntry = { dirs: computed.dirs.map((dir) => relocate(dir, this.roots)), missing: computed.missing };
    this.fresh = true;
    return computed;
  }

  /** Writes the record when this computation added or refreshed anything, and the file-hash cache. */
  save(): void {
    this.hashes.save(this.dir);
    if (!this.fresh && !this.sibling) return;
    const base = this.base();
    const stamps =
      base?.checkout === this.roots.project && !this.sibling ? base.stamps : stampReads(this.roots, this.since);
    if (!stamps) return;
    const record = newRecord(this.key, this.roots.project, stamps);
    record.parts = { ...base?.parts, ...this.parts };
    record.packages = this.packages;
    record.closure = this.closureEntry;
    writeRecord(this.dir, record, checkoutTag(this.roots.project));
  }
}
