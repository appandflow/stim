import { randomUUID } from 'node:crypto';
import { realpathSync } from 'node:fs';
import type { ChildProcess, SpawnOptions } from 'node:child_process';
import { isJsonObject } from '@stim-cli/core/state';
import { runCollector, type RunCollectorHandle } from './collector.ts';
import { deviceSlotKey, validateDeviceSlot } from '../../devices/device-slots.ts';
import { getExecutor } from '../../exec.ts';
import { signalProcessTree } from '../../metro.ts';
import {
  clearClaimChild,
  markClaimChildPending,
  processGroupAlive,
  releaseClaim,
  setClaimChild,
  type ClaimHandle,
} from '../../ownership-claim.ts';
import { captureProcessToken, inspectProcessIdentity } from '../../process-identity.ts';
import { startAndroidLogcat } from './android.ts';
import { clearHistoryClaim, clearStreamClaim, takeStreamClaim } from './claim.ts';
import { backfillDeviceLog } from './backfill.ts';
import { startIosDeviceConsole } from './ios-device.ts';
import { startIosLogStream } from './ios.ts';
import { readCollectors, registerCollector, unregisterStream, unregisterStreamAll } from './state.ts';
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

export interface StreamTable {
  ownedSync(root?: string): Promise<string | null>;
  ownedDrain(root: string): Promise<string | null>;
  ownedDrainHosted(session: string): Promise<string | null>;
  ownedRunning(): boolean;
  start(input: StreamSpec, env: Record<string, string>, signal?: AbortSignal): Promise<{ streamId: string }>;
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
  ): Promise<{ revision: number; gone?: true }>;
  running(): boolean;
  close(): Promise<void>;
}

type Stream = {
  id: string;
  key: string;
  root: string;
  slotKey: string;
  spec: StreamSpec;
  aliases: Map<string, string>;
  claim: ClaimHandle;
  controller: AbortController;
  sink: LogSink;
  child: ChildProcess | null;
  identity: { pid: number; processToken: string } | null;
  pending: boolean;
  paused: boolean;
  generation: number;
  activePid: number | null;
  observedAt: number | null;
  revision: number;
  waiters: Set<(gone: boolean) => void>;
  historySeen: WeakSet<AbortSignal>;
  histories: Set<Promise<void>>;
  historyQueue: Promise<void>;
  started: Promise<RunCollectorHandle | null>;
  done: Promise<void>;
  finalized: boolean;
  cleanup: () => Promise<void>;
  finish: () => void;
};

function alive(stream: Stream): boolean {
  if (!stream.identity) return false;
  return process.platform === 'win32'
    ? inspectProcessIdentity(stream.identity) === 'same'
    : processGroupAlive(stream.identity.pid);
}

function signalChild(stream: Stream): void {
  const child = stream.identity;
  if (!child || inspectProcessIdentity(child) !== 'same') return;
  try {
    signalProcessTree(child.pid, 'SIGTERM', { group: process.platform !== 'win32' });
  } catch {}
}

async function waitChild(stream: Stream): Promise<void> {
  if (stream.pending && !stream.identity) throw new Error('the device log stream child identity is unresolved');
  for (const deadline = Date.now() + 2000; alive(stream) && Date.now() < deadline;)
    await new Promise((resolve) => setTimeout(resolve, 20));
  if (alive(stream)) throw new Error('the device log stream did not stop');
  if (stream.identity) clearClaimChild(stream.claim);
  stream.pending = false;
  stream.identity = null;
  stream.child = null;
}

function spawnChild(
  stream: Stream,
  env: Record<string, string>,
  cmd: string,
  args: string[],
  options: SpawnOptions,
): ChildProcess {
  markClaimChildPending(stream.claim);
  stream.pending = true;
  let child: ChildProcess;
  try {
    child = getExecutor().spawn(cmd, args, {
      ...options,
      cwd: stream.root,
      env,
      detached: process.platform !== 'win32',
    });
  } catch (error) {
    clearClaimChild(stream.claim);
    stream.pending = false;
    throw error;
  }
  stream.child = child;
  const token = child.pid ? captureProcessToken(child.pid) : null;
  if (!child.pid || !token) {
    child.kill('SIGTERM');
    throw new Error('could not capture the device log stream child identity');
  }
  stream.identity = { pid: child.pid, processToken: token };
  try {
    setClaimChild(stream.claim, stream.identity);
  } catch (error) {
    signalChild(stream);
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

const matches = (stream: Stream, input: StreamSpec, root: string): boolean =>
  stream.root === root &&
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

export function createStreams(
  log: (message: string) => void,
  ownedLog: (level: 'debug' | 'info' | 'warn' | 'error', event: string, msg: string) => void = () => {},
): StreamTable {
  const streams = new Map<string, Stream>();
  const queues = new Map<string, Promise<void>>();
  let writers: LogWriters | null = null;
  let writerFailure: Error | null = null;
  let writerRecovery: Promise<void> | null = null;
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
  const stop = async (stream: Stream): Promise<void> => {
    const retry = stream.finalized;
    signalChild(stream);
    stream.controller.abort();
    await stream.started.catch(() => null);
    await stream.done;
    if (retry && [...streams.values()].includes(stream)) await stream.cleanup();
    if ([...streams.values()].includes(stream)) throw new Error('the device log stream could not be stopped');
  };
  const getWriters = async (): Promise<LogWriters> => {
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
    if (writers) return writers;
    // Node closes worker-owned process handles on worker exit: https://github.com/nodejs/node/issues/46569
    writers = createLogWriters(
      (error) => {
        writerFailure = error;
        ownedRunning = true;
        log(`the logs worker failed: ${error.message}`);
        for (const stream of new Set(streams.values())) {
          signalChild(stream);
          stream.controller.abort();
        }
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
  const scheduleBackfill = (stream: Stream, since: number, signal: AbortSignal, env: Record<string, string>): void => {
    if (stream.spec.physical || stream.historySeen.has(signal)) return;
    stream.historySeen.add(signal);
    const cancelled = AbortSignal.any([signal, stream.controller.signal]);
    const task = stream.historyQueue.then(async () => {
      cancelled.throwIfAborted();
      return backfillDeviceLog({
        root: stream.root,
        streamId: stream.id,
        spec: stream.spec,
        since,
        env,
        signal: cancelled,
        warm: (pid) =>
          stream.observedAt !== null &&
          stream.observedAt <= since &&
          (stream.spec.platform !== 'android' || stream.activePid === pid),
        sink: stream.sink,
      });
    });
    stream.histories.add(task);
    stream.historyQueue = task
      .catch((error: unknown) => {
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
      });
  };
  return {
    async ownedSync(root) {
      try {
        await (await getWriters()).ownedSync(root);
        return null;
      } catch (error) {
        return error instanceof Error ? error.message : String(error);
      }
    },
    async ownedDrain(root) {
      try {
        await (await getWriters()).ownedDrain(root);
        return null;
      } catch (error) {
        return error instanceof Error ? error.message : String(error);
      }
    },
    async ownedDrainHosted(session) {
      try {
        await (await getWriters()).ownedDrainHosted(session);
        return null;
      } catch (error) {
        return error instanceof Error ? error.message : String(error);
      }
    },
    ownedRunning: () => ownedRunning,
    async start(input: StreamSpec, env: Record<string, string>, signal?: AbortSignal): Promise<{ streamId: string }> {
      const root = realpathSync(input.root);
      const slot = validateDeviceSlot(input.slot ?? 'default');
      const slotKey = deviceSlotKey(input.platform, slot);
      const key = `${root}\0${slotKey}`;
      return serialize(root, async () => {
        signal?.throwIfAborted();
        const previous = streams.get(key);
        if (previous && matches(previous, input, root)) return { streamId: previous.id };
        if (previous) await removeAlias(previous, key, slotKey);
        signal?.throwIfAborted();
        const recorded = readCollectors(root)[slotKey];
        if (recorded !== undefined && (!isJsonObject(recorded) || recorded.kind !== 'stream'))
          throw new Error('the previous device log collector must be stopped before starting a stream');
        const shared = [...new Set(streams.values())].find((stream) => matches(stream, input, root));
        if (shared && recorded === undefined) {
          registerCollector(root, slotKey, {
            kind: 'stream',
            streamId: shared.id,
            claimSlot: shared.spec.slot ?? 'default',
            startedAt: new Date().toISOString(),
          });
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
          if (typeof recorded.streamId !== 'string') throw new Error('the previous device log stream has no identity');
          const claimSlot = typeof recorded.claimSlot === 'string' ? recorded.claimSlot : slot;
          await clearStreamClaim(root, input.platform, claimSlot, recorded.streamId);
          unregisterStreamAll(root, recorded.streamId);
        }
        const id = randomUUID();
        const claim = await takeStreamClaim(root, input.platform, slot, id);
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
          aliases: new Map([[key, slotKey]]),
          claim,
          controller,
          sink,
          child: null,
          identity: null,
          pending: false,
          paused: false,
          generation: 0,
          activePid: null,
          observedAt: null,
          revision: 0,
          waiters: new Set(),
          historySeen: new WeakSet(),
          histories: new Set(),
          historyQueue: Promise.resolve(),
          started: Promise.resolve(null),
          done,
          finalized: false,
          cleanup: async () => {},
          finish,
        };
        try {
          registerCollector(root, slotKey, {
            kind: 'stream',
            streamId: id,
            claimSlot: slot,
            startedAt: new Date().toISOString(),
          });
        } catch (error) {
          sink.writer.close();
          await sink.closed().catch(() => {});
          releaseClaim(claim);
          throw error;
        }
        streams.set(key, stream);
        stream.cleanup = async () => {
          stream.controller.abort();
          await Promise.allSettled(stream.histories);
          await clearHistoryClaim(root, id);
          await waitChild(stream);
          await sink
            .closed()
            .catch((error: unknown) => log(`device log stream ${id} could not flush: ${String(error)}`));
          if ([...streams.values()].includes(stream)) {
            if (!releaseClaim(claim)) throw new Error('the device log claim changed during cleanup');
            unregisterStreamAll(root, id);
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
              log(`device log stream ${id} did not close: ${error instanceof Error ? error.message : String(error)}`);
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
          writer: sink.writer,
          recordLine: (line, clockOffsetMs, child) => sink.line(line, clockOffsetMs, generations.get(child)),
          beforeFinish: sink.beforeFinish,
          startStream: (options) => {
            stream.generation++;
            stream.activePid = options.pid ?? null;
            stream.observedAt = null;
            const spawnFn = (cmd: string, args: string[], opts: SpawnOptions) =>
              spawnChild(stream, env, cmd, args, opts);
            let child: ChildProcess;
            if (input.platform === 'android') {
              if (!input.serial || !options.pid) throw new Error('the Android log stream has no serial or app pid');
              child = startAndroidLogcat({ serial: input.serial, pid: options.pid, spawnFn });
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
            return child;
          },
          stopStream: async () => {
            signalChild(stream);
            await waitChild(stream);
          },
          onExit: finalize,
        });
        void stream.started.catch((error: unknown) => {
          log(`device log stream ${id} failed: ${String(error)}`);
          signalChild(stream);
          stream.controller.abort();
          if (!finishing) {
            sink.writer.close();
            finalize();
          }
        });
        return { streamId: id };
      });
    },
    async stop(root: string, platform: string, slot: string, streamId: string): Promise<boolean> {
      const key = `${realpathSync(root)}\0${deviceSlotKey(platform, validateDeviceSlot(slot))}`;
      const canonicalRoot = realpathSync(root);
      return serialize(canonicalRoot, async () => {
        const stream = streams.get(key);
        if (!stream) {
          const recorded = readCollectors(root)[deviceSlotKey(platform, slot)];
          if (recorded === undefined) return false;
          if (!isJsonObject(recorded) || recorded.kind !== 'stream' || recorded.streamId !== streamId)
            throw new Error('the device log stream changed');
          const claimSlot = typeof recorded.claimSlot === 'string' ? recorded.claimSlot : slot;
          await clearStreamClaim(root, platform, claimSlot, streamId);
          unregisterStreamAll(root, streamId);
          return true;
        }
        if (stream.id !== streamId) throw new Error('the device log stream changed');
        await removeAlias(stream, key, deviceSlotKey(platform, slot));
        return true;
      });
    },
    async wait(root, platform, slot, streamId, since, after, timeoutMs, signal, env) {
      const key = `${realpathSync(root)}\0${deviceSlotKey(platform, validateDeviceSlot(slot))}`;
      const stream = streams.get(key);
      if (!stream || stream.id !== streamId) return { revision: after, gone: true };
      if (signal && env) scheduleBackfill(stream, since, signal, env);
      if (stream.revision > after) return { revision: stream.revision };
      signal?.throwIfAborted();
      return new Promise((resolve, reject) => {
        const finish = (gone: boolean) => {
          clearTimeout(timer);
          signal?.removeEventListener('abort', abort);
          stream.waiters.delete(finish);
          resolve({ revision: stream.revision, ...(gone ? { gone: true as const } : {}) });
        };
        const abort = () => {
          clearTimeout(timer);
          signal?.removeEventListener('abort', abort);
          stream.waiters.delete(finish);
          reject(signal?.reason);
        };
        const timer = setTimeout(() => finish(false), timeoutMs);
        stream.waiters.add(finish);
        signal?.addEventListener('abort', abort, { once: true });
        if (signal?.aborted) abort();
      });
    },
    running: () => streams.size > 0,
    async close(): Promise<void> {
      try {
        await Promise.all(queues.values());
        await Promise.all([...new Set(streams.values())].map(stop));
      } finally {
        try {
          await writers?.ownedClose();
        } finally {
          await writers?.close();
        }
      }
    },
  };
}
