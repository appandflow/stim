import type { StimContext } from '@stim-cli/core';
import { withWorkspaceProcessLock } from '../engine/workspace-process-lock.ts';
import { inspectProcessIdentity } from '../process-identity.ts';
import { getConcurrencyLimits, getConfigDir, getPlatformDeviceLimits, loadConfig } from '../workspace/config.ts';
import { runningBundleInstancesAsync } from './instances.ts';
import { requiredMacosRecord } from './state.ts';

function localLimit(context: StimContext): { max: number; setting: string } | undefined {
  return [
    { max: getPlatformDeviceLimits({ env: context.env }).macos, setting: 'concurrency.maxMacosApps' },
    { max: getConcurrencyLimits({ env: context.env }).maxDevices, setting: 'concurrency.maxDevices' },
  ]
    .filter((limit) => limit.max > 0)
    .toSorted((a, b) => a.max - b.max)[0];
}

export async function peekLocalMacosCapacity(
  root: string,
  context: StimContext,
): Promise<{ count: number; max: number; limit?: string; queued: number; localLive: boolean }> {
  const limit = localLimit(context);
  if (!limit) return { count: 0, max: 0, queued: 0, localLive: false };
  let running = 0;
  for (const project of Object.keys(loadConfig()?.projects ?? {})) {
    context.signal.throwIfAborted();
    if (project === root) continue;
    const record = requiredMacosRecord(project);
    if (record?.host) continue;
    const identity = record?.app ? inspectProcessIdentity(record.app) : 'gone';
    if (identity === 'unknown') {
      throw Object.assign(new Error(`Cannot verify the macOS app in ${project}; local app capacity is unknown.`), {
        code: 'STIM_MACOS_OWNER_UNVERIFIED',
      });
    }
    if (identity === 'same' || (await runningBundleInstancesAsync(project, context)).length > 0) running++;
    if (running >= limit.max) break;
  }
  return { count: running, max: limit.max, limit: limit.setting, queued: 0, localLive: false };
}

export async function assertLocalMacosCapacity(root: string, context: StimContext): Promise<void> {
  const capacity = await peekLocalMacosCapacity(root, context);
  if (capacity.max > 0 && capacity.count >= capacity.max) {
    throw Object.assign(
      new Error(`${capacity.count} local macOS apps are running and ${capacity.limit} is ${capacity.max}.`),
      {
        code: 'STIM_AT_CAPACITY',
        remedy: `Run stim stop in another workspace or raise ${capacity.limit}.`,
      },
    );
  }
}

export function withLocalMacosAdmission<T>(root: string, context: StimContext, launch: () => Promise<T>): Promise<T> {
  if (!localLimit(context)) return launch();
  return withWorkspaceProcessLock(
    getConfigDir(),
    'macos-admission',
    async () => {
      await assertLocalMacosCapacity(root, context);
      return launch();
    },
    { external: true, signal: context.signal, declareSpawnsFor: context, ownerPurpose: 'admit local macOS app' },
  );
}
