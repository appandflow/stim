# LLP 0006: Making room before a build

**Type:** Decision
**Status:** Active
**Systems:** Cleanup, Builds
**Author:** Janic Duplessis / Claude
**Date:** 2026-11-12
**Related:** LLP 0001, LLP 0003

## A build never refuses for headroom

Before a local native compile (`ios`, `android`, `macos`; not a cache hit or an
offloaded build), Stim estimates what the compile will write. When the build's
volume has less free than that estimate plus the critical floor, the build runs
the pressure ladder once in its own process, then builds whatever the result,
with one stderr warning when the estimate still does not fit. The check adds no
refusal and no error code: a failure inside it is ignored, and only a
cancellation passes through. `disk.hardFloorGb` remains the only disk refusal
(LLP 0001).

Reason: a cold build can take a disk from above a pressure level to well below
it in minutes, so a build should make room first. Refusing would stop work on
an estimate, and the estimate is a guess.

The maintainer decided on 2026-11-11 that headroom never refuses a build and
that the default without history is per project type and platform (#5512;
paraphrased there, not quoted). This replaced an earlier plan, still in the
body of #5513, to refuse with the number needed.

## Only the build's own device counts

The run uses the high level only, rungs 2 to 8, never rung 9 (LLP 0003). It
stops once the build's volume, found by its device id, has the target free,
whether the target is under or over `disk.minFreeGb`. Other volumes and memory
do not count. It ends after any action that leaves the build volume's free
space no higher, after 60 seconds, or when another process holds the ladder
claim.

Reason: only space on the build's own volume helps the build, and a build holds
its build slot while it waits, so the run must be bounded and must not delete
more than the build needs.

## Estimate and measurement

The estimate is the median of the project's ten newest positive records for that
platform in the last 30 days, matched by project key so a new worktree inherits
its project's history; without history, a default per project type and
platform. A build's size is the drop in free space on its volume between start
and end: two volume reads, no directory walk.

Reason: the median keeps one inflated record, such as a build that ran beside
another, from pinning the estimate. The free-space drop needs two reads where a
size walk would visit every output file while the build holds its slot.

Chosen in the reviews of #5517, not by the maintainer.

## Links

- Issues: #5512, #5513. Pull request: #5517.
- Code: `packages/stim-cli/src/engine/build-headroom-run.ts`
  (`createBuildHeadroom`), `packages/stim-cli/src/engine/build-headroom.ts`,
  `packages/stim-cli/src/daemon/passes.ts` (`runLadderToFree`).
