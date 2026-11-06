import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  readClaimSet,
  releaseClaim,
  tryAcquireClaim,
  updateClaimDetails,
  type ClaimHandle,
} from '@stim-cli/core/ownership-claim';
import { getConfigDir } from '../workspace/config.ts';
import { allDrained, buildClaimRoot } from '../engine-store/claims.ts';
import { ownStoreEngine, switchedEngine, type StoreEngine } from '../daemon/engine-switch.ts';
import { takeLock } from '../engine-store/locks.ts';
import { FORMAT } from '../engine-store/store.ts';
import { getExecutor } from '../exec.ts';

const FLIP_TIMEOUT_MS = 10 * 60_000;
const FLIP_LOCK_POLL_MS = 50;

type Log = (
  level: 'debug' | 'info' | 'warn' | 'error',
  event: string,
  msg: string,
  fields?: Record<string, unknown>,
) => void;

/** What stimd owes the engine store: its claim at the root, the drain, the switch, and noticing the pointer move. */
export interface EngineFollower {
  engine: StoreEngine;
  /** Records whether this stimd has pinned work and which builds its home's supervisors and collectors run. */
  record(pinned: boolean, engineDirs: string[]): void;
  /**
   * Admits an `op.begin`: records the work as pinned, then waits out a switch under way. Returns the build the engine
   * switched to meanwhile, which the op must not run on, or null.
   */
  admit(): Promise<{ build: string; version: string } | null>;
  /** The build the engine points at once it is not this one, else flips a staged build when every claim drained. */
  check(pinned: () => boolean): Promise<{ build: string; version: string } | null>;
  release(): void;
}

/** The staged entry's `dir`: the only field of `staged.json` the running build reads. */
function stagedDir(root: string): string | null {
  try {
    const staged = JSON.parse(readFileSync(join(root, 'staged.json'), 'utf8'));
    return staged?.format === FORMAT && typeof staged.dir === 'string' ? staged.dir : null;
  } catch {
    return null;
  }
}

/**
 * Takes this stimd's shared claim under its build's claim root when it runs from the engine store; null otherwise, or
 * when the claim cannot be taken, and then the engine does not wait for this stimd.
 */
export function followEngine(log: Log): EngineFollower | null {
  const engine = ownStoreEngine();
  if (!engine) return null;
  const root = buildClaimRoot(engine.root, engine.build);
  const attempt = tryAcquireClaim({
    root,
    mode: 'shared',
    label: 'stimd engine',
    details: { home: getConfigDir(), drained: true, engineDirs: [] },
  });
  if (attempt.pending) releaseClaim(attempt.pending);
  let claim: ClaimHandle | null = attempt.acquired ?? null;
  if (!claim) return null;
  let flipping = false;
  let dirs: string[] = [];
  const record = (pinned: boolean, engineDirs: string[]) => {
    dirs = [...new Set(engineDirs)].toSorted();
    const details = { home: getConfigDir(), drained: !pinned, engineDirs: dirs };
    if (!claim || JSON.stringify(details) === JSON.stringify(claim.details)) return;
    const was = claim.details.drained;
    claim = updateClaimDetails(claim, details);
    if (was !== details.drained) log('debug', pinned ? 'engine_pinned' : 'engine_drained', `drained: ${!pinned}`);
  };
  const flip = async (pinned: () => boolean) => {
    const staged = stagedDir(engine.root);
    if (!staged || staged === engine.build || pinned() || !allDrained(readClaimSet(root))) return;
    const lock = await takeLock(engine.root, '.lock.sock');
    if (!lock) return;
    try {
      const flipLock = await takeLock(engine.root, '.flip.sock');
      if (!flipLock) return;
      try {
        if (pinned() || !allDrained(readClaimSet(root)) || stagedDir(engine.root) !== staged) return;
        const started = performance.now();
        const select = join(engine.root, staged, 'dist', 'engine-select.mjs');
        const output = await getExecutor().runFileAsync(process.execPath, [select, '--flip'], {
          timeoutMs: FLIP_TIMEOUT_MS,
          env: { STIM_ENGINE_ROOT: engine.root, STIM_HOME: getConfigDir() },
        });
        log('info', 'engine_flipped', `${staged}: ${output.trim()}`, {
          build: staged,
          flipMs: Math.round(performance.now() - started),
        });
      } finally {
        await flipLock.release();
      }
    } catch (error) {
      log('warn', 'engine_flip_failed', error instanceof Error ? error.message : String(error));
    } finally {
      await lock.release();
    }
  };
  return {
    engine,
    record,
    async admit() {
      record(true, dirs);
      for (;;) {
        const probe = await takeLock(engine.root, '.flip.sock');
        if (probe) {
          await probe.release();
          return switchedEngine(engine);
        }
        await new Promise((done) => setTimeout(done, FLIP_LOCK_POLL_MS));
      }
    },
    async check(pinned) {
      const switched = switchedEngine(engine);
      if (switched || flipping) return switched;
      flipping = true;
      try {
        await flip(pinned);
      } finally {
        flipping = false;
      }
      return switchedEngine(engine);
    },
    release() {
      releaseClaim(claim);
      claim = null;
    },
  };
}
