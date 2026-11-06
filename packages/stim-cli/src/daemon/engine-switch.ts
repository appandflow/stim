import { readFileSync, realpathSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BUILD_DIR, engineRoot, FORMAT } from '../engine-store/store.ts';

/** How long after a build is staged a cache miss waits at the build slot for the switch. */
const SLOT_HOLD_MS: number = 10 * 60_000;
/** The exit code of a command that outlived its build: rerunning it runs the new one. */
const SWITCHED_EXIT: number = 75;

/** The engine store entry a process runs from. */
export type StoreEngine = { root: string; build: string };
type Pointer = { build: string; version: string };

let own: StoreEngine | null | undefined;

/** The engine root's `bin/stim`, which runs whatever build the engine points at. */
export const engineShim = (engine: StoreEngine): string =>
  join(engine.root, 'bin', process.platform === 'win32' ? 'stim.cmd' : 'stim');

/** The store entry this code runs from, or null for a copy outside the engine store. */
export function ownStoreEngine(): StoreEngine | null {
  if (own !== undefined) return own;
  own = null;
  try {
    const root = realpathSync(engineRoot(process.env));
    const [build, dist] = relative(root, realpathSync(dirname(fileURLToPath(import.meta.url)))).split(sep);
    if (build && BUILD_DIR.test(build) && dist === 'dist') own = { root, build };
  } catch {}
  return own;
}

function pointer(file: string): Pointer | null {
  try {
    const value = JSON.parse(readFileSync(file, 'utf8'));
    return value?.format === FORMAT && typeof value.dir === 'string'
      ? { build: value.dir, version: String(value.version) }
      : null;
  } catch {
    return null;
  }
}

/** The build `current.json` names once it no longer names `engine`'s: the engine switched under this process. */
export function switchedEngine(engine: StoreEngine | null = ownStoreEngine()): Pointer | null {
  const current = engine && pointer(join(engine.root, 'current.json'));
  return current && current.build !== engine.build ? current : null;
}

/** The staged build a cache miss of `engine` waits for, until `SLOT_HOLD_MS` after it was staged. */
export function stagedHold(engine: StoreEngine | null, now: number): Pointer | null {
  if (!engine) return null;
  try {
    const staged = JSON.parse(readFileSync(join(engine.root, 'staged.json'), 'utf8'));
    if (staged?.format !== FORMAT || staged.dir === engine.build) return null;
    return now - Date.parse(staged.stagedAt) < SLOT_HOLD_MS ? { build: staged.dir, version: staged.version } : null;
  } catch {
    return null;
  }
}

/** A wait that outlived its build. The CLI prints its message and exits {@link SWITCHED_EXIT}. */
class EngineSwitchedError extends Error {
  readonly code: string = 'STIM_ENGINE_SWITCHED';
  readonly exitCode: number = SWITCHED_EXIT;

  constructor(version: string) {
    super(`Stim updated to ${version}; rerun`);
  }
}

/** Ends a wait or stream whose build is no longer the engine's: exits 75 in a CLI, throws elsewhere. */
export function endForSwitch(version: string): never {
  const error = new EngineSwitchedError(version);
  if (!Reflect.get(globalThis, Symbol.for('stim.cli'))) throw error;
  process.stderr.write(`${error.message}\n`);
  process.exit(SWITCHED_EXIT);
}

const STREAM_CHECK_MS = 1000;

/** Ends a stream (`stim logs --follow`, `stim status --watch`) with the rerun line once the engine switches. */
export function endStreamOnSwitch(): void {
  const engine = ownStoreEngine();
  if (!engine) return;
  setInterval(() => {
    const switched = switchedEngine(engine);
    if (switched) endForSwitch(switched.version);
  }, STREAM_CHECK_MS).unref();
}
