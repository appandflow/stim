// Legacy oracle from https://github.com/appandflow/stim/commit/6c5ef3bfcde179bcfe1f9d9186c399d3e313d44f.
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, join, posix, resolve } from 'node:path';
import type { Options as FingerprintOptions } from '@expo/fingerprint';
import { pathPattern, sha1, splitChecksums } from '../workspace/pods-relocate.ts';

type FileHook = NonNullable<FingerprintOptions['fileHookTransform']>;

const CHECKOUT_PLACEHOLDER = '<stim-checkout>';
const CHECKSUM_LINE = /^( {2}"?)([^":\s]+)("?: )([0-9a-f]{40})$/gm;

function checkoutRootOf(dir: string): string | null {
  for (let current = dir; ; current = dirname(current)) {
    if (existsSync(join(current, '.git'))) return current;
    if (dirname(current) === current) return null;
  }
}

function checkoutRoots(projectRoot: string): string[] {
  const given = resolve(projectRoot);
  let real = given;
  try {
    real = realpathSync(given);
  } catch {}
  const candidates = [given, real];
  for (const start of [given, real]) {
    const top = checkoutRootOf(start);
    if (top) candidates.push(top);
  }
  return [...new Set(candidates)].toSorted((a, b) => b.length - a.length);
}

/**
 * `text` with the checksum of each pod whose podspec names the checkout path replaced by the checksum of that podspec
 * with the path neutralized. Only a checksum equal to the sha1 of its own podspec is replaced.
 */
function canonicalPodfileLock(text: string, podsDir: string, projectRoot: string): string {
  const parsed = splitChecksums(text);
  if (!parsed) return text;
  let patterns: RegExp[] | null = null;
  const replaced = new Map<string, string>();
  for (const [pod, checksum] of parsed.entries) {
    if (!/^[\w.+-]+$/.test(pod)) continue;
    let podspec: string;
    try {
      podspec = readFileSync(join(podsDir, 'Local Podspecs', `${pod}.podspec.json`), 'utf-8');
    } catch {
      continue;
    }
    if (sha1(podspec) !== checksum) continue;
    patterns ??= checkoutRoots(projectRoot).map((root) => pathPattern(root, 'g'));
    const neutral = patterns.reduce((value, pattern) => value.replace(pattern, () => CHECKOUT_PLACEHOLDER), podspec);
    if (neutral !== podspec) replaced.set(pod, sha1(neutral));
  }
  if (replaced.size === 0) return text;
  const blockEnd = text.length - parsed.after.length;
  const block = text
    .slice(parsed.before.length, blockEnd)
    .replace(CHECKSUM_LINE, (line, open: string, pod: string, close: string) => {
      const checksum = replaced.get(pod);
      return checksum === undefined ? line : `${open}${pod}${close}${checksum}`;
    });
  return text.slice(0, parsed.before.length) + block + text.slice(blockEnd);
}

function podfileLockPath(iosProjectPath: string): string {
  return posix.normalize(posix.join(iosProjectPath, 'Podfile.lock'));
}

/**
 * A `fileHookTransform` that hashes the project's Podfile.lock through `canonicalPodfileLock`, so two checkouts of one
 * commit that each ran `pod install` fingerprint alike. @expo/fingerprint calls a hook with the file in chunks and
 * drops a null result, so the file is held until its last chunk. A hook from the project's fingerprint.config.js sees
 * every chunk first, and its output is what gets canonicalized.
 */
export function podfileLockHook(projectRoot: string, iosProjectPath: string, projectHook?: FileHook): FileHook {
  const target = podfileLockPath(iosProjectPath);
  const held = new WeakMap<object, Buffer[]>();
  const hook: FileHook = (source, chunk, isEndOfFile, encoding) => {
    const output = projectHook ? projectHook(source, chunk, isEndOfFile, encoding) : chunk;
    if (source.type !== 'file' || source.filePath !== target) return output;
    const parts = held.get(source) ?? [];
    held.set(source, parts);
    if (output !== null)
      parts.push(
        typeof output === 'string' ? Buffer.from(output, Buffer.isEncoding(encoding) ? encoding : 'utf8') : output,
      );
    if (!isEndOfFile) return null;
    held.delete(source);
    const bytes = Buffer.concat(parts);
    const text = bytes.toString('utf-8');
    const canonical = canonicalPodfileLock(text, join(projectRoot, iosProjectPath, 'Pods'), projectRoot);
    return canonical === text ? bytes : canonical;
  };
  return hook;
}
