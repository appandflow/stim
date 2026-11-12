import { existsSync } from 'node:fs';
import type { StimContext } from '@stim-cli/core';
import chalk from 'chalk';
import {
  readBuildLedger,
  sharedCcache,
  sharedCompilationCache,
  sharedGradle,
  sharedPods,
  workspaceDerivedData,
  workspaceGradleBuild,
  type BuildLedgerPlatform,
} from '@stim-cli/core/state';
import { phaseLine } from '../command-output.ts';
import { runLadderToFree } from '../daemon/passes.ts';
import { diskThresholds } from '../daemon/pressure.ts';
import { readVolumeSpaceAsync } from '../stimd/passes/budget.ts';
import { projectRegistry } from '../integrations/projects.ts';
import { measureTree } from '../private-size.ts';
import { formatSpace } from '../status.ts';
import { getConfigDir, loadConfig } from '../workspace/config.ts';
import { sharedBuildCache } from '../workspace/paths.ts';
import { detectIsExpo } from '../workspace/project-files.ts';
import { existingBuildDirsAsync } from '../workspace/regenerable-dirs.ts';
import { gitCommonDir, repoRoot } from '../workspace/worktree.ts';
import { statsProjectKey } from './stats.ts';
import { setBuildBytes } from './build-bytes.ts';
import { estimateBuildBytes, headroomShortfall, type BuildProjectType } from './build-headroom.ts';

const MB = 1024 ** 2;
/** Each `du` walk over the measured directories; a walk that runs out of time leaves the build's size unrecorded. */
const MEASURE_TIMEOUT_MS = 20_000;

function buildProjectType(root: string, platform: BuildLedgerPlatform): BuildProjectType {
  if (platform === 'macos') return 'native';
  const selected = platform === 'ios' ? projectRegistry.selectIos(root) : projectRegistry.selectAndroid(root);
  const id = 'id' in selected ? selected.id : null;
  if (id === 'exact') return 'exact';
  if (id === 'react-native') return detectIsExpo(root) ? 'expo' : 'react-native';
  return 'native';
}

async function measureTargets(root: string): Promise<number | null> {
  const candidates = [
    ...(await existingBuildDirsAsync(root)),
    workspaceDerivedData(root),
    workspaceGradleBuild(root),
    sharedBuildCache(),
    sharedCompilationCache(),
    sharedCcache(),
    sharedGradle(),
    sharedPods(),
  ];
  const targets = candidates.filter((path) => existsSync(path));
  if (!targets.length) return 0;
  const size = await measureTree(root, { timeoutMs: MEASURE_TIMEOUT_MS, targets, private: false });
  return size ? size.bytes : null;
}

export interface BuildHeadroom {
  /** Before a local compile: makes room for the estimated build when the volume lacks it, then starts measuring. */
  begin(): Promise<void>;
  /** After the build succeeded: hands the bytes it wrote to the build ledger. */
  finish(): Promise<void>;
}

/**
 * The disk headroom of one local native compile. It estimates the bytes the compile writes from the project's recorded
 * builds (or the default for its project type), runs the pressure ladder when free space is under that estimate plus
 * the critical floor, and warns on stderr when it is still short. It never refuses, and a failure inside it is
 * ignored: only an abort passes through. It measures the growth of the workspace's build output, derived data and
 * Gradle build, and of the shared artifact store, compilation cache, ccache, Gradle and Pods directories; it leaves
 * out Xcode's own DerivedData, `~/.gradle`, node_modules, simulators and other builds' concurrent writes.
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
  const { env, signal } = context;
  let before: Promise<number | null> | null = null;
  const projectKey = () => statsProjectKey({ root, commonDir: gitCommonDir(root), repoRoot: repoRoot(root) });

  async function makeRoom(): Promise<void> {
    const config = loadConfig();
    const { thresholds, error } = diskThresholds(config, env);
    if (error) return;
    const estimate = estimateBuildBytes({
      records: readBuildLedger(),
      projectKey: projectKey(),
      platform,
      type: buildProjectType(root, platform),
      now: Date.now(),
    });
    const critical = thresholds.criticalMb * MB;
    const shortfall = async () => {
      const volumes = await readVolumeSpaceAsync([root, getConfigDir()], signal);
      const tightest = volumes.toSorted((a, b) => a.freeMb - b.freeMb)[0];
      if (!tightest) return null;
      const missing = headroomShortfall({
        freeBytes: tightest.freeMb * MB,
        estimateBytes: estimate.bytes,
        criticalBytes: critical,
      });
      return missing > 0 ? { volume: tightest, freeMb: tightest.freeMb } : null;
    };
    if (!(await shortfall())) return;
    await runLadderToFree(env, (estimate.bytes + critical) / MB, signal, root);
    signal?.throwIfAborted();
    const still = await shortfall();
    if (!still) return;
    context.output(
      'stderr',
      `${chalk.yellow(
        phaseLine(
          'disk',
          `this build is expected to write about ${formatSpace(estimate.bytes / MB)} (${estimate.source === 'history' ? 'the largest recent build of this project' : 'a default for this project type'}) and only ${formatSpace(still.freeMb)} is free on ${still.volume.volume}, with ${formatSpace(thresholds.criticalMb)} kept as the critical floor; building anyway`,
        ),
      )}\n`,
    );
  }

  return {
    async begin() {
      if (before) return;
      try {
        await makeRoom();
      } catch (error) {
        if (signal?.aborted) throw error;
      }
      before = measureTargets(root).catch(() => null);
    },
    async finish() {
      if (!before) return;
      try {
        const [start, end] = [await before, await measureTargets(root)];
        if (start === null || end === null) return;
        setBuildBytes(root, platform, Math.max(0, end - start));
      } catch {}
    },
  };
}
