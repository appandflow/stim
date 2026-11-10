import type { StimContext } from '@stim-cli/core';
import { readdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { basename, join } from 'node:path';
import { ensurePrivateDir } from '@stim-cli/core';
import { fingerprintIndexDir, fingerprintPendingVerifyDir } from '@stim-cli/core/state';
import { debugLog } from '../debug-log.ts';
import { fingerprint, type Fingerprint } from './evaluate.ts';
import {
  checkoutTag,
  withIndexLock,
  dropRecords,
  indexDir,
  nowNs,
  readWorkspaceEnv,
  writePrivate,
} from './index-store.ts';
import { targetLayout, type StaticTarget } from './inputs.ts';
import { field } from './walk.ts';
import { diffInputs, isUncertain, sha256, type InputChange, type Platform, type Uncertain } from './key.ts';

/** An index hit is checked in the CLI once its directory has served more hits than this since a verification. */
const TRUST_HITS = 3;
/** Or once it has gone this long without one. */
const TRUST_NS = 10n * 60n * 1_000_000_000n;
/** How long the end of a run waits for a background check that is still running before it gives the check up. */
const FINGERPRINT_CHECK_GRACE_MS = 3000;

export interface VerifyRequest {
  root: string;
  target: StaticTarget;
  embedMode: 'development' | 'production';
}

interface Trust {
  verifiedAtNs: string | null;
  firstHitNs: string;
  hits: number;
}

interface Pending extends VerifyRequest {
  hash: string;
  inputs: Fingerprint['inputs'];
  at: string;
  envRef: { id: string; digest: string };
}

interface CheckResult {
  status: 'confirmed' | 'disagreed' | 'failed' | 'abandoned';
  recorded: string;
  current: string | null;
  changes?: InputChange[];
}

type CheckOutcome = { value: CheckResult } | { failure: unknown };

function checkValue(outcome: CheckOutcome): CheckResult {
  if ('failure' in outcome) throw outcome.failure;
  return outcome.value;
}

export interface BackgroundCheck {
  join(): Promise<CheckResult>;
  settle(graceMs?: number): Promise<CheckResult>;
  cancel(): Promise<void>;
}

function readJson(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
}

function writeJson(path: string, value: unknown): void {
  ensurePrivateDir(join(path, '..'));
  writePrivate(path, JSON.stringify(value));
}

const requestDir = ({ root, target }: VerifyRequest, home?: string) => {
  const project = realpathSync.native(root);
  return { project, dir: indexDir(target.platform, project, targetLayout(target), home) };
};

const trustFile = (dir: string) => join(dir, 'trust.json');

function readTrust(dir: string): Trust | null {
  const value = readJson(trustFile(dir));
  const hits = field(value, 'hits');
  const verifiedAtNs = field(value, 'verifiedAtNs');
  const firstHitNs = field(value, 'firstHitNs');
  return typeof hits === 'number' && typeof firstHitNs === 'string'
    ? { hits, firstHitNs, verifiedAtNs: typeof verifiedAtNs === 'string' ? verifiedAtNs : null }
    : null;
}

/** Counts one index hit and says whether the directory is past its trust bound (3 hits or 10 minutes unverified). */
function countHit(dir: string, now: bigint, home?: string): boolean {
  return withIndexLock(() => {
    const trust = readTrust(dir) ?? { verifiedAtNs: null, firstHitNs: String(now), hits: 0 };
    trust.hits += 1;
    try {
      writeJson(trustFile(dir), trust);
    } catch {}
    return trust.hits > TRUST_HITS || now - BigInt(trust.verifiedAtNs ?? trust.firstHitNs) > TRUST_NS;
  }, home);
}

function markVerified(dir: string, now: bigint, home?: string): void {
  withIndexLock(() => {
    if (statSync(dir, { throwIfNoEntry: false }) === undefined) return;
    try {
      writeJson(trustFile(dir), { verifiedAtNs: String(now), firstHitNs: String(now), hits: 0 });
    } catch {}
  }, home);
}

const disagreementsFile = (home?: string) => join(fingerprintIndexDir(undefined, home), 'disagreements.json');

interface Disagreements {
  count: number;
  unreported: { platform: Platform; recorded: string; current: string; changes: InputChange[] }[];
}

const readDisagreements = (home?: string): Disagreements => {
  const value = readJson(disagreementsFile(home));
  const count = field(value, 'count');
  const unreported = field(value, 'unreported');
  return {
    count: typeof count === 'number' ? count : 0,
    unreported: Array.isArray(unreported) ? unreported.filter(isDisagreement) : [],
  };
};

const isDisagreement = (value: unknown): value is Disagreements['unreported'][number] =>
  ['platform', 'recorded', 'current'].every((key) => typeof field(value, key) === 'string') &&
  Array.isArray(field(value, 'changes'));

/** Drops a directory whose recorded parts gave another key than a full computation, and counts it. */
function disagree(
  dir: string,
  platform: Platform,
  recorded: string,
  current: string,
  changes: InputChange[],
  home?: string,
): void {
  debugLog.log('fingerprint.index_disagreement', { platform, recorded, current, changes });
  withIndexLock(() => {
    dropRecords(dir);
    const known = readDisagreements(home);
    try {
      writeJson(disagreementsFile(home), {
        count: known.count + 1,
        unreported: [...known.unreported, { platform, recorded, current, changes }].slice(-20),
      });
    } catch {}
  }, home);
}

/** How many index hits a full computation has disagreed with on this machine. */
export const disagreementCount = (): number => readDisagreements().count;

/** Disagreements no run has warned about yet, cleared as they are returned, and the total ever counted. */
export function takeDisagreements(home?: string): Disagreements {
  try {
    return withIndexLock(() => {
      const known = readDisagreements(home);
      if (known.unreported.length > 0) writeJson(disagreementsFile(home), { count: known.count, unreported: [] });
      return known;
    }, home);
  } catch {
    return { count: 0, unreported: [] };
  }
}

/** Recomputes a key without the index and compares it with the one an index hit produced. */
async function recompute(
  request: VerifyRequest,
  env: NodeJS.ProcessEnv,
  hit: Pick<Fingerprint, 'hash' | 'inputs'>,
  signal: AbortSignal,
  operation?: StimContext,
): Promise<CheckResult> {
  const { dir } = requestDir(request, operation?.home);
  const compute = (index: 'use' | 'skip') =>
    fingerprint(request.root, request.target, { env, embedMode: request.embedMode, index, signal, operation }).catch(
      (error: unknown): Uncertain => {
        if (typeof error === 'object' && error !== null && 'reportCleanup' in error) throw error;
        return { uncertain: 'fingerprint verification failed' };
      },
    );
  const current = await compute('skip');
  if (signal.aborted) return { status: 'abandoned', recorded: hit.hash, current: null };
  if (isUncertain(current)) return { status: 'failed', recorded: hit.hash, current: null };
  if (current.hash === hit.hash) {
    locked(() => markVerified(dir, nowNs(), operation?.home));
    return { status: 'confirmed', recorded: hit.hash, current: current.hash };
  }
  const indexed = await compute('use');
  if (signal.aborted || isUncertain(indexed) || indexed.hash !== hit.hash)
    return { status: 'abandoned', recorded: hit.hash, current: current.hash };
  const changes = diffInputs(hit.inputs, current.inputs);
  locked(() => disagree(dir, request.target.platform, hit.hash, current.hash, changes, operation?.home));
  return { status: 'disagreed', recorded: hit.hash, current: current.hash, changes };
}

/** Runs a bookkeeping step whose lock may time out; a lost count or mark only delays the next check. */
function locked(step: () => void): void {
  try {
    step();
  } catch {}
}

/**
 * What follows a key that used the index. Within the trust bound and with the background passes running, the hit
 * waits in `pending-verify/` for them; otherwise this run recomputes it in the background and `settle` reports the
 * outcome, a disagreement having already dropped the directory's records.
 */
export function verifyHit(
  request: VerifyRequest,
  hit: Fingerprint,
  {
    env,
    passes,
    signal,
    operation,
  }: { env: NodeJS.ProcessEnv; passes: boolean; signal?: AbortSignal; operation?: StimContext },
): BackgroundCheck | null {
  if (hit.from !== 'index') return null;
  const { project, dir } = requestDir(request, operation?.home);
  const now = nowNs();
  let pastBound = true;
  locked(() => {
    pastBound = countHit(dir, now, operation?.home);
  });
  if (passes && !pastBound) {
    const envRef = readWorkspaceEnv(project, operation?.home);
    if (envRef) {
      const pending: Pending = {
        ...request,
        root: project,
        hash: hit.hash,
        inputs: hit.inputs,
        at: String(now),
        envRef: { id: sha256(project), digest: envRef.digest },
      };
      try {
        writeJson(
          join(fingerprintPendingVerifyDir(operation?.home), `${basename(dir)}-${checkoutTag(project)}.json`),
          pending,
        );
        return null;
      } catch {}
    }
  }
  const controller = new AbortController();
  const both = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
  let settled: CheckOutcome | null = null;
  const result: Promise<CheckOutcome> = recompute(request, env, hit, both, operation)
    .then(
      (value): CheckOutcome => ({ value }),
      (failure: unknown): CheckOutcome => ({ failure }),
    )
    .then((outcome) => (settled = outcome));
  return {
    join: async () => checkValue(await result),
    settle: async (graceMs = FINGERPRINT_CHECK_GRACE_MS) => {
      if (settled) return checkValue(settled);
      let timer: ReturnType<typeof setTimeout> | undefined;
      const late = new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), graceMs);
      });
      const outcome = await Promise.race([result, late]);
      clearTimeout(timer);
      if (outcome) return checkValue(outcome);
      controller.abort();
      return checkValue(await result);
    },
    cancel: async () => {
      controller.abort();
      checkValue(await result);
    },
  };
}

const isPending = (value: unknown): value is Pending =>
  ['root', 'hash', 'embedMode'].every((key) => typeof field(value, key) === 'string') &&
  typeof field(field(value, 'envRef'), 'digest') === 'string' &&
  typeof field(field(value, 'target'), 'platform') === 'string' &&
  Array.isArray(field(value, 'inputs'));

/**
 * The passes' share of verification: recomputes up to `perPass` pending hits, one per index directory, under the env
 * their workspace recorded. A hit whose workspace env changed since it was recorded is dropped unchecked.
 */
export async function verifyPending({
  perPass,
  signal,
  root,
  file,
}: {
  perPass: number;
  signal: AbortSignal;
  root?: string;
  file?: string;
}): Promise<number> {
  const dir = fingerprintPendingVerifyDir();
  let names: string[];
  try {
    names = file
      ? basename(file) === file && file.endsWith('.json')
        ? [file]
        : []
      : readdirSync(dir).filter((name) => name.endsWith('.json'));
  } catch {
    return 0;
  }
  let checked = 0;
  for (const name of names.slice(0, perPass)) {
    const original = join(dir, name);
    const claimed = join(dir, `claim-${randomUUID()}.json`);
    try {
      renameSync(original, claimed);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
      throw error;
    }
    const pending = readJson(claimed);
    if (!isPending(pending)) {
      rmSync(claimed, { force: true });
      continue;
    }
    let project: string;
    try {
      project = realpathSync.native(pending.root);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') rmSync(claimed, { force: true });
      continue;
    }
    if (root && project !== root) continue;
    const env = readWorkspaceEnv(project);
    if (!env || env.digest !== pending.envRef.digest) {
      rmSync(claimed, { force: true });
      continue;
    }
    await recompute(pending, env.env, pending, signal);
    if (signal.aborted) return checked;
    rmSync(claimed, { force: true });
    checked += 1;
  }
  return checked;
}
