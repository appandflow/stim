import { createHash } from 'crypto';
import {
  existsSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  renameSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'fs';
import { join } from 'path';

const CHECKSUMS_HEADER = 'SPEC CHECKSUMS:\n';
const GENERATED_DIRS = ['Target Support Files', 'Pods.xcodeproj', 'Local Podspecs'];

export type PodRelocation = { ok: true; pods: string[] } | { ok: false };

function normalize(text: string): string {
  return text.replace(/\r\n/g, '\n').trimEnd() + '\n';
}

function splitChecksums(text: string): { before: string; entries: Map<string, string>; after: string } | null {
  const start = text.indexOf(`\n${CHECKSUMS_HEADER}`);
  if (start === -1) return null;
  const bodyStart = start + 1 + CHECKSUMS_HEADER.length;
  const lines = text.slice(bodyStart).split('\n');
  const entries = new Map<string, string>();
  let used = 0;
  for (const line of lines) {
    const match = /^ {2}"?([^":\s]+)"?: ([0-9a-f]{40})$/.exec(line);
    if (!match) break;
    entries.set(match[1] as string, match[2] as string);
    used += line.length + 1;
  }
  return { before: text.slice(0, bodyStart), entries, after: text.slice(bodyStart + used) };
}

function pathPattern(root: string, flags = ''): RegExp {
  const escaped = root.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(?:(?<![\\w.-])|(?<=-[IFL]))${escaped}(?![\\w.-])`, flags);
}

function sha1(text: string): string {
  return createHash('sha1').update(text).digest('hex');
}

export function relocatePath(text: string, from: string, to: string): string {
  return text.replace(pathPattern(from, 'g'), () => to);
}

/**
 * Decides whether a carried Pods directory differs from the checkout's Podfile.lock only by
 * checksums of podspecs that embed the source checkout's absolute path. Any other difference,
 * a missing podspec, a podspec that does not embed the path, or a carried checksum that does
 * not match the carried podspec refuses.
 */
export function planPodsRelocation({
  podfileLock,
  manifest,
  sourceRoot,
  readPodspec,
}: {
  podfileLock: string;
  manifest: string;
  sourceRoot: string;
  readPodspec: (pod: string) => string | null;
}): PodRelocation {
  const lock = splitChecksums(normalize(podfileLock));
  const carried = splitChecksums(normalize(manifest));
  if (!lock || !carried) return { ok: false };
  if (lock.before !== carried.before || lock.after !== carried.after) return { ok: false };
  if (lock.entries.size !== carried.entries.size) return { ok: false };
  const pods: string[] = [];
  for (const [pod, checksum] of lock.entries) {
    const carriedChecksum = carried.entries.get(pod);
    if (carriedChecksum === undefined) return { ok: false };
    if (carriedChecksum === checksum) continue;
    if (!/^[\w.+-]+$/.test(pod)) return { ok: false };
    const podspec = readPodspec(pod);
    if (podspec === null || sha1(podspec) !== carriedChecksum) return { ok: false };
    if (!pathPattern(sourceRoot).test(podspec)) return { ok: false };
    pods.push(pod);
  }
  return pods.length > 0 ? { ok: true, pods } : { ok: false };
}

function walkTextFiles(dir: string, visit: (file: string) => void): void {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) walkTextFiles(path, visit);
    else if (entry.isFile()) visit(path);
  }
}

function findPath(dir: string, needle: Buffer): string | null {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isSymbolicLink() && Buffer.from(readlinkSync(path)).includes(needle)) return path;
    if (entry.isDirectory()) {
      const found = findPath(path, needle);
      if (found) return found;
    } else if (entry.isFile() && readFileSync(path).includes(needle)) return path;
  }
  return null;
}

function walkSymlinks(dir: string, visit: (link: string) => void): void {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isSymbolicLink()) visit(path);
    else if (entry.isDirectory()) walkSymlinks(path, visit);
  }
}

/**
 * Makes a Pods directory cloned from `sourceRoot` read as one CocoaPods generated for
 * `targetRoot`: it rewrites the source path in the generated text files and absolute symlinks,
 * then points Pods/Manifest.lock at the checkout's Podfile.lock. The lock files are written
 * last, and only after no file or symlink in Pods names the source path, so an interrupted or incomplete run leaves them differing and `pod install` still runs.
 */
export function relocatePods({
  podsDir,
  podfileLockPath,
  sourceRoot,
  targetRoot,
}: {
  podsDir: string;
  podfileLockPath: string;
  sourceRoot: string;
  targetRoot: string;
}): PodRelocation {
  const manifestPath = join(podsDir, 'Manifest.lock');
  if (!existsSync(manifestPath) || !existsSync(podfileLockPath)) return { ok: false };
  const podfileLock = readFileSync(podfileLockPath, 'utf-8');
  const plan = planPodsRelocation({
    podfileLock,
    manifest: readFileSync(manifestPath, 'utf-8'),
    sourceRoot,
    readPodspec: (pod) => {
      try {
        return readFileSync(join(podsDir, 'Local Podspecs', `${pod}.podspec.json`), 'utf-8');
      } catch {
        return null;
      }
    },
  });
  if (!plan.ok) return plan;

  const pattern = pathPattern(sourceRoot);
  for (const name of GENERATED_DIRS) {
    const dir = join(podsDir, name);
    if (!existsSync(dir)) continue;
    walkTextFiles(dir, (file) => {
      const buffer = readFileSync(file);
      if (buffer.includes(0)) return;
      const text = buffer.toString('utf-8');
      if (!pattern.test(text)) return;
      writeFileSync(file, relocatePath(text, sourceRoot, targetRoot));
    });
  }
  walkSymlinks(podsDir, (link) => {
    const target = readlinkSync(link);
    if (!pattern.test(target)) return;
    const next = `${link}.stim-relocate`;
    symlinkSync(relocatePath(target, sourceRoot, targetRoot), next);
    try {
      renameSync(next, link);
    } catch (error) {
      unlinkSync(next);
      throw error;
    }
  });
  const leftover = findPath(podsDir, Buffer.from(sourceRoot));
  if (leftover) throw new Error(`${leftover} still names ${sourceRoot}`);
  writeFileSync(manifestPath, podfileLock);
  return plan;
}
