import type { StimContext } from '@stim-cli/core';
import chalk from 'chalk';
import { readBuildLedger, type BuildLedgerPlatform } from '@stim-cli/core/state';
import { phaseLine } from '../command-output.ts';
import { runGcThroughStimd } from '../daemon/client.ts';
import { diskThresholds } from '../daemon/pressure.ts';
import { readVolumeSpaceAsync } from '../stimd/passes/budget.ts';
import { projectRegistry } from '../integrations/projects.ts';
import { formatSpace } from '../status.ts';
import { loadConfig } from '../workspace/config.ts';
import { detectIsExpo } from '../workspace/project-files.ts';
import { gitCommonDir, repoRoot } from '../workspace/worktree.ts';
import { statsProjectKey } from './stats.ts';
import { runCancellationSignal } from './native-run.ts';
import { setBuildBytes } from './build-bytes.ts';
import { estimateBuildBytes, type BuildProjectType } from './build-headroom.ts';

const MB = 1024 ** 2;
const HEADROOM_MS = 60_000;

function buildProjectType(root: string, platform: BuildLedgerPlatform): BuildProjectType {
  if (platform === 'macos') return 'native';
  const selected = platform === 'ios' ? projectRegistry.selectIos(root) : projectRegistry.selectAndroid(root);
  const id = 'id' in selected ? selected.id : null;
  if (id === 'exact') return 'exact';
  if (id === 'react-native') return detectIsExpo(root) ? 'expo' : 'react-native';
  return 'native';
}

export interface BuildHeadroom {
  /** Before a local compile: makes room for the estimated build when the volume lacks it, then starts measuring. */
  begin(): Promise<void>;
  /** After the build succeeded: hands the bytes it wrote to the build ledger. */
  finish(): Promise<void>;
}

/**
 * The disk headroom of one local native compile. It estimates the bytes the compile writes from the project's recorded
 * builds (or the default for its project type), runs the pressure ladder once when free space on the build's volume is
 * under that estimate plus the critical floor, and warns on stderr when it is still short. It never refuses, and a
 * failure inside it is ignored: only an abort passes through. It measures the build by the drop in free space on that
 * volume between `begin` and `finish`, so it reads two statfs values and walks nothing; writes of other processes in
 * that time count, and a drop that is not positive records nothing.
 */
export function createBuildHeadroom({
  root,
  platform,
  context,
}: {
  root: string;
  platform: BuildLedgerPlatform;
  context: StimContext;
}): BuildHeadroom {
  const { env } = context;
  const signal = runCancellationSignal(context) ?? context.signal;
  let started = false;
  let before: number | null = null;
  const projectKey = () => statsProjectKey({ root, commonDir: gitCommonDir(root), repoRoot: repoRoot(root) });
  const space = async (readSignal = signal) => {
    const volume = (await readVolumeSpaceAsync([root], readSignal))[0] ?? null;
    readSignal.throwIfAborted();
    return volume;
  };

  async function makeRoom(stop: AbortSignal, deadline: number): Promise<void> {
    const { thresholds, error } = diskThresholds(loadConfig(), env);
    if (error) return;
    const estimate = estimateBuildBytes({
      records: readBuildLedger(),
      projectKey: projectKey(),
      platform,
      type: buildProjectType(root, platform),
      now: Date.now(),
    });
    const requiredMb = (estimate.bytes + thresholds.criticalMb * MB) / MB;
    const volume = await space(stop);
    const device = volume?.device;
    if (!volume || device === undefined || volume.freeMb >= requiredMb) return;
    try {
      await runGcThroughStimd(
        {
          headroom: { device, freeMb: requiredMb, protectedRoot: root, deadline },
        },
        context,
        stop,
      );
    } catch {
      stop.throwIfAborted();
    }
    stop.throwIfAborted();
    const after = await space(stop);
    if (!after || after.freeMb >= requiredMb) return;
    context.output(
      'stderr',
      `${chalk.yellow(
        phaseLine(
          'disk',
          `this build is expected to write about ${formatSpace(estimate.bytes / MB)} (${estimate.source === 'history' ? 'the median of recent builds of this project' : 'a default for this project type'}) and only ${formatSpace(after.freeMb)} is free on ${after.volume}, with ${formatSpace(thresholds.criticalMb)} kept as the critical floor; building anyway`,
        ),
      )}\n`,
    );
  }

  return {
    async begin() {
      if (started) return;
      started = true;
      signal.throwIfAborted();
      const deadline = Date.now() + HEADROOM_MS;
      const expired = new AbortController();
      const stop = AbortSignal.any([signal, expired.signal]);
      const timer = setTimeout(() => expired.abort(new Error('Build headroom deadline reached.')), HEADROOM_MS);
      let abort!: () => void;
      const cancelled = new Promise<never>((_resolve, reject) => {
        abort = () => reject(stop.reason);
        stop.addEventListener('abort', abort, { once: true });
      });
      try {
        before = await Promise.race([
          (async () => {
            await makeRoom(stop, deadline);
            return (await space(stop))?.freeMb ?? null;
          })(),
          cancelled,
        ]);
      } catch (error) {
        // @ref LLP 0006#a-build-never-refuses-for-headroom -- only a cancellation passes through
        if (signal.aborted) throw error;
      } finally {
        clearTimeout(timer);
        stop.removeEventListener('abort', abort);
      }
    },
    async finish() {
      if (before === null) return;
      try {
        const after = (await space())?.freeMb;
        if (after === undefined) return;
        const bytes = (before - after) * MB;
        if (bytes > 0) setBuildBytes(root, platform, bytes);
      } catch {}
    },
  };
}
