import { randomUUID } from 'node:crypto';
import {
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  rmdirSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { workspaceName } from '@stim-cli/core';
import { formatElapsed, phaseLine } from '../command-output.ts';
import { getConfigDir } from '../config.ts';
import { isPidAlive } from '../metro.ts';

type WarmLockMode = 'refresh' | 'copy';

interface WarmLockHolder {
  pid: number | null;
  installerPid: number | null;
  mode: WarmLockMode;
  startedAt: string | null;
}

interface WarmLockRecord extends WarmLockHolder {
  token: string;
}

const WRITER_DIR = 'refresh';
const READERS_DIR = 'copies';
const RECORD_SUFFIX = '.json';

const WARM_LOCK_POLL_MS = 250;
const WARM_LOCK_PROGRESS_MS = 30_000;
const WARM_LOCK_CEILING_MS = 90 * 60 * 1000;

const OCCUPIED_CODES = new Set(['EEXIST', 'ENOTEMPTY']);

export function warmLocksDir(): string {
  return join(getConfigDir(), 'warm-locks');
}

export function warmLockPath(repositoryRoot: string): string {
  return join(warmLocksDir(), `${workspaceName(repositoryRoot)}.lock`);
}

function warmLockCommand(mode: WarmLockMode): string {
  return mode === 'refresh' ? 'stim worktree warm --refresh' : 'stim worktree warm';
}

function warmLockWaitingLine(holder: WarmLockHolder, elapsedMs: number): string {
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

export function warmLockUnavailableLine(reason: string): string {
  return phaseLine('lock', `unavailable (${reason}); copying without it`);
}

export interface WarmLockWait {
  waitedMs: number;
  holder: WarmLockHolder | null;
}

export interface WarmLockHold {
  wait: WarmLockWait;
  trackInstaller: (pid: number | null) => void;
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

function errorCode(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException)?.code;
}

function readHolder(file: string): WarmLockHolder | null {
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf-8'));
    if (!parsed || typeof parsed !== 'object') return null;
    return {
      pid: Number.isFinite(parsed.pid) ? parsed.pid : null,
      installerPid: Number.isFinite(parsed.installerPid) ? parsed.installerPid : null,
      mode: parsed.mode === 'refresh' ? 'refresh' : 'copy',
      startedAt: typeof parsed.startedAt === 'string' ? parsed.startedAt : null,
    };
  } catch {
    return null;
  }
}

function holderIsAlive(holder: WarmLockHolder, isAlive: (pid: number) => boolean): boolean {
  if (holder.pid !== null && isAlive(holder.pid)) return true;
  return holder.installerPid !== null && isAlive(holder.installerPid);
}

function writeRecordFile(file: string, stagingDir: string, record: WarmLockRecord): void {
  const tmp = join(stagingDir, `.record-${process.pid}-${randomUUID()}.tmp`);
  writeFileSync(tmp, JSON.stringify(record));
  try {
    renameSync(tmp, file);
  } catch (error) {
    rmSync(tmp, { force: true });
    throw error;
  }
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

interface WriterClaim {
  holder: WarmLockHolder;
  token: string;
}

function readWriterClaim(paths: LockPaths): WriterClaim | null {
  let names: string[];
  try {
    names = readdirSync(paths.writer);
  } catch {
    return null;
  }
  const name = names.find((entry) => entry.endsWith(RECORD_SUFFIX));
  if (!name) return null;
  const token = name.slice(0, -RECORD_SUFFIX.length);
  const holder = readHolder(join(paths.writer, name));
  return { token, holder: holder ?? { pid: null, installerPid: null, mode: 'refresh', startedAt: null } };
}

function claimWriter(paths: LockPaths, record: WarmLockRecord): boolean {
  const staging = join(paths.lock, `.claim-${process.pid}-${randomUUID()}`);
  mkdirSync(staging, { recursive: true });
  try {
    writeFileSync(join(staging, `${record.token}${RECORD_SUFFIX}`), JSON.stringify(record));
    try {
      renameSync(staging, paths.writer);
      return true;
    } catch (error) {
      if (OCCUPIED_CODES.has(String(errorCode(error)))) return false;
      throw error;
    }
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}

function removeWriterClaim(paths: LockPaths, token: string): void {
  try {
    unlinkSync(join(paths.writer, `${token}${RECORD_SUFFIX}`));
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return;
    throw error;
  }
  try {
    rmdirSync(paths.writer);
  } catch (error) {
    const code = errorCode(error);
    if (code === 'ENOENT' || OCCUPIED_CODES.has(String(code))) return;
    throw error;
  }
}

function liveWriter(paths: LockPaths, isAlive: (pid: number) => boolean): WarmLockHolder | null {
  const claim = readWriterClaim(paths);
  if (!claim) return null;
  if (holderIsAlive(claim.holder, isAlive)) return claim.holder;
  removeWriterClaim(paths, claim.token);
  return null;
}

function liveReaders(paths: LockPaths, isAlive: (pid: number) => boolean): WarmLockHolder[] {
  let names: string[];
  try {
    names = readdirSync(paths.readers);
  } catch {
    return [];
  }
  const live: WarmLockHolder[] = [];
  for (const name of names) {
    if (!name.endsWith(RECORD_SUFFIX)) continue;
    const file = join(paths.readers, name);
    const holder = readHolder(file);
    if (holder && holderIsAlive(holder, isAlive)) {
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
}: WarmLockOptions): Promise<WarmLockHold & { release: () => void }> {
  const paths = lockPaths(repositoryRoot);
  const token = randomUUID();
  const record: WarmLockRecord = {
    pid: process.pid,
    installerPid: null,
    mode,
    startedAt: new Date(now()).toISOString(),
    token,
  };
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
    const claim = async (): Promise<void> => {
      for (;;) {
        if (claimWriter(paths, record)) return;
        const observed = readWriterClaim(paths);
        if (observed && holderIsAlive(observed.holder, isAlive)) {
          await step(observed.holder);
          continue;
        }
        if (observed) {
          removeWriterClaim(paths, observed.token);
          continue;
        }
        await step({ pid: null, installerPid: null, mode: 'refresh', startedAt: null });
      }
    };
    await claim();
    for (;;) {
      if (readWriterClaim(paths)?.token !== token) {
        await claim();
        continue;
      }
      const first = liveReaders(paths, isAlive)[0];
      if (!first) break;
      await step(first);
    }
    return {
      wait: { waitedMs: now() - started, holder: waitedOn },
      trackInstaller: (installerPid) => {
        if (readWriterClaim(paths)?.token !== token) return;
        record.installerPid = installerPid;
        try {
          writeRecordFile(join(paths.writer, `${token}${RECORD_SUFFIX}`), paths.lock, record);
        } catch {}
      },
      release: () => {
        try {
          removeWriterClaim(paths, token);
        } catch {}
      },
    };
  }

  const readerFile = join(paths.readers, `${process.pid}-${token}${RECORD_SUFFIX}`);
  for (;;) {
    const holder = liveWriter(paths, isAlive);
    if (holder) {
      await step(holder);
      continue;
    }
    writeRecordFile(readerFile, paths.readers, record);
    const raced = liveWriter(paths, isAlive);
    if (!raced) break;
    rmSync(readerFile, { force: true });
    await step(raced);
  }
  return {
    wait: { waitedMs: now() - started, holder: waitedOn },
    trackInstaller: () => {},
    release: () => rmSync(readerFile, { force: true }),
  };
}

export async function withWarmLock<T>(
  options: WarmLockOptions,
  fn: (hold: WarmLockHold) => Promise<T> | T,
): Promise<T> {
  const { release, ...hold } = await acquireWarmLock(options);
  try {
    return await fn(hold);
  } finally {
    release();
  }
}
