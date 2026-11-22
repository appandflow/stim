import type { Config, ProjectRecord } from '@stim-cli/core/state';
import type { StimContext } from '@stim-cli/core';
import { readGcMark, readDiscoveryCensusFile } from '@stim-cli/core/state';
import { stat } from 'node:fs/promises';
import { isClaimUnavailable } from '@stim-cli/core/ownership-claim';
import { loadConfig } from '../workspace/config.ts';
import { targetedCheckouts } from '../workspace/discovery.ts';
import { listedRoots } from '../commands/gc/worktrees.ts';
import { MarkInterrupted, requestMark } from './disk-owner.ts';
import { realpathAsync } from '../commands/gc/paths.ts';
import { answered, Unanswered } from '../workspace/bounded-read.ts';
import { markDue, markWriter, type HolderMarkScope } from './marks.ts';
import { inheritDeclaredSpawns, operationState } from '../engine/operation-state.ts';
import { dormantAfterMs, readCheckout, type DeviceReading } from './stages.ts';

export async function refreshKnownOutputMark(
  config: Config,
  path: string,
  project: ProjectRecord,
  reading: DeviceReading & { operation: StimContext },
  options: { signal?: AbortSignal; holder?: HolderMarkScope } = {},
): Promise<void> {
  const deadline = new AbortController();
  const timer = setTimeout(() => deadline.abort(new Unanswered('mark read deadline')), 3_000);
  const signal = AbortSignal.any([
    reading.operation.signal,
    options.signal ?? reading.operation.signal,
    operationState(reading.operation).runSignal ?? reading.operation.signal,
    deadline.signal,
  ]);
  const operation = { ...reading.operation, signal };
  inheritDeclaredSpawns(reading.operation, operation);
  operationState(operation).runSignal = signal;
  try {
    const root = await answered(path, () => realpathAsync(path), 3_000, signal);
    const previous = readGcMark(root);
    if (!markDue(previous, Date.now(), dormantAfterMs(config, operation.env))) return;
    const holder = options.holder;
    if (holder && (holder.root !== root || holder.markedAt !== previous?.markedAt)) return;
    if (holder && (await answered(root, () => stat(root), 3_000, signal)).dev !== holder.device) return;
    if (!holder && !Object.hasOwn(config.projects, path) && !Object.hasOwn(config.projects, root)) {
      const allowed = await targetedCheckouts(config, listedRoots(), [root], operation);
      if (!allowed.some((entry) => entry.path === root)) return;
    }
    const current = await readCheckout(path, project, { ...reading, operation }, 2 * 60_000);
    signal.throwIfAborted();
    await markWriter(config, signal, true, holder ? new Map([[path, holder]]) : undefined)(current);
  } finally {
    clearTimeout(timer);
  }
}

export interface MarkRefreshInput extends Pick<DeviceReading, 'devices' | 'simsFailed'> {
  config: Config;
  known: readonly string[];
  holders: readonly HolderMarkScope[];
  at: number;
  intervalMs: number;
}

export async function refreshKnownMarks(
  input: MarkRefreshInput,
  operation: StimContext,
  log?: DeviceReading['log'],
): Promise<void> {
  const census = readDiscoveryCensusFile();
  const roots = new Set([
    ...Object.keys(input.config.projects),
    ...input.known,
    ...(census.status === 'read'
      ? (census.census?.finds ?? []).filter(({ kind }) => kind === 'reduce-only').map(({ path }) => path)
      : []),
  ]);
  const signature = JSON.stringify(input.config);
  for (const path of roots) {
    operation.signal.throwIfAborted();
    const config = loadConfig();
    if (!config) return;
    if (!markDue(readGcMark(path), Date.now(), dormantAfterMs(config, operation.env))) continue;
    const asked = requestMark((signal) => {
      const current = loadConfig();
      if (!current) return Promise.resolve();
      const holder =
        Date.now() - input.at <= input.intervalMs && JSON.stringify(current) === signature
          ? input.holders.find(({ root }) => root === path)
          : undefined;
      return refreshKnownOutputMark(
        current,
        path,
        current.projects[path] ?? {},
        { ...input, operation, log },
        { signal, holder },
      );
    });
    const cancel = () => asked.leave();
    operation.signal.addEventListener('abort', cancel, { once: true });
    if (operation.signal.aborted) cancel();
    try {
      await asked.result;
    } catch (error) {
      if (isClaimUnavailable(error) || (error instanceof Error && 'reportCleanup' in error)) throw error;
      operation.signal.throwIfAborted();
      if (error instanceof MarkInterrupted) return;
      log?.('debug', 'gc_mark_refresh_failed', error instanceof Error ? error.message : String(error), { root: path });
      if (error instanceof Unanswered) return;
    } finally {
      operation.signal.removeEventListener('abort', cancel);
    }
  }
}
