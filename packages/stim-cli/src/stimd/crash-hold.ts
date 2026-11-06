import { join } from 'node:path';
import { readClaimSet } from '@stim-cli/core/ownership-claim';
import { isJsonObject } from '@stim-cli/core/state';
import { buildClaimRoot, readBuildClaims } from '../engine-store/claims.ts';
import { takeLock } from '../engine-store/locks.ts';
import { machineRoot, readSchema } from '../engine-store/schema.ts';
import { readManifest, readRecords, writeState } from '../engine-store/store.ts';
import type { StoreEngine } from '../daemon/engine-switch.ts';
import { getExecutor } from '../exec.ts';

const BOOT_WINDOW_MS = 10 * 60_000;
const BOOTS_KEPT = 20;
const CRASHES = 3;
const SELECT_TIMEOUT_MS = 10 * 60_000;

/** One stimd start in a Stim home: when, from which build, and whether that stimd exited abnormally. */
export type Boot = { at: number; build: string; abnormal?: true };

/** The boots in a claim's details, as stimd recorded them. */
export function parseBoots(value: unknown): Boot[] {
  return (Array.isArray(value) ? value : []).flatMap((boot) => {
    if (!isJsonObject(boot) || typeof boot.at !== 'number' || typeof boot.build !== 'string') return [];
    const parsed: Boot = { at: boot.at, build: boot.build };
    if (boot.abnormal === true) parsed.abnormal = true;
    return [parsed];
  });
}

/** The boots stimd keeps at `now`: those of the last 10 minutes, at most 20, oldest first. */
export const keptBoots = (boots: readonly Boot[], now: number): Boot[] =>
  boots
    .filter((boot) => boot.at <= now && now - boot.at < BOOT_WINDOW_MS)
    .toSorted((a, b) => a.at - b.at)
    .slice(-BOOTS_KEPT);

/** Whether `build`'s stimd exited abnormally three times among the kept boots, which span at most 10 minutes. */
export const crashLooping = (boots: readonly Boot[], build: string): boolean =>
  boots.filter((boot) => boot.build === build && boot.abnormal).length >= CRASHES;

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

/** Every Stim home a stimd claim under the engine root names, live or left by a crash, with this home and the machine root. */
function claimedHomes(root: string, own: string): HomeSchema[] {
  const homes = new Set([own, machineRoot()]);
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
