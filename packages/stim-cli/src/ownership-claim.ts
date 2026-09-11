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
import { captureProcessToken, inspectProcessIdentity, type ProcessRecord } from './process-identity.ts';

export type ClaimMode = 'exclusive' | 'shared';

export interface ClaimDetails {
  readonly [key: string]: unknown;
}

export interface ClaimOwner {
  pid: number;
  processToken: string;
}

export interface ClaimHolder {
  path: string;
  claimId: string;
  mode: ClaimMode;
  owner: ClaimOwner;
  startedAt: string;
  details: ClaimDetails;
  child: ClaimOwner | null;
  childDeclared: boolean;
}

export interface ClaimHandle {
  root: string;
  path: string;
  claimId: string;
  mode: ClaimMode;
  owner: ClaimOwner;
  startedAt: string;
  details: ClaimDetails;
  label: string;
}

export interface ClaimAttempt {
  acquired?: ClaimHandle;
  held?: ClaimHolder;
  waitingFor?: ClaimHolder[];
  pending?: ClaimHandle;
  reaped: ClaimHolder[];
}

export interface ClaimSetState {
  exclusive: ClaimHolder | null;
  shared: ClaimHolder[];
  reaped: ClaimHolder[];
}

export interface ClaimProblem {
  path: string;
  reason: string;
}

export interface ClaimSurvey {
  live: ClaimHolder[];
  dead: ClaimHolder[];
  unresolved: ClaimProblem[];
}

export interface ClaimOptions {
  root: string;
  mode: ClaimMode;
  details?: ClaimDetails;
  label?: string;
}

export const CLAIM_REFUSED = 'STIM_CLAIM_REFUSED';
export const CLAIM_UNAVAILABLE = 'STIM_CLAIM_UNAVAILABLE';

const EXCLUSIVE_DIR = 'exclusive';
const SHARED_DIR = 'shared';
const CLAIM_SUFFIX = '.claim';
const CHILD_SUFFIX = '.child';
const PUBLISH_ATTEMPTS = 64;

export class ClaimRefusedError extends Error {
  readonly code: string = CLAIM_REFUSED;
  readonly claimPath: string;
  readonly removeCommand: string;

  constructor({ claimPath, root, reason, label }: { claimPath: string; root: string; reason: string; label: string }) {
    const removeCommand = claimRemoveCommand(claimPath.startsWith(root) ? claimPath : root);
    super(
      `Stim cannot tell whether the ${label} claim at ${claimPath} is still held: ${reason}. ` +
        'It will not remove a claim it cannot prove is dead, and it will not wait on one either. ' +
        `If nothing is using it, remove the claim and run the command again:\n  ${removeCommand}`,
    );
    this.claimPath = claimPath;
    this.removeCommand = removeCommand;
  }
}

export class ClaimUnavailableError extends Error {
  readonly code: string = CLAIM_UNAVAILABLE;

  constructor(reason: string) {
    super(`Stim could not record a process identity, so it cannot take an ownership claim: ${reason}.`);
  }
}

export function claimRemoveCommand(root: string): string {
  return `rm -rf ${root}`;
}

export function isClaimRefusal(err: unknown): err is ClaimRefusedError {
  return (err as { code?: string })?.code === CLAIM_REFUSED;
}

export function exclusiveClaimDir(root: string): string {
  return join(root, EXCLUSIVE_DIR);
}

export function sharedClaimDir(root: string): string {
  return join(root, SHARED_DIR);
}

function childPath(claimPath: string): string {
  return `${claimPath.slice(0, -CLAIM_SUFFIX.length)}${CHILD_SUFFIX}`;
}

function asOwner(record: unknown): ClaimOwner | null {
  const candidate = record as { pid?: unknown; processToken?: unknown } | null;
  if (!candidate || typeof candidate !== 'object') return null;
  if (typeof candidate.pid !== 'number' || !Number.isSafeInteger(candidate.pid) || candidate.pid <= 0) return null;
  if (typeof candidate.processToken !== 'string' || !candidate.processToken) return null;
  return { pid: candidate.pid, processToken: candidate.processToken };
}

function readChild(claimPath: string): { record: ClaimOwner | null } | null | 'unreadable' {
  let text;
  try {
    text = readFileSync(childPath(claimPath), 'utf-8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') return null;
    return 'unreadable';
  }
  try {
    return { record: asOwner((JSON.parse(text) as { record?: unknown })?.record) };
  } catch {
    return 'unreadable';
  }
}

function readClaim(path: string, mode: ClaimMode): ClaimHolder | null | 'unreadable' {
  let text;
  try {
    text = readFileSync(path, 'utf-8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') return null;
    return 'unreadable';
  }
  let parsed;
  try {
    parsed = JSON.parse(text) as { claimId?: unknown; owner?: unknown; startedAt?: unknown; details?: unknown };
  } catch {
    return 'unreadable';
  }
  const owner = asOwner(parsed?.owner);
  if (!owner || typeof parsed.claimId !== 'string' || !parsed.claimId) return 'unreadable';
  const child = readChild(path);
  if (child === 'unreadable') return 'unreadable';
  return {
    path,
    claimId: parsed.claimId,
    mode,
    owner,
    startedAt: typeof parsed.startedAt === 'string' ? parsed.startedAt : '',
    details: (parsed.details && typeof parsed.details === 'object' ? parsed.details : {}) as ClaimDetails,
    child: child?.record ?? null,
    childDeclared: child !== null,
  };
}

function processGroupAlive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 1) return false;
  try {
    process.kill(-pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException)?.code === 'EPERM';
  }
}

type Liveness = 'live' | 'dead' | 'unknown';

function childLiveness(claimPath: string): Liveness | 'none' {
  const child = readChild(claimPath);
  if (child === null) return 'none';
  if (child === 'unreadable' || !child.record) return 'unknown';
  const status = inspectProcessIdentity(child.record);
  if (status === 'same') return 'live';
  if (status === 'gone') return processGroupAlive(child.record.pid) ? 'live' : 'dead';
  return 'unknown';
}

export function claimLiveness(holder: ClaimHolder): Liveness {
  const status = inspectProcessIdentity(holder.owner);
  if (status === 'same') return 'live';
  if (status === 'unknown') return 'unknown';
  const child = childLiveness(holder.path);
  return child === 'none' ? 'dead' : child;
}

function refuse(root: string, claimPath: string, label: string, reason: string): never {
  throw new ClaimRefusedError({ claimPath, root, label, reason });
}

function names(dir: string): string[] | 'unreadable' {
  try {
    return readdirSync(dir).toSorted();
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') return [];
    return 'unreadable';
  }
}

function survey(dir: string, mode: ClaimMode, into: ClaimSurvey): void {
  const listed = names(dir);
  if (listed === 'unreadable') {
    into.unresolved.push({ path: dir, reason: 'its directory could not be read' });
    return;
  }
  for (const name of listed) {
    if (!name.endsWith(CLAIM_SUFFIX)) continue;
    const path = join(dir, name);
    const holder = readClaim(path, mode);
    if (holder === null) continue;
    if (holder === 'unreadable') {
      into.unresolved.push({ path, reason: 'its record is missing, truncated or not valid JSON' });
      continue;
    }
    const liveness = claimLiveness(holder);
    if (liveness === 'live') into.live.push(holder);
    else if (liveness === 'dead') into.dead.push(holder);
    else {
      into.unresolved.push({
        path,
        reason:
          holder.childDeclared && !holder.child
            ? 'it spawned the process that holds it and was killed before recording which one'
            : 'its process identity token does not decode, so the holder cannot be identified',
      });
    }
  }
  if (listed.length > 0 && !listed.some((name) => name.endsWith(CLAIM_SUFFIX))) {
    into.unresolved.push({ path: dir, reason: 'it holds files Stim did not write' });
  }
}

/** Classify every claim in a claim set without removing anything and without refusing. */
export function readClaimSet(root: string): ClaimSurvey {
  const state: ClaimSurvey = { live: [], dead: [], unresolved: [] };
  survey(exclusiveClaimDir(root), 'exclusive', state);
  survey(sharedClaimDir(root), 'shared', state);
  return state;
}

function removeOrRefuse(path: string, root: string, claimPath: string, label: string): void {
  try {
    unlinkSync(path);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code;
    if (code === 'ENOENT') return;
    refuse(root, claimPath, label, `the claim left behind could not be removed (${code || (err as Error)?.message})`);
  }
}

function reap(holder: ClaimHolder, root: string, label: string): boolean {
  const again = readClaim(holder.path, holder.mode);
  if (again === null) return true;
  if (again === 'unreadable' || again.claimId !== holder.claimId) return false;
  removeOrRefuse(childPath(holder.path), root, holder.path, label);
  removeOrRefuse(holder.path, root, holder.path, label);
  return true;
}

function tidy(dir: string): void {
  try {
    rmdirSync(dir);
  } catch {}
}

export function inspectClaimSet(root: string, { label = 'ownership' }: { label?: string } = {}): ClaimSetState {
  const state = readClaimSet(root);
  const unresolved = state.unresolved[0];
  if (unresolved) refuse(root, unresolved.path, label, unresolved.reason);
  const reaped: ClaimHolder[] = [];
  for (const holder of state.dead) {
    if (reap(holder, root, label)) reaped.push(holder);
  }
  if (!state.live.some((holder) => holder.mode === 'exclusive')) tidy(exclusiveClaimDir(root));
  if (!state.live.some((holder) => holder.mode === 'shared')) tidy(sharedClaimDir(root));
  return {
    exclusive: state.live.find((holder) => holder.mode === 'exclusive') ?? null,
    shared: state.live.filter((holder) => holder.mode === 'shared'),
    reaped,
  };
}

function selfOwner(): ClaimOwner {
  const processToken = captureProcessToken(process.pid);
  if (!processToken) throw new ClaimUnavailableError('this platform returned no process identity token');
  return { pid: process.pid, processToken };
}

// A claim set is removed the instant it holds nothing, so any step of a publication can lose the
// directory it is writing into to another process's cleanup. Those codes mean "try again", never
// "nobody holds this".
function contended(code: string | undefined): boolean {
  return code === 'EEXIST' || code === 'ENOTEMPTY' || code === 'ENOENT' || code === 'EINVAL';
}

function publishExclusive(root: string, payload: string, claimId: string, label: string): string | null {
  const staging = join(root, `.staging-${claimId}`);
  const target = exclusiveClaimDir(root);
  try {
    mkdirSync(staging, { recursive: true });
    writeFileSync(join(staging, `${claimId}${CLAIM_SUFFIX}`), payload);
    renameSync(staging, target);
    return join(target, `${claimId}${CLAIM_SUFFIX}`);
  } catch (err) {
    rmSync(staging, { recursive: true, force: true });
    const code = (err as NodeJS.ErrnoException)?.code;
    if (contended(code)) return null;
    if (code === 'ENOTDIR') refuse(root, target, label, 'the claim path is a file, not a claim directory');
    throw err;
  }
}

function publishShared(root: string, payload: string, claimId: string): string | null {
  const staging = join(root, `.staging-${claimId}`);
  const target = join(sharedClaimDir(root), `${claimId}${CLAIM_SUFFIX}`);
  try {
    mkdirSync(sharedClaimDir(root), { recursive: true });
    writeFileSync(staging, payload);
    renameSync(staging, target);
    return target;
  } catch (err) {
    rmSync(staging, { force: true });
    if (contended((err as NodeJS.ErrnoException)?.code)) return null;
    throw err;
  }
}

function settleOrRelease(claim: ClaimHandle): ClaimSetState {
  try {
    return inspectClaimSet(claim.root, { label: claim.label });
  } catch (err) {
    releaseClaim(claim);
    throw err;
  }
}

export function tryAcquireClaim({ root, mode, details = {}, label = 'ownership' }: ClaimOptions): ClaimAttempt {
  const owner = selfOwner();
  const reaped: ClaimHolder[] = [];

  for (let attempt = 0; attempt < PUBLISH_ATTEMPTS; attempt++) {
    try {
      mkdirSync(root, { recursive: true });
    } catch (err) {
      if (contended((err as NodeJS.ErrnoException)?.code)) continue;
      throw err;
    }
    const state = inspectClaimSet(root, { label });
    reaped.push(...state.reaped);
    if (state.exclusive) return { held: state.exclusive, reaped };

    const claimId = randomUUID();
    const startedAt = new Date().toISOString();
    const payload = JSON.stringify({ claimId, mode, owner, startedAt, details });
    const handle = (path: string): ClaimHandle => ({
      root,
      path,
      claimId,
      mode,
      owner,
      startedAt,
      details,
      label,
    });

    if (mode === 'shared') {
      const published = publishShared(root, payload, claimId);
      if (!published) continue;
      const claim = handle(published);
      const settled = settleOrRelease(claim);
      reaped.push(...settled.reaped);
      if (!settled.exclusive) return { acquired: claim, reaped };
      releaseClaim(claim);
      return { held: settled.exclusive, reaped };
    }

    const path = publishExclusive(root, payload, claimId, label);
    if (!path) continue;
    const claim = handle(path);
    const settled = settleOrRelease(claim);
    reaped.push(...settled.reaped);
    if (settled.shared.length === 0) return { acquired: claim, reaped };
    return { waitingFor: settled.shared, pending: claim, reaped };
  }

  const contender = inspectClaimSet(root, { label });
  reaped.push(...contender.reaped);
  const holder = contender.exclusive ?? contender.shared[0];
  if (holder) return { held: holder, reaped };
  refuse(
    root,
    root,
    label,
    `another process took and gave up the claim on every one of ${PUBLISH_ATTEMPTS} attempts to take it`,
  );
}

export function settleClaim(pending: ClaimHandle): ClaimAttempt {
  const state = inspectClaimSet(pending.root, { label: pending.label });
  if (state.shared.length === 0) return { acquired: pending, reaped: state.reaped };
  return { waitingFor: state.shared, pending, reaped: state.reaped };
}

export function releaseClaim(handle: ClaimHandle | null | undefined): boolean {
  if (!handle) return false;
  const current = readClaim(handle.path, handle.mode);
  if (current === null) return true;
  if (current === 'unreadable' || current.claimId !== handle.claimId) return false;
  try {
    rmSync(childPath(handle.path), { force: true });
    rmSync(handle.path, { force: true });
  } catch {
    return false;
  }
  tidy(handle.mode === 'exclusive' ? exclusiveClaimDir(handle.root) : sharedClaimDir(handle.root));
  tidy(handle.root);
  return true;
}

/**
 * Declare that this claim is about to spawn the process that does the real work, before the spawn.
 * A claim marked this way and left without a child record reads as unresolvable rather than as free,
 * so a parent killed between the spawn and the record cannot release a claim its child still needs.
 */
export function markClaimChildPending(handle: ClaimHandle): void {
  writeChild(handle, { record: null });
}

/**
 * Record the spawned process that holds this claim. Spawn it with `detached: true` so it leads its own
 * process group: the claim then reads as held while any member of that group is alive, which is what
 * keeps a package manager's postinstall child covered after the manager itself exits.
 */
export function setClaimChild(handle: ClaimHandle, record: ProcessRecord): void {
  const child = asOwner(record);
  if (!child) throw new ClaimUnavailableError('the child process identity was not a pid and token pair');
  writeChild(handle, { record: child });
}

export function clearClaimChild(handle: ClaimHandle): void {
  rmSync(childPath(handle.path), { force: true });
}

function writeChild(handle: ClaimHandle, body: { record: ClaimOwner | null }): void {
  const staging = join(handle.root, `.staging-child-${handle.claimId}`);
  try {
    writeFileSync(staging, JSON.stringify(body));
    renameSync(staging, childPath(handle.path));
  } catch (err) {
    rmSync(staging, { force: true });
    throw err;
  }
}
