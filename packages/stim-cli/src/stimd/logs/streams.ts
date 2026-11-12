import { createHash, randomUUID } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { join, resolve as resolvePath } from 'node:path';
import type { ChildProcess, SpawnOptions } from 'node:child_process';
import { isJsonObject, readDevServerStop, type DevServerStopRecord } from '@stim-cli/core/state';
import { readWorkspaceState } from '../../workspace/workspace-state.ts';
import { runCollector, type RunCollectorHandle } from './collector.ts';
import { deviceSlotKey, parseDeviceSlotKey, validateDeviceSlot } from '../../devices/device-slots.ts';
import { getExecutor } from '../../exec.ts';
import { signalProcessTree } from '../../metro.ts';
import {
  ClaimUnavailableError,
  clearClaimChild,
  markClaimChildPending,
  processGroupAlive,
  releaseClaim,
  setClaimChild,
  type ClaimHandle,
} from '../../ownership-claim.ts';
import { captureProcessToken, inspectProcessIdentity } from '../../process-identity.ts';
import { adbCommand, isLogCleanupError, startAndroidLogcat } from './android.ts';
import { androidToolCwd } from '../../devices/android.ts';
import {
  clearHistoryClaim,
  clearStreamClaim,
  pendingChildRemoveCommand,
  streamOwnerGone,
  takeStreamClaim,
} from './claim.ts';
import { deviceUnavailable, interruptedRecord, lastWrittenFor } from './interruption.ts';
import { workspaceLogsDir } from '../../workspace/paths.ts';
import { readWebRecord } from '../../web/state.ts';
import { loadConfig } from '../../workspace/config.ts';
import { backfillDeviceLog } from './backfill.ts';
import { startIosDeviceConsole } from './ios-device.ts';
import { startIosLogStream } from './ios.ts';
import {
  handedOverStream,
  markStreamHandedOver,
  markStreamInterrupted,
  readCollectors,
  registerCollector,
  unregisterStream,
  unregisterStreamAll,
} from './state.ts';
import { createLogWriters, type LogSink, type LogWriters } from './writer.ts';

export interface StreamSpec {
  root: string;
  platform: 'ios' | 'android';
  slot?: string;
  udid?: string;
  bundleId?: string;
  appName?: string;
  appExecutable?: string;
  serial?: string;
  packageName?: string;
  physical?: boolean;
  payloadUrl?: string;
}

export function parseStreamSpec(value: unknown): StreamSpec | null {
  if (
    !isJsonObject(value) ||
    typeof value.root !== 'string' ||
    (value.platform !== 'ios' && value.platform !== 'android')
  )
    return null;
  const fields = [
    'slot',
    'udid',
    'bundleId',
    'appName',
    'appExecutable',
    'serial',
    'packageName',
    'payloadUrl',
  ] as const;
  for (const field of fields) if (value[field] !== undefined && typeof value[field] !== 'string') return null;
  if (value.physical !== undefined && typeof value.physical !== 'boolean') return null;
  if (value.platform === 'ios' && (!value.udid || !value.bundleId || !value.appName)) return null;
  if (value.platform === 'android' && (!value.serial || !value.packageName || value.physical)) return null;
  if (value.payloadUrl && !value.physical) return null;
  return {
    root: value.root,
    platform: value.platform,
    ...(typeof value.slot === 'string' ? { slot: value.slot } : {}),
    ...(typeof value.udid === 'string' ? { udid: value.udid } : {}),
    ...(typeof value.bundleId === 'string' ? { bundleId: value.bundleId } : {}),
    ...(typeof value.appName === 'string' ? { appName: value.appName } : {}),
    ...(typeof value.appExecutable === 'string' ? { appExecutable: value.appExecutable } : {}),
    ...(typeof value.serial === 'string' ? { serial: value.serial } : {}),
    ...(typeof value.packageName === 'string' ? { packageName: value.packageName } : {}),
    ...(typeof value.payloadUrl === 'string' ? { payloadUrl: value.payloadUrl } : {}),
    ...(value.physical === true ? { physical: true } : {}),
  };
}

/**
 * Whether stimd restarts the stream record found under `slotKey` of the workspace at canonical `root`, or why it drops
 * it. `lost` is true when capture stopped and will not come back, so the device log should say so. A handed-over
 * record without a parseable `handedOverAt` counts as handed over at time 0, so any recorded `stim stop` or idle stop
 * drops it; a record that was never handed over (its stimd died) is compared against its `startedAt` the same way.
 */
export function resumeDecision(
  record: Record<string, unknown>,
  root: string,
  slotKey: string,
  devServerStop: DevServerStopRecord | null,
): { spec: StreamSpec } | { reason: string; lost: boolean } {
  const spec = parseStreamSpec(record.spec);
  if (!spec) return { reason: 'its record holds no stream spec', lost: true };
  const stamp = record.handover === true ? record.handedOverAt : record.startedAt;
  const handedOverAt = typeof stamp === 'string' ? Date.parse(stamp) : Number.NaN;
  if (
    (devServerStop?.reason === 'requested' || devServerStop?.reason === 'idle') &&
    Date.parse(devServerStop.at) >= (Number.isNaN(handedOverAt) ? 0 : handedOverAt)
  )
    return { reason: 'the workspace stopped after the handover', lost: false };
  if (spec.physical) return { reason: 'a physical device console is not resumed', lost: true };
  if (spec.root !== root)
    return {
      reason: `its spec names another workspace, ${spec.root}`,
      lost: false,
    };
  if (deviceSlotKey(spec.platform, spec.slot ?? 'default') !== slotKey)
    return { reason: 'its spec names another slot', lost: false };
  return { spec };
}

export interface StreamTable {
  ownedSync(root?: string): Promise<string | null>;
  ownedDrain(root: string): Promise<string | null>;
  ownedObserveWeb(root: string, pid: number, token: string): Promise<string | null>;
  ownedRunning(): boolean;
  start(
    input: StreamSpec,
    env: Record<string, string>,
    signal?: AbortSignal,
    runId?: string,
  ): Promise<{ streamId: string }>;
  stop(root: string, platform: string, slot: string, streamId: string): Promise<boolean>;
  wait(
    root: string,
    platform: string,
    slot: string,
    streamId: string,
    since: number,
    after: number,
    timeoutMs: number,
    signal?: AbortSignal,
    env?: Record<string, string>,
    through?: number,
    checkCoverage?: boolean,
  ): Promise<{
    revision: number;
    gone?: true;
    coverage?: 'pending' | 'covered' | 'failed';
  }>;
  running(): boolean;
  /** Whether a stream runs that a successor stimd cannot resume: a physical iPhone's console launches its app. */
  holdsRelaunch(): boolean;
  /** The workspaces whose streams hold a relaunch. */
  heldRoots(): string[];
  /** Restarts the streams a predecessor stimd handed over in these workspaces, with this process's environment. */
  resume(paths: string[], env: Record<string, string>): void;
  /** With `handover`, each stopped stream that can be resumed keeps its record, marked for the successor. */
  close(options?: { handover?: boolean }): Promise<void>;
}

type HistoryCoverage = {
  status: 'pending' | 'covered' | 'failed';
  generation?: number;
  startedAt?: number;
  warm?: boolean;
  failureVersion?: number;
};

type Stream = {
  id: string;
  key: string;
  root: string;
  slotKey: string;
  spec: StreamSpec;
  envHash: string;
  env: Record<string, string>;
  interruptedBy: string | null;
  aliases: Map<string, string>;
  claim: ClaimHandle;
  controller: AbortController;
  sink: LogSink;
  child: ChildProcess | null;
  childClosed: Promise<void> | null;
  spawnedPid: number | null;
  identity: { pid: number; processToken: string } | null;
  signalling: Promise<void> | null;
  stopping: boolean;
  treePending: boolean;
  lastStop: {
    pid: number | null;
    identity: string;
    signalled?: boolean;
    error?: string;
  } | null;
  pending: boolean;
  handover: boolean;
  initialQueryPending: boolean;
  queryReads: number;
  paused: boolean;
  generation: number;
  activePid: number | null;
  observedAt: number | null;
  writeFailures: number;
  revision: number;
  waiters: Set<(gone: boolean) => void>;
  historySeen: WeakMap<AbortSignal, HistoryCoverage>;
  histories: Set<Promise<void>>;
  historyQueue: Promise<void>;
  started: Promise<RunCollectorHandle | null>;
  done: Promise<void>;
  finalized: boolean;
  cleanupError: string | null;
  probeFailure: Error | null;
  cleanup: () => Promise<void>;
  finish: () => void;
};

function alive(stream: Stream): boolean {
  if (!stream.identity) return false;
  return process.platform === 'win32'
    ? inspectProcessIdentity(stream.identity) === 'same'
    : processGroupAlive(stream.identity.pid);
}

function signalChild(stream: Stream): Promise<void> {
  if (stream.signalling) return stream.signalling;
  const child = stream.identity;
  if (!child) {
    stream.lastStop = { pid: stream.spawnedPid, identity: 'unavailable' };
    return Promise.resolve();
  }
  const identity = inspectProcessIdentity(child);
  if (identity !== 'same') {
    if (stream.lastStop?.pid !== child.pid || stream.lastStop.signalled === undefined)
      stream.lastStop = { pid: child.pid, identity };
    return Promise.resolve();
  }
  stream.lastStop = { pid: child.pid, identity };
  const lastStop = stream.lastStop;
  const signalling = (async () => {
    try {
      if (process.platform === 'win32') {
        markClaimChildPending(stream.claim);
        stream.treePending = true;
        stream.pending = true;
        await getExecutor().runFileAsync(
          join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'taskkill.exe'),
          ['/PID', String(child.pid), '/T', '/F'],
          { timeoutMs: 30_000 },
        );
        lastStop.signalled = true;
      } else {
        lastStop.signalled = signalProcessTree(child.pid, 'SIGTERM', {
          group: true,
        });
      }
    } catch (error) {
      lastStop.signalled = false;
      const detail = error instanceof Error ? error : new Error(String(error));
      lastStop.error = JSON.stringify({
        code: Reflect.get(detail, 'code'),
        status: Reflect.get(detail, 'status'),
        stderr: String(Reflect.get(detail, 'stderr') ?? '').slice(0, 2048),
        message: detail.message.slice(0, 2048),
      });
    }
  })();
  stream.signalling = signalling;
  void signalling.finally(() => {
    if (stream.signalling === signalling) stream.signalling = null;
  });
  return signalling;
}

async function waitChild(stream: Stream): Promise<void> {
  await stream.signalling;
  if (process.platform === 'win32' && stream.treePending && stream.lastStop?.signalled !== true)
    throw new Error(
      `the device log process tree could not be verified stopped (stop=${JSON.stringify(stream.lastStop)}); ` +
        `verify the prior daemon, child and descendants have stopped, then run ${pendingChildRemoveCommand(stream.claim.path)} and retry.`,
    );
  const running = () =>
    stream.identity
      ? alive(stream)
      : stream.spawnedPid !== null &&
        (process.platform === 'win32'
          ? stream.child !== null && stream.child.exitCode === null && stream.child.signalCode === null
          : processGroupAlive(stream.spawnedPid));
  for (const deadline = Date.now() + 2000; running() && Date.now() < deadline;)
    await new Promise((resolve) => setTimeout(resolve, 20));
  if (running()) {
    if (stream.pending && !stream.identity)
      throw new Error(
        `The device log child at ${stream.claim.root} cannot be verified stopped; verify the prior daemon, child and descendants have stopped, then run ${pendingChildRemoveCommand(stream.claim.path)} and retry.`,
      );
    throw new Error('the device log stream did not stop');
  }
  const childClosed = stream.childClosed;
  if (childClosed) {
    const closed = await new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => resolve(false), 2000);
      void childClosed.then(() => {
        clearTimeout(timer);
        resolve(true);
        return undefined;
      });
    });
    if (!closed) {
      const child = stream.child;
      throw new Error(
        `the device log stream pipes did not close (exit=${String(child?.exitCode)}, signal=${String(child?.signalCode)}, ` +
          `stdoutEnded=${String(child?.stdout?.readableEnded)}, stdoutFlowing=${String(child?.stdout?.readableFlowing)}, ` +
          `stderrEnded=${String(child?.stderr?.readableEnded)}, stderrFlowing=${String(child?.stderr?.readableFlowing)}, backpressure=${stream.paused}, stop=${JSON.stringify(stream.lastStop)})`,
      );
    }
  }
  if (stream.queryReads === 0) {
    if (stream.identity || stream.pending || stream.initialQueryPending) clearClaimChild(stream.claim);
    stream.initialQueryPending = false;
  } else stream.initialQueryPending = true;
  stream.pending = false;
  stream.treePending = false;
  stream.identity = null;
  stream.spawnedPid = null;
  stream.child = null;
}

function spawnChild(
  stream: Stream,
  env: Record<string, string>,
  cmd: string,
  args: string[],
  options: SpawnOptions,
): ChildProcess {
  stream.lastStop = null;
  if (stream.queryReads === 0) stream.initialQueryPending = false;
  markClaimChildPending(stream.claim);
  stream.pending = true;
  // Windows taskkill /T needs the live launcher PID to find descendants; keep the claim pending until it succeeds.
  // https://learn.microsoft.com/windows-server/administration/windows-commands/taskkill
  stream.treePending = process.platform === 'win32';
  let child: ChildProcess;
  try {
    const android = stream.spec.platform === 'android';
    child = getExecutor().spawn(android ? adbCommand(env, stream.root) : cmd, args, {
      ...options,
      cwd: android ? (androidToolCwd() ?? stream.root) : stream.root,
      env,
      detached: process.platform !== 'win32',
    });
  } catch (error) {
    if (stream.queryReads === 0) clearClaimChild(stream.claim);
    else stream.initialQueryPending = true;
    stream.pending = false;
    stream.treePending = false;
    throw error;
  }
  stream.child = child;
  stream.spawnedPid = child.pid ?? null;
  stream.childClosed = new Promise((resolve) => child.once('close', () => resolve()));
  child.on('error', () => {});
  if (!child.pid) {
    if (stream.queryReads === 0) clearClaimChild(stream.claim);
    else stream.initialQueryPending = true;
    stream.pending = false;
    stream.treePending = false;
    throw new Error('could not start the device log stream child');
  }
  const token = captureProcessToken(child.pid);
  if (!token) {
    throw new Error('could not capture the device log stream child identity');
  }
  stream.identity = { pid: child.pid, processToken: token };
  try {
    if (process.platform !== 'win32' && stream.queryReads === 0) setClaimChild(stream.claim, stream.identity);
  } catch (error) {
    void signalChild(stream);
    throw error;
  }
  stream.pending = false;
  if (stream.paused) {
    child.stdout?.pause();
    child.stderr?.pause();
  }
  return child;
}

const noop = () => {};
const NO_LINE_LOOKBACK_MS = 5 * 60_000;
class AndroidPidChanged extends Error {}

function environmentHash(env: Record<string, string>): string {
  const values = new Map<string, string>();
  for (const [name, value] of Object.entries(env).toSorted(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    const key = process.platform === 'win32' ? name.toUpperCase() : name;
    if (key === 'STIM_RUN_ID' || key === 'STIM_TRACE' || key === 'STIM_TRACE_OWNER' || values.has(key)) continue;
    values.set(key, value);
  }
  return createHash('sha256')
    .update(JSON.stringify([...values].toSorted(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))))
    .digest('hex');
}

const matches = (stream: Stream, input: StreamSpec, root: string, envHash: string): boolean =>
  stream.root === root &&
  stream.envHash === envHash &&
  !input.physical &&
  !stream.spec.physical &&
  !stream.controller.signal.aborted &&
  stream.spec.platform === input.platform &&
  stream.spec.udid === input.udid &&
  stream.spec.serial === input.serial &&
  stream.spec.bundleId === input.bundleId &&
  stream.spec.packageName === input.packageName &&
  stream.spec.appName === input.appName &&
  stream.spec.appExecutable === input.appExecutable &&
  (!stream.child || (stream.child.exitCode === null && stream.child.signalCode === null));
const attribution = (slot: string, input: StreamSpec) =>
  slot === 'default' ? {} : { slot, deviceId: input.udid ?? input.serial };
const streamRecord = (streamId: string, spec: StreamSpec, runId: string | undefined) => ({
  kind: 'stream',
  streamId,
  startedAt: new Date().toISOString(),
  ...(spec.physical ? {} : { spec, ...(runId ? { runId } : {}) }),
});

const stopStimdRemedy = () =>
  process.platform === 'win32'
    ? `Stopping this stimd (taskkill /PID ${process.pid} /F) is safe, and the next command starts a new one.`
    : `Stopping this stimd (kill ${process.pid}) is safe, and the next command starts a new one.`;
const errorText = (error: unknown): string => (error instanceof Error ? error.message : String(error));
export function createStreams(
  log: (message: string) => void,
  ownedLog: (level: 'debug' | 'info' | 'warn' | 'error', event: string, msg: string) => void = () => {},
): StreamTable {
  const streams = new Map<string, Stream>();
  const queues = new Map<string, Promise<void>>();
  let writers: LogWriters | null = null;
  let writerFailure: Error | null = null;
  let writerRecovery: Promise<void> | null = null;
  const unverified = new Set<string>();
  const inflight = new Map<string, number>();
  const restarted = new Set<string>();
  let ownedPending = 0;
  let closing = false;
  let closePromise: Promise<void> | null = null;
  let ownedRunning = true;
  const serialize = <T>(key: string, work: () => Promise<T>): Promise<T> => {
    const result = (queues.get(key) ?? Promise.resolve()).then(work);
    const done = result.then(
      () => undefined,
      () => undefined,
    );
    queues.set(key, done);
    void done.then(() => {
      if (queues.get(key) === done) queues.delete(key);
      return undefined;
    });
    return result;
  };
  const abortAfterSignal = async (stream: Stream): Promise<void> => {
    await signalChild(stream);
    if (
      process.platform !== 'win32' ||
      (!stream.child && stream.spawnedPid === null && !stream.pending) ||
      stream.lastStop?.signalled === true
    )
      stream.controller.abort();
  };
  const stop = async (stream: Stream, requested = true): Promise<void> => {
    stream.stopping = true;
    if (requested) {
      stream.handover = false;
      stream.interruptedBy = null;
    }
    const retry = stream.finalized;
    await abortAfterSignal(stream);
    if (
      process.platform === 'win32' &&
      (stream.child || stream.spawnedPid !== null || stream.pending) &&
      stream.lastStop?.signalled !== true
    )
      throw new Error(`the device log tree could not be stopped (stop=${JSON.stringify(stream.lastStop)})`);
    await stream.started.catch(() => null);
    await stream.done;
    if (retry && [...streams.values()].includes(stream)) await stream.cleanup();
    if (stream.probeFailure) throw stream.probeFailure;
    if ([...streams.values()].includes(stream))
      throw new Error(
        `the device log stream could not be stopped${stream.cleanupError ? `: ${stream.cleanupError}` : ''}`,
      );
  };
  const getWriters = async (): Promise<LogWriters> => {
    if (closing) throw new Error('the logs worker is closing');
    if (writerFailure) {
      writerRecovery ??= (async () => {
        await writers?.close();
        writers = null;
        writerFailure = null;
      })().finally(() => {
        writerRecovery = null;
      });
      await writerRecovery;
    }
    if (closing) throw new Error('the logs worker is closing');
    if (writers) return writers;
    // Node closes worker-owned process handles on worker exit: https://github.com/nodejs/node/issues/46569
    writers = createLogWriters(
      (error) => {
        writerFailure = error;
        ownedRunning = true;
        log(`the logs worker failed: ${error.message}`);
        const lost = [...new Set(streams.values())];
        for (const stream of lost) {
          if (!closing && !stream.spec.physical && !stream.stopping) {
            stream.handover = true;
            stream.interruptedBy = `the logs worker failed (${error.message})`;
          }
          void abortAfterSignal(stream);
        }
        if (closing) return;
        for (const root of inflight.keys()) unverified.add(root);
        try {
          for (const root of Object.keys(loadConfig()?.projects ?? {})) {
            try {
              if (readWebRecord(root)?.chromeProcess) unverified.add(root);
            } catch {}
          }
        } catch (failure) {
          log(`the config cannot be read to find owned browsers: ${errorText(failure)}`);
        }
        recover(lost, error);
      },
      (streamId) => {
        const stream = [...streams.values()].find((entry) => entry.id === streamId);
        if (!stream) return;
        stream.revision++;
        for (const wake of stream.waiters) wake(false);
      },
      (running) => {
        ownedRunning = running;
      },
      ownedLog,
      (streamId, generation) => {
        const stream = [...streams.values()].find((entry) => entry.id === streamId);
        if (stream && stream.generation === generation && stream.observedAt === null) stream.observedAt = Date.now();
      },
      (streamId, generation) => {
        const stream = [...streams.values()].find((entry) => entry.id === streamId);
        if (stream && stream.generation === generation) {
          stream.writeFailures++;
          stream.observedAt = null;
          for (const wake of stream.waiters) wake(false);
        }
      },
    );
    return writers;
  };
  const removeAlias = async (stream: Stream, key: string, slotKey: string): Promise<void> => {
    if (stream.aliases.size === 1) return stop(stream);
    await stream.sink.removeAlias(slotKey);
    try {
      unregisterStream(stream.root, slotKey, stream.id);
    } catch (error) {
      await stream.sink.addAlias(slotKey, attribution(slotKey.split(':')[1] ?? 'default', stream.spec));
      throw error;
    }
    stream.aliases.delete(key);
    streams.delete(key);
  };
  const scheduleBackfill = (
    stream: Stream,
    since: number,
    signal: AbortSignal,
    env: Record<string, string>,
    through: number,
  ): HistoryCoverage => {
    if (stream.spec.physical)
      return {
        status: 'failed' as const,
        warm: true,
        startedAt: Infinity,
      };
    const existing = stream.historySeen.get(signal);
    if (existing) {
      if (
        existing.status === 'covered' &&
        existing.generation !== undefined &&
        (existing.generation !== stream.generation ||
          existing.failureVersion !== stream.writeFailures ||
          !stream.child ||
          stream.child.exitCode !== null ||
          stream.child.signalCode !== null)
      )
        existing.status = 'failed';
      if (existing.status !== 'covered' || existing.warm || (existing.startedAt ?? 0) >= through) return existing;
    }
    const coverage: HistoryCoverage = { status: 'pending' };
    stream.historySeen.set(signal, coverage);
    const cancelled = AbortSignal.any([signal, stream.controller.signal]);
    const task = stream.historyQueue.then(async () => {
      cancelled.throwIfAborted();
      await new Promise<void>((resolve, reject) => {
        const cleanup = () => {
          cancelled.removeEventListener('abort', abort);
        };
        const abort = () => {
          cleanup();
          reject(cancelled.reason);
        };
        cancelled.addEventListener('abort', abort, { once: true });
        void stream.started.then(
          (started) => {
            if (!started) {
              cleanup();
              reject(new Error('the device log stream did not attach'));
            } else {
              cleanup();
              resolve();
            }
            return undefined;
          },
          (error: unknown) => {
            cleanup();
            reject(error);
          },
        );
        if (cancelled.aborted) abort();
      });
      while (!cancelled.aborted) {
        const generation = stream.generation;
        const activePid = stream.activePid;
        coverage.generation = generation;
        coverage.startedAt = Date.now();
        const retry = await backfillDeviceLog({
          root: stream.root,
          streamId: stream.id,
          spec: stream.spec,
          since,
          env,
          signal: cancelled,
          onBegin: () => {
            coverage.failureVersion = stream.writeFailures;
          },
          warm: (pid) => {
            if (stream.spec.platform === 'android' && (stream.generation !== generation || activePid !== pid))
              throw new AndroidPidChanged();
            if (stream.generation !== generation)
              throw new Error('the device log source changed during history replay');
            coverage.warm = false;
            return false;
          },
          sink: stream.sink,
        })
          .then(() => false)
          .catch(async (error: unknown) => {
            if (!(error instanceof AndroidPidChanged)) throw error;
            await new Promise<void>((resolve, reject) => {
              const cleanup = () => {
                stream.waiters.delete(check);
                cancelled.removeEventListener('abort', abort);
              };
              const abort = () => {
                cleanup();
                reject(cancelled.reason);
              };
              const check = () => {
                if (stream.generation <= generation || stream.activePid === null || !stream.child) return;
                cleanup();
                resolve();
              };
              stream.waiters.add(check);
              cancelled.addEventListener('abort', abort, { once: true });
              if (cancelled.aborted) abort();
              else check();
            });
            return true;
          });
        if (retry) continue;
        if (
          stream.generation !== generation ||
          coverage.failureVersion !== stream.writeFailures ||
          !stream.child ||
          stream.child.exitCode !== null ||
          stream.child.signalCode !== null
        )
          throw new Error('the device log source changed during history replay');
        return undefined;
      }
      cancelled.throwIfAborted();
      return undefined;
    });
    stream.histories.add(task);
    stream.historyQueue = task
      .then(() => {
        coverage.status = 'covered';
        return undefined;
      })
      .catch((error: unknown) => {
        coverage.status = 'failed';
        if (isLogCleanupError(error)) {
          stream.probeFailure = error;
          markClaimChildPending(stream.claim);
        }
        if (!cancelled.aborted) {
          const message = error instanceof Error ? error.message : String(error);
          log(`device log backfill ${stream.id} failed: ${message}`);
          stream.sink.writer.write({
            src: 'device',
            platform: stream.spec.platform,
            level: 'warn',
            event: 'collector_backfill_failed',
            msg: `Device log backfill failed: ${message}`,
          });
        }
      })
      .finally(() => {
        stream.histories.delete(task);
        for (const wake of stream.waiters) wake(false);
      });
    return coverage;
  };
  const startLocked = async (
    input: StreamSpec,
    env: Record<string, string>,
    signal?: AbortSignal,
    runId?: string,
    resumeId?: string,
  ): Promise<{ streamId: string }> => {
    if (closing) throw new Error('the logs worker is closing');
    const root = realpathSync(input.root);
    const envHash = environmentHash(env);
    const slot = validateDeviceSlot(input.slot ?? 'default');
    const slotKey = deviceSlotKey(input.platform, slot);
    const key = `${root}\0${slotKey}`;
    signal?.throwIfAborted();
    const previous = streams.get(key);
    if (previous && matches(previous, input, root, envHash)) return { streamId: previous.id };
    if (previous) await removeAlias(previous, key, slotKey);
    signal?.throwIfAborted();
    const recorded = readCollectors(root)[slotKey];
    if (recorded !== undefined && (!isJsonObject(recorded) || recorded.kind !== 'stream'))
      throw new Error('the previous device log collector must be stopped before starting a stream');
    const shared = [...new Set(streams.values())].find((stream) => matches(stream, input, root, envHash));
    if (shared && (recorded === undefined || handedOverStream(recorded))) {
      registerCollector(root, slotKey, streamRecord(shared.id, { ...input, root, slot }, runId));
      try {
        await shared.sink.addAlias(slotKey, attribution(slot, input));
        signal?.throwIfAborted();
      } catch (error) {
        await shared.sink.removeAlias(slotKey).catch(() => {});
        unregisterStream(root, slotKey, shared.id);
        throw error;
      }
      shared.aliases.set(key, slotKey);
      streams.set(key, shared);
      return { streamId: shared.id };
    }
    if (isJsonObject(recorded)) {
      if (typeof recorded.streamId !== 'string' || !recorded.streamId)
        throw new Error('the previous device log stream has no identity');
      const recordedId = recorded.streamId;
      await clearStreamClaim(root, recordedId, () => unregisterStreamAll(root, recordedId), handedOverStream(recorded));
    }
    const id = resumeId ?? randomUUID();
    const claim = await takeStreamClaim(root, id);
    if (signal?.aborted) {
      releaseClaim(claim);
      signal.throwIfAborted();
    }
    const controller = new AbortController();
    let stream: Stream;
    let sink: LogSink;
    try {
      sink = await (
        await getWriters()
      ).open(
        {
          streamId: id,
          slotKey,
          root,
          platform: input.platform,
          physical: input.physical === true,
          bundleId: input.bundleId,
          runId,
          attribution: attribution(slot, input),
        },
        (paused) => {
          if (!stream) return;
          stream.paused = paused;
          for (const pipe of [stream.child?.stdout, stream.child?.stderr]) {
            if (paused) pipe?.pause();
            else pipe?.resume();
          }
        },
      );
    } catch (error) {
      releaseClaim(claim);
      throw error;
    }
    if (signal?.aborted) {
      sink.writer.close();
      await sink.closed().catch(() => {});
      releaseClaim(claim);
      signal.throwIfAborted();
    }
    let finish = noop;
    const done = new Promise<void>((resolve) => {
      finish = resolve;
    });
    stream = {
      id,
      key,
      root,
      slotKey,
      spec: { ...input, root, slot },
      envHash,
      env,
      interruptedBy: null,
      aliases: new Map([[key, slotKey]]),
      claim,
      controller,
      sink,
      child: null,
      childClosed: null,
      spawnedPid: null,
      identity: null,
      signalling: null,
      stopping: false,
      treePending: false,
      lastStop: null,
      pending: false,
      handover: false,
      initialQueryPending: false,
      queryReads: 0,
      paused: false,
      generation: 0,
      activePid: null,
      observedAt: null,
      writeFailures: 0,
      revision: 0,
      waiters: new Set(),
      historySeen: new WeakMap(),
      histories: new Set(),
      historyQueue: Promise.resolve(),
      started: Promise.resolve(null),
      done,
      finalized: false,
      cleanupError: null,
      probeFailure: null,
      cleanup: async () => {},
      finish,
    };
    try {
      if (input.platform === 'android') {
        markClaimChildPending(claim);
        stream.initialQueryPending = true;
      }
      registerCollector(root, slotKey, streamRecord(id, stream.spec, runId));
    } catch (error) {
      sink.writer.close();
      await sink.closed().catch(() => {});
      releaseClaim(claim);
      throw error;
    }
    streams.set(key, stream);
    stream.cleanup = async () => {
      await stream.signalling;
      if (
        process.platform !== 'win32' ||
        (!stream.child && stream.spawnedPid === null && !stream.pending) ||
        stream.lastStop?.signalled === true
      )
        stream.controller.abort();
      try {
        const started = await stream.started;
        await started?.settled();
        if (stream.probeFailure) throw stream.probeFailure;
      } catch (error) {
        if (isLogCleanupError(error)) {
          markClaimChildPending(stream.claim);
          stream.probeFailure = error;
          throw error;
        }
      }
      const histories = await Promise.allSettled(stream.histories);
      for (const result of histories)
        if (result.status === 'rejected' && isLogCleanupError(result.reason)) stream.probeFailure = result.reason;
      if (stream.probeFailure) {
        markClaimChildPending(stream.claim);
        throw stream.probeFailure;
      }
      await clearHistoryClaim(root, id);
      await waitChild(stream);
      await sink.closed().catch((error: unknown) => log(`device log stream ${id} could not flush: ${String(error)}`));
      if ([...streams.values()].includes(stream)) {
        if (stream.handover) markStreamHandedOver(root, id, stream.interruptedBy ?? undefined);
        else unregisterStreamAll(root, id);
        if (!releaseClaim(claim)) throw new Error(`the device log claim at ${claim.root} changed during cleanup`);
        for (const alias of stream.aliases.keys()) if (streams.get(alias) === stream) streams.delete(alias);
        for (const wake of stream.waiters) wake(true);
      }
    };
    let finishing = false;
    const finalize = () => {
      if (finishing) return;
      finishing = true;
      void stream
        .cleanup()
        .catch((error: unknown) => {
          stream.cleanupError = error instanceof Error ? error.message : String(error);
          log(`device log stream ${id} did not close: ${stream.cleanupError}`);
        })
        .finally(() => {
          stream.finalized = true;
          stream.finish();
        });
    };
    const generations = new WeakMap<ChildProcess, number>();
    stream.started = runCollector({
      ...input,
      root,
      slot,
      signal: controller.signal,
      env,
      guardQuery: async (work) => {
        if (stream.queryReads === 0) markClaimChildPending(stream.claim);
        stream.queryReads++;
        let finished = false;
        const finishRead = () => {
          if (finished) return;
          finished = true;
          stream.queryReads--;
          if (
            stream.queryReads === 0 &&
            !stream.probeFailure &&
            !stream.stopping &&
            stream.identity &&
            process.platform !== 'win32'
          ) {
            try {
              setClaimChild(stream.claim, stream.identity);
              stream.initialQueryPending = false;
            } catch (error) {
              const failure = Object.assign(
                new ClaimUnavailableError(`device log claim could not be restored: ${String(error)}`),
                {
                  reportCleanup: true,
                  remedy: `Inspect the device log claim at ${stream.claim.root}.`,
                },
              );
              stream.probeFailure = failure;
              throw failure;
            }
          }
        };
        try {
          const value = await work();
          finishRead();
          return value;
        } catch (error) {
          if (isLogCleanupError(error)) stream.probeFailure = error;
          finishRead();
          throw error;
        }
      },
      writer: sink.writer,
      recordLine: (line, clockOffsetMs, child) => sink.line(line, clockOffsetMs, generations.get(child)),
      beforeFinish: sink.beforeFinish,
      startStream: (options) => {
        if (stream.stopping) throw new Error('the device log stream is stopping');
        stream.generation++;
        stream.activePid = options.pid ?? null;
        stream.observedAt = null;
        const spawnFn = (cmd: string, args: string[], opts: SpawnOptions) => spawnChild(stream, env, cmd, args, opts);
        let child: ChildProcess;
        if (input.platform === 'android') {
          if (!input.serial || !options.pid) throw new Error('the Android log stream has no serial or app pid');
          child = startAndroidLogcat({
            serial: input.serial,
            pid: options.pid,
            spawnFn,
          });
        } else if (!input.udid) throw new Error('the iOS log stream has no device id');
        else if (input.physical) {
          if (!input.bundleId) throw new Error('the iOS device console has no bundle id');
          child = startIosDeviceConsole({
            udid: input.udid,
            bundleId: input.bundleId,
            payloadUrl: input.payloadUrl,
            spawnFn,
          });
        } else {
          if (!input.appName) throw new Error('the iOS log stream has no app name');
          child = startIosLogStream({
            udid: input.udid,
            appName: input.appName,
            executableName: input.appExecutable,
            spawnFn,
          });
        }
        generations.set(child, stream.generation);
        for (const wake of stream.waiters) wake(false);
        return child;
      },
      stopStream: async () => {
        stream.generation++;
        stream.activePid = null;
        stream.observedAt = null;
        for (const wake of stream.waiters) wake(false);
        await signalChild(stream);
        await waitChild(stream);
      },
      onCleanupFailure: (error) => {
        stream.probeFailure = error;
      },
      onExit: finalize,
    });
    void stream.started.catch((error: unknown) => {
      log(`device log stream ${id} failed: ${String(error)}`);
      if (isLogCleanupError(error)) stream.probeFailure = error;
      void (async () => {
        await abortAfterSignal(stream);
        if (!finishing) {
          sink.writer.close();
          finalize();
        }
      })();
    });
    return { streamId: id };
  };
  const writeLost = async (
    root: string,
    slotKey: string,
    streamId: string,
    spec: StreamSpec | undefined,
    platform: 'ios' | 'android',
    runId: string | undefined,
    record: Record<string, unknown>,
  ): Promise<void> => {
    const slot = slotKey.split(':')[1] ?? 'default';
    const sink = await (
      await getWriters()
    ).open(
      {
        streamId,
        slotKey,
        root,
        platform,
        physical: true,
        runId,
        attribution: slot === 'default' ? {} : { slot, deviceId: spec?.udid ?? spec?.serial },
      },
      () => {},
    );
    sink.writer.write(record);
    await sink.closed();
  };
  // @ref LLP 0019#a-stream-survives-a-stimd-crash-a-planned-update-and-a-logs-worker-failure -- a stream restarts only when its owner is proven gone
  const resumeIn = async (
    root: string,
    env: Record<string, string>,
    envs: Map<string, Record<string, string>> = new Map(),
    skip: Set<string> = new Set(),
  ): Promise<void> => {
    const groups = new Map<
      string,
      {
        specs: StreamSpec[];
        runId?: string;
        reason: string | null;
        startedAt: string | undefined;
      }
    >();
    const state = readWorkspaceState(root);
    const devServerStop = readDevServerStop(state);
    const live = new Set([...streams.values()].map((stream) => stream.id));
    const file = join(workspaceLogsDir(root), 'device.ndjson');
    for (const [slotKey, record] of Object.entries(state?.collectors ?? {})) {
      if (!isJsonObject(record) || record.kind !== 'stream' || typeof record.streamId !== 'string') continue;
      const id = record.streamId;
      if (live.has(id) || skip.has(id)) continue;
      const handedOver = handedOverStream(record);
      if (!handedOver && typeof record.interruptedAt === 'string') continue;
      const crashed = !handedOver;
      const reason =
        typeof record.interruptedBy === 'string'
          ? record.interruptedBy
          : crashed
            ? 'the stimd that captured it exited without stopping it'
            : null;
      if (crashed) {
        const owner = streamOwnerGone(root, id);
        if (!owner.gone) {
          ownedLog(
            'warn',
            'device_log_stream_unverified',
            `device log stream ${id} in ${root} was not resumed: ${owner.reason}`,
          );
          continue;
        }
      }
      const decision = resumeDecision(record, root, slotKey, devServerStop);
      const parsed = parseDeviceSlotKey(slotKey);
      let refusal = 'reason' in decision ? decision : null;
      if (!refusal && crashed && 'spec' in decision) {
        const why = await deviceUnavailable(decision.spec);
        if (why) refusal = { reason: why, lost: true };
      }
      if (refusal) {
        ownedLog('info', 'device_log_stream_dropped', `device log stream ${id} in ${root}: ${refusal.reason}`);
        if (refusal.lost && reason !== null && parsed) {
          try {
            await writeLost(
              root,
              slotKey,
              id,
              parseStreamSpec(record.spec) ?? undefined,
              parsed.platform,
              typeof record.runId === 'string' ? record.runId : undefined,
              interruptedRecord({
                platform: parsed.platform,
                from: (await lastWrittenFor(file, id)).record,
                until: Date.now(),
                reason: `${reason}; it was not restarted because ${refusal.reason}`,
                outcome: 'lost',
              }),
            );
          } catch (error) {
            ownedLog('warn', 'device_log_stream_dropped', `${id} in ${root}: ${String(error)}`);
          }
        }
        if (handedOver) unregisterStream(root, slotKey, id);
        else if (refusal.lost) markStreamInterrupted(root, id);
        continue;
      }
      if (!('spec' in decision)) continue;
      const group = groups.get(id) ?? {
        specs: [],
        reason,
        startedAt: typeof record.startedAt === 'string' ? record.startedAt : undefined,
        ...(typeof record.runId === 'string' ? { runId: record.runId } : {}),
      };
      group.specs.push(decision.spec);
      groups.set(id, group);
    }
    for (const [id, { specs, runId, reason, startedAt }] of groups) {
      const streamEnv = envs.get(id) ?? env;
      try {
        const last = await lastWrittenFor(file, id);
        const since =
          last.line !== null ? last.line + 1 : Math.max(Date.parse(startedAt ?? ''), Date.now() - NO_LINE_LOOKBACK_MS);
        for (const [index, spec] of specs.entries())
          await startLocked(spec, streamEnv, undefined, runId, index === 0 ? id : undefined);
        const stream = [...streams.values()].find((entry) => entry.id === id);
        if (stream) {
          if (reason !== null)
            stream.sink.writer.write(
              interruptedRecord({
                platform: stream.spec.platform,
                from: last.record ?? (Number.isNaN(since) ? null : since),
                until: Date.now(),
                reason,
                outcome: 'backfill',
              }),
            );
          if (!Number.isNaN(since)) scheduleBackfill(stream, since, stream.controller.signal, streamEnv, 0);
        }
        ownedLog('info', 'device_log_stream_resumed', `resumed device log stream ${id} in ${root}`);
      } catch (error) {
        ownedLog(
          'warn',
          'device_log_stream_dropped',
          `device log stream ${id} in ${root} was not resumed: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
  };
  const tracked = async <T>(root: string, work: () => Promise<T>): Promise<T> => {
    ownedPending++;
    inflight.set(root, (inflight.get(root) ?? 0) + 1);
    try {
      return await work();
    } finally {
      const left = (inflight.get(root) ?? 1) - 1;
      if (left > 0) inflight.set(root, left);
      else inflight.delete(root);
      ownedPending--;
    }
  };
  const syncRoot = (root: string): Promise<string | null> =>
    tracked(root, async () => {
      try {
        const w = await getWriters();
        await w.ownedSync(root);
        if (w === writers && !writerFailure) unverified.delete(root);
        return null;
      } catch (error) {
        return errorText(error);
      }
    });
  function recover(lost: Stream[], error: Error): void {
    if (!lost.length && !unverified.size) return;
    void (async () => {
      await Promise.allSettled(lost.map((stream) => stream.done));
      const marked = lost.filter((stream) => stream.interruptedBy !== null);
      const again = marked.filter((stream) => restarted.has(stream.id));
      const first = marked.filter((stream) => !restarted.has(stream.id));
      for (const stream of first) restarted.add(stream.id);
      const envs = new Map(first.map((stream) => [stream.id, stream.env]));
      for (const root of new Set(first.map((stream) => stream.root))) {
        if (closing) return;
        await serialize(root, () =>
          resumeIn(root, first[0]?.env ?? {}, envs, new Set(again.map((stream) => stream.id))),
        ).catch((failure: unknown) => log(`device log streams in ${root} were not restarted: ${String(failure)}`));
      }
      const stopped = [
        ...again.map((stream) => ({
          stream,
          reason: `the logs worker failed again (${error.message}) after stimd restarted this stream; logging stopped here. The next stim ios|android in this workspace, or a stimd restart, starts it again`,
        })),
        ...lost
          .filter((stream) => stream.spec.physical)
          .map((stream) => ({
            stream,
            reason: `the logs worker failed (${error.message}); restarting a physical device console would launch the app again`,
          })),
      ];
      for (const { stream, reason } of stopped) {
        const platform = stream.spec.platform;
        await writeLost(
          stream.root,
          stream.slotKey,
          stream.id,
          stream.spec,
          platform,
          undefined,
          interruptedRecord({ platform, from: null, until: Date.now(), reason, outcome: 'lost' }),
        ).catch((failure: unknown) => log(`could not record the interrupted stream: ${String(failure)}`));
      }
      for (const root of unverified) if (!closing) await syncRoot(root);
    })().catch((failure: unknown) => log(`logs worker recovery failed: ${String(failure)}`));
  }
  return {
    async ownedSync(root) {
      if (root !== undefined) return syncRoot(root);
      ownedPending++;
      try {
        await (await getWriters()).ownedSync();
        return null;
      } catch (error) {
        return error instanceof Error ? error.message : String(error);
      } finally {
        ownedPending--;
      }
    },
    async ownedDrain(root) {
      const refusal = `the previous owned log worker exited before the browser output of ${root} could be verified. ${stopStimdRemedy()}`;
      if (unverified.has(root)) return refusal;
      return tracked(root, async () => {
        try {
          await (await getWriters()).ownedDrain(root);
          return unverified.has(root) ? refusal : null;
        } catch (error) {
          return errorText(error);
        }
      });
    },
    async ownedObserveWeb(root, pid, token) {
      return tracked(root, async () => {
        try {
          const w = await getWriters();
          await w.ownedObserveWeb(root, pid, token);
          if (w === writers && !writerFailure) unverified.delete(root);
          return null;
        } catch (error) {
          return errorText(error) || 'the browser observer failed';
        }
      });
    },
    ownedRunning: () => ownedRunning || unverified.size > 0,
    async start(
      input: StreamSpec,
      env: Record<string, string>,
      signal?: AbortSignal,
      runId?: string,
    ): Promise<{ streamId: string }> {
      if (closing) throw new Error('the logs worker is closing');
      const root = realpathSync(input.root);
      return serialize(root, () => startLocked(input, env, signal, runId));
    },
    async stop(root: string, platform: string, slot: string, streamId: string): Promise<boolean> {
      let canonicalRoot: string;
      try {
        canonicalRoot = realpathSync(root);
      } catch (error) {
        if (!error || typeof error !== 'object' || !('code' in error) || error.code !== 'ENOENT') throw error;
        canonicalRoot = resolvePath(root);
      }
      const key = `${canonicalRoot}\0${deviceSlotKey(platform, validateDeviceSlot(slot))}`;
      return serialize(canonicalRoot, async () => {
        const stream = streams.get(key);
        if (!stream) {
          const recorded = readCollectors(root)[deviceSlotKey(platform, slot)];
          if (recorded === undefined) return false;
          if (!isJsonObject(recorded) || recorded.kind !== 'stream' || recorded.streamId !== streamId)
            throw new Error('the device log stream changed');
          await clearStreamClaim(root, streamId, () => unregisterStreamAll(root, streamId), handedOverStream(recorded));
          return true;
        }
        if (stream.id !== streamId) throw new Error('the device log stream changed');
        await removeAlias(stream, key, deviceSlotKey(platform, slot));
        return true;
      });
    },
    async wait(
      root,
      platform,
      slot,
      streamId,
      since,
      after,
      timeoutMs,
      signal,
      env,
      through = 0,
      checkCoverage = false,
    ) {
      const key = `${realpathSync(root)}\0${deviceSlotKey(platform, validateDeviceSlot(slot))}`;
      const stream = streams.get(key);
      if (!stream || stream.id !== streamId) return { revision: after, gone: true };
      const deadline = Date.now() + timeoutMs;
      if (checkCoverage && (stream.spec.physical || (signal && stream.historySeen.get(signal)?.status === 'covered'))) {
        const synced = await new Promise<boolean>((resolve, reject) => {
          let settled = false;
          const cleanup = () => {
            clearTimeout(timer);
            signal?.removeEventListener('abort', abort);
          };
          const finish = (result: boolean) => {
            if (settled) return;
            settled = true;
            cleanup();
            resolve(result);
          };
          const abort = () => {
            if (settled) return;
            settled = true;
            cleanup();
            reject(signal?.reason);
          };
          const timer = setTimeout(() => finish(false), timeoutMs);
          signal?.addEventListener('abort', abort, { once: true });
          void stream.sink.sync().then(
            () => {
              finish(true);
              return undefined;
            },
            (error: unknown) => {
              if (settled) return;
              settled = true;
              cleanup();
              reject(error);
            },
          );
          if (signal?.aborted) abort();
        });
        if (!synced) return { revision: stream.revision, coverage: 'pending' as const };
        if (streams.get(key) !== stream) return { revision: after, gone: true };
      }
      const coverage = signal && env ? scheduleBackfill(stream, since, signal, env, through) : undefined;
      const coverageStatus = () => {
        if (stream.spec.physical && stream.writeFailures) return 'failed' as const;
        if (
          !stream.spec.physical &&
          coverage?.status === 'covered' &&
          (coverage.generation !== stream.generation ||
            coverage.failureVersion !== stream.writeFailures ||
            !stream.child ||
            stream.child.exitCode !== null ||
            stream.child.signalCode !== null)
        )
          return 'failed' as const;
        return coverage?.status === 'covered' && !coverage.warm && (coverage.startedAt ?? 0) < through
          ? ('pending' as const)
          : coverage?.status;
      };
      if (stream.revision > after || (checkCoverage && coverageStatus() !== 'pending'))
        return {
          revision: stream.revision,
          ...(coverage ? { coverage: coverageStatus() } : {}),
        };
      signal?.throwIfAborted();
      return new Promise((resolve, reject) => {
        const finish = (gone: boolean) => {
          clearTimeout(timer);
          signal?.removeEventListener('abort', abort);
          stream.waiters.delete(finish);
          resolve({
            revision: stream.revision,
            ...(gone ? { gone: true as const } : {}),
            ...(coverage ? { coverage: coverageStatus() } : {}),
          });
        };
        const abort = () => {
          clearTimeout(timer);
          signal?.removeEventListener('abort', abort);
          stream.waiters.delete(finish);
          reject(signal?.reason);
        };
        const timer = setTimeout(() => finish(false), Math.max(0, deadline - Date.now()));
        stream.waiters.add(finish);
        signal?.addEventListener('abort', abort, { once: true });
        if (signal?.aborted) abort();
      });
    },
    running: () => streams.size > 0,
    holdsRelaunch: () => [...streams.values()].some((stream) => stream.spec.physical),
    heldRoots: () => [
      ...new Set([...streams.values()].filter((stream) => stream.spec.physical).map((stream) => stream.root)),
    ],
    resume(paths, env) {
      for (const path of paths) {
        let root: string;
        try {
          root = realpathSync(path);
        } catch {
          continue;
        }
        void serialize(root, () => resumeIn(root, env)).catch((error: unknown) =>
          log(`device log streams in ${root} were not resumed: ${String(error)}`),
        );
      }
    },
    async close(options): Promise<void> {
      closing = true;
      closePromise ??= (async () => {
        await Promise.all(queues.values());
        if (options?.handover) for (const stream of streams.values()) stream.handover = !stream.spec.physical;
        const results = await Promise.allSettled([...new Set(streams.values())].map((stream) => stop(stream, false)));
        const recovery = await Promise.allSettled([writerRecovery]);
        const owned = await Promise.allSettled([writers?.ownedClose()]);
        const closed = await Promise.allSettled([writers?.close()]);
        if (unverified.size)
          throw new Error('the previous owned log worker exited before its output could be verified');
        const failure = results.find((result) => result.status === 'rejected');
        if (failure?.status === 'rejected') throw failure.reason;
        for (const result of [...recovery, ...owned, ...closed]) if (result.status === 'rejected') throw result.reason;
      })();
      try {
        await closePromise;
      } finally {
        closePromise = null;
      }
    },
  };
}
