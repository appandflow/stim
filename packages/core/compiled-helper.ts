import { spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, statSync } from 'node:fs';
import { basename, join } from 'node:path';

function isHelperName(entry: string, name: string): boolean {
  return (
    entry.length === name.length + 17 &&
    entry.startsWith(`${name}-`) &&
    /^[0-9a-f]{16}$/.test(entry.slice(name.length + 1))
  );
}

export function selectHelpersToPrune(
  entries: readonly { name: string; mtimeMs: number }[],
  currentName: string,
  name: string,
  running: ReadonlySet<string>,
): string[] {
  const previous = entries
    .filter((entry) => isHelperName(entry.name, name) && entry.name !== currentName)
    .toSorted((a, b) => b.mtimeMs - a.mtimeMs || a.name.localeCompare(b.name));
  return previous
    .slice(1)
    .filter((entry) => !running.has(entry.name))
    .map((entry) => entry.name);
}

function runningExecutablePaths(): ReadonlySet<string> | null {
  const result = spawnSync('ps', ['-axo', 'comm='], { encoding: 'utf8', timeout: 500 });
  if (result.error || result.status !== 0 || typeof result.stdout !== 'string' || !result.stdout.trim()) return null;
  return new Set(
    result.stdout
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean),
  );
}

export function pruneCompiledHelpers(
  dir: string,
  currentName: string,
  name: string,
  runningPaths: () => ReadonlySet<string> | null = runningExecutablePaths,
): void {
  try {
    const entries = readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isFile() && isHelperName(entry.name, name))
      .map((entry) => ({ name: entry.name, mtimeMs: statSync(join(dir, entry.name)).mtimeMs }));
    if (entries.length <= 2) return;
    const paths = runningPaths();
    if (paths === null) return;
    const canonicalPaths = new Set<string>();
    for (const path of paths) {
      try {
        canonicalPaths.add(realpathSync(path));
      } catch {}
    }
    const running = new Set(
      entries.filter((entry) => canonicalPaths.has(realpathSync(join(dir, entry.name)))).map((entry) => entry.name),
    );
    for (const entry of selectHelpersToPrune(entries, currentName, name, running))
      rmSync(join(dir, entry), { force: true });
  } catch {}
}

/**
 * Returns `<dir>/<name>-<hash>`, compiling it with `compile` first when it is missing. The hash covers `version` and
 * each input's name and bytes, so a changed source or compiler builds a new helper beside the old one. `compile`
 * writes to a private temporary path that is renamed into place, so concurrent builders never expose a partial file.
 * Pruning is best effort and keeps this helper, the newest previous build and any running helpers.
 */
export async function compiledHelper({
  dir,
  name,
  inputs,
  version,
  compile,
}: {
  dir: string;
  name: string;
  inputs: readonly string[];
  version: string;
  compile: (output: string) => Promise<void>;
}): Promise<string> {
  const hash = createHash('sha256').update(version);
  for (const input of inputs) hash.update(basename(input)).update(readFileSync(input));
  const helper = join(dir, `${name}-${hash.digest('hex').slice(0, 16)}`);
  if (!existsSync(helper)) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const output = `${helper}.tmp-${process.pid}-${randomBytes(4).toString('hex')}`;
    try {
      await compile(output);
      renameSync(output, helper);
    } finally {
      rmSync(output, { force: true });
    }
  }
  pruneCompiledHelpers(dir, basename(helper), name);
  return helper;
}
