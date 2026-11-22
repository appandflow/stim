import type { GcCandidateCoverage, GcCandidateInventory, GcMark } from '@stim-cli/core/state';

type InventoryMark = Pick<GcMark, 'root' | 'markedAt' | 'candidates' | 'dependencies'> & {
  worktree?: { markedAt: string };
};
type Candidate = { kind: string; path: string; bytes: number | null; measuredAt: string | null };
type Observation = { markedAt: string; candidates: readonly Candidate[] };

function coverage(observations: readonly (Observation | undefined)[], complete: boolean): GcCandidateCoverage {
  const identities = new Map<string, { bytes: number | null; at: number }>();
  let seen = 0;
  let oldest = Infinity;
  for (const observation of observations) {
    const markedAt = Date.parse(observation?.markedAt ?? '');
    if (!observation || !Number.isFinite(markedAt)) continue;
    seen++;
    oldest = Math.min(oldest, markedAt);
    for (const candidate of observation.candidates) {
      const identity = `${candidate.kind}\0${candidate.path}`;
      const measuredAt = Date.parse(candidate.measuredAt ?? '');
      const at = Number.isFinite(measuredAt) ? measuredAt : markedAt;
      const prior = identities.get(identity);
      if (prior && prior.at >= at) continue;
      const bytes =
        candidate.bytes !== null && Number.isFinite(candidate.bytes) && candidate.bytes >= 0 ? candidate.bytes : null;
      identities.set(identity, { bytes, at });
    }
  }
  const state = complete && seen === observations.length ? 'ready' : seen ? 'partial' : 'unavailable';
  let knownBytes = 0;
  let unknownSizeCount = 0;
  for (const { bytes } of identities.values()) {
    if (bytes === null) unknownSizeCount++;
    else knownBytes += bytes;
  }
  return {
    state,
    ...(state === 'ready' || identities.size ? { count: identities.size, knownBytes, unknownSizeCount } : {}),
    ...(Number.isFinite(oldest) ? { oldestMarkedAt: new Date(oldest).toISOString() } : {}),
  };
}

// @ref LLP 0001#the-lane-marks-what-each-checkout-could-free -- candidate coverage is saved evidence, not filesystem-wide totals
/** Summarizes only the authorized saved batch; it reads no paths and grants no deletion authority. */
export function candidateInventory(
  marks: readonly InventoryMark[],
  complete: boolean,
  listed: boolean,
): GcCandidateInventory {
  return {
    readState: !listed ? 'unavailable' : complete ? 'ready' : 'partial',
    outputs: coverage(
      marks.map(({ markedAt, candidates }) => ({ markedAt, candidates })),
      complete,
    ),
    dependencies: coverage(
      marks.map(({ dependencies }) =>
        dependencies
          ? {
              markedAt: dependencies.markedAt,
              candidates: dependencies.candidates.map((candidate) => ({ ...candidate, kind: 'dependencies' })),
            }
          : undefined,
      ),
      complete,
    ),
    worktrees: coverage(
      marks.map(({ root, worktree }) =>
        worktree
          ? {
              markedAt: worktree.markedAt,
              candidates: [{ kind: 'worktree', path: root, bytes: null, measuredAt: null }],
            }
          : undefined,
      ),
      complete,
    ),
  };
}
