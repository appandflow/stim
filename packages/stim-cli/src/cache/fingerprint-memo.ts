import { existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { FingerprintSource } from '@expo/fingerprint';
import type { StimContext } from '@stim-cli/core';
import {
  FINGERPRINT_MEMO_SCHEMA,
  fingerprintMemoDir,
  fingerprintMemoFile,
  fingerprintMemoLock,
  readFingerprintMemo,
  trace,
  type FingerprintMemoRecord,
} from '@stim-cli/core/state';
import { shortHash } from '../command-output.ts';
import { debugLog } from '../debug-log.ts';
import { withDirLock } from '../dir-lock.ts';
import { readDoctorFingerprint } from '../doctor-fingerprint.ts';
import { fingerprintProject, type FingerprintTarget, type ProjectFingerprint } from './build-cache.ts';
import { register } from './cache-manifest.ts';
import { staticFingerprint } from './static-fingerprint.ts';

/** Records kept per platform; writing one more removes the least recently written. */
const FINGERPRINT_MEMO_CAP = 256;

/** How long the end of a run waits for a background check that is still running before it gives the check up. */
const FINGERPRINT_CHECK_GRACE_MS = 3000;

type MemoPlatform = 'ios' | 'android';

interface FingerprintCheckResult {
  status: 'confirmed' | 'stale' | 'failed' | 'abandoned';
  recorded: string;
  current: string | null;
  /** Autolinked packages the current fingerprint lists that the static check did not count as native. */
  unmodeled?: string[];
}

const AUTOLINKED = /^(expo|rncore)Autolinking(Ios|Android)$/;

/** The full fingerprint a memo hit runs in the background; settle() puts the record back only when it agrees. */
export interface FingerprintCheck {
  settle(graceMs?: number): Promise<FingerprintCheckResult>;
  cancel(): void;
}

export type BackgroundFingerprint = (
  operation: StimContext,
  projectRoot: string,
  target: FingerprintTarget,
  signal: AbortSignal,
) => Promise<ProjectFingerprint | null>;

const errorMessage = (error: unknown): string => (error instanceof Error ? error.message : String(error));

const SOURCE_TYPES = new Set(['file', 'dir', 'contents', 'package']);

function isSourceList(sources: unknown[]): sources is FingerprintSource[] {
  return sources.every(
    (source) =>
      source !== null && typeof source === 'object' && 'type' in source && SOURCE_TYPES.has(String(source.type)),
  );
}

function writeRecord(record: FingerprintMemoRecord, { onlyIfAbsent = false } = {}): void {
  const dir = fingerprintMemoDir(record.platform);
  const file = fingerprintMemoFile(record.platform, record.digest);
  withDirLock(fingerprintMemoLock(), () => {
    if (onlyIfAbsent && existsSync(file)) return;
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const tmp = `${file}.tmp-${process.pid}`;
    writeFileSync(tmp, JSON.stringify(record), { mode: 0o600 });
    renameSync(tmp, file);
    const records = readdirSync(dir).filter((name) => name.endsWith('.json'));
    if (records.length <= FINGERPRINT_MEMO_CAP) return;
    const byAge = records
      .map((name) => ({ name, mtimeMs: statSync(join(dir, name), { throwIfNoEntry: false })?.mtimeMs ?? 0 }))
      .toSorted((a, b) => a.mtimeMs - b.mtimeMs);
    for (const { name } of byAge.slice(0, records.length - FINGERPRINT_MEMO_CAP))
      rmSync(join(dir, name), { force: true });
  });
  try {
    register({
      dir: fingerprintMemoDir(),
      name: 'Fingerprint memo',
      prune: 'entries',
      entriesDepth: 2,
      note: 'full native fingerprints keyed by a static digest of their inputs',
    });
  } catch {}
}

function dropRecord(platform: MemoPlatform, digest: string): void {
  const file = fingerprintMemoFile(platform, digest);
  if (!existsSync(file)) return;
  withDirLock(fingerprintMemoLock(), () => rmSync(file, { force: true }));
}

const runBackgroundFingerprint: BackgroundFingerprint = (operation, projectRoot, target, signal) =>
  readDoctorFingerprint(
    { ...operation, signal },
    {
      root: projectRoot,
      ...(target.platform ? { platform: target.platform } : {}),
      ...(target.iosProjectPath ? { iosProjectPath: target.iosProjectPath } : {}),
      ...(target.androidLayout ? { androidLayout: target.androidLayout } : {}),
    },
    { lowPriority: true },
  );

function startCheck(
  operation: StimContext,
  projectRoot: string,
  target: FingerprintTarget & { platform: MemoPlatform },
  stored: FingerprintMemoRecord,
  background: BackgroundFingerprint,
): FingerprintCheck {
  const controller = new AbortController();
  const signal = AbortSignal.any([operation.signal, controller.signal]);
  let done = false;
  let abandoned = false;
  const result = background(operation, projectRoot, target, signal)
    .then(
      (computed) => ({
        hash: computed?.hash ?? null,
        sources: computed?.sources ?? [],
        failure: computed?.hash ? null : 'no hash',
      }),
      (error: unknown) => ({ hash: null, sources: [], failure: errorMessage(error) }),
    )
    .then(({ hash, sources, failure }): FingerprintCheckResult => {
      done = true;
      const status = hash === stored.hash ? 'confirmed' : hash === null ? 'failed' : 'stale';
      if (status === 'confirmed') {
        try {
          writeRecord(stored, { onlyIfAbsent: true });
        } catch {}
      }
      if (!abandoned)
        debugLog.log('fingerprint_memo_check', {
          platform: target.platform,
          status,
          ...(failure && !controller.signal.aborted ? { failure } : {}),
        });
      const modeled = new Set(stored.nativePackages);
      const unmodeled = sources.flatMap((source) =>
        source.type === 'package' &&
        source.reasons.some((reason) => AUTOLINKED.test(reason)) &&
        !modeled.has(source.name)
          ? [source.name]
          : [],
      );
      return { status, recorded: stored.hash, current: hash, ...(status === 'stale' ? { unmodeled } : {}) };
    });
  return {
    settle: async (graceMs = FINGERPRINT_CHECK_GRACE_MS) => {
      if (done) return result;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const late = new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), graceMs);
      });
      const settled = await Promise.race([result, late]);
      clearTimeout(timer);
      if (settled) return settled;
      abandoned = true;
      controller.abort();
      debugLog.log('fingerprint_memo_check', { platform: target.platform, status: 'abandoned' });
      return { status: 'abandoned', recorded: stored.hash, current: null };
    },
    cancel: () => controller.abort(),
  };
}

export interface MemoizedFingerprint {
  fingerprint: ProjectFingerprint | null;
  /** True when a recorded fingerprint was used instead of computing one. */
  memoHit: boolean;
  check: FingerprintCheck | null;
}

/**
 * The fingerprint for a pre-mutation cache lookup. With `consult`, a record of this machine's Stim home whose static
 * digest matches the tree stands in for the full fingerprint, and with `record` a full fingerprint then runs in the
 * background as `check`; the record is removed until that check agrees. With `record`, a full fingerprint is
 * recorded under the tree's static digest, only when the digest did not change while it was computed. Any memo
 * failure falls back to the full fingerprint; errors from the fingerprint itself propagate.
 */
export async function memoizedFingerprint(
  projectRoot: string,
  target: FingerprintTarget & { platform: MemoPlatform },
  {
    consult,
    record,
    operation,
    fingerprint = fingerprintProject,
    background = runBackgroundFingerprint,
    staticDigest = staticFingerprint,
    now = Date.now,
  }: {
    consult: boolean;
    record: boolean;
    operation?: StimContext;
    fingerprint?: typeof fingerprintProject;
    background?: BackgroundFingerprint;
    staticDigest?: typeof staticFingerprint;
    now?: () => number;
  },
): Promise<MemoizedFingerprint> {
  const full = (): Promise<ProjectFingerprint | null> => fingerprint(projectRoot, target);
  const skip = (reason: string): void => debugLog.log('fingerprint_memo_skip', { platform: target.platform, reason });
  if (!operation || !(consult || record)) return { fingerprint: await full(), memoHit: false, check: null };
  const digestNow = async (): Promise<{ digest: string; nativePackages: string[] } | null> => {
    try {
      const result = await staticDigest(projectRoot, target, { env: operation.env, signal: operation.signal });
      if (result.uncertain !== null) {
        skip(result.uncertain);
        return null;
      }
      return result;
    } catch (error) {
      operation.signal.throwIfAborted();
      skip(errorMessage(error));
      return null;
    }
  };
  const before = await digestNow();
  if (!before) return { fingerprint: await full(), memoHit: false, check: null };

  if (consult) {
    try {
      const stored = readFingerprintMemo(target.platform, before.digest);
      if (!stored) skip('no record');
      else if (!isSourceList(stored.sources)) skip('the record has unknown sources');
      else {
        if (record) dropRecord(target.platform, before.digest);
        debugLog.log('fingerprint_memo_hit', { platform: target.platform });
        trace.mark('fingerprint memo hit', { platform: target.platform });
        return {
          fingerprint: { hash: stored.hash, sources: stored.sources },
          memoHit: true,
          check: record ? startCheck(operation, projectRoot, target, stored, background) : null,
        };
      }
    } catch (error) {
      skip(errorMessage(error));
    }
  }
  const startedAt = now();
  const computed = await full();
  if (!record || !computed?.hash) return { fingerprint: computed, memoHit: false, check: null };
  const after = await digestNow();
  if (after?.digest !== before.digest) skip('an input changed while it was fingerprinted');
  else {
    try {
      writeRecord({
        schema: FINGERPRINT_MEMO_SCHEMA,
        platform: target.platform,
        digest: before.digest,
        recordedAt: startedAt,
        hash: computed.hash,
        sources: computed.sources,
        nativePackages: before.nativePackages,
      });
    } catch (error) {
      skip(errorMessage(error));
    }
  }
  return { fingerprint: computed, memoHit: false, check: null };
}

/** Waits briefly for a memo hit's background check and reports a disagreement, which has already dropped the record. */
export async function settleFingerprintCheck(
  check: FingerprintCheck | null | undefined,
  platform: MemoPlatform,
  warn: (line: string) => void,
  log?: (record: Record<string, unknown>) => void,
): Promise<void> {
  if (!check) return;
  const { status, recorded, current, unmodeled } = await check.settle();
  if (status !== 'stale' || !current) return;
  const line =
    `the recorded fingerprint ${shortHash(recorded)} no longer matches the tree (${shortHash(current)}), ` +
    `so this run looked up the build cache with a stale key; run stim ${platform} again to use the current tree`;
  warn(line);
  log?.({
    src: 'build',
    level: 'warn',
    event: 'fingerprint_memo_stale',
    msg: line,
    recorded,
    current,
    ...(unmodeled?.length ? { unmodeled } : {}),
  });
}
