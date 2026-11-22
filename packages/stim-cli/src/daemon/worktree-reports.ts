import { isClaimUnavailable } from '@stim-cli/core/ownership-claim';
import type { GcWorktreeObservation } from '@stim-cli/core/state';
import { realpath, stat } from 'node:fs/promises';
import { sep } from 'node:path';
import { processContext } from '../cli-operation.ts';
import { realpathAsync } from '../commands/gc/paths.ts';
import {
  DEFAULT_WORKTREE_IDLE_DAYS,
  listedRoots,
  savedWorktreeFacts,
  worktreeReportThresholds,
  worktreeSkipReason,
} from '../commands/gc/worktrees.ts';
import { answered, Unanswered } from '../workspace/bounded-read.ts';
import type { Config } from '../workspace/config.ts';
import { targetedCheckouts } from '../workspace/discovery.ts';
import { endedPullRequest } from '../workspace/pull-request.ts';
import { outputMarks } from './marks.ts';
import { worktreeMarkDue } from './worktree-marks.ts';
import { dormantAfterMs, type DeviceReading } from './stages.ts';

function savedPolicyKeep(
  observation: GcWorktreeObservation,
  level: 'high' | 'critical',
  idle: boolean,
  grace: { graceMs: number; emptyBranchMs: number },
): string | null {
  if (observation.clean !== true)
    return observation.clean === false
      ? 'the normal observation found uncommitted changes'
      : 'the normal observation could not prove a clean worktree';
  const keep = observation.keep;
  const policyCodes = new Set(['not-merged', 'merge-unknown', 'last-use-unknown', 'recently-used']);
  if (keep && !policyCodes.has(keep.code) && !(keep.code === 'recent-activity' && keep.eligibleAt !== null))
    return keep.reason;
  const now = Date.now();
  const activity = Date.parse(observation.activity?.at ?? '');
  if (observation.finished) {
    if (grace.graceMs === 0) return null;
    if (!Number.isFinite(activity)) return 'its saved activity is unknown, so the current grace cannot be evaluated';
    const finished = Date.parse(observation.finished.at ?? '');
    return now >= Math.max(activity, Number.isFinite(finished) ? finished : activity) + grace.graceMs
      ? null
      : 'its observed activity or finish is inside the current grace period';
  }
  if (observation.emptyBranch === true)
    return Number.isFinite(activity) && now >= activity + grace.emptyBranchMs
      ? null
      : 'the empty branch is inside its activity grace, or its activity is unknown';
  const lastUsed = Date.parse(observation.lastUsedAt ?? '');
  return level === 'critical' &&
    idle &&
    observation.pushed === true &&
    Number.isFinite(lastUsed) &&
    now - lastUsed >= DEFAULT_WORKTREE_IDLE_DAYS * 86_400_000
    ? null
    : 'it is not observed finished or eligible under the current pushed-idle policy';
}

/** Reports scheduled worktree observations; never discovers a worktree or grants removal authority. */
export async function savedWorktreeReports(
  config: Config,
  reading: DeviceReading,
  level: 'high' | 'critical',
  idle: boolean,
): Promise<{ target: string; detail: string }[]> {
  const marks = await outputMarks(config, reading.operation);
  const rows: { target: string; detail: string }[] = [];
  const registry = new Set(listedRoots());
  const covered = new Set(marks.flatMap((mark) => [mark.root, ...(mark.worktree?.keys ?? [])]));
  for (const root of Object.keys(config.projects))
    if (!covered.has(root))
      rows.push({ target: root, detail: 'worktree inventory is unknown; the normal lane has not observed it' });
  const thresholds = worktreeReportThresholds(level, reading.operation);
  const native = new Map<string, Promise<string>>();
  const identity = (path: string) => {
    let value = native.get(path);
    if (!value) {
      value = answered(path, () => realpath(path), 3_000, reading.operation?.signal);
      native.set(path, value);
    }
    return value;
  };
  for (const mark of marks) {
    const observation = mark.worktree;
    if (!observation) {
      rows.push({ target: mark.root, detail: 'worktree inventory is unknown; its normal producer may be disabled' });
      continue;
    }
    let keep = savedPolicyKeep(observation, level, idle, thresholds);
    if (
      !keep &&
      (Date.parse(mark.dirtyAt ?? '') > Date.parse(observation.markedAt) ||
        worktreeMarkDue(mark, Date.now(), dormantAfterMs(config, reading.operation?.env)))
    )
      keep = 'the worktree observation is due or dirty; current eligibility is unknown';
    if (keep) {
      rows.push({ target: mark.root, detail: keep });
      continue;
    }
    const deadline = new AbortController();
    const timer = setTimeout(() => deadline.abort(new Unanswered('worktree report deadline')), 3_000);
    const signal = reading.operation ? AbortSignal.any([reading.operation.signal, deadline.signal]) : deadline.signal;
    const operation = reading.operation ? { ...reading.operation, signal } : processContext(process.cwd(), signal);
    try {
      const root = await identity(mark.root);
      if (
        (await answered(mark.root, () => realpathAsync(mark.root), 3_000, signal)) !== mark.root ||
        (await answered(mark.root, () => stat(mark.root), 3_000, signal)).dev !== mark.device
      )
        keep = 'the marked worktree moved or changed volume';
      const keys = [mark.root];
      for (const key of Object.keys(config.projects)) {
        signal.throwIfAborted();
        const path = await identity(key);
        if ((path === root || path.startsWith(`${root}${sep}`)) && !keys.includes(key)) keys.push(key);
      }
      if (!keep && (keys.length !== observation.keys.length || keys.some((key) => !observation.keys.includes(key))))
        keep = 'the worktree workspace membership changed';
      if (!keep && !keys.some((key) => registry.has(key))) {
        const route = (await targetedCheckouts(config, [...registry], [mark.root], operation)).find(
          (entry) => entry.path === mark.root,
        );
        if (!route || route.reduceOnly)
          keep = 'current whole-worktree scope is unproven or permits output reduction only';
      }
      if (!keep && reading.protectedRoot) {
        const protectedPath = await identity(reading.protectedRoot);
        if (protectedPath === root || protectedPath.startsWith(`${root}${sep}`))
          keep = 'the command runs inside this worktree';
      }
      if (!keep && (reading.simsFailed || reading.devices.some((device) => keys.includes(device.project))))
        keep = 'a device uses this worktree or its device state is unknown';
      if (!keep && !observation.head) keep = 'the observed HEAD is unknown';
      if (!keep && !observation.source) keep = 'the observed source checkout is unknown';
      if (!keep && observation.head && observation.source) {
        const facts = await savedWorktreeFacts(mark.root, root, keys, observation.head, observation.source, operation);
        if ('keep' in facts) keep = facts.keep;
        else if (observation.finished && !facts.merge?.merged && !endedPullRequest(facts.pullRequest))
          keep = 'its current finished state is unproven without a new normal check';
        else
          keep =
            worktreeSkipReason(
              facts,
              level === 'critical' && idle ? DEFAULT_WORKTREE_IDLE_DAYS : null,
              { ms: thresholds.graceMs, now: Date.now() },
              thresholds.emptyBranchMs,
            )?.text ?? null;
      }
      signal.throwIfAborted();
      rows.push({
        target: mark.root,
        detail:
          keep ??
          `report only: the pressure ladder removes no worktree; ${observation.finished?.reason ?? (observation.emptyBranch ? 'empty branch past its activity grace' : 'pushed worktree idle at least 7 days')}`,
      });
    } catch (error) {
      if (isClaimUnavailable(error) && 'reportCleanup' in error) throw error;
      reading.operation?.signal.throwIfAborted();
      rows.push({ target: mark.root, detail: 'current worktree eligibility could not be checked; it stays' });
    } finally {
      clearTimeout(timer);
    }
  }
  return rows;
}
