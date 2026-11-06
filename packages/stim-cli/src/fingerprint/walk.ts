import {
  closeSync,
  openSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  readSync,
  realpathSync,
  statSync,
} from 'node:fs';
import type { Dirent } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, isAbsolute, join, relative, sep } from 'node:path';
import { byCodeUnit, canonicalJson, sha256, type Input, type Uncertain } from './key.ts';

export interface Roots {
  /** Real path of the app. */
  project: string;
  /** Real path of the nearest directory at or above the app that holds a lockfile; the app when none does. */
  install: string;
}

interface Pattern {
  negate: boolean;
  dirOnly: boolean;
  regex: RegExp;
}

const LIMITS = { files: 50_000, bytes: 2 * 1024 ** 3 };
const CHUNK = 1024 * 1024;
const GRADLE_SCRIPTS = new Set(['build.gradle', 'build.gradle.kts', 'settings.gradle', 'settings.gradle.kts']);

const BUILT_IN = compileIgnore(
  [
    'DerivedData/',
    'xcuserdata/',
    '.xcode.env.local',
    '**/vendor/bundle/',
    '.gradle/',
    '.cxx/',
    '.kotlin/',
    '.idea/',
    'local.properties',
    'gradlew.bat',
    '.DS_Store',
    '.expo/',
    '.git',
    '.watchman-cookie-*',
    'node_modules/',
  ].join('\n'),
);

const SIGNING = compileIgnore(
  [
    '*.p8',
    '*.p12',
    '*.mobileprovision',
    '*.provisionprofile',
    '*.keystore',
    '*.jks',
    '*.pfx',
    'keystore.properties',
    '!debug.keystore',
    '!**/src/*/assets/**',
    '!**/src/*/res/**',
  ].join('\n'),
);

function globSource(glob: string): string {
  let out = '';
  for (let i = 0; i < glob.length; i++) {
    const char = glob.charAt(i);
    if (char === '*' && glob[i + 1] === '*') {
      const atStart = i === 0 || glob[i - 1] === '/';
      const atEnd = i + 2 === glob.length;
      if (atStart && glob[i + 2] === '/') {
        out += '(?:.*/)?';
        i += 2;
        continue;
      }
      if (atStart && atEnd) {
        out += '.*';
        i += 1;
        continue;
      }
    }
    if (char === '*') out += '[^/]*';
    else if (char === '?') out += '[^/]';
    else if (char === '\\') {
      const next = glob.charAt(++i);
      out += /[.*+?^${}()|[\]\\/]/.test(next) ? `\\${next}` : next;
    } else if (char === '[') {
      const close = glob.indexOf(']', i + 2);
      if (close === -1) out += '\\[';
      else {
        const body = glob
          .slice(i + 1, close)
          .replace(/^!/, '^')
          .replace(/\\/g, '\\\\');
        out += `[${body}]`;
        i = close;
      }
    } else out += /[.+^${}()|\]\\/]/.test(char) ? `\\${char}` : char;
  }
  return out;
}

/**
 * `.fingerprintignore` patterns with gitignore semantics: `#` starts a comment, `!` re-includes, a trailing `/` matches
 * directories only, any other `/` anchors the pattern to the list's base, `**` crosses directories, and the last
 * matching pattern wins.
 */
export function compileIgnore(text: string): Pattern[] {
  const patterns: Pattern[] = [];
  for (const raw of text.split(/\r?\n/)) {
    let line = raw.replace(/(?<!\\)\s+$/, '');
    if (!line || line.startsWith('#')) continue;
    const negate = line.startsWith('!');
    if (negate) line = line.slice(1);
    else if (line.startsWith('\\!') || line.startsWith('\\#')) line = line.slice(1);
    const dirOnly = line.endsWith('/');
    if (dirOnly) line = line.slice(0, -1);
    const anchored = line.includes('/');
    line = line.replace(/^\//, '');
    if (!line || /(?<!\\)(?:\\\\)*\\$/.test(line)) continue;
    try {
      patterns.push({ negate, dirOnly, regex: new RegExp(`^${anchored ? '' : '(?:.*/)?'}${globSource(line)}$`) });
    } catch {}
  }
  return patterns;
}

/** Whether the last pattern matching `path` excludes it; undefined when none matches. */
function matchIgnore(patterns: readonly Pattern[], path: string, isDir: boolean): boolean | undefined {
  let result: boolean | undefined;
  for (const pattern of patterns) {
    if (pattern.dirOnly && !isDir) continue;
    if (pattern.regex.test(path)) result = !pattern.negate;
  }
  return result;
}

const toPosix = (path: string) => path.split(sep).join('/');

export function within(path: string, dir: string): boolean {
  const rel = relative(dir, path);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

/**
 * A row name that does not depend on where the checkout or the package store lives: `npm:<name>/<subpath>` inside an
 * installed package, relative inside the app, `<install>/<rel>` inside the install root, else a hash of the path.
 */
export function pathForm(path: string, roots: Roots): string {
  const inside = within(path, roots.install);
  const segments = toPosix(inside ? relative(roots.install, path) : path).split('/');
  const modules = segments.lastIndexOf('node_modules');
  if (modules !== -1 && segments[modules + 1]) return `npm:${segments.slice(modules + 1).join('/')}`;
  if (within(path, roots.project)) return toPosix(relative(roots.project, path)) || '.';
  if (inside) return `<install>/${toPosix(relative(roots.install, path))}`;
  return `outside:${sha256(path)}`;
}

function realOrNull(path: string): string | null {
  try {
    return realpathSync.native(path);
  } catch {
    return null;
  }
}

/**
 * The parts of a package a native build reads: the paths its autolinking entry names, top-level podspecs, `ios/`,
 * `apple/`, `android/` and `cpp/`, any other top-level directory its podspecs or Android build files mention, its
 * codegen spec directory and its native manifests. The whole package when none of those exist.
 */
export function nativeSubset(root: string, named: readonly string[] = []): string[] {
  const entries = readdirSync(root);
  const sources = [
    ...named,
    ...entries.filter((name) => name.endsWith('.podspec')).map((name) => join(root, name)),
    ...['ios', 'apple', 'android', 'cpp'].filter((name) => entries.includes(name)).map((name) => join(root, name)),
  ];
  if (sources.length === 0) return [root];
  const buildFiles = [
    ...entries.filter((name) => name.endsWith('.podspec')),
    ...['build.gradle', 'build.gradle.kts', 'CMakeLists.txt'].map((name) => join('android', name)),
  ]
    .map((name) => {
      try {
        return readFileSync(join(root, name), 'utf8');
      } catch {
        return '';
      }
    })
    .join('\n');
  for (const name of entries) {
    const path = join(root, name);
    if (sources.includes(path) || name === 'node_modules' || !statSync(path, { throwIfNoEntry: false })?.isDirectory())
      continue;
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    if (new RegExp(`(?:^|[^\\w.-])${escaped}/`).test(buildFiles)) sources.push(path);
  }
  let manifest: unknown = null;
  try {
    manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  } catch {}
  const codegen = field(field(manifest, 'codegenConfig'), 'jsSrcsDir');
  if (typeof codegen === 'string') sources.push(join(root, codegen));
  for (const name of ['package.json', 'react-native.config.js', 'expo-module.config.json'])
    if (entries.includes(name)) sources.push(join(root, name));
  return sources;
}

export const field = (value: unknown, key: string): unknown =>
  value && typeof value === 'object' && key in value ? Reflect.get(value, key) : undefined;

export interface WalkOptions {
  roots: Roots;
  /** Directories and files to hash; directories are walked. A path that does not exist adds nothing. */
  trees: readonly string[];
  /** The project's `.fingerprintignore`, matched against paths relative to the app. */
  ignore?: readonly Pattern[];
  /** Real paths git tracks, or null outside a git work tree. */
  tracked: ReadonlySet<string> | null;
  /** Paths never walked, whatever the patterns say. */
  skip?: readonly string[];
  /** Paths that are inputs only while git tracks them or a file under them. */
  trackedOnly?: readonly string[];
  keepSigningFiles?: boolean;
  /** Files hashed after a transform of their bytes, by real path. */
  transforms?: ReadonlyMap<string, (bytes: Buffer) => Buffer | string>;
  limits?: { files: number; bytes: number };
}

export interface WalkResult {
  inputs: Input[];
  portable: boolean;
}

class LimitExceeded extends Error {}
class AppLink extends Error {}

type Sink = (path: string, hash: string, outside: boolean) => void;

/**
 * File rows for every file under the trees. Built-in excludes apply relative to each tree, then `.fingerprintignore`
 * relative to the app. A symlink row covers its link text and its target: a directory target inside the project or
 * install root is walked as one more tree, and any target outside both is hashed into an `outside:` row that makes the
 * result non-portable.
 */
export function walk(options: WalkOptions): WalkResult | Uncertain {
  const { roots, tracked } = options;
  const limits = options.limits ?? LIMITS;
  const builtIn = options.keepSigningFiles ? BUILT_IN : [...SIGNING, ...BUILT_IN];
  const trackedOnly = new Set(options.trackedOnly ?? []);
  const skipped = new Set(options.skip ?? []);
  const trackedDirs = new Set<string>();
  for (const path of tracked ?? [])
    for (let dir = dirname(path); !trackedDirs.has(dir) && dirname(dir) !== dir; dir = dirname(dir))
      trackedDirs.add(dir);
  const inputs: Input[] = [];
  let portable = true;
  let files = 0;
  let bytes = 0;
  const walked = new Set<string>();
  const outsideDigests = new Map<string, string>();
  const queue = [...options.trees];

  const hashFile = (path: string, size: number): string => {
    files += 1;
    bytes += size;
    if (files > limits.files || bytes > limits.bytes) throw new LimitExceeded();
    const transform = options.transforms?.get(path);
    if (transform) return sha256(transform(readFileSync(path)));
    const hash = createHash('sha256');
    const buffer = Buffer.allocUnsafe(Math.min(CHUNK, Math.max(size, 1)));
    const fd = openSync(path, 'r');
    try {
      for (let read = readSync(fd, buffer); read > 0; read = readSync(fd, buffer))
        hash.update(buffer.subarray(0, read));
    } finally {
      closeSync(fd);
    }
    return hash.digest('hex');
  };

  const isTracked = (path: string, isDir: boolean) =>
    tracked !== null && (isDir ? trackedDirs.has(path) : tracked.has(path));

  const excluded = (path: string, tree: string, isDir: boolean, siblings: readonly string[]): boolean => {
    const name = path.slice(path.lastIndexOf(sep) + 1);
    if ((isDir && path === roots.project) || skipped.has(path)) return true;
    if (trackedOnly.has(path) || (isDir && name.endsWith('.xcworkspace'))) return !isTracked(path, isDir);
    const generated =
      isDir &&
      ((name === 'build' &&
        siblings.some((n) => GRADLE_SCRIPTS.has(n) || n === 'Podfile' || n.endsWith('.xcodeproj'))) ||
        (name === 'Pods' && siblings.includes('Podfile')));
    const inTree = toPosix(relative(tree, path));
    const own = within(path, roots.project)
      ? matchIgnore(options.ignore ?? [], toPosix(relative(roots.project, path)), isDir)
      : undefined;
    return own ?? (generated || (matchIgnore(builtIn, inTree, isDir) ?? false));
  };

  const ignoredAncestor = (path: string): boolean => {
    if (!within(path, roots.project)) return false;
    const parts = toPosix(relative(roots.project, path)).split('/').slice(0, -1);
    return parts.some((_, i) => matchIgnore(options.ignore ?? [], parts.slice(0, i + 1).join('/'), true) === true);
  };

  const link = (path: string, sink: Sink): void => {
    const text = readlinkSync(path);
    const target = realOrNull(path);
    const stat = target ? statSync(target, { throwIfNoEntry: false }) : undefined;
    const inside = target !== null && (within(target, roots.project) || within(target, roots.install));
    if (!target || !stat) sink(path, sha256(canonicalJson(['symlink', text, null])), false);
    else if (stat.isDirectory() && inside) {
      if (within(roots.project, target)) throw new AppLink(path);
      sink(path, sha256(canonicalJson(['symlink', text])), false);
      queue.push(target);
    } else if (stat.isDirectory()) {
      sink(path, sha256(canonicalJson(['symlink', text, outsideDigest(target)])), true);
    } else if (stat.isFile()) {
      sink(path, sha256(canonicalJson(['symlink', text, hashFile(target, stat.size)])), !inside);
    } else sink(path, sha256(canonicalJson(['symlink', text, null])), !inside);
  };

  const visit = (dir: string, tree: string, sink: Sink): void => {
    const entries: Dirent[] = readdirSync(dir, { withFileTypes: true }).toSorted((a, b) => byCodeUnit(a.name, b.name));
    const names = entries.map((entry) => entry.name);
    for (const entry of entries) {
      const path = join(dir, entry.name);
      const isLink = entry.isSymbolicLink();
      const isDir =
        entry.isDirectory() || (isLink && (statSync(path, { throwIfNoEntry: false })?.isDirectory() ?? false));
      if (excluded(path, tree, isDir, names)) continue;
      if (isLink) link(path, sink);
      else if (isDir) visit(path, tree, sink);
      else if (entry.isFile()) sink(path, hashFile(path, statSync(path).size), false);
    }
  };

  const outsideDigest = (dir: string): string => {
    const known = outsideDigests.get(dir);
    if (known !== undefined) return known;
    outsideDigests.set(dir, 'cycle');
    const rows: [string, string][] = [];
    visit(dir, dir, (path, hash) => rows.push([toPosix(relative(dir, path)), hash]));
    const digest = sha256(canonicalJson(rows.toSorted(([a], [b]) => byCodeUnit(a, b))));
    outsideDigests.set(dir, digest);
    return digest;
  };

  const row: Sink = (path, hash, outside) => {
    const name = pathForm(path, roots);
    if (outside || name.startsWith('outside:')) portable = false;
    const input: Input = { name: outside ? `outside:${sha256(name)}` : name, kind: 'file', hash };
    if (isTracked(path, false)) input.git = 'tracked';
    inputs.push(input);
  };

  try {
    for (const path of queue.splice(0).toSorted(byCodeUnit)) queue.push(path);
    while (queue.length > 0) {
      const tree = queue.shift() ?? '';
      const real = realOrNull(tree);
      if (!real || walked.has(real)) continue;
      walked.add(real);
      const stat = statSync(real);
      if (
        real !== roots.project &&
        (excluded(real, dirname(real), stat.isDirectory(), readdirSync(dirname(real))) || ignoredAncestor(real))
      )
        continue;
      if (stat.isDirectory()) visit(real, real, row);
      else if (stat.isFile()) row(real, hashFile(real, stat.size), false);
    }
  } catch (error) {
    if (error instanceof LimitExceeded)
      return {
        uncertain: `the fingerprint inputs exceed ${limits.files} files or ${limits.bytes} bytes`,
        remedy: 'Exclude generated output with .fingerprintignore.',
      };
    if (error instanceof AppLink)
      return { uncertain: `${error.message} links to the app directory or a directory that contains it` };
    throw error;
  }
  return { inputs, portable };
}
