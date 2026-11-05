import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';

// Bundler's lockfile indents a resolved spec name with exactly four spaces; six marks
// that spec's own dependencies and two marks the DEPENDENCIES section. Matching the
// four-space form finds cocoapods whether the Gemfile names it directly or pulls it in
// through another gem, which is exactly when `bundle exec pod` can work; DEPENDENCIES
// would miss the transitive case.
const COCOAPODS_SPEC = /^ {4}cocoapods \(([^)\s]+)/m;

export type BundlerPin = { gemfile: string; lockfile: string; cocoapods: string };

/**
 * The Bundler pin `pod install` in `directory` runs under: the nearest Gemfile from `directory` up to `root`, as
 * Bundler finds it, when its Gemfile.lock resolves cocoapods.
 */
export function bundlerPin(root: string, directory: string = root): BundlerPin | null {
  for (let dir = directory; ; dir = dirname(dir)) {
    const gemfile = join(dir, 'Gemfile');
    if (existsSync(gemfile)) return lockedCocoapods(gemfile, join(dir, 'Gemfile.lock'));
    const up = relative(root, dir);
    if (!up || up.startsWith('..') || dirname(dir) === dir) return null;
  }
}

function lockedCocoapods(gemfile: string, lockfile: string): BundlerPin | null {
  let lock: string;
  try {
    lock = readFileSync(lockfile, 'utf-8');
  } catch {
    return null;
  }
  const cocoapods = COCOAPODS_SPEC.exec(lock)?.[1];
  return cocoapods ? { gemfile, lockfile, cocoapods } : null;
}

export function podInstallCommand(root: string, directory: string, ...args: string[]): string {
  const pod = ['pod', 'install', ...args].join(' ');
  return bundlerPin(root, directory) ? `bundle exec ${pod}` : pod;
}
