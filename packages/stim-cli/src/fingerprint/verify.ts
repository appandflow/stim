import { readdirSync, readFileSync, realpathSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { ensurePrivateDir } from '@stim-cli/core';
import { fingerprintIndexDir, fingerprintIndexLock, fingerprintPendingVerifyDir } from '@stim-cli/core/state';
import { debugLog } from '../debug-log.ts';
import { withDirLock } from '../dir-lock.ts';
import { fingerprint, type Fingerprint } from './evaluate.ts';
import { dropRecords, indexDir, newerThanInstall, nowNs, readWorkspaceEnv, writePrivate } from './index-store.ts';
import { installRoot, targetLayout, type StaticTarget } from './inputs.ts';
import { diffInputs, isUncertain, sha256, type InputChange, type Platform, type Uncertain } from './key.ts';

/** An index hit is checked in the CLI once its directory has served more hits than this since a verification. */
const TRUST_HITS = 3;
/** Or once it has gone this long without one. */
const TRUST_NS = 10n * 60n * 1_000_000_000n;
/** How long the end of a run waits for a background check that is still running before it gives the check up. */
export const FINGERPRINT_CHECK_GRACE_MS = 3000;

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

export interface CheckResult {
  status: 'confirmed' | 'disagreed' | 'failed' | 'abandoned';
  recorded: string;
  current: string | null;
  changes?: InputChange[];
}

export interface BackgroundCheck {
  settle(graceMs?: number): Promise<CheckResult>;
  cancel(): void;
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

const requestDir = ({ root, target }: VerifyRequest) => {
  const project = realpathSync.native(root);
  return { project, dir: indexDir(target.platform, project, targetLayout(target)) };
};

const trustFile = (dir: string) => join(dir, 'trust.json');

function readTrust(dir: string): Trust | null {
  const value = readJson(trustFile(dir));
  return value && typeof value === 'object' && typeof (value as Trust).hits === 'number' ? (value as Trust) : null;
}

/** Counts one index hit and says whether the directory is past its trust bound (3 hits or 10 minutes unverified). */
function countHit(dir: string, now: bigint): boolean {
  return withDirLock(fingerprintIndexLock(), () => {
    const trust = readTrust(dir) ?? { verifiedAtNs: null, firstHitNs: String(now), hits: 0 };
    trust.hits += 1;
    try {
      writeJson(trustFile(dir), trust);
    } catch {}
    return trust.hits > TRUST_HITS || now - BigInt(trust.verifiedAtNs ?? trust.firstHitNs) > TRUST_NS;
  });
}

function markVerified(dir: string, now: bigint): void {
  withDirLock(fingerprintIndexLock(), () => {
    if (statSync(dir, { throwIfNoEntry: false }) === undefined) return;
    try {
      writeJson(trustFile(dir), { verifiedAtNs: String(now), firstHitNs: String(now), hits: 0 });
    } catch {}
  });
}

const disagreementsFile = () => join(fingerprintIndexDir(), 'disagreements.json');

interface Disagreements {
  count: number;
  unreported: { platform: Platform; recorded: string; current: string; changes: InputChange[] }[];
}

const readDisagreements = (): Disagreements => {
  const value = readJson(disagreementsFile()) as Disagreements | null;
  return value && typeof value.count === 'number' && Array.isArray(value.unreported)
    ? value
    : { count: 0, unreported: [] };
};

/** Drops a directory whose recorded parts gave another key than a full computation, and counts it. */
function disagree(dir: string, platform: Platform, recorded: string, current: string, changes: InputChange[]): void {
  dropRecords(dir);
  debugLog.log('fingerprint.index_disagreement', { platform, recorded, current, changes });
  withDirLock(fingerprintIndexLock(), () => {
    const known = readDisagreements();
    try {
      writeJson(disagreementsFile(), {
        count: known.count + 1,
        unreported: [...known.unreported, { platform, recorded, current, changes }].slice(-20),
      });
    } catch {}
  });
}

/** How many index hits a full computation has disagreed with on this machine. */
export const disagreementCount = (): number => readDisagreements().count;

/** Disagreements no run has warned about yet, cleared as they are returned, and the total ever counted. */
export function takeDisagreements(): Disagreements {
  return withDirLock(fingerprintIndexLock(), () => {
    const known = readDisagreements();
    if (known.unreported.length > 0)
      try {
        writeJson(disagreementsFile(), { count: known.count, unreported: [] });
      } catch {}
    return known;
  });
}

/** Recomputes a key without the index and compares it with the one an index hit produced. */
async function recompute(
  request: VerifyRequest,
  env: NodeJS.ProcessEnv,
  hit: Pick<Fingerprint, 'hash' | 'inputs'>,
  signal: AbortSignal,
): Promise<CheckResult> {
  const { dir } = requestDir(request);
  const current = await fingerprint(request.root, request.target, {
    env,
    embedMode: request.embedMode,
    index: 'skip',
    signal,
  }).catch((error: unknown): Uncertain => ({ uncertain: String(error) }));
  if (signal.aborted) return { status: 'abandoned', recorded: hit.hash, current: null };
  if (isUncertain(current)) return { status: 'failed', recorded: hit.hash, current: null };
  if (current.hash === hit.hash) {
    markVerified(dir, nowNs());
    return { status: 'confirmed', recorded: hit.hash, current: current.hash };
  }
  const changes = diffInputs(hit.inputs, current.inputs);
  disagree(dir, request.target.platform, hit.hash, current.hash, changes);
  return { status: 'disagreed', recorded: hit.hash, current: current.hash, changes };
}

/**
 * What follows a key that used the index. Within the trust bound and with the background passes running, the hit
 * waits in `pending-verify/` for them; otherwise this run recomputes it in the background and `settle` reports the
 * outcome, a disagreement having already dropped the directory's records.
 */
export function verifyHit(
  request: VerifyRequest,
  hit: Fingerprint,
  { env, passes, signal }: { env: NodeJS.ProcessEnv; passes: boolean; signal?: AbortSignal },
): BackgroundCheck | null {
  if (hit.from !== 'index') return null;
  const { project, dir } = requestDir(request);
  const now = nowNs();
  const pastBound = countHit(dir, now);
  if (passes && !pastBound) {
    const envRef = readWorkspaceEnv(project);
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
        writeJson(join(fingerprintPendingVerifyDir(), `${dir.split(/[\\/]/).at(-1)}.json`), pending);
        return null;
      } catch {}
    }
  }
  const controller = new AbortController();
  const both = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
  let settled: CheckResult | null = null;
  const result = recompute(request, env, hit, both).then((outcome) => (settled = outcome));
  return {
    settle: async (graceMs = FINGERPRINT_CHECK_GRACE_MS) => {
      if (settled) return settled;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const late = new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), graceMs);
      });
      const outcome = await Promise.race([result, late]);
      clearTimeout(timer);
      if (outcome) return outcome;
      controller.abort();
      return { status: 'abandoned', recorded: hit.hash, current: null };
    },
    cancel: () => controller.abort(),
  };
}

/**
 * The passes' share of verification: recomputes up to `perPass` pending hits, one per index directory, under the env
 * their workspace recorded. A hit whose workspace env changed since it was recorded is dropped unchecked.
 */
export async function verifyPending({ perPass, signal }: { perPass: number; signal: AbortSignal }): Promise<number> {
  let names: string[];
  try {
    names = readdirSync(fingerprintPendingVerifyDir()).filter((name) => name.endsWith('.json'));
  } catch {
    return 0;
  }
  let checked = 0;
  for (const name of names.slice(0, perPass)) {
    const file = join(fingerprintPendingVerifyDir(), name);
    const pending = readJson(file) as Pending | null;
    rmSync(file, { force: true });
    if (!pending?.envRef || typeof pending.root !== 'string') continue;
    let project: string;
    try {
      project = realpathSync.native(pending.root);
    } catch {
      continue;
    }
    const env = readWorkspaceEnv(project);
    if (!env || env.digest !== pending.envRef.digest) continue;
    await recompute(pending, env.env, pending, signal);
    checked += 1;
  }
  return checked;
}

/**
 * The local store gate: refuses a store when a patch or the lockfile is newer than the last install, or when the key
 * recomputed now (by stat through the index) differs from the one the build was looked up under.
 */
export async function localStoreGate(
  request: VerifyRequest,
  key: Pick<Fingerprint, 'hash'>,
  { env, signal }: { env: NodeJS.ProcessEnv; signal?: AbortSignal },
): Promise<{ store: true } | { store: false; reason: string }> {
  const project = realpathSync.native(request.root);
  const pending = newerThanInstall({ project, install: installRoot(project) });
  if (pending) return { store: false, reason: `${pending} changed after the last install` };
  const now = await fingerprint(request.root, request.target, { env, embedMode: request.embedMode, signal });
  if (isUncertain(now)) return { store: false, reason: now.uncertain };
  return now.hash === key.hash
    ? { store: true }
    : { store: false, reason: 'the native inputs changed during the build' };
}

/** The remote store gate: a key that used the index is recomputed in full before anything is uploaded under it. */
export async function remoteStoreGate(
  request: VerifyRequest,
  key: Pick<Fingerprint, 'hash' | 'from'>,
  { env, signal }: { env: NodeJS.ProcessEnv; signal?: AbortSignal },
): Promise<{ store: true } | { store: false; reason: string }> {
  if (key.from !== 'index') return { store: true };
  const full = await fingerprint(request.root, request.target, {
    env,
    embedMode: request.embedMode,
    index: 'skip',
    signal,
  });
  if (isUncertain(full)) return { store: false, reason: full.uncertain };
  return full.hash === key.hash
    ? { store: true }
    : { store: false, reason: 'the key the index served differs from a full computation' };
}
