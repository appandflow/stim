import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { pathPattern, sha1, splitChecksums } from '../workspace/pods-relocate.ts';

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
 * with the path neutralized, so two checkouts of one commit that each ran `pod install` hash alike. Only a checksum
 * equal to the sha1 of its own `Pods/Local Podspecs/<pod>.podspec.json` is replaced.
 */
export function canonicalPodfileLock(text: string, podsDir: string, projectRoot: string): string {
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
