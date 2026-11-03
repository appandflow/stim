import { existsSync } from 'node:fs';
import { homedir, platform } from 'node:os';
import { join, sep } from 'node:path';
import type { StimContext } from '@stim-cli/core';
import chalk from 'chalk';
import { readVolumeSpaceAsync, type BudgetRefusal, type ReclaimObserver } from '../budget.ts';
import { phaseLine } from '../command-output.ts';
import { canonicalPath } from '../commands/gc/paths.ts';
import { formatBytes, measuredDirectorySizeAsync } from '../fs-util.ts';
import { formatSpace } from '../status.ts';
import { getConfigDir, loadConfig } from '../workspace/config.ts';
import { sharedBuildCache } from '../workspace/paths.ts';
import { runLadderNow } from './passes.ts';
import { diskThresholds } from './pressure.ts';

const USAGE_TIMEOUT_MS = 10_000;

const SETTING_REMEDY =
  'Fix the value with `stim settings set <key> <value>`, or unset the environment variable. Run `stim guide settings` for the disk keys.';

async function spaceUsers(
  env: NodeJS.ProcessEnv = process.env,
  signal?: AbortSignal,
  operation?: StimContext,
): Promise<string[]> {
  const home = env.HOME || env.USERPROFILE || homedir();
  const candidates: [string, string][] = [
    ['Stim state', getConfigDir()],
    ['shared build cache', sharedBuildCache()],
    ...(platform() === 'darwin'
      ? ([
          ['simulators', join(home, 'Library', 'Developer', 'CoreSimulator', 'Devices')],
          ['Xcode DerivedData', join(home, 'Library', 'Developer', 'Xcode', 'DerivedData')],
        ] as [string, string][])
      : []),
    ['Android emulators', join(home, '.android', 'avd')],
  ];
  const measured = new Set<string>();
  const targets: [string, string][] = [];
  for (const [label, path] of candidates) {
    const canonical = canonicalPath(path);
    if (measured.has(canonical) || [...measured].some((dir) => canonical.startsWith(`${dir}${sep}`))) continue;
    measured.add(canonical);
    if (existsSync(path)) targets.push([label, path]);
  }
  const sizes = await Promise.all(
    targets.map(([, path]) => measuredDirectorySizeAsync(path, { timeoutMs: USAGE_TIMEOUT_MS, signal, operation })),
  );
  const users = targets.flatMap(([label, path], index) =>
    sizes[index] ? [{ label: `${label} ${path}`, bytes: sizes[index] }] : [],
  );
  return users.toSorted((a, b) => b.bytes - a.bytes).map(({ label, bytes }) => `${label}: ${formatBytes(bytes)}`);
}

const LOW_DISK_REMEDY =
  'Run `stim status` to see what the stim-daemon reclaimed, `stim gc` to see what else Stim can reclaim, then `stim gc --delete` (add `--cache all` to empty the shared caches, or `--worktrees` to remove finished worktrees). Free space outside Stim from the largest uses listed, or lower disk.hardFloorGb.';

/**
 * Rung 7 of the pressure ladder, before `start`, `ios` and `android` do their work: while free disk on the
 * workspace's or the Stim home's volume is under `disk.hardFloorGb`, the ladder runs now (one daemon tick, or
 * in this process without a daemon) and the run refuses with `STIM_LOW_DISK` when free disk is still under the floor
 * after it.
 */
export async function diskFloorGate({
  root,
  note,
  env = process.env,
  signal,
  onReclaim,
}: {
  root: string;
  note: (line: string) => void;
  env?: NodeJS.ProcessEnv;
  signal?: AbortSignal;
  onReclaim?: ReclaimObserver;
}): Promise<{ refusal: BudgetRefusal | null }> {
  const { thresholds, error } = diskThresholds(loadConfig(), env);
  if (error) return { refusal: { code: 'STIM_BAD_ARG', message: error, remedy: SETTING_REMEDY } };
  if (thresholds.hardFloorMb <= 0) return { refusal: null };
  const paths = [root, getConfigDir()];
  const under = async () =>
    (await readVolumeSpaceAsync(paths, signal)).filter((volume) => volume.freeMb < thresholds.hardFloorMb);
  let low = await under();
  if (!low.length) return { refusal: null };
  const tight = () => low.map((volume) => `${formatSpace(volume.freeMb)} on ${volume.volume}`).join(' and ');
  note(
    chalk.yellow(
      phaseLine(
        'disk',
        `only ${tight()} free, under the ${formatSpace(thresholds.hardFloorMb)} hard floor; running the pressure ladder`,
      ),
    ),
  );
  onReclaim?.('start');
  let completed = false;
  try {
    await runLadderNow(env, signal, root);
    signal?.throwIfAborted();
    low = await under();
    completed = true;
  } finally {
    onReclaim?.(completed ? 'complete' : 'failed');
  }
  if (!low.length) return { refusal: null };
  const users = await spaceUsers(env, signal);
  return {
    refusal: {
      code: 'STIM_LOW_DISK',
      message:
        `Only ${tight()} is free, below the ${formatSpace(thresholds.hardFloorMb)} hard floor (disk.hardFloorGb) after the stim-daemon's pressure ladder reclaimed what it safely could, so this run could fill the disk.` +
        (users.length ? ` Largest uses: ${users.join('; ')}.` : ''),
      remedy: LOW_DISK_REMEDY,
    },
  };
}
