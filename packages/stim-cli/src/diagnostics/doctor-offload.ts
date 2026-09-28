import {
  localStimBuildId,
  localToolchain,
  offloadHost,
  probeWorker,
  readAndroidRequirements,
  toolchainMismatches,
  MIN_WORKER_DISK,
  type AndroidRequirements,
  type LocalToolchain,
  type OffloadPlatform,
} from '../offload/client.ts';
import type { WorkerProbe } from '../offload/protocol.ts';
import type { DoctorPlatform, Finding } from './doctor.ts';

const SETUP = 'scripts/offload-worker-setup.sh <host> [<worker root>]';

/** Doctor findings for the experimental offload worker named by STIM_OFFLOAD_HOST. */
export function offloadFindings({
  host,
  worker,
  error,
  platforms,
  toolchains,
  localBuildId,
  android,
  localNode = process.version,
}: {
  host: string;
  worker: WorkerProbe | null;
  error: string | null;
  platforms: OffloadPlatform[];
  toolchains: Partial<Record<OffloadPlatform, LocalToolchain>>;
  localBuildId: string | null;
  android: AndroidRequirements | null;
  localNode?: string;
}): Finding[] {
  if (!worker) {
    return [
      {
        level: 'cost',
        title: `The offload worker ${host} is unreachable`,
        detail: `STIM_OFFLOAD_HOST is set, but the worker probe failed: ${error ?? 'no result'}. Every native build falls back to this Mac after the probe times out.`,
        fix: `Check \`ssh ${host}\`, then run ${SETUP}; or unset STIM_OFFLOAD_HOST.`,
      },
    ];
  }
  const findings: Finding[] = [];
  const ready: string[] = [];
  for (const platform of platforms) {
    const mismatches = toolchainMismatches({
      platform,
      worker,
      toolchain: toolchains[platform]!,
      localBuildId,
      android: platform === 'android' ? android : null,
    });
    if (mismatches.length) {
      findings.push({
        level: 'cost',
        title: `The offload worker ${host} cannot build ${platform} like this Mac`,
        detail: `Offloaded ${platform} builds are refused and run here: ${mismatches.join('; ')}.`,
        fix: `Align the worker's toolchain with this Mac, then rerun ${SETUP} so it runs this Stim build.`,
      });
    } else {
      ready.push(platform);
    }
  }
  if (worker.diskFreeBytes !== null && worker.diskFreeBytes < MIN_WORKER_DISK) {
    findings.push({
      level: 'cost',
      title: `The offload worker ${host} is low on disk`,
      detail: `${(worker.diskFreeBytes / 1024 ** 3).toFixed(1)} GB free under ${worker.root}; offloads are refused below ${MIN_WORKER_DISK / 1024 ** 3} GB.`,
      fix: `Free space on that volume, or move the worker root to a larger volume with ${SETUP}.`,
    });
  }
  if (ready.length) {
    const nodeNote =
      worker.node.split('.')[0] === localNode.split('.')[0]
        ? ''
        : ` Node differs (${worker.node} vs ${localNode}); the fingerprint gate still applies.`;
    findings.push({
      level: 'note',
      title: `The offload worker ${host} can build ${ready.join(' and ')}`,
      detail: `Root ${worker.root}, ${((worker.diskFreeBytes ?? 0) / 1024 ** 3).toFixed(0)} GB free, Stim ${worker.stimVersion}.${nodeNote}`,
      fix: null,
    });
  }
  return findings;
}

export async function detectOffloadWorker(
  root: string,
  { platform }: { platform?: DoctorPlatform } = {},
): Promise<Finding[]> {
  const host = offloadHost();
  if (!host) return [];
  const platforms: OffloadPlatform[] = platform ? [platform] : ['ios', 'android'];
  const { worker, error } = await probeWorker(host);
  const toolchains: Partial<Record<OffloadPlatform, LocalToolchain>> = {};
  for (const p of platforms) toolchains[p] = localToolchain(p);
  return offloadFindings({
    host,
    worker,
    error,
    platforms,
    toolchains,
    localBuildId: localStimBuildId(),
    android: platforms.includes('android') ? readAndroidRequirements(root) : null,
  });
}
