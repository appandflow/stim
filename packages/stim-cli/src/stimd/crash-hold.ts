import { renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { withDirLock } from '../dir-lock.ts';
import { readClaimSet, type ClaimHolder } from '@stim-cli/core/ownership-claim';
import { captureProcessToken, processTokenBootId } from '@stim-cli/core/process-identity';
import {
  readDaemonSnapshot,
  keptBoots,
  readStimdBoots,
  stimdBootsFile,
  type Boot,
  type CrashLoop,
} from '@stim-cli/core/state';
import { buildClaimRoot, readBuildClaims } from '../engine-store/claims.ts';
import { takeLock } from '../engine-store/locks.ts';
import { machineRoot, readSchema } from '../engine-store/schema.ts';
import { readManifest, readRecords, writeState } from '../engine-store/store.ts';
import type { StoreEngine } from '../daemon/engine-switch.ts';
import { getExecutor } from '../exec.ts';
import { getConfigDir } from '../workspace/config.ts';

const SELECT_TIMEOUT_MS = 10 * 60_000;
const REASON_CHARS = 500;

const bounded = (text: string): string => (text.length > REASON_CHARS ? `${text.slice(0, REASON_CHARS)}...` : text);

/**
 * What to fix when `error` comes from the Stim home rather than from the build: a `config.json` that does not parse, a
 * full disk, or a state file that cannot be written. Null for any other failure.
 */
function homeStateFault(error: unknown, home: string = getConfigDir()): string | null {
  if (!(error instanceof Error)) return null;
  const code: unknown = Reflect.get(error, 'code');
  const path: unknown = Reflect.get(error, 'path');
  if (code === 'STIM_CONFIG_CORRUPT') return bounded(error.message.replaceAll('\n', ' '));
  if (code === 'ENOSPC' || code === 'EDQUOT')
    return `a write to ${path ?? home} failed with ${code}; free disk space on the volume that holds ${home}`;
  if ((code === 'EACCES' || code === 'EROFS') && typeof path === 'string' && path.startsWith(home))
    return `${path} cannot be written (${code}); fix its permissions or its mount`;
  return null;
}

/** The boot `at` of `pid` in `stimd-boots.json`, changed by `change` under the file's lock, which also prunes the file. */
export function updateBoot(at: number, pid: number, change: (boot: Boot | undefined) => Boot | undefined): void {
  const file = stimdBootsFile();
  withDirLock(`${file}.lock`, () => {
    const boots = readStimdBoots();
    const index = boots.findIndex((boot) => boot.at === at && boot.pid === pid);
    const changed = change(boots[index]);
    if (changed) {
      if (index >= 0) boots[index] = changed;
      else boots.push(changed);
    }
    const tmp = `${file}.${process.pid}.tmp`;
    writeFileSync(tmp, `${JSON.stringify({ format: 1, boots: keptBoots(boots, Date.now()) })}\n`, { mode: 0o600 });
    try {
      renameSync(tmp, file);
    } catch (error) {
      rmSync(tmp, { force: true });
      throw error;
    }
  });
}

/** Records the boot `at` of `pid` as abnormal, keeping the first reason it was given. */
export function recordAbnormalBoot(boot: Pick<Boot, 'at' | 'pid' | 'build'>, reason: string, cause?: unknown): void {
  updateBoot(boot.at, boot.pid, (found) => {
    if (found?.abnormal) return found;
    const home = homeStateFault(cause);
    return {
      ...boot,
      ...found,
      abnormal: true,
      reason: bounded(reason),
      exitedAt: Date.now(),
      ...(home ? { home } : {}),
    };
  });
}

export const errorText = (error: unknown): string =>
  bounded(error instanceof Error ? (error.stack ?? error.message) : String(error));

type Log = (level: 'error', event: string, msg: string, fields?: Record<string, unknown>) => unknown;

/**
 * Logs `stimd_predecessor_lost` for each dead holder of the stimd claim that did not end through an exit path of its own
 * (those mark their claim `kept`) and records its boot as abnormal. A holder that died in an earlier system boot is not
 * counted: a reboot or a logout is no crash, and a boot id that cannot be compared counts as different.
 */
// @ref LLP 0021#every-exit-leaves-a-record -- a dead claim without kept is a lost predecessor, unless the system rebooted
export function recordLostPredecessors(leftover: readonly ClaimHolder[], log: Log): void {
  const ownBoot = processTokenBootId(captureProcessToken(process.pid));
  const snapshot = readDaemonSnapshot();
  for (const holder of leftover) {
    const theirBoot = processTokenBootId(holder.owner.processToken);
    if (holder.details.kept === true || !ownBoot || ownBoot !== theirBoot) continue;
    const { pid } = holder.owner;
    const build = String(holder.details.build ?? '');
    const bootAt = typeof holder.details.bootAt === 'number' ? holder.details.bootAt : Date.parse(holder.startedAt);
    const lastTickAt = snapshot?.pid === pid ? snapshot.tickAt : null;
    log(
      'error',
      'stimd_predecessor_lost',
      `the stimd pid ${pid} (build ${build}), started ${holder.startedAt}, ended without a clean exit; its last tick was ${lastTickAt ?? 'never written'}`,
      { pid, build, version: holder.details.version, startedAt: holder.startedAt, lastTickAt },
    );
    try {
      recordAbnormalBoot(
        { at: bootAt, pid, build },
        'the process ended without a clean exit: killed, out of memory or crashed',
      );
    } catch {}
  }
}

/** What a stimd that does not start because of a crash loop prints and logs: why, until when, and what to do. */
// @ref LLP 0021#the-crash-hold-keeps-its-history -- no previous engine: stop with a remedy, never invent a rollback
export function crashHoldRemedy(loop: CrashLoop, version: string, store: boolean): string {
  const until = new Date(loop.until).toISOString();
  const file = stimdBootsFile();
  if (loop.home)
    return `stimd exited abnormally ${loop.count} times in 10 minutes because of this Stim home, not engine ${version}: ${loop.home}. It starts again after ${until}, or at once when ${file} is removed.`;
  const last = loop.reason ? ` (last: ${loop.reason})` : '';
  const fix = store
    ? 'run stim engine use <version> or stim engine update'
    : 'reinstall or downgrade stim, or fix what the daemon log names';
  return `stimd of ${version} exited abnormally ${loop.count} times in 10 minutes${last} and has no previous engine to go back to; it starts again after ${until}. To change that, ${fix}; remove ${file} to try again now.`;
}

/** A Stim home, or `~/.stim/machine`, and the schema its marker records (1 without one). */
export type HomeSchema = { home: string; schema: number; by: string };

/**
 * What the next boot of a crash-looping build does: point the engine back at `previous` when that build reads every
 * claimed home's schema, else stop with the remedy. Without a previous build there is nothing to go back to.
 */
export function crashLoopAction({
  version,
  previous,
  homes,
}: {
  version: string;
  previous: { dir: string; schema: number } | null;
  homes: readonly HomeSchema[];
}): { rollback: string } | { stop: string } {
  if (!previous)
    return {
      stop: `engine ${version} crashes and has no previous build to go back to; run stim engine use <version> or stim engine update`,
    };
  const newer = homes.find((home) => home.schema > previous.schema);
  if (!newer) return { rollback: previous.dir };
  const by = newer.by === version ? 'it' : newer.by;
  return {
    stop: `engine ${version} crashes and home ${newer.home} was migrated to schema ${newer.schema} by ${by}; run stim engine rollback --restore-state or stim engine update`,
  };
}

/**
 * Every Stim home a stimd claim under the engine root names, live or left by a crash, every home a flip migrated, this
 * home and the machine root.
 */
function claimedHomes(root: string, own: string): HomeSchema[] {
  const homes = new Set([own, machineRoot(), ...(readRecords(root).state.migrated ?? [])]);
  for (const { build } of readBuildClaims(root)) {
    const { live, dead } = readClaimSet(buildClaimRoot(root, build));
    for (const claim of [...live, ...dead]) if (typeof claim.details.home === 'string') homes.add(claim.details.home);
  }
  return [...homes].map((home) => {
    const found = readSchema(home);
    return { home, schema: found?.schema ?? 1, by: found?.by ?? '' };
  });
}

/** How a crash loop ended for this boot. */
export type CrashHold =
  | { rolledBack: { build: string; version: string } }
  | { staged: string }
  | { stop: string }
  | { moved: true };

/**
 * The boot after three abnormal exits of `engine`'s build: under the promotion lock, marks the build bad in
 * `state.json` and, as `crashLoopAction` decides, has `previous`'s own `engine-select` point the engine back at it
 * with `pinned: false` and `pinReason: "crash loop in <v>"`, which holds automatic sources off this build and below.
 * The pointer is staged instead when another home's stimd still runs this build. `moved` when the engine already
 * points elsewhere.
 */
export async function holdCrashLoop(engine: StoreEngine, version: string, home: string): Promise<CrashHold> {
  const { root, build } = engine;
  const lock = await takeLock(root, '.lock.sock');
  if (!lock) return { stop: `engine ${version} crashes; another process is changing ${root}; trying again later` };
  try {
    const { current, previous, state } = readRecords(root);
    if (current?.dir !== build) return { moved: true };
    const marked = { build, version, at: new Date().toISOString() };
    writeState(root, { ...state, bad: [...state.bad.filter((entry) => entry.build !== build), marked] });
    const manifest = previous ? readManifest(join(root, previous)) : null;
    const action = crashLoopAction({
      version,
      previous: previous && manifest ? { dir: previous, schema: manifest.schema } : null,
      homes: claimedHomes(root, home),
    });
    if ('stop' in action) return action;
    const select = join(root, action.rollback, 'dist', 'engine-select.mjs');
    const args = ['--source', join(root, action.rollback), '--set-by', 'crash-loop', '--explicit', '--locked'];
    const output = await getExecutor().runFileAsync(
      process.execPath,
      [select, ...args, '--hold', `crash loop in ${version}`],
      { timeoutMs: SELECT_TIMEOUT_MS, env: { STIM_ENGINE_ROOT: root, STIM_HOME: home } },
    );
    const result = JSON.parse(output.trim().split('\n').at(-1) ?? '{}');
    if (typeof result.flipped === 'string')
      return { rolledBack: { build: result.flipped, version: manifest?.version ?? '' } };
    if (typeof result.staged === 'string') return { staged: result.staged };
    return { stop: `engine ${version} crashes and going back to ${manifest?.version} was refused: ${result.refused}` };
  } finally {
    await lock.release();
  }
}
