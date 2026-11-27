import type { ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import release from '../native/fsevents-release.json' with { type: 'json' };
import { isJsonObject, type GcHistoryStatus } from '@stim-cli/core/state';
import { getExecutor } from './exec.ts';
import { readHistoryCheckpoints, writeHistoryCheckpoints } from './fsevents-state.ts';
import { markSegment } from './stimd/stall-watch.ts';

export interface HistoryRoot {
  root: string;
  device: number;
}

export type HelperCheck = { ok: true } | { ok: false; kind: 'missing' | 'digest'; reason: string };

/** The signed helper shipped beside this package's bundled JavaScript. */
export function packagedHistoryHelper(): { binary: string; sha256: string } {
  return {
    binary: fileURLToPath(new URL('../native/darwin/stim-fsevents', import.meta.url)),
    sha256: release.binarySha256,
  };
}

/** Verifies the immutable packaged helper; the daemon calls this once before starting its child. */
export function checkHistoryHelper(binary: string, sha256: string): HelperCheck {
  try {
    const actual = createHash('sha256').update(readFileSync(binary)).digest('hex');
    return actual === sha256
      ? { ok: true }
      : { ok: false, kind: 'digest', reason: 'the FSEvents helper does not match its pinned digest' };
  } catch {
    return { ok: false, kind: 'missing', reason: 'the packaged FSEvents helper is missing or unreadable' };
  }
}

export interface HistoryFeed {
  update(roots: readonly HistoryRoot[]): Promise<void>;
  changed(roots: readonly string[]): Promise<void>;
  close(): Promise<void>;
  status(): GcHistoryStatus | undefined;
}

/** One helper lifetime: dirty writes are acknowledged before its checkpoint advances. */
export function startHistoryFeed({
  binary,
  sha256,
  dirty,
  log,
  platform = process.platform,
}: {
  binary: string;
  sha256: string;
  dirty: (roots: readonly string[], at: number) => Promise<void>;
  log: (reason: string) => void;
  platform?: NodeJS.Platform;
}): HistoryFeed {
  let checkpoints = readHistoryCheckpoints();
  let generation = 0;
  let roots: HistoryRoot[] = [];
  let byDevice = new Map<number, string[]>();
  let lastEvent = new Map<number, number>();
  let signature = '';
  let failed: string | undefined;
  let closing = false;
  let closeWork: Promise<void> | undefined;
  let child: ChildProcess | undefined;
  let exited = false;
  let stderr = '';
  let ended: Promise<void> = Promise.resolve();
  let serial = Promise.resolve();
  const invalidated = new Set<string>();
  const fallback = async (reason: string) => {
    if (!failed) log(reason);
    failed = reason;
    const pending = roots.map(({ root }) => root).filter((root) => !invalidated.has(root));
    if (pending.length) {
      await dirty(pending, Date.now());
      for (const root of pending) invalidated.add(root);
    }
  };
  const enqueue = (work: () => Promise<void>) => {
    serial = serial.then(work).catch(async (error: unknown) => {
      try {
        await fallback(error instanceof Error ? error.message : String(error));
      } catch (writeError) {
        log(`could not persist dirty marks: ${writeError instanceof Error ? writeError.message : String(writeError)}`);
      }
    });
    return serial;
  };
  let received: string[] = [];
  const accept = async () => {
    const batch = received;
    received = [];
    if (failed || closing) return;
    markSegment('fsevents batch');
    const changed = new Set<string>();
    let next = checkpoints;
    let fdLimit = false;
    for (const text of batch) {
      const message: unknown = JSON.parse(text);
      if (!isJsonObject(message)) throw new Error('the FSEvents helper sent a malformed record');
      if (message.generation !== generation) continue;
      const dev = Number(message.dev);
      const watched = byDevice.get(dev);
      if (!watched || !Number.isSafeInteger(message.eventId) || Number(message.eventId) < 0)
        throw new Error('the FSEvents helper sent an invalid device or event id');
      let named: string[] = [];
      if (typeof message.purged === 'string') named = watched;
      else if (Array.isArray(message.dirty)) {
        named = message.dirty.map((index: unknown) => {
          const root = typeof index === 'number' ? watched[index] : undefined;
          if (!Number.isSafeInteger(index) || root === undefined)
            throw new Error('the FSEvents helper sent an invalid root index');
          return root;
        });
      } else if (message.historyDone !== true) throw new Error('the FSEvents helper sent an unknown record');
      for (const root of named) changed.add(root);
      const previous = next[String(dev)];
      const eventId = Number(message.eventId);
      const last = lastEvent.get(dev);
      if (last !== undefined && eventId < last) throw new Error('the FSEvents helper event id went backwards');
      lastEvent.set(dev, eventId);
      const uuid = message.uuid === null || typeof message.uuid === 'string' ? message.uuid : previous?.uuid;
      if (uuid !== undefined)
        next = { ...next, [String(dev)]: { uuid, eventId, sinceAt: Math.floor(Date.now() / 1000), roots: watched } };
      if (message.purged === 'fd-limit') {
        fdLimit = true;
        break;
      }
    }
    if (changed.size) await dirty([...changed], Date.now());
    if (next !== checkpoints) {
      markSegment('fsevents checkpoint write');
      writeHistoryCheckpoints(next);
      checkpoints = next;
    }
    if (fdLimit) {
      for (const root of changed) invalidated.add(root);
      await fallback('the FSEvents watch exceeds the helper descriptor limit');
    }
  };
  const start = async () => {
    if (platform !== 'darwin') return fallback('FSEvents history is only available on macOS');
    const checked = checkHistoryHelper(binary, sha256);
    if (!checked.ok) return fallback(checked.reason);
    const spawned = getExecutor().spawn(binary, ['5'], { stdio: ['pipe', 'pipe', 'pipe'] });
    child = spawned;
    ended = new Promise<void>((done) => {
      spawned.once('close', () => {
        exited = true;
        done();
        if (!closing)
          void enqueue(() => fallback(`the FSEvents helper exited${stderr.trim() ? `: ${stderr.trim()}` : ''}`));
      });
    });
    child.once(
      'error',
      (error) => void enqueue(() => fallback(`the FSEvents helper could not start: ${error.message}`)),
    );
    child.stdin?.on(
      'error',
      (error) => void enqueue(() => fallback(`the FSEvents helper input failed: ${error.message}`)),
    );
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr = (stderr + chunk.toString()).slice(-4096);
    });
    if (child.stdout)
      createInterface({ input: child.stdout }).on('line', (line) => {
        received.push(line);
        if (received.length === 1) void enqueue(accept);
      });
  };
  return {
    update(nextRoots) {
      return enqueue(async () => {
        if (closing) return;
        const ordered = nextRoots.toSorted((a, b) => a.device - b.device || a.root.localeCompare(b.root));
        const nextSignature = JSON.stringify(ordered);
        if (signature === nextSignature && !failed) return;
        roots = ordered;
        if (failed) return fallback(failed);
        if (!child) await start();
        if (failed) return;
        const nextDevices = new Map<number, string[]>();
        for (const { root, device } of roots) {
          const paths = nextDevices.get(device) ?? [];
          paths.push(root);
          nextDevices.set(device, paths);
        }
        const added = roots.filter(({ root, device }) => !checkpoints[String(device)]?.roots?.includes(root));
        if (added.length)
          await dirty(
            added.map(({ root }) => root),
            Date.now(),
          );
        const watch = [...nextDevices].map(([dev, paths]) => {
          const saved = checkpoints[String(dev)];
          return {
            dev,
            uuid: saved?.uuid ?? null,
            since: saved?.eventId ?? null,
            sinceAt: saved?.sinceAt ?? null,
            roots: paths,
          };
        });
        byDevice = nextDevices;
        lastEvent = new Map();
        signature = nextSignature;
        if (!child?.stdin) throw new Error('the FSEvents helper has no input pipe');
        child.stdin.write(`${JSON.stringify({ generation: ++generation, watch })}\n`);
      });
    },
    changed(changedRoots) {
      return enqueue(async () => {
        if (!closing && changedRoots.length) await dirty(changedRoots, Date.now());
      });
    },
    status() {
      if (failed) return { source: 'fallback', reason: failed };
      return child && !exited ? { source: 'fsevents' } : undefined;
    },
    close() {
      return (closeWork ??= (async () => {
        closing = true;
        await serial;
        if (!child || exited) return;
        child.stdin?.end();
        const timer = setTimeout(() => {
          if (!exited) child?.kill('SIGKILL');
        }, 5000);
        await ended.finally(() => clearTimeout(timer));
      })());
    },
  };
}
