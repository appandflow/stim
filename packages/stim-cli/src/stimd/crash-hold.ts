import { existsSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative } from 'node:path';
import { withDirLock } from '../dir-lock.ts';
import { isClaimRefusal, isClaimUnavailable, readClaimSet, type ClaimHolder } from '@stim-cli/core/ownership-claim';
import { captureProcessToken, processTokenBootId } from '@stim-cli/core/process-identity';
import {
  readDaemonSnapshot,
  keptBoots,
  readStimdBoots,
  stimdBootsFile,
  type Boot,
  type BootCause,
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
const STACK_CHARS = 8000;
const REFUSAL_CODES = ['STIM_ENGINE_SWITCHED', 'STIM_ENGINE_UNAVAILABLE', 'STIM_SANDBOX_BLOCKED', 'socket-refused'];
const HOME_CODES = ['EACCES', 'EPERM', 'EROFS', 'EISDIR', 'ENOTDIR'];

const bounded = (text: string, max = REASON_CHARS): string => (text.length > max ? `${text.slice(0, max)}...` : text);

/** `path` with its nearest existing ancestor resolved, so a symlinked or not yet created path compares by where it is. */
function resolved(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    const parent = dirname(path);
    return parent === path ? path : join(resolved(parent), basename(path));
  }
}

/** Whether `path` is `home` or below it, compared by real path and at a path separator. */
function insideHome(path: string, home: string): boolean {
  const from = relative(resolved(home), resolved(path));
  return from === '' || (!from.startsWith('..') && !isAbsolute(from));
}

/**
 * How a failure that ended a boot counts. `refusal`: stimd was refused or could not take the home (a claim, the socket
 * directory, another process answering, a socket denied outside the home, a sandbox, an engine switch), which is no
 * crash. `home`: the Stim home is at fault, with what to fix: a `config.json` that does not parse, or an ENOSPC, EDQUOT,
 * EACCES, EPERM, EROFS, EISDIR or ENOTDIR on a path inside the home. Anything else is `engine`.
 */
export function classifyFailure(
  error: unknown,
  home: string = getConfigDir(),
): { kind: 'refusal' | 'engine' } | { kind: 'home'; remedy: string } {
  if (!(error instanceof Error)) return { kind: 'engine' };
  const code: unknown = Reflect.get(error, 'code');
  const raw: unknown = Reflect.get(error, 'path') ?? Reflect.get(error, 'address');
  const path = typeof raw === 'string' ? raw : null;
  if (code === 'STIM_CONFIG_CORRUPT') return { kind: 'home', remedy: bounded(error.message.replaceAll('\n', ' ')) };
  const inside = path !== null && insideHome(path, home);
  if ((code === 'ENOSPC' || code === 'EDQUOT') && inside)
    return {
      kind: 'home',
      remedy: `a write to ${path} failed with ${code}; free disk space on the volume that holds it`,
    };
  if (typeof code === 'string' && HOME_CODES.includes(code) && inside)
    return { kind: 'home', remedy: `${path} cannot be used (${code}); fix its permissions, its type or its mount` };
  const listening = Reflect.get(error, 'syscall') === 'listen';
  const refused =
    isClaimRefusal(error) ||
    isClaimUnavailable(error) ||
    (typeof code === 'string' &&
      (REFUSAL_CODES.includes(code) || (listening && ['EADDRINUSE', 'EACCES', 'EPERM'].includes(code))));
  return { kind: refused ? 'refusal' : 'engine' };
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
    try {
      writeFileSync(tmp, `${JSON.stringify({ format: 1, boots: keptBoots(boots, Date.now()) })}\n`, { mode: 0o600 });
      renameSync(tmp, file);
    } catch (error) {
      rmSync(tmp, { force: true });
      throw error;
    }
  });
}

/** Removes the boots file, which ends a crash hold: what `stim doctor --fix` does, and what a person's `rm` does. */
export function clearCrashHold(): boolean {
  const file = stimdBootsFile();
  if (!existsSync(file)) return false;
  return withDirLock(`${file}.lock`, () => {
    const had = readStimdBoots().length > 0;
    rmSync(file, { force: true });
    return had;
  });
}

/**
 * Records the boot `at` of `pid` as abnormal with its cause, keeping the first reason it was given. Never throws: a
 * full or unwritable home cannot record its own loop, which then shows only in the log writer's line on stderr.
 * Returns whether the boot was recorded.
 */
export function recordAbnormalBoot(
  boot: Pick<Boot, 'at' | 'pid' | 'build'>,
  reason: string,
  cause: BootCause,
  home?: string,
): boolean {
  try {
    updateBoot(boot.at, boot.pid, (found) =>
      found?.abnormal
        ? found
        : {
            ...boot,
            ...found,
            abnormal: true,
            reason: bounded(reason),
            exitedAt: Date.now(),
            cause,
            ...(home ? { home } : {}),
          },
    );
    return true;
  } catch {
    return false;
  }
}

export const errorText = (error: unknown, max: number = REASON_CHARS): string =>
  bounded(error instanceof Error ? (error.stack ?? error.message) : String(error), max);

/** The stack an uncaught exception writes to the daemon log, which is longer than the reason a boot keeps. */
export const stackText = (error: unknown): string => errorText(error, STACK_CHARS);

type Log = (level: 'error', event: string, msg: string, fields?: Record<string, unknown>) => unknown;

/**
 * Logs `stimd_predecessor_lost` for each dead holder of the stimd claim that did not end through an exit path of its own
 * (those mark their claim `kept`) and records its boot as abnormal with cause `unknown`. A holder that died in an
 * earlier system boot is not counted, and neither is one whose boot id cannot be compared with this process's (always
 * the case on Windows). A logout that kills a stimd within its boot session cannot be told from a kill: that boot is
 * `unknown` too, which holds only after five of them.
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
    recordAbnormalBoot(
      { at: bootAt, pid, build },
      'the process ended with no record: killed, out of memory or a logout',
      'unknown',
    );
  }
}

/**
 * What a stimd that does not start because of a crash loop prints and logs, on one line: why, until when, and what to
 * do, naming `stim doctor --fix` first. A hold of boots with an unknown cause says what is known and blames no build.
 */
// @ref LLP 0021#the-crash-hold-keeps-its-history -- no previous engine: stop with a remedy, never invent a rollback
export function crashHoldRemedy(loop: CrashLoop, store: boolean): string {
  const until = new Date(loop.until).toISOString();
  const clear = `run stim doctor --fix to clear the hold now, or wait until ${until}`;
  if (loop.unknownOnly)
    return `stimd was killed or ran out of memory ${loop.count} times in 10 minutes, cause unknown, so it is not restarted automatically; check what stops it (daemon.ndjson has stimd_predecessor_lost records), then ${clear}.`;
  if (loop.home)
    return `stimd exited abnormally ${loop.count} times in 10 minutes because of this Stim home, not build ${loop.build}: ${loop.home}; ${clear}.`;
  const last = loop.reason ? ` (last: ${loop.reason.split('\n')[0]})` : '';
  const fix = store ? 'stim engine use <version> or stim engine update' : 'reinstalling or downgrading stim';
  return `stimd of build ${loop.build} exited abnormally ${loop.count} times in 10 minutes${last}, so it is not restarted automatically; ${clear}, or change the build with ${fix}.`;
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
