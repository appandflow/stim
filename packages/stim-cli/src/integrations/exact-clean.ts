import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { getExecutor } from '../exec.ts';

const BUN_VERSION = /^\d{1,4}\.\d{1,4}\.\d{1,4}$/;
const HELP_TIMEOUT_MS = 60_000;
/** Exact's clean waits up to 60 seconds for its sweep's lock before it reports busy. */
const CLEAN_TIMEOUT_MS = 180_000;

/** What Exact's `scripts/sweep.mjs clean <app-dir> --json` printed, version 1 (appandflow/exact#41). */
export interface ExactCleanReport {
  status: 'ok' | 'busy' | 'refused' | 'failed';
  /** Absolute paths removed, or that a dry run would remove; for `failed`, those already removed. */
  remove: string[];
  kept: { path: string; why: string }[];
  /** The locks and leases that made it `busy`. */
  held: string[];
  error?: string;
}

const bunAt = (version: string, home: string): string => join(home, `.bun-${version}`, 'bin', 'bun');

const isStrings = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((entry) => typeof entry === 'string');

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

function statusOf(value: unknown): ExactCleanReport['status'] | null {
  switch (value) {
    case 'ok':
    case 'busy':
    case 'refused':
    case 'failed':
      return value;
    default:
      return null;
  }
}

/** The report in `stdout` when it is exactly one version 1 object, or null. */
function parseReport(stdout: unknown): ExactCleanReport | null {
  if (typeof stdout !== 'string') return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout.trim());
  } catch {
    return null;
  }
  if (!isRecord(parsed) || parsed.version !== 1) return null;
  const status = statusOf(parsed.status);
  const { remove, kept, held, error } = parsed;
  if (!status || !isStrings(remove) || !isStrings(held) || !Array.isArray(kept)) return null;
  const keptEntries: ExactCleanReport['kept'] = [];
  for (const entry of kept) {
    if (!isRecord(entry) || typeof entry.path !== 'string' || typeof entry.why !== 'string') return null;
    keptEntries.push({ path: entry.path, why: entry.why });
  }
  return { status, remove, kept: keptEntries, held, ...(typeof error === 'string' ? { error } : {}) };
}

/** A failed child's stdout, which `runFileAsync` attaches to the error it rejects with. */
function stdoutOf(error: unknown): unknown {
  return isRecord(error) ? error.stdout : undefined;
}

// @ref LLP 0005#exact-apps-clean-through-exact -- Exact decides what of an app's target/ its builds remake
/**
 * Runs Exact's own cleaner on the idle Exact app at `app`: `<bun> <checkout>/scripts/sweep.mjs clean <app> [--dry-run]
 * --json`. The checkout is the one the app's `exact.mjs` resolves, which its `help` names on its last line (`Exact
 * checkout: <path> at <commit>`), run with the Bun its launcher pins; the cleaner runs with the Bun the checkout's
 * `package.json` pins, both from `~/.bun-<version>`. Anything but one version 1 report, such as an older checkout that
 * prints no JSON, is `unsupported`, which keeps the target. Exact checks its own locks and leases; a dev server or a
 * running app holds none, so the caller decides the app is idle first.
 */
export async function exactClean(
  app: string,
  { dryRun = false, signal, home = homedir() }: { dryRun?: boolean; signal?: AbortSignal; home?: string } = {},
): Promise<ExactCleanReport | { unsupported: string }> {
  let launcher: string;
  try {
    launcher = readFileSync(join(app, 'exact.mjs'), 'utf8');
  } catch {
    return { unsupported: `${app}/exact.mjs cannot be read` };
  }
  const launcherBun = /ensureBun\(\s*["'](\d+\.\d+\.\d+)["']\s*\)/.exec(launcher)?.[1];
  if (!launcherBun) return { unsupported: `${app}/exact.mjs names no Bun version the way Stim reads it` };
  const exec = getExecutor();
  const run = (file: string, args: string[], timeoutMs: number) =>
    exec.runFileAsync(file, args, { cwd: app, timeoutMs, signal });
  let help: string;
  try {
    help = await run(bunAt(launcherBun, home), [join(app, 'exact.mjs'), 'help'], HELP_TIMEOUT_MS);
  } catch (error) {
    signal?.throwIfAborted();
    return {
      unsupported: `bun exact.mjs help failed: ${error instanceof Error ? error.message.split('\n')[0] : error}`,
    };
  }
  const checkout = /^Exact checkout: (\/.*) at [0-9a-f]+$/m.exec(help.trim().split('\n').at(-1) ?? '')?.[1];
  if (!checkout) return { unsupported: 'bun exact.mjs help does not name its Exact checkout' };
  let pinned: unknown;
  try {
    pinned = JSON.parse(readFileSync(join(checkout, 'package.json'), 'utf8'));
  } catch {
    return { unsupported: `${checkout}/package.json cannot be read` };
  }
  const manager = isRecord(pinned) ? pinned.packageManager : null;
  const version = typeof manager === 'string' && manager.startsWith('bun@') ? manager.slice('bun@'.length) : '';
  if (!BUN_VERSION.test(version)) return { unsupported: `${checkout}/package.json pins no Bun version` };
  let stdout: unknown;
  try {
    stdout = await run(
      bunAt(version, home),
      [join(checkout, 'scripts', 'sweep.mjs'), 'clean', app, ...(dryRun ? ['--dry-run'] : []), '--json'],
      CLEAN_TIMEOUT_MS,
    );
  } catch (error) {
    signal?.throwIfAborted();
    stdout = stdoutOf(error);
  }
  return (
    parseReport(stdout) ?? {
      unsupported: `the Exact checkout at ${checkout} has no clean that reports version 1 JSON (appandflow/exact#41)`,
    }
  );
}
