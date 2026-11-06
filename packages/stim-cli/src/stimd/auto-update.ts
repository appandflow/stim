import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { compareVersions } from '../../bin/route.mjs';
import { newestBad } from '../engine-store/select.ts';
import { FORMAT, readRecords, writeRecord } from '../engine-store/store.ts';
import type { StoreEngine } from '../daemon/engine-switch.ts';
import { getExecutor } from '../exec.ts';

/** How often stimd checks for a newer engine on its own. */
export const DAILY_MS: number = 24 * 60 * 60_000;
/** The shortest gap between checks that something asked for: Stim Desktop's launch, a newer phone, a crash hold. */
export const ASKED_MS: number = 60 * 60_000;
const NPM_TIMEOUT_MS = 60_000;
const SELECT_TIMEOUT_MS = 10 * 60_000;

/**
 * Whether stimd updates the engine by itself. The `engine.autoUpdate` setting decides when it is `on` or `off`; under
 * `auto` an engine Stim Desktop installed (`install:desktop`) or one a service runs updates, and any other, such as a
 * plain global npm install, waits for a person or a newer copy.
 */
export function autoUpdateOn(setting: unknown, installedBy: string | undefined, service: boolean): boolean {
  if (setting === 'on') return true;
  if (setting === 'off') return false;
  return installedBy === 'install:desktop' || service;
}

/** Whether a check is due, `everyMs` after the last one recorded at `lastAt` (0 when none was). */
export const updateDue = (lastAt: number, now: number, everyMs: number): boolean => now - lastAt >= everyMs;

const checkFile = (root: string) => join(root, 'update-check.json');

/** When any stimd under the engine root last checked for an update, or 0. */
export function lastUpdateCheck(root: string): number {
  try {
    const value = JSON.parse(readFileSync(checkFile(root), 'utf8'));
    return value?.format === FORMAT && typeof value.at === 'string' ? Date.parse(value.at) || 0 : 0;
  } catch {
    return 0;
  }
}

/**
 * Looks up the newest version on the engine's channel and, when it is newer than the engine and above every build
 * marked bad, has this build's `engine-select` install it as an unattended promotion, which a person's pin refuses and
 * which is staged while work runs. Returns one line for the log.
 */
export async function checkForUpdate(engine: StoreEngine, why: string): Promise<string> {
  const { root, build } = engine;
  writeRecord(checkFile(root), { format: FORMAT, at: new Date().toISOString(), why });
  const { current, state } = readRecords(root);
  if (!current || current.dir !== build) return 'the engine points at another build';
  if (current.pinned) return `the engine is pinned (${current.pinReason})`;
  const view = (
    await getExecutor().runFileAsync('npm', ['view', `stim@${current.channel}`, 'version'], {
      timeoutMs: NPM_TIMEOUT_MS,
    })
  ).trim();
  if ((compareVersions(view, current.version) ?? 0) <= 0)
    return `${current.channel} has nothing newer than ${current.version}`;
  const bad = newestBad(state.bad);
  if (bad && (compareVersions(view, bad) ?? 1) <= 0) return `${view} is at or below ${bad}, which crash-looped`;
  const have = state.installed.find((each) => each.version === view);
  const source = have ? ['--source', join(root, have.dir)] : ['--release', view];
  const output = await getExecutor().runFileAsync(
    process.execPath,
    [join(root, build, 'dist', 'engine-select.mjs'), ...source, '--set-by', 'auto-update'],
    { timeoutMs: SELECT_TIMEOUT_MS, env: { STIM_ENGINE_ROOT: root } },
  );
  return `${view}: ${output.trim().split('\n').at(-1)}`;
}
