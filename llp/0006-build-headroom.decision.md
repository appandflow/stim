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
volume has less free than that estimate plus the critical floor, the build asks
stimd's disk owner for a headroom turn, then builds whatever the result,
with one stderr warning when the estimate still does not fit. The check adds no
refusal and no error code: a failure inside it is ignored, and only a
cancellation passes through. `disk.hardFloorGb` remains the only disk refusal
(LLP 0001).

Reason: a cold build can take a disk from above a pressure level to well below
it in minutes, so a build should make room first. Refusing would stop work on
an estimate, and the estimate is a guess.

Maintainer decision: "headroom should never refuse builds tho", 2026-11-11.

## Only the build's own device counts

The run uses the high level only, rungs 2 to 8, never rung 9 (LLP 0003). It
stops once the build's volume, found by its device id, has the target free,
whether the target is under or over `disk.minFreeGb`. Other volumes and memory
do not count. It ends after any action that removed something, or failed, and
left the build volume's free space no higher, or at the deadline. An action that kept everything does not end it,
so a cache with nothing to evict does not stop the run before the Cargo trims,
which rung 3 runs after the caches (LLP 0001, The ladder runs by yield). The
cost: a run whose every action keeps goes on to the end of its rungs or the
60 seconds. Chosen by the implementer of #6025, not the maintainer.

Reason: only space on the build's own volume helps the build, and a build holds
its build slot while it waits, so the run must be bounded and must not delete
more than the build needs.

Chosen by the coordinator and the reviews of #5517, not by the maintainer.

## One bounded turn on the disk owner

Headroom takes the high ladder rank on stimd's existing queue, behind a pass
already running and ahead of the lane at its next unit boundary. On grant it
measures the build device again: if earlier cleanup met the target, it runs no
second cleanup. If still short, it frees only the remaining need. This avoids
duplicate work without another coalescing registry. It waits for the held pass
or unit to finish rather than subscribing to its progress or returning early
when that pass crosses the target.

One 60-second client budget covers setup, volume reads, daemon startup/contact,
queue wait and cleanup. Expiry or an ordinary error lets the build continue;
only real user cancellation propagates. A pending filesystem call cannot hold
the client past that budget or change its build baseline later. A queued request
that expires or is cancelled never starts cleanup. An executing request stops
at its existing safe unit boundaries and keeps ownership until that unit
settles; the client does not release its turn early.

There is no in-process fallback. Off mode starts no daemon and skips cleanup;
report mode does not delete. stimd's configuration governs the pass. The
protected build root, build-device scope and rungs 2-8 are preserved. The
independent hard-floor caller path and general maintenance claim remain until
that path also migrates to the owner.

Reason: a build already holds its slot while making room, so waiting for the
queue must share its cleanup budget. Rechecking after the turn is granted
observes prior cleanup without adding shared requests with different volume
targets and protected roots.

## Estimate and measurement

The estimate is the median of the project's ten newest positive records for that
platform in the last 30 days, matched by project key so a new worktree inherits
its project's history; without history, a default per project type and
platform. A build's size is the drop in free space on its volume between start
and end: two volume reads, no directory walk.

Maintainer decision: "If no build history can we still have a default headroom
value, maybe per project type", 2026-11-11.

Reason: the median keeps one inflated record, such as a build that ran beside
another, from pinning the estimate. The free-space drop needs two reads where a
size walk would visit every output file while the build holds its slot.

The median, the ten-record window and the free-space measurement were chosen
by the coordinator and the reviews of #5517, not by the maintainer.

## Links

- Issues: #5512, #5513, #6079. Pull request: #5517.
- Code: `packages/stim-cli/src/engine/build-headroom-run.ts`
  (`createBuildHeadroom`), `packages/stim-cli/src/engine/build-headroom.ts`,
  `packages/stim-cli/src/daemon/passes.ts` (`runLadderToFree`).
