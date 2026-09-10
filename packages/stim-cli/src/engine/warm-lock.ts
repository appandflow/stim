import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { workspaceName } from '@stim-cli/core';
import { formatElapsed, phaseLine } from '../command-output.ts';
import { getConfigDir } from '../config.ts';
import { isPidAlive } from '../metro.ts';

type WarmLockMode = 'refresh' | 'copy';

export interface WarmLockHolder {
  pid: number | null;
  mode: WarmLockMode;
  startedAt: string | null;
}

const WRITER_DIR = 'refresh';
const READERS_DIR = 'copies';
const RECORD_FILE = 'owner.json';
const RECORD_GRACE_MS = 5000;

const WARM_LOCK_POLL_MS = 250;
const WARM_LOCK_PROGRESS_MS = 30_000;
const WARM_LOCK_CEILING_MS = 90 * 60 * 1000;

export function warmLocksDir(): string {
  return join(getConfigDir(), 'warm-locks');
}

export function warmLockPath(repositoryRoot: string): string {
  return join(warmLocksDir(), `${workspaceName(repositoryRoot)}.lock`);
}

function warmLockCommand(mode: WarmLockMode): string {
  return mode === 'refresh' ? 'stim worktree warm --refresh' : 'stim worktree warm';
}

export function warmLockWaitingLine(holder: WarmLockHolder, elapsedMs: number): string {
  return phaseLine(
    'lock',
    `waiting on ${warmLockCommand(holder.mode)} (pid ${holder.pid ?? '?'}, ${formatElapsed(elapsedMs)} elapsed)`,
  );
}

export function warmLockAcquiredLine(waited: WarmLockWait): string {
  if (!waited.holder || waited.waitedMs <= 0) return phaseLine('lock', 'acquired');
  return phaseLine(
    'lock',
    `acquired (waited ${formatElapsed(waited.waitedMs)} for ${warmLockCommand(waited.holder.mode)} pid ${waited.holder.pid ?? '?'})`,
  );
}

export interface WarmLockWait {
  waitedMs: number;
  holder: WarmLockHolder | null;
}

export interface WarmLockOptions {
  repositoryRoot: string;
  mode: WarmLockMode;
  isAlive?: (pid: number) => boolean;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  pollMs?: number;
  progressMs?: number;
  ceilingMs?: number;
  out?: (line: string) => void;
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function readHolder(file: string): WarmLockHolder | null {
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf-8'));
    if (!parsed || typeof parsed !== 'object') return null;
    return {
      pid: Number.isFinite(parsed.pid) ? parsed.pid : null,
      mode: parsed.mode === 'refresh' ? 'refresh' : 'copy',
      startedAt: typeof parsed.startedAt === 'string' ? parsed.startedAt : null,
    };
  } catch {
    return null;
  }
}

function writeRecord(file: string, record: WarmLockHolder & { token: string }): void {
  const tmp = `${file}.${process.pid}.${randomUUID()}.tmp`;
  writeFileSync(tmp, JSON.stringify(record));
  try {
    renameSync(tmp, file);
  } catch (error) {
    rmSync(tmp, { force: true });
    throw error;
  }
}

function readToken(file: string): string | null {
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf-8'));
    return typeof parsed?.token === 'string' ? parsed.token : null;
  } catch {
    return null;
  }
}

function ageMs(path: string, now: number): number | null {
  try {
    return now - statSync(path).mtimeMs;
  } catch {
    return null;
  }
}

function reap(path: string): void {
  const aside = `${path}.reap-${process.pid}-${randomUUID()}`;
  try {
    renameSync(path, aside);
  } catch {
    return;
  }
  rmSync(aside, { recursive: true, force: true });
}

interface LockPaths {
  lock: string;
  writer: string;
  readers: string;
}

function lockPaths(repositoryRoot: string): LockPaths {
  const lock = warmLockPath(repositoryRoot);
  return { lock, writer: join(lock, WRITER_DIR), readers: join(lock, READERS_DIR) };
}

function liveWriter(paths: LockPaths, isAlive: (pid: number) => boolean, now: number): WarmLockHolder | null {
  const holder = readHolder(join(paths.writer, RECORD_FILE));
  if (holder) {
    if (holder.pid !== null && isAlive(holder.pid)) return holder;
    reap(paths.writer);
    return null;
  }
  const age = ageMs(paths.writer, now);
  if (age === null) return null;
  if (age > RECORD_GRACE_MS) {
    reap(paths.writer);
    return null;
  }
  return { pid: null, mode: 'refresh', startedAt: null };
}

function liveReaders(paths: LockPaths, isAlive: (pid: number) => boolean, skipToken: string | null): WarmLockHolder[] {
  let names: string[];
  try {
    names = readdirSync(paths.readers);
  } catch {
    return [];
  }
  const live: WarmLockHolder[] = [];
  for (const name of names) {
    if (!name.endsWith('.json') || name === skipToken) continue;
    const file = join(paths.readers, name);
    const holder = readHolder(file);
    if (holder && holder.pid !== null && isAlive(holder.pid)) {
      live.push(holder);
      continue;
    }
    rmSync(file, { force: true });
  }
  return live;
}

function timeoutError(holder: WarmLockHolder, elapsedMs: number, lock: string): Error {
  const error = new Error(
    `Waited ${formatElapsed(elapsedMs)} for ${warmLockCommand(holder.mode)} (pid ${holder.pid ?? '?'}) to release the ` +
      `warm lock. The lock is ${lock}; remove that directory if that process is not really warming.`,
  ) as Error & { code?: string; lockPath?: string };
  error.code = 'STIM_LOCK_TIMEOUT';
  error.lockPath = lock;
  return error;
}

export async function acquireWarmLock({
  repositoryRoot,
  mode,
  isAlive = isPidAlive,
  now = Date.now,
  sleep = defaultSleep,
  pollMs = WARM_LOCK_POLL_MS,
  progressMs = WARM_LOCK_PROGRESS_MS,
  ceilingMs = WARM_LOCK_CEILING_MS,
  out = () => {},
}: WarmLockOptions): Promise<{ wait: WarmLockWait; release: () => void }> {
  const paths = lockPaths(repositoryRoot);
  const token = randomUUID();
  const record = { pid: process.pid, mode, startedAt: new Date(now()).toISOString(), token };
  const started = now();
  let lastProgress = started;
  let waitedOn: WarmLockHolder | null = null;

  const step = async (holder: WarmLockHolder): Promise<void> => {
    waitedOn = holder;
    const elapsed = now() - started;
    if (elapsed >= ceilingMs) throw timeoutError(holder, elapsed, paths.lock);
    if (now() - lastProgress >= progressMs) {
      lastProgress = now();
      out(warmLockWaitingLine(holder, elapsed));
    }
    await sleep(pollMs);
  };

  mkdirSync(paths.readers, { recursive: true });

  if (mode === 'refresh') {
    for (;;) {
      try {
        mkdirSync(paths.writer);
        writeRecord(join(paths.writer, RECORD_FILE), record);
        break;
      } catch (error) {
        if ((error as NodeJS.ErrnoException)?.code !== 'EEXIST') throw error;
      }
      const holder = liveWriter(paths, isAlive, now());
      if (holder) await step(holder);
    }
    for (;;) {
      const readers = liveReaders(paths, isAlive, null);
      const first = readers[0];
      if (!first) break;
      await step(first);
    }
    return {
      wait: { waitedMs: now() - started, holder: waitedOn },
      release: () => {
        if (readToken(join(paths.writer, RECORD_FILE)) === token)
          rmSync(paths.writer, { recursive: true, force: true });
      },
    };
  }

  const readerFile = join(paths.readers, `${process.pid}-${token}.json`);
  for (;;) {
    const holder = liveWriter(paths, isAlive, now());
    if (holder) {
      await step(holder);
      continue;
    }
    writeRecord(readerFile, record);
    const raced = liveWriter(paths, isAlive, now());
    if (!raced) break;
    rmSync(readerFile, { force: true });
    await step(raced);
  }
  return {
    wait: { waitedMs: now() - started, holder: waitedOn },
    release: () => rmSync(readerFile, { force: true }),
  };
}

export async function withWarmLock<T>(
  options: WarmLockOptions,
  fn: (wait: WarmLockWait) => Promise<T> | T,
): Promise<T> {
  const { wait, release } = await acquireWarmLock(options);
  try {
    return await fn(wait);
  } finally {
    release();
  }
}
