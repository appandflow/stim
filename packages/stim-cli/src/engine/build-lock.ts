import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { formatDuration, formatElapsed, shortHash } from '../command-output.ts';
import { getConfigDir } from '../workspace/config.ts';
import { resolveBuild } from '../cache/build-cache.ts';
import {
  claimFailure,
  ClaimRefusedError,
  claimRemoveCommand,
  readClaimSet,
  releaseClaim,
  tryAcquireClaim,
  type ClaimFailure,
  type ClaimHandle,
  type ClaimHolder,
} from '../ownership-claim.ts';
import type { WaitedForBuild } from './build-facts.ts';
import { declareSpawnsOn, stopDeclaringSpawnsOn } from './spawn-claims.ts';

const LOCK_SUFFIX = '.lock';

export interface BuildLockRecord {
  pid: number | null;
  projectRoot: string | null;
  startedAt: string | null;
  logFile: string | null;
}

interface BuildLockSpec {
  platform: string;
  key: string;
}

interface AcquireBuildLockOptions {
  platform: string;
  key: string;
  root?: string | null;
  logFile?: string | null;
}

export interface BuildLockHandle {
  acquired?: true;
  path?: string;
  lock?: BuildLockRecord;
  held?: BuildLockRecord;
  tookOver?: BuildLockRecord;
  platform?: string;
  key?: string;
  claim?: ClaimHandle;
}

export interface BuildLockInfo {
  path: string;
  name: string;
  platform: string;
  key: string | null;
  pid: number | null;
  projectRoot: string | null;
  startedAt: string | null;
  logFile: string | null;
  alive: boolean;
  unresolved: boolean;
}

interface WaitingLineArgs {
  projectRoot: string | null;
  pid: number | null;
  elapsedMs: number;
  logFile: string | null;
}

interface WaitForBuildOptions {
  platform: string;
  key: string;
  resolve?: (platform: string, key: string) => string | null;
  intervalMs?: number;
  progressMs?: number;
  ceilingMs?: number;
  out?: (line: string) => void;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

export interface WaitForBuildResult {
  hit?: string;
  waitedMs?: number;
  lockReleased?: true;
  builderFailed?: string;
  holder?: BuildLockRecord | null;
}

export const WAIT_POLL_MS = 1000;
export const WAIT_PROGRESS_MS = 30000;
export const WAIT_CEILING_MS: number = 90 * 60 * 1000;

function sleepAsync(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function segment(value: string): string {
  return (
    String(value)
      .replace(/[^A-Za-z0-9._-]+/g, '-')
      .replace(/^\.+/, '') || 'unknown'
  );
}

export function buildLocksDir(): string {
  return join(getConfigDir(), 'build-locks');
}

export function buildLockPath(platform: string, key: string): string {
  return join(buildLocksDir(), `${segment(platform)}-${segment(key)}${LOCK_SUFFIX}`);
}

function label(platform: string): string {
  return `${platform} build`;
}

function toRecord(holder: ClaimHolder): BuildLockRecord {
  const details = holder.details as { projectRoot?: unknown; logFile?: unknown };
  return {
    pid: holder.owner.pid,
    projectRoot: typeof details.projectRoot === 'string' ? details.projectRoot : null,
    startedAt: holder.startedAt || null,
    logFile: typeof details.logFile === 'string' ? details.logFile : null,
  };
}

export function readBuildLock(pathOrSpec: string | BuildLockSpec): BuildLockRecord | null {
  const path = typeof pathOrSpec === 'string' ? pathOrSpec : buildLockPath(pathOrSpec.platform, pathOrSpec.key);
  const survey = readClaimSet(path);
  const holder = survey.live[0] ?? survey.dead[0];
  return holder ? toRecord(holder) : null;
}

export function acquireBuildLock({
  platform,
  key,
  root = null,
  logFile = null,
}: AcquireBuildLockOptions): BuildLockHandle {
  const path = buildLockPath(platform, key);
  const attempt = tryAcquireClaim({
    root: path,
    mode: 'exclusive',
    label: label(platform),
    details: { projectRoot: root, logFile },
  });
  const reaped = attempt.reaped[0];

  if (attempt.acquired) {
    const lock: BuildLockRecord = {
      pid: attempt.acquired.owner.pid,
      projectRoot: root,
      startedAt: attempt.acquired.startedAt,
      logFile,
    };
    const handle: BuildLockHandle = { acquired: true, path, lock, claim: attempt.acquired };
    declareSpawnsOn(attempt.acquired);
    return reaped ? { ...handle, tookOver: toRecord(reaped) } : handle;
  }

  if (attempt.pending) releaseClaim(attempt.pending);
  const holder = attempt.held ?? attempt.waitingFor?.[0];
  return holder ? { held: toRecord(holder), path } : { path };
}

export function releaseBuildLock(handle?: BuildLockHandle | null): boolean {
  stopDeclaringSpawnsOn(handle?.claim);
  return releaseClaim(handle?.claim);
}

export function listBuildLocks(): BuildLockInfo[] {
  const dir = buildLocksDir();
  let names;
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  const locks: BuildLockInfo[] = [];
  for (const name of names) {
    if (!name.endsWith(LOCK_SUFFIX)) continue;
    const path = join(dir, name);
    try {
      if (!statSync(path).isDirectory()) continue;
    } catch {
      continue;
    }
    const stem = name.slice(0, -LOCK_SUFFIX.length);
    const cut = stem.indexOf('-');
    const survey = readClaimSet(path);
    const holder = survey.live[0] ?? survey.dead[0];
    const info = holder ? toRecord(holder) : null;
    locks.push({
      path,
      name,
      platform: cut > 0 ? stem.slice(0, cut) : stem,
      key: cut > 0 ? stem.slice(cut + 1) : null,
      pid: info?.pid ?? null,
      projectRoot: info?.projectRoot ?? null,
      startedAt: info?.startedAt ?? null,
      logFile: info?.logFile ?? null,
      alive: survey.live.length > 0,
      unresolved: survey.unresolved.length > 0,
    });
  }
  return locks;
}

export function waitingLine({ projectRoot, pid, elapsedMs, logFile }: WaitingLineArgs): string {
  const where = projectRoot || 'another workspace';
  const tail = logFile ? ` -- tail ${logFile}` : '';
  return `${'build'.padEnd(11)} waiting on ${where} (pid ${pid ?? '?'}, ${formatElapsed(elapsedMs)} elapsed)${tail} -- stim guide lifecycle concurrency`;
}

export function takeoverLine({
  projectRoot,
  pid,
  logFile,
  startedAt = null,
  now = Date.now,
}: {
  projectRoot: string | null;
  pid: number | null;
  logFile: string | null;
  startedAt?: string | null;
  now?: () => number;
}): string {
  const where = projectRoot || 'another workspace';
  const started = startedAt ? Date.parse(startedAt) : Number.NaN;
  const ago = Number.isFinite(started) ? ` (it started ${formatElapsed(now() - started)} ago)` : '';
  const tail = logFile ? ` -- read ${logFile} before this one finishes` : '';
  return (
    `RETRY: ${where}'s build of this fingerprint (pid ${pid ?? '?'}) FAILED without an artifact${ago}, ` +
    `and this run rebuilds the SAME inputs, so expect the same failure unless something changed${tail}`
  );
}

export async function waitForBuild({
  platform,
  key,
  resolve = resolveBuild,
  intervalMs = WAIT_POLL_MS,
  progressMs = WAIT_PROGRESS_MS,
  ceilingMs = WAIT_CEILING_MS,
  out = () => {},
  now = Date.now,
  sleep = sleepAsync,
}: WaitForBuildOptions): Promise<WaitForBuildResult> {
  const path = buildLockPath(platform, key);
  const started = now();
  let lastProgress = started;
  let holder = readBuildLock(path);

  for (;;) {
    const hit = resolve(platform, key);
    if (hit) return { hit, waitedMs: now() - started };

    const survey = readClaimSet(path);
    const unresolved = survey.unresolved[0];
    if (unresolved) {
      throw new ClaimRefusedError({
        claimPath: unresolved.path,
        root: path,
        label: label(platform),
        reason: unresolved.reason,
      });
    }

    const live = survey.live[0];
    if (live) holder = toRecord(live);
    else {
      const dead = survey.dead[0];
      if (dead) {
        return {
          builderFailed: `the builder (pid ${dead.owner.pid}) is gone`,
          holder: toRecord(dead),
          waitedMs: now() - started,
        };
      }
      return { lockReleased: true, holder, waitedMs: now() - started };
    }

    const elapsed = now() - started;
    if (elapsed >= ceilingMs) {
      const err = new Error(
        `Waited ${formatElapsed(elapsed)} for ${holder?.projectRoot || 'another workspace'}'s ${platform} build of ${key} ` +
          `without an artifact, and pid ${holder?.pid} is still the live holder. The lock is ${path}; ` +
          `remove it if that process is not really building:\n  ${claimRemoveCommand(path)}`,
      ) as Error & { code?: string; lockPath?: string; holder?: BuildLockRecord };
      err.code = 'STIM_BUILD_WAIT_TIMEOUT';
      err.lockPath = path;
      err.holder = holder ?? undefined;
      throw err;
    }

    if (now() - lastProgress >= progressMs) {
      lastProgress = now();
      out(
        waitingLine({ projectRoot: holder.projectRoot, pid: holder.pid, elapsedMs: elapsed, logFile: holder.logFile }),
      );
    }

    await sleep(intervalMs);
  }
}

interface SharedBuildWaitOptions {
  platform: string;
  key: string;
  fingerprint: string;
  root: string;
  logFile: string;
  command: string;
  acquire: typeof acquireBuildLock;
  wait: typeof waitForBuild;
  now: () => number;
  phase: (text: string) => void;
  warn: (text: string) => void;
  out: (line: string) => void;
}

type SharedBuildWait =
  | {
      refusal: null;
      lock: BuildLockHandle | null;
      hit: { path: string; waited: WaitedForBuild } | null;
      released: { facts: WaitedForBuild; who: string } | null;
    }
  | { refusal: ClaimFailure };

export async function waitForSharedBuild({
  platform,
  key,
  fingerprint,
  root,
  logFile,
  command,
  acquire,
  wait,
  now,
  phase,
  warn,
  out,
}: SharedBuildWaitOptions): Promise<SharedBuildWait> {
  const waitStarted = now();
  let failedHolder: BuildLockHandle['held'];
  let released: { facts: WaitedForBuild; who: string } | null = null;
  for (;;) {
    let attempt: BuildLockHandle | null = null;
    try {
      attempt = acquire({ platform, key, root, logFile });
    } catch (err) {
      const refusal = claimFailure(err, command);
      if (refusal) return { refusal };
      warn(`could not take the build lock: ${(err as Error)?.message || err}; building anyway`);
    }

    if (attempt?.acquired) {
      const previous = attempt.tookOver ?? failedHolder;
      if (previous) warn(takeoverLine(previous));
      return { refusal: null, lock: attempt, hit: null, released };
    }
    if (!attempt?.held) return { refusal: null, lock: null, hit: null, released };

    released = null;
    const holder = attempt.held;
    const who = holder.projectRoot || 'another workspace';
    phase(
      `${who} is already building ${shortHash(fingerprint)} (pid ${holder.pid})` +
        `${holder.logFile ? ` -- tail ${holder.logFile}` : ''} -- stim guide lifecycle concurrency`,
    );

    let waited: WaitForBuildResult;
    try {
      const ceilingMs = WAIT_CEILING_MS - (now() - waitStarted);
      if (ceilingMs <= 0) {
        throw Object.assign(
          new Error(
            `Waited ${formatDuration(now() - waitStarted)} for shared builds without an artifact; ${who} (pid ${holder.pid}) holds ${attempt.path}.`,
          ),
          {
            code: 'STIM_BUILD_WAIT_TIMEOUT',
            lockPath: attempt.path,
          },
        );
      }
      waited = await wait({ platform, key, out, ceilingMs });
    } catch (err) {
      const refusal = claimFailure(err, command);
      if (refusal) return { refusal };
      const timeout = err as Error & { code?: string; lockPath?: string };
      if (timeout?.code !== 'STIM_BUILD_WAIT_TIMEOUT') throw err;
      return {
        refusal: {
          code: 'STIM_BUILD_WAIT_TIMEOUT',
          message: timeout.message,
          remedy: `Check pid ${holder.pid}; if it is not really building, remove ${timeout.lockPath} and run \`${command}\` again.`,
        },
      };
    }

    if (waited.hit) {
      phase(
        `waited ${formatDuration(waited.waitedMs)} for ${who}'s build -> installed from cache -- stim guide lifecycle concurrency`,
      );
      return {
        refusal: null,
        lock: null,
        hit: { path: waited.hit, waited: { pid: holder.pid, ms: waited.waitedMs } },
        released,
      };
    }
    if (waited.lockReleased) {
      failedHolder = undefined;
      released = { facts: { pid: holder.pid, ms: waited.waitedMs }, who };
      phase(`${who}'s build lock was released; rechecking this workspace before building`);
    } else {
      warn(`${who}'s build ended without an artifact (${waited.builderFailed}); retrying the build lock`);
      failedHolder = holder;
    }
  }
}
