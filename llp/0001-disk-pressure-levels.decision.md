# LLP 0001: Disk pressure levels and what each deletes

**Type:** Decision
**Status:** Active
**Systems:** Cleanup
**Author:** Janic Duplessis / Claude
**Date:** 2026-11-12
**Related:** LLP 0002, LLP 0003, LLP 0005

## Stim gc deletes by default

`stim gc` runs one automatic maintenance pass at the pressure level the machine
measures, and deletes. `--dry-run` reports and deletes nothing; `--pressure
<normal|high|critical>` replaces the measured level. There are no selectors for
what to delete: the level decides. The daemon and `stim gc` run the same passes.

Reason: one model of cleanup instead of two that drift apart, and a single
command that frees everything Stim can safely free when a disk is full.

Maintainer decision: "Lets redesign stim gc command by default with no args it
should do same as a maintenance run, add --dry-run flag for no deletion and
allow overriding pressure, lets remove the super convulted option that allows
specifying what to delete it should all be automatic based on pressure level",
2026-11-11.

Maintainer decision: "no need for replacement we will release 2.0 I tihnk so
can be breaking", 2026-11-11. The removed flags (`--delete`, `--cache`,
`--older-than`, `--worktrees`) are unknown options with no replacement hint.

## Levels and defaults

Free disk on any volume Stim writes to sets the level:

| Level    | Free disk under                       | Setting               | Default |
| -------- | ------------------------------------- | --------------------- | ------- |
| high     | the high level                        | `disk.minFreeGb`      | 40 GB   |
| critical | the critical level, or the hard floor | `disk.criticalFreeGb` | 20 GB   |
| refuse   | the hard floor, after the ladder ran  | `disk.hardFloorGb`    | 5 GB    |

Only the hard floor refuses a command (`start`, `ios` and `android` with
`STIM_LOW_DISK`). High and critical only reclaim, so their levels can be high
without stopping anyone's work.

Reason: a cold Xcode build can take a disk from 15 GB to 7.3 GB free in three
minutes, so a critical level of a few GB is reached only after the disk is
nearly full. The high level stays above critical so high always acts first.

Maintainer decision: "Ok I think 6gb is way too small for default considering
some projects can take several gbs (I guess headroom check will help, but maybe
raise to 20gb)", 2026-11-11, for `disk.criticalFreeGb`.

Maintainer decision: "40gb for high sounds good too", 2026-11-11, for
`disk.minFreeGb`. The 40 GB figure was proposed by the coordinator.

## Predictive disk cleanup

The daemon keeps five minutes of free-space readings per device in memory,
coalesced by minute. A filling volume still measured normal can request high
cleanup on that device toward `disk.minFreeGb + fill rate × lead time`. Lead
time is the last sweep's first measured positive free-space delta plus the
actual next tick interval (one minute active, five minutes quiet); before a
successful observation it is one tick. Flat or recovering volumes start none.
At least 60 seconds of elapsed samples are required; a wall-clock minute
boundary alone supplies no admission evidence. Forecasts expire after five
minutes, checked on grant and between resumed candidates. Predictive Cargo
retry clocks are per device and independent of measured-pressure clocks.
Measured pressure stays normal. Real pressure stops predictive work, then the
ordinary scheduler acquires the appropriate turn immediately. Prediction never
runs rung 9, changes build refusals, or replaces manual pressure policy.

Learning currently uses completed saved-output removals and Cargo pressure
trims. It pairs adjacent same-device free-space probes before a candidate
handoff, after its claims, child and locks settle. The first positive delta per
device/pass includes queue wait and probe time. Unknown devices, failed or
kept actions, pending trash estimates and another owner's later free space do
not train it. Uninstrumented cleanup can make the learned lead conservative.
Rates and timing disappear when the daemon exits or a volume disappears.

Status reports each volume's fill rate. Doctor reports an hour-long predictive
episode only after admitted cleanup and fresh measurements still below its
target; clearing the target or ending prediction resets that evidence. This
adds no timeout, refusal or setting.

## What each level deletes

Each level includes the ones below it.

- normal: the automatic maintenance plan (caps, the age sweep, orphans, stale
  records, finished linked worktrees after `gc.worktreeGraceMinutes`, unused
  simulator runtimes), and every workspace idle `idle.dormantDays` reduced to
  its minimal size.
- high: the pressure ladder, rungs 0 to 7; every Cargo `target/` on the
  volume loses its stale profiles and `incremental/` data (LLP 0005). The
  `node_modules` and Pods of linked worktrees idle an hour are reported by
  `stim gc`, not deleted (Rungs 5, 7 and 8 only report).
- critical: rungs 0 to 8 with shorter idle times and no grace, idle Cargo
  build units (LLP 0005), then rung 9, the caches of tools Stim does not own
  (LLP 0003).

Maintainer decision: "1 hour", 2026-11-11, for the idle time before a linked
worktree loses `node_modules` and Pods at high. Since #6025 it is the idle time
at which rung 5 reports them.

Maintainer decision: "make sure all things we can delete are actually deleted
at max pressure level", 2026-11-11. #6025 narrows it: the dependency and
worktree steps of the ladder only report.

## The ladder runs by yield

The ladder runs its rungs in this order: rung 0 (memory), rung 2 (parked
devices), rung 3 (Stim's shared caches, then the Cargo trims), rung 1 (the
build outputs of stopped workspaces), rungs 4, 6, 8 and 9, then the report
rungs 5 and 7 (Rungs 5, 7 and 8 only report). The rung numbers name the steps
and do not change. Each rung measures again before it starts and the ladder
stops once no volume is under pressure.

Rung 3 runs its Cargo trims even when its shared caches failed (a lock that did
not answer, a full disk), recording that failure as a failed action. It trims
the targets largest first, by the size the disk-usage cache records for each.
The size scan measures every registered target but only six discovered ones
per pass, and writes each size into the disk-usage cache, so a size survives
the later scans that measure other targets; the caps still plan from the scan's
own list. A target with no recorded size, or none newer than this process's
last attempt to trim it, follows in plan order, so a target the ladder tried
does not stay first. Before each trim the daemon's ladder measures that target's
volume again and skips the target once its volume is no longer short, since a
larger target's trim may have cleared it; a build's headroom run keeps its own
free-space target.

Rung 1 leaves out a checkout whose only output is a Cargo `target/`: rung 1
never deletes a `target/`, so reading the evidence of that checkout bought
nothing.

Reason: on 2026-11-19 a pass at high spent 327 s and then 132 s in rung 1's
evidence reads of 174 checkouts and took nothing. Rung 3 then spent 622 of its
727 s on three Cargo targets that freed nothing; about 47 GB of its 51.5 GB came
from three targets it reached in its last 86 s. Over 2026-11-16 to 2026-11-20
rungs 2 and 3 freed 3.8 and 245.9 GiB at 22.6 and 3.8 GiB per minute, and rung
1 freed 31 GiB at 0.25.

Maintainer decision: "I agree lets do this and ur recommendations from prev
messages, also lets do the changes now that u flagged as after 2.0 id rather
delay than ship what we have", 2026-11-20, on #6025, whose decided list
includes this order and leaving target-only checkouts out of rung 1.

Chosen by the implementer of #6025, not the maintainer: the rung numbers stay,
rung 4 stays after rung 1 because it needs the same evidence reads, an unsized
or already tried target goes after the sized ones, and the sizes persist in the
disk-usage cache rather than in the scan's list, so stale sizes never drive a
cap trim. The per-target volume check, the Cargo step's isolation from cache
failures and the persisted sizes followed the first review of #6029.

A summary table lives in `website/docs/maintenance.md` and the full one in
`stim guide cleanup`; this document records why the levels are shaped this
way, not the table.

## Pressure acts without waiting for measurement or load

While any volume is at high or critical, no cleanup step waits for a size
scan, a `du` of what it frees, or host load to drop. A step whose decision
needs no byte count (the Cargo `target/` trim, LLP 0005) plans from structure
and runs in the same ladder pass, after the shared caches of rung 3 (The ladder
runs by yield); a step that needs sizes measures them at once. The shared
caches at high are measured with one walk each, bounded at 120 s, and trimmed
to half their cap; each directory entry evicted is sized with a bounded walk
that does not block the event loop. A cache whose walk fails is kept with a
kept action. At critical the caches are emptied whatever their size, with no
walk of the cache or of any entry, and report 0 bytes freed.
A recorded size is not used to choose what to trim at high: a `stim gc`
running beside the daemon would evict against the same number. Host load
defers the size, idle, worktree and sweep checks only while every volume is at
normal. The walk itself keeps its protections (one at a time, the walk claim,
time limits, abort on handover). Walks above normal run at normal priority:
under the load that defers a walk at normal, a walk niced to 19 gets almost no
CPU, and the disk is what is short.

Reason: on 2026-11-14 a Mac spent an evening at high and critical, reached 0.2
GB free three times, and emptied Stim's own shared caches before it trimmed 40
GB of Cargo data it was allowed to remove. The Cargo trim was planned only by
the maintenance pass, which starts after the daemon tick's pressure ladder
(112 minutes that evening) and after the lane's dormant dependency step (69
minutes), so it waited 3 h 26 min from the previous Cargo measurement. Since
#6025 the shared caches again go before the Cargo trim, but within one pass:
Stim's caches free their bytes in seconds, and the trim follows in the same
pass instead of hours later.

Maintainer decision: "we def should not have to wait on full disk measurement
to be able to remove caches", 2026-11-14.

Maintainer decision: "Lets make sure that if disk space is low we do any needed
measurement right away since disk space is prio over cpu use", 2026-11-14.

Chosen by the coordinator, not the maintainer: the Cargo trim runs as the last
step of ladder rung 3, after the shared caches (The ladder runs by yield), at most every 10 minutes per level in the long-lived daemon (a build command's
ladder runs it once, and leaves its own workspace's `target/` alone), so a
checkout in use does not lose its `incremental/` data every tick; walks above
normal are not niced.

## A ladder pass that frees nothing waits

A pass frees something when one of its actions removed something it counted in
bytes. An action that freed no bytes, such as a Gradle stop, a parked simulator
shut down for memory, or a Cargo trim whose volume gained nothing because other
writers filled it meanwhile, does not count, and it does not drop the git reads
the rungs share. A cache emptied at critical reports 0 bytes, so a pass that
only emptied caches counts as freeing nothing and waits, at most a minute at
critical.

After a daemon ladder pass that freed nothing, the next pass waits four times
that pass's duration, at most 15 minutes, or at most one minute at critical. A
rise of the disk or the memory level, any measured volume that is new or reached
a higher level since that pass, a volume at high or critical that lost 256 MB, a
volume at normal that lost 1 GB, or a command that asks the daemon for a tick
(the hard floor) runs it at once. The idle and dormant stages still run on every
tick; a ladder pass runs inside the tick, so a long pass delays the next tick. A
build's headroom ladder and `stim gc` are not paced.

Reason: on a Linux worker held at critical by space Stim cannot free, 615 of 657
ladder passes in a day freed nothing, and the ladder ran about 53% of the wall
clock with a git spawn per checkout per rung, so stimd used 30 to 40% of a core
for days (#5933). At high, the factor keeps a pass that frees nothing under a
fifth of the time while the full four-times wait applies, that is for passes
under 225 seconds; past that the 15-minute cap holds, so the incident's
335-second pass below would run about 27% of the time at high. The cap bounds
how late a newly idle tree is taken, and the bypasses keep a disk that is
filling, or new memory pressure, from waiting. At critical the one-minute cap
lets the ladder rerun on every tick, so a pass longer than 15 seconds that frees
nothing can take more than a fifth of the time: a 335-second pass followed by a
one-minute wait runs about 85% of the time. A worker held at critical, the #5933
case, is back to that cost; the long wait covers a volume held at high.

On 2026-11-19 a MacBook filled to 121 MB free while native builds grew Cargo
targets past 20 GB (#6011). A ladder pass at high took 335 seconds and freed
nothing, almost all of it in rung 1. At 22:46 UTC stimd paced the next tick;
the tick after it ran the ladder, so pacing delayed the next pass by about one
tick. That pass spent 132 seconds in rung 1, then trimmed Cargo targets in rung
3 from 22:51; a trim failed with ENOSPC at 23:01 UTC, before the two targets
that freed 21.8 GB and 23.3 GB were reached. Most of the delay was pass
duration and trim order, not pacing; those are separate from this rule. The
bypasses still keep a filling disk from waiting a full pace: on a volume at high
or critical, a 256 MB drop since the last pass lets the next tick bypass the
remaining wait, a quarter of the 1 GB a volume at normal needs.

Chosen by the implementer of #6011, not the maintainer: critical keeps the wait
of four times the pass, capped at one minute, the daemon's tick. A build, boot
or test slot request or release asks stimd for a tick at once, and with no wait
a pass that freed nothing at critical would start again as soon as it ended.

Chosen by the implementers, not the maintainer: the 1 GB drop for a volume at
normal (#5939) and the 256 MB drop for a volume at high or critical (#6011).

Pacing on bytes is part of #6025's decision. On 2026-11-19, on a build with
pacing, passes whose only actions freed 0 bytes or 2 KB let the next pass start
at once, three times in under an hour. Chosen by the implementer of #6025, not
the maintainer: any byte counts, and a pass under memory pressure alone that
only stopped processes is paced too; its rungs take seconds, so its wait is
about a tick, and a memory level that rises still runs the ladder at once.

Maintainer decision: "Good for both points", 2026-11-18, in answer to whether
a wait of up to 15 minutes after a pass that freed nothing is acceptable, given
that disk space comes before CPU use (#5933, pull request #5939).

Maintainer decision: "lets do both", 2026-11-20, in answer to whether to keep
both the critical-pressure bypass and the falling-free-space bypass of the
ladder's pacing wait
([#6011 comment](https://github.com/appandflow/stim/issues/6011#issuecomment-7031008184)).

## Rungs 5, 7 and 8 only report

Rung 5 (the `node_modules` and Pods of idle linked worktrees), rung 7
(finished worktrees) and the first step of rung 8 (the `node_modules` and Pods
of idle main checkouts) delete nothing. Each records, as a `kept` action, what
it would have taken, what that would free when the size is known, and why. Rung
8 itself, device recordings and archived history, still acts; rung 5 runs the
main checkout report after its own. Rungs 5 and 7 run last, after rung 9. Only
`stim gc` and `stim gc --dry-run` run them, each time, at critical too. The
stim-daemon's ladder passes and the ladder a command runs, a build's headroom
run included, never run them. The
pressure path neither samples hard links nor checks dependency trees for hand
edits; the dormant steps still do both before they delete. The dormant steps,
`stim worktree remove` and the worktree check of the maintenance pass are what
delete dependencies and worktrees.

Reason: over 2026-11-16 to 2026-11-20 on the maintainer's MacBook, rungs 5, 7
and 8 took 30,179 s, 71% of all rung time, and freed 1.3 GiB, 0.4% of the
bytes. Rung 5 ran 758 actions and kept every one; 79% of its time was its
evidence loop over every checkout.

Maintainer decision: "I agree lets do this and ur recommendations from prev
messages, also lets do the changes now that u flagged as after 2.0 id rather
delay than ship what we have", 2026-11-20, on #6025, whose decided list makes
rungs 5, 7 and 8 report-only and drops hard-link sampling and dependency-edit
detection from the pressure path.

Maintainer decision: "Remove from daemon", 2026-11-20, on #6063, choosing to
remove the report-only rungs from the stim-daemon while `stim gc --dry-run`
still reports their rows.

Chosen by the coordinator of #6025, after the first review of #6029, not the
maintainer: run them last, and keep them in `stim gc`, where a person asked for
the report.

## One task runs every gc deletion

The stim-daemon runs its gc deletions in one task, the passes thread, one at a
time: the disk rungs of each ladder pass, the dormant step (the hourly
reduction of workspaces idle `idle.dormantDays`, One idle day reduces a
workspace) and the automatic maintenance pass. They take turns on one queue,
so none ever runs beside another.

- The tick on the main thread keeps measurement, the idle and dormant stages,
  the rungs that relieve memory (rung 0 and the daemon stops of rung 6) and
  boot reclaim. For the disk rungs it asks the passes thread for a disk pass
  and waits for its result, which pacing and the snapshot use as before.
- The dormant step and the maintenance pass run in units: one checkout's
  reads, each size walk or removal of the dormant outputs, the ranking, one dependency deletion, one
  maintenance check, each size walk of the size check, the plan, one plan
  action (each entry, for a cache trim), or one source checkout's trees. Walks that run side by side hand the turn over once and each waits
  until the lane has it back. Between units a waiting disk pass goes
  first, a hard-floor pass ahead of any other, and the lane then continues
  from where it was. Each deletion still checks its candidate again under its
  workspace's claims right before it acts, so a pass in between cannot leave
  it acting on a stale reading.
- A disk pass therefore waits at most one unit. The longest units are one
  size walk of the maintenance pass, bounded at 120 s, one deletion of a
  dormant `target/` or dependency tree, and the maintenance plan.
- The disk pass measures again before each rung, so a level that fell while
  it waited takes only what the new level needs.
- An acting `stim gc` and the API's `collectGarbage` ask the queue for a gc
  pass (Every gc joins a pass under way). Critical ranks ahead of high, and both
  take the turn at the lane's next unit boundary. Normal gc shares the lane's
  rank and does not cause it to yield. Raising or measuring a queued pass
  changes its rank to its level. Headroom takes the high rank and rechecks its
  volume target on grant (LLP 0006); hard floor ranks ahead of critical.
- Each ticket owns its release and pending handoff. Concurrent boundaries of
  one ticket share that handoff; a different ticket has its own. A resumption
  keeps the granted owner ahead of waiting peers at its rank; new and reranked
  tickets queue after equal peers. Releasing an old ticket
  cannot release the current owner. Pass identity, listeners and results stay
  with the ticket while it waits, and are current again when it resumes.
  A cancelled queued request withdraws its own ticket; a cancelled executing
  pass keeps ownership through its current work and observes cancellation
  after regrant. The covering pass recreates the reserve when it still owns
  the turn or the queue is idle, never while another ticket owns the turn.
- Stopped output marks yield between individual saved paths, after each
  workspace claim and removal has settled. Cargo pressure trims yield between
  targets, after their profile locks close. Tick, manual and headroom callers
  pass their own ticket boundary; manual dormant cleanup uses its existing
  boundary outside workspace claims. A resumed candidate checks cancellation,
  current pressure or the build's free-space target, device scope and current
  in-use or pin protection before removal. Explicit forced runs retain their
  selected level; read-only previews do not hand off a disk turn.
  Keeping one saved output updates only its candidate's keep hint. Current
  mark fields and sibling candidates stay intact. Active-workspace stopping
  and finer units inside a whole manual workspace action remain separate from
  these candidate families (#6101); candidate ranking is #6111.
  A resumed saved output needs its current exact registry key or one targeted
  discovery proof. A rewritten registry alias with no current discovery route
  stays kept rather than resolving every registered root again per path.
- Other acting ladder units hand off after a whole parked-device operation,
  shared-cache trim or empty, rung 6 planned action, history action group, or
  tool-cache plan has returned. The next operation checks cancellation and
  current volume eligibility after reacquiring its turn; existing pressure
  checks still decide whether to continue. Critical parked-device cleanup
  retains its all-parked policy, and explicit unmeasured force retains its
  all-volume scope. Atomic-cache claims, native children and their final
  accounting stay within a unit, as do grouped recordings, archives and
  multi-path tool commands. No nested lock or claim is suspended by these
  outer-action boundaries.
  The final tool cleanup hands off before inventory/reporting. Acting tool
  cleanup measures its selected cache after reacquisition for its own credit;
  surveyed ordering and read-only measurement stay unchanged.
- An owned rung 0 pass hands off between parked and deferred simulator
  shutdowns and after the final group. Native shutdown, pool ownership and
  deferred-marker changes settle first. The next helper rechecks current
  parked ownership or the exact deferral and workspace use. A pre-handoff
  stopped/absent native listing cannot clear a deferral: the owned pass keeps
  that marker for a later fresh-inventory tick. Ordinary tick
  maintenance supplies no disk callback; forced selection stays unchanged.
- Rung 4's pressure ladder hands off between whole dormant workspaces and
  before leaving the rung. Acting admission refreshes the exact registration
  and device-volume gate; the existing claimed stage checks idle/activity and
  pins again, using current measured urgency unless explicitly forced. A
  resumed owned action keeps an already-completed dormant record under the
  workspace claim. All devices and logs of one workspace remain under that stage's
  claim. The ordinary activity pass and finer in-claim loops stay separate.
  Read-only passes neither yield nor refresh their captured project selection.
- The maintenance pass gives up the turn once it deletes nothing more, before
  its discovery scan and census.
- When the passes thread ends, a disk pass it had not answered fails as
  unverified cleanup, as a job of that thread does: a child it started may
  still run. A disk pass whose cleanup refusal names one child crosses with
  that child, which stimd watches as it does one of the tick's. An abort of
  the passes thread reaches a disk pass as well as the lane's job.
- The ladder's clocks live as long as stimd, like the dormant step's: rung 9's
  hourly limit, each level's 10-minute Cargo trim limit and each report rung's
  hourly limit. A new passes thread does not run them again early.

The fingerprint precompute deletes nothing and runs beside a disk pass. The
idle stage's output deletion and the dormant stage's device and archive work
stay in the tick, inside flows that also stop dev servers and devices and
hold workspace claims. A build's headroom ladder takes its own high-rank turn there and rechecks the
build device's target before acting (LLP 0006). Workspace and Cargo claims stay. The API's `deleteGarbageItem` sends an explicit item to the same queue,
after pressure passes and before the lane's next unit. Every item has its own
turn and result, even when two requests name the same item; none joins a pass.
It starts stimd under `off` and acts under `report`, as an explicit request.
An item cancellation or report timeout stops that item; it never detaches as a
whole-pass report timeout does. The caller waits for terminal cleanup, and a
cleanup refusal takes precedence over cancellation or timeout. Completed actions
remain applied. Progress is notification delivered over IPC; an announced or
in-flight action may complete before stimd receives a callback cancellation.

An item and the lane take no outer maintenance claim. The disk turn excludes
this daemon's cleanup units. The worker's report tracks its children and pending work
until cleanup settles, and its existing per-object claims remain unchanged.
An older in-process cleanup may therefore overlap removal of a regenerable
cache that has no per-cache claim; that may repeat work or require a rebuild.
The queue serializes this stimd's cleanup, and workspace, Cargo, archive and
atomic-cache ownership protections still apply.

Reason: on 2026-11-19 the lane's dormant step ran for 49 minutes beside both
slow rung 1 passes and rung 3, walking the same 171 checkouts with its own
`ps`, `lsof`, `git` and `du`, in another thread that shares no caches with the
ladder. One owner and one queue keep them apart with no turn shared across
threads.

Maintainer decision: "Like everything gc related should run in same task ro
avoid concurrency problems", 2026-11-20. The units, the hard-floor priority
and keeping the idle and dormant stages in the tick are the coordinator's and
implementer's reading of it on #6029.

## Explicit cache and archive items can return before removal

An explicit `deleteGarbageItem` for a shared cache or archive moves eligible
content into a typed, exclusively claimed entry under `$STIM_HOME/trash` on
the same filesystem. Only selected directory trees move; regular files are
unlinked in place. It returns `pending` with an estimated byte count once
the move has completed. Pending bytes are not reclaimed bytes. Status exposes
their count and estimate in `maintenance.pendingDelete`; Desktop labels them
pending until physical removal.

Cache selection is unchanged: entry-depth, age and directory protections still
apply, the cache root stays, and atomic caches retain their exterior exclusive
claim while entries move. Archives move under the archive lock; a selected
part clears only that part's bytes and expiry. Recovery completes a part's
metadata update if the process ended between its move and that update.

The worker queues a short-lived trash drain after a successful handoff, ahead
of the maintenance lane and behind explicit items, or at pressure-pass
priority when the latest measurement is critical. The drain owns its child
and claim independently of the requester's cancellation. An off-mode daemon
stays up until the admitted drain settles. A later daemon discovers typed
pending entries at startup and queues their drain. Unverified ownership keeps
an entry. Unsupported moves, including Windows and another filesystem, retain
the existing in-place deletion; report-only caches remain untouched. No Cargo
target or automatic pressure sweep uses this handoff.

Doctor reports the oldest verified typed payload queued for more than 24 hours.
It reuses the pending manifest inventory with bounded asynchronous metadata
reads, without walking payloads, changing estimated pending totals or deleting
anything. Diagnostics check regular manifests at most 64 KiB before opening;
these are ordinary atomic typed records, not foreign concurrently rewritten
files. Malformed, foreign, linked and missing evidence supplies no stale claim.
A later deadline retains a previously verified stale payload with partial
coverage. Caller cancellation still propagates. After rendering and recording
its run, the doctor CLI uses the existing pending-read exit path so an unanswered
native read cannot keep the command alive.

This implements the lazy-free part of the cleanup redesign in #6025 and #6089.

## Queue ownership replaces the maintenance claim

The maintenance lane no longer takes `maintenance/run.claims`. Items, GC
passes, headroom and the lane all use the same disk owner. Workspace, Cargo,
archive and cache claims remain; unverified child cleanup still reaches the
worker's existing cleanup watch (LLP 0007).

`maintenance.running` is the active disk turn's start and trigger;
`maintenance.queued` counts the waiting units, including a lane waiting to
regain its turn. The worker publishes changes through the owning daemon's
claim details, so status works before that daemon completes its first tick.
Only a live shared daemon holder supplies queue state. There is no separate
maintenance claim or unresolved maintenance-claim status.

The hard-floor gate asks for the existing requested daemon tick, whose disk
pass has the hard-floor rank. An unavailable daemon runs no inline ladder;
the gate remeasures and retains its existing `STIM_LOW_DISK` refusal when
still below the floor. Off mode skips that cleanup and report mode deletes
nothing, as before. The build's headroom run remains on its own high-rank
queue turn (LLP 0006), never a new refusal.

This removes the last command-side fallback without adding a cross-build
compatibility claim. Normal installed clients route to the selected engine;
a deliberately run prequeue copy can still clean locally, so that copy must
be updated before sharing a home with the queue owner (RELEASE.md,
Compatibility and breaking changes).

## Every gc joins a pass under way

An acting `stim gc` and the API's `collectGarbage` send one `gc.run` request
to this home's stimd and run nothing in their own process; `gc --dry-run` and
`previewGarbage` stay there, since they only read. The request starts a stimd
whatever `daemon.mode` says, as Metro does; under `off` that stimd serves the
request as a command it runs and exits after it. With no stimd the request
fails with `STIM_DAEMON_UNAVAILABLE`. stimd's config and environment apply to
the pass, not the caller's `STIM_*` overrides; the caller's working directory
travels, so the pass never takes the caller's own workspace. A request that
joins a pass is protected by that pass's working directory, not its own.

- A request with no level, or a level at or below that of the pass running or
  queued on the passes thread, joins it: the running pass first, then the
  lane's acting maintenance pass, which counts as normal, then the queued one.
  The running pass is another gc pass or the tick's acting disk pass, which
  frees only the volumes under pressure. The maintenance pass runs only the
  checks due then. The joined result names the pass's start, trigger and
  level.
- A queued gc pass joins the first pass that starts, or measures its level,
  at or above the queued level before the queued pass takes its turn: the
  lane's maintenance pass, the tick's disk pass or the running gc pass. Its
  requests then wait for that pass and receive its result.
- A request for a higher level raises the queued gc pass to it, or queues one
  when none waits. At most one gc pass waits. A requester that leaves before
  execution withdraws its level too; the queued level and rank come from the
  remaining requesters. An executing pass keeps its level.
- A request that leaves (an interrupted gc, a cancelled call) stops its pass
  only when no other request waits for it; completed actions stay. The API's
  report budget detaches instead: the client tells stimd before it closes its
  socket, and the pass goes on after the caller exits. stimd stays up for a
  gc request until its pass settles, also under `daemon.mode` off, and does
  not switch engines under one.
- A stimd that stops during the pass fails the request with the remedy to run
  it again (LLP 0012, A command does not continue across a stimd restart).

The caller releases the maintenance disk reserve before starting or contacting
stimd and restores it if startup, hello or cancellation fails before the
request is sent. After transmission the executed or covering pass restores
it when that pass settles, including after a caller detaches. A daemon lost
or refusing the request after transmission may leave the reserve absent until
the next pass. The reserve is rebuildable; the protocol has no ownership
acknowledgement solely to cover that narrow gap.

Reason: one queue for every cleanup, so a gc and the daemon never repeat each
other's work on the same disk.

Maintainer decision: "I would like every cleanup to use the same queue,
including stim gc calls.", 2026-11-20 (#6058).

Maintainer decision: "It should avoid duplicate work too like if gc runs while
maintenance is ongoing I dont think we need to run it twice as long as it is
for same pressure lvl (no flag passed or same value as current run)",
2026-11-20 (#6058).

Maintainer decision: "Always join same level" (a forced `--pressure` level
joins a pass at that level), 2026-11-20 (#6058).

Maintainer decision: "Accept, stimd's config wins", 2026-11-20 (#6058).

A lower level joins and a higher level queues one pass: the coordinator's
plan on #6058. That a request leaving stops only a pass it alone waits for is
the implementer's reading on #6058. That the lane's maintenance pass is one a
request at normal joins, while its dormant step is not, and the ranks above,
are the reviewer's and implementer's reading of the second quote on #6061.

## The lane marks what each checkout could free

The dormant step's hourly walk of registered workspaces and discovered
checkouts at `idle.dormantDays` writes one mark per checkout it reads, inside that checkout's unit, to
`$STIM_HOME/gc/marks/<hash>.json`, keyed by the canonical root. A mark holds
the outputs rung 1 lists there, with each Cargo `target/` as its own kind and
sizes from the disk-usage cache; the mark starts no size walk. It skips rung
1's in-use reads, so it takes no process listing and reads no other checkout:
a Cargo `target/` another process uses and a Metro store a running dev server
shares stay candidates, and a sweep reads them fresh before it deletes. It
also holds the newest activity the walk read, and the walk reads at
`idle.dormantDays`, not at rung 1's 2-minute threshold:

- A checkout with something running records that as the keep reason on each
  candidate.
- A checkout idle past `idle.dormantDays` has its full reading, and a keep
  reason on each candidate when something other than activity keeps it
  (`maintenance.keep`, `idle.minutes` 0, unreadable evidence).
- A newer checkout records the newest activity read, or only its last Stim
  command when one ran within `idle.dormantDays`, which is a lower bound. Its
  settings are not read. A sweep reads activity and keeps again before it
  deletes.
- A mark is rebuildable: an unknown version or a file that does not parse
  reads as absent and the next walk rewrites it, so deleting the folder is
  safe. It is written with a temporary file and a rename.
- A successful owned Git worktree removal retires that root's validated saved
  marks, including the authorized original removal spelling and currently
  locked registry spellings whose native identity equals that exact Git root,
  captured before removal. Nested and unrelated
  roots are not included. Retirement runs before any later branch cleanup. Unlink is best
  effort; source-only reclamation, failed removal and uncertain missing or
  offline roots do not retire marks. An in-flight mark writer can republish
  this rebuildable record after retirement; its later sweep still requires
  current scope, root and device proof. Retirement adds no lock or tombstone.
- A `dirtyAt` newer than the start of the checkout's reads stays, so a
  change seen while the walk read the checkout is not lost.
- Output rung 1 sweeps the recorded output paths, without a new candidate
  discovery. It rechecks current idleness, settings, devices, process/claim
  protections, worktree locks, output recognition and Metro sharing before
  deletion; the mark's activity is a lower bound, never permission to delete.
  Registered marks need no discovery topology read. Unregistered marks use
  the existing discovery policy with a required target set: only those roots
  and their repository sources are considered as children. It lists no
  sibling-parent folder and does no full discovery or source walk. Current
  git worktree membership and sibling/explicit-root recognition decide scope;
  scan-only marks stay pending the targeted sentinel proof in #6093. Native
  identity is used for both targets and registered coverage. Repository Git
  commands have 3-second deadlines and bypass per-worktree path-cache probes;
  filesystem identity reads share the single outstanding-read slot. An
  unresolved route keeps the mark. Canonical root/output paths
  and their own recorded devices must still match. Each candidate records
  its device separately: an external checkout can have Stim outputs on the
  internal disk. Version 2 marks add that field; older marks are absent.
  An unreadable check keeps the outputs and records the reason on the mark.
- High pressure tries existing output marks first. Only while still short does
  it discover roots, refresh missing or expired marks with current checkout
  readings, and sweep successful refreshes. Critical and hard-floor output
  sweeps never refresh marks, and leave unmarked outputs alone. An unforced
  high sweep checks the latest disk level before refreshing, so a transition
  to critical skips the refresh. Daemon report mode uses known marks without
  deleting or updating them; explicit dry runs retain discovery previews.
- The automatic normal dormant pass uses its due-refreshed marks for
  non-Cargo build-output candidates instead of enumerating those outputs
  again. Missing, due or uncertain saved evidence keeps that family's outputs.
  Only selected checkouts read marks, at their disk-turn boundaries; an
  inaccessible unrelated registration does not stop healthy normal work.
  Current root and output identities/devices, scope, recognition and Git
  protections are checked before measurement and under the existing native-run
  and metro-start claims, together with the full current idle/pin/use checks.
  The current mark's due state and candidate device are checked again there,
  including after measurement or a yield.
  A saved path whose recognition changed stays without finding a replacement.
  The shared normal checkout/dependency inventory, normal Cargo discovery and
  policy, whole-worktree removal and explicit discovery previews are unchanged.
  A removal exception remains a failed rung, as before; accounting for bytes
  removed before a later removal failed is an existing separate limitation. Registered
  roots without marks are reported; unmarked discovered roots are not listed
  during a critical sweep.
- A mark is due after 10 minutes for activity under a day old, hourly for idle
  checkouts, and daily after `idle.dormantDays`. Dirtiness brings the interval
  to 10 minutes, never sooner. Unknown activity uses the 10-minute interval.
  These constants implement the approved generation policy; this selector is
  brought forward so high-pressure refresh does not invent a temporary TTL.
  The normal lane still walks hourly and publishes due marks. At normal
  pressure, a separate tracked worker request refreshes due known or cached
  census roots without discovery. Each complete root read holds one rank-6
  read-only disk ticket and has a three-second budget; it changes no reserve.
  High/headroom, critical and hard-floor work cancel only that mark operation
  and wait for its cleanup before taking ownership. An unanswered root leaves
  one in-memory position so the next batch starts after it. Ordinary lane and explicit
  item work wait for the bounded root. Off mode and shutdown cancel the request.
  When resolving a root returns ENOENT, the worker retries that root after
  ten minutes. The delay lives in memory and grants no cleanup authority.
  Fresh same-config history evidence preserves a Cargo-only holder's previously
  authorized nested targets and provenance; stale or changed evidence is dropped.
- The passes worker's existing history batch also observes mark freshness.
  Mark files are read once through bounded asynchronous reads and the same
  parser and scope policy the sweep uses. Invalid legacy or torn records
  still contribute no sweep candidate, and make diagnostic coverage partial.
  Missing, failed or timed-out inventory is unavailable, never a zero count.
  The owning daemon saves a small aggregate and at most five positively scoped
  overdue roots in its existing snapshot. `stim doctor` warns for those marks
  only when they were more than twice the effective generation interval old at
  the observation time. The interval follows the due-only writer policy in on
  mode; report mode retains its hourly normal-walk floor. Partial coverage omits totals. Definite
  exclusions when discovery has no routes do not make coverage partial.
  Other unproved routes remain conservative and omit totals. An observation older
  than the daemon's existing three-interval late-tick limit is unavailable.
  Reporting starts no discovery or size walk on the socket or doctor path.
  The same authorized batch optionally publishes saved-candidate coverage for
  outputs, dependencies and worktrees, deduplicated by kind and stored path.
  It reports cached known bytes, unknown-size counts and each subtype's own
  oldest generation, including a verified empty observation. Worktree sizes
  remain unknown when their producer saved no bytes. Missing subtype evidence
  is unavailable or partial; partial counters describe only verified saved
  identities and omit an empty total. Read coverage describes the saved file
  inventory, not never-marked filesystem roots. These counts and estimates are
  neither current deletion eligibility nor reclaimed bytes. Publication adds
  no path probes, discovery, sizing or ordinary status reads.
- The writer also recognizes untagged Cargo targets by the existing Cargo
  manifest/profile rules and marks targets in the holder's `apps/` and
  `packages/` children. The normal lane reads actual Git holders reached by
  its artifact scanner and publishes their own marks. A registered app's
  current buffered Git worktree metadata can authorize its exact holder's
  Cargo candidates, without authorizing the holder's other outputs. The
  helper may watch that holder; a watch grants no deletion authority. A holder
  reached through a recognized discovered nested app saves that app path in
  its existing mark. A targeted read must still prove the app’s current
  discovery route and current exact Git holder before authorizing only Cargo
  candidates whose parent still belongs to that exact Git holder. Independent
  nested checkouts stay outside this authority. Removed routes, missing apps
  and changed holders keep the target; old marks keep their existing scope
  behavior.
- Both Cargo pressure entrypoints consume saved target candidates. The
  planner and executor share the same action object in one isolate; its
  private mark proof is not serialized. A copied pressure action is kept.
  Execution rechecks the saved generation, current scope, target ownership,
  canonical root/target paths and devices before using the existing Cargo
  admission, process reads and locked remover. Planning authorizes one saved
  batch; execution reauthorizes only the selected root. Rewriting the mark makes an
  earlier action stale. Failed safety reads keep the target. High pressure
  tries known targets before refreshing due or missing marks while still
  high; critical and hard-floor pressure never refresh or rediscover Cargo
  targets. Unmarked targets stay. Acting size/cap passes use normal rules
  even under pressure, so measured sizes cannot bypass the saved pressure
  candidates; explicit read-only previews retain their pressure policy. The
  existing normal sizing, cap selection and scheduling remain unchanged.
  A build-headroom deadline cancels the same bounded Cargo refresh and
  leaves later holders and the next sweep unstarted; failed cleanup still
  propagates.
- The normal dependency phases save their raw linked/source inventories in an
  optional section of the existing mark, including younger checkouts that
  the normal dormant thresholds keep. Each enabled phase reuses its current
  discovered roots and inventory; disabling both normal thresholds starts
  neither discovery nor inventory. Dependency observations have their own
  timestamp. Output-only refreshes preserve that timestamp and any newer
  shared dirty watermark; dependency-only writes preserve the output
  generation. Missing or malformed optional evidence leaves output marks
  valid and dependency eligibility unknown.
- The acting normal dependency phases select their saved dependency
  generation inside the existing current Git-holder inventory. A missing or
  due subtype gets the existing complete inventory and publication first;
  failed publication keeps it. A fresh subtype supplies only its saved paths
  that remain fixed dependency locations of the current holder and keys.
  Partial saved selections never replace a complete generation. Scope,
  membership, path/device, current generation and dormant settings are checked
  before ranking and again through the existing claimed deletion recheck.
  Existing process, activity, tracked-file, pin, lock, install-edit and size
  protections remain. Source eligibility starts from saved paths rather than
  probing for new trees; missing or due observations go through full normal
  collection before selection. Source grouping, current linked-worktree sharing,
  copied-from activity and exclusive warm claims remain required. Explicit
  previews keep their existing collection path.
- Acting pressure dependency reports use saved candidates, cached estimates
  and targeted current scope, membership, path/device, Git role/lock,
  pin, activity and warm checks. They discover no dependency candidates,
  measure no new sizes and delete nothing. Missing, due or dirty evidence
  is reported as unknown. For a validated source dependency, the current Git
  worktree list supplies fixed matching dependency-link locations. A current
  direct link into that saved path reports its borrower. One supervised Node
  query uses native canonical paths, with a three-second command timeout and
  at most 64 total candidate–borrower locations per source; its JSON input is capped at 64 KiB.
  No recursive listing or size walk runs, and an optional stalled lookup does
  not occupy the passes isolate's shared filesystem-read slot. A negative, changed, deeper, inaccessible or timed-out
  link remains sharing-unknown, never evidence that the source is unshared.
  Explicit read-only dry runs retain discovery previews.
  Normal dependency deletion and its thresholds are unchanged.
- The scheduled normal worktree inventory also publishes an optional section,
  preserving actual clean/dirty facts separately from archive eligibility,
  HEAD/source identity, finish and activity times, exact last Stim use and
  its existing keep verdict. It writes no mark in a read-only preview.
  Newly observed Git activity or a finish event can select the worktree
  section's active cadence without advancing output or dependency stamps.
  All represented sections retain their independent dirty watermark.
- Acting rung 7 reports saved worktrees only. It preserves finished-worktree
  grace, the empty-branch activity floor, and the optional pushed-idle policy,
  then rechecks selected worktrees with current local/cached Git, scope,
  path/device, pin and claim facts and one shared device/agent inventory.
  Automatic-only roots, custom ignored paths, hidden/sparse index flags and
  current Pod churn stay uncertain where proving removal would need a
  dependency or filesystem walk. Pressure performs no such walks, full
  worktree collection, fetch or pull-request refresh. Missing, due,
  dirty or uncertain evidence stays explicitly unknown. Normal removal and
  its archive and final-lock safeguards are unchanged.
- The acting normal worktree planner uses a fresh clean finished observation
  as a shortlist for the existing current reconciliation, reusing its current
  branch-status read. Dirty or unknown status, empty branches and opted-in
  pushed-idle cleanup retain their existing planner path. A fresh clean
  unfinished observation with unchanged HEAD and membership defers external
  completion until refresh. Omitted roots never publish partial generations.
  Missing or due observations use the complete current producer first;
  failed publication keeps a clean finished removal. Current saved scope,
  generation, identity/device and membership are checked under the existing
  removal claims in addition to the independent deletion, archive, grace,
  edit, pin and in-use safeguards. Saved data grants no merge or archive authority.
- Normal mark-first
  scheduling, per-candidate disk-turn yielding and yield ranking remain
  pending. The no-discovery guarantee applies to output rung 1 and Cargo
  pressure candidate selection and saved dependency/worktree reports, not the other maintenance stages or normal
  size/cap passes. `stim gc --dry-run` retains discovery previews.

Reason: planning dominates a pressure pass (rung 5's evidence loop took about
13,300 s for 0 bytes on the loaded MacBook), and every pass repeats the
walk the lane already made. Marks let a later sweep recheck and delete
without planning again.

Maintainer decision: "I really like all 6 points lets do them all!",
2026-11-20, #6059. The generation constants and pressure ordering are the
coordinator-approved design applied in #6081. Point 1 of the six is the split between a background
mark and a sweep that only rechecks and deletes.

Mark-only asynchronous layout reads, canonical-root reads and root-device reads
share the census reader's outstanding-read slot and a 3 second deadline per
checkout. A timeout or cancellation publishes no mark and retains the previous
complete one. A late native read cannot publish its result. Node's synchronous
filesystem calls inside the output checks (including regenerable-directory
metadata checks and the Metro package-name read) remain noninterruptible, so
this is an asynchronous-read deadline, not a hard bound on the whole mark.

## Saved candidate order

Rung and substep order stay unchanged. Within the stopped-output family,
individual saved paths go in descending cached-byte order, with kept paths
last. A known zero comes before an unknown size; ties and unknowns retain
input order. The bytes remain approximate yield hints, not exact space freed
or permission to delete. Ordering starts no size walk. Per-path output
actions name the saved folder in `target` and the checkout in `workspace`;
other action families and grouped workspace maintenance actions keep their
existing target meaning.

A candidate actually evaluated and refused gains a keep reason on its exact
kind and path until its checkout is marked again. Pressure clearing and a
healthy volume exclude candidates from that pass without a keep hint. The
synchronous keep update preserves the current mark generation, dirty time
and siblings. Mark-based read-only reports use the same saved order and current refusal
evidence without writing keep hints. Explicit force dry-runs keep their fresh,
grouped preview semantics.

Cargo pressure planning uses its existing saved-size order at every
entrypoint, with individual keep hints last. A cached measurement from before
an acting pressure trim attempt stays unknown until a newer measurement
exists. Sorting preserves the original action objects and their private
saved-mark proof. A newly read mark replaces old keep hints; the existing
per-candidate safety, lock and volume rechecks still decide whether to act.

## Each rung frees only the volumes under pressure

While disk sets the level, a rung deletes an item only when the path it will
delete lies on a volume under `disk.minFreeGb`, measured at the start of the
rung; a path or device that cannot be resolved is kept (invariant 8). The path is the one
deleted, not the workspace it belongs to: each build output, each owned or
parked device's data folder (the simulator's data path, or the AVD folders under
the storage roots its deletion searches), each cache and Cargo `target/`, each
`node_modules` or Pods tree, each worktree, and the roots of rung 6's Gradle
versions, TMPDIR leftovers and trash. A dormant workspace is taken only when
its Stim workspace folder, whose logs it archives, or an owned device's data
lies on such a volume, and loses only the devices there. Rung 8 and rung 9 take an item only on a volume
under the critical level (LLP 0003). Under pressure from disk alone, the
activity pass, which then stops a workspace at `idle.minutes`, deletes only
the outputs on such a volume of a workspace with its checkout or Stim
workspace folder there, and all outputs of any other; memory pressure idles
every workspace and deletes all its outputs. The ladder a build runs for its
headroom (LLP 0006) plans its Cargo trim at high and treats only the build's
volume as short. The Gradle, Kotlin and watchman stops relieve memory and are
not gated. `stim gc --pressure` treats every volume as short; `stim gc` at the
measured level is gated, its idle pass included.

Reason: free disk on any volume sets the level, but deleting on a healthy volume
frees nothing where space is needed. A project on an external disk under the
high level made every tick clear the `node_modules`, outputs and caches of the
internal disk, and the level never cleared (#5877).

Chosen by the 2.0 reliability review and the fix for #5877, not by the
maintainer, following the reason LLP 0003 gives for rung 9.

## The 2-minute idle stop is for memory

The idle stage stops a workspace's dev server and shuts down its owned devices
after 2 minutes without activity, instead of `idle.minutes`, only while the
memory level is high or critical. Disk pressure alone leaves the idle stage at
`idle.minutes`, in the stim-daemon and in `stim gc`, a forced `--pressure` run
included: the 2-minute stop needs memory measured above normal, and otherwise
the idle pass still runs at `idle.minutes`.

- Disk pressure keeps the 10-minute activity window of an agent-device command,
  in the stim-daemon and a measured `stim gc` for a workspace on a short
  volume, in a forced `--pressure` run for every workspace. Only the threshold
  for other inactivity stays `idle.minutes`.
- The ladder's rungs keep needing nothing of a workspace running. Under disk
  pressure alone a running workspace reaches them once the idle stage has
  stopped it at `idle.minutes`.
- Memory pressure keeps the 2-minute idle stage, rung 0, the end of deferred
  shutdowns and of the booted grace.

Reason: a stop frees memory, not disk. Over three days on the maintainer's
MacBook, 50 stops ran on the 2-minute clock, all from disk pressure alone; 31
freed nothing, 3 freed build outputs whose deletion did not need the stop, and
16 let a later rung delete the simulator a few minutes before the 15-minute
stop would have (#5998).

Maintainer decision: "I feel like we maybe too agressively stop metro / sims
on low disk, those are more RAM based I think no? Unless we need to stop the
worktree in order to free disk space maybe we should only stop fast on low
RAM?", then "lets do all 4", 2026-11-19.

## The folders a build wrote are measured by the daemon

When a local native compile ends, whether it succeeded, failed or was cancelled,
the command writes a marker naming the project root it already holds, with no
read of the workspace. Every 30 seconds stimd starts its measure thread when
markers exist and no measure job runs. The job walks only for a root this Stim
home has registered whose bounded canonical path is still the marker's root (a
difference of case alone counts as the same root on macOS and Windows only when
the root itself is a real directory, not a link), and
drops a marker for any other root, an unreadable marker file, or a marker over
an hour old, without a read inside that root. A workspace layout that cannot be
read keeps the marker and measures nothing for that root. An expired marker is
dropped, and those folders are measured again at the next build end or when
`stim gc` reports; the hourly size scan refreshes only the Cargo `target/` sizes
it measures (The ladder runs by yield). The disk-usage cache is keyed by the exact path string, so each folder is
walked and keyed as the gc worktree report spells it, the registered root joined
with the name as enumerated; the canonical path only bounds what may be walked. A
case-only redirect through a replaced ancestor on a case-sensitive volume is not
detected and only changes which folder's size is shown. A Windows 8.3 short-name root
differs by more than case, so that workspace gets no build-end measurement. For a known root it walks the build output folders the gc
worktree report measures (inside the workspace, a Cargo `target/` included) and
the Stim workspace folder, through the disk-usage cache with the cache bypassed,
then removes the markers it listed before the walk. A build that ended meanwhile
leaves a newer marker, which stays. Every read of the workspace goes through the
census's bounded reader, so an unresponsive mount cannot hold shutdown: a read
that does not answer ends the pass and keeps the markers. A pass that leaves its
markers doubles the wait before the next one, from 30 seconds to four minutes.

The measure thread is not gated by host load, so a marker is measured at any
level and waits only for the walk claim: a held claim keeps every marker for the
next period. The walk is the same one the thread already runs: one at a time,
under the walk claim, with a time limit. The cache numbers feed `stim status`,
Desktop and the `stim gc` worktree report. No deletion, reduction, refusal or
build admission is started by them: the pressure ladder reads them to order its
Cargo trims, from the latest recorded size of each target whatever its age
(a size older than the ladder's last attempt on that target counts as unknown;
the trims themselves plan from structure), and the size scan reuses a
`target/` size at or under the cap, which can only hold a trim back (see the
cap rule below); the
caps read only the size scan of their own pass, the
dependency ranking reads only `node_modules` and Pods entries, which this job
never writes, and the headroom estimate (LLP 0006) reads the build ledger.

Maintainer decision, 2026-11-14: "Yes, add it", in answer to the proposal to add
a size measurement at the end of each build to the second pull request for this
issue (#5759).

Maintainer decision, 2026-11-15: "For rest for with ur recs", which accepts a
marker plus a 30 second timer with no protocol change, no cap check brought
forward when a measurement crosses a cap, no use of the measurement in the
headroom estimate, and no new setting (#5759).

## A size walk that times out reports what it measured

The Cargo remover, the idle and dormant stages, rung 1's output delete and the
`stim gc` workspace output clear size what they delete in a way that keeps
partial results. A walk stopped at its deadline reports the bytes of the
top-level entries it finished, marked `partial` ("at least" in text), instead of
nothing. Callers that decide what to delete or trim from a size still treat a
timed-out walk as unknown, so the lower bound changes only what is reported.

How the walk runs depends on the number of top-level entries, counted with one
directory read. Up to 100, it runs `du -sk` once per entry, one after another
under one shared deadline, and adds up the entries that finished. Discovery and
metadata reads consume that budget too; the filesystem calls themselves are not
interruptible, so a stalled mounted volume can still delay returning. Above 100, it
runs one `du -k -d 1` and sums the entry lines printed before the deadline. The
split exists because macOS du writes to a pipe in 4 KB blocks (about 105 lines),
so a single walk of a small folder stopped early prints nothing, while a large
folder with many subdirectories has already printed whole blocks. BSD du emits
intermediate rows only for directories: a flat folder with over 100 files can
still report zero partial bytes before the final total; GNU du writes each line as it finishes.
Per entry costs about the same as one walk on a few dozen entries and three to
five times more on several hundred (measured on macOS, warm cache: 16 to 27
entries 0.04 against 0.06 s and 0.79 against 0.80 s; 667 entries 0.23 against
1.26 s; 1,037 entries 0.76 against 2.47 s). A file hard-linked into two
top-level entries would count twice on the per-entry path, so a folder with a
top-level file that has another link takes the single walk, which counts it
once: a Cargo profile, whose binaries are hard-linked into its `deps/`, is that
case. A link shared by two top-level folders still counts twice; pnpm's links
point into the store outside the folder, so the layouts Stim deletes do not hit
it.

Maintainer decision, 2026-11-20: "Can timed out scan report the bytes it
measured when it timed out, but still flag it as incomplete" (#6067).

Maintainer decision, 2026-11-20: "ok do it", on the proposal to walk folders of
up to about 100 top-level entries with one `du -sk` per entry under one deadline
and larger ones with a single `du -k -d 1` (#6067).

## One idle day reduces a workspace

A workspace with no activity for `idle.dormantDays` (default 1) is reduced to
its minimal size at every level: build outputs, owned devices, logs archived,
and in a linked worktree `node_modules` and Pods.

The stim-daemon runs the build output step and then the dependency step at most
hourly at every level, in its maintenance lane, in turn with the ladder's disk
passes (One task runs every gc deletion), and `stim gc` on each run. Build outputs go only by the
full evidence, for a registered workspace as for a discovered checkout: Stim
activity, source and git writes, and processes running from or working in the
checkout, its git checkout as a whole for an app nested in one. A locked
worktree, or one git cannot list, keeps them. Where the running processes
cannot be listed, always on Windows, that evidence cannot be read, so no
output goes for dormancy there; ladder rung 1 still takes them under
pressure, except a Cargo `target/` and a locked worktree's. Each output is
measured before the workspace's native-run and metro-start claims are taken,
checked again under them, and removed one at a time; a recognised Cargo
`target/`, untagged included, goes whole under the checks of LLP 0005 (The
dormant reduction deletes an idle target whole). A removal puts its parent
directory's modification time back, so the next output and the dependency step
do not read Stim's own removal as a source write. The Metro transform cache is
not a dormant output: every worktree of the app shares it, so one idle
worktree would empty it for the one in use. Report mode runs the same
checks and acts on nothing.

Reason: until #5968 a machine that relied on the daemon kept idle build outputs
until the disk reached high, and the first daemon version of this step (#5966)
took outputs an external Gradle build was using. Chosen by the coordinator and
the review of #5966, not by the maintainer.

Maintainer decision: "I think projects not touched for like 1 day should be
reduced to minimal size", 2026-11-11.

Maintainer decision: "Need to be more aggressive in our resources reclaim, i
dont want to have computers in this situation again", 2026-11-11.

Wherever the stages and the ladder read discovered checkouts (the dormant
stage's output and dependency steps, and the `stim gc --dry-run` previews of
rungs 1, 5 and 8), they also read every root a Stim command recorded a
workspace for (`workspaces/<id>/workspace.json`) that has no registry entry,
still exists, and holds no registered project. Such a root is
judged idle by the full evidence, as a discovered checkout is, since most
commands run in an unregistered root do not record their use. A registered app
inside a worktree covers that worktree instead, so a recorded worktree root
never takes the trees of an app in use. Saved output marks of such a root are
authorized like a registered root's, so the daemon's dormant pass removes its
outputs as `stim gc` does. The stimd output sweep of the pressure ladder still
rechecks each mark against the registry or targeted discovery and keeps such a
root's outputs.

Reason: `stim worktree warm` at a repository root records use of the root but
registers only the app it finds, and older Stim versions dropped the app's
registry entry on an idle stop while the root's record stayed. Discovery treats
every recorded root as known, and the gc marks and the worktree check already
read recorded roots, so without this the stage reached none of them (#6203).
Chosen by the implementing lane of #6203, not the maintainer.

## The main checkout goes last

Every stage and rung that reduces checkouts takes linked worktrees before the
source (main) checkout, longest idle first within each. After a main
checkout's dependencies are deleted, `stim worktree warm` in a linked worktree
says on stderr that the source has no installed dependencies to copy, and
`stim status` shows the same, until they are installed again.

A main checkout's `node_modules` and Pods go in one case only, after those of
every linked worktree: no activity for `idle.sourceDormantDays` (default 7, 0
for never), at any level. At critical, `stim gc` reports in rung 8 those of a
main checkout idle 2 minutes whose volume is still under the critical level, and
deletes nothing (Rungs 5, 7 and 8 only report).

Activity is the newest of a Stim command, a source file write, a git index,
HEAD or reflog write and the last commit, in the checkout and in every Stim
workspace in it, and a `stim worktree warm` that copied from it when the warmed
app has a Stim workspace there. Reading files in an editor, with no process
working there and no write, is not activity.

It is kept while a process works in it or names a path in it, an agent session
works in it, an app in it is in use or pinned with `maintenance.keep`, a warm is
copying from it, or a linked worktree of the same repository links into the
tree or cannot be fully checked for links. The tree must be a real git-ignored
directory that is not a mount point, and at the 7-day rule it must have been
measured. The deletion holds the warm claim of the checkout exclusively, and the
native-run claims of the root and of every workspace in it.

Reason: new worktrees are warmed from the main checkout, so keeping it installed
is worth more than keeping any one worktree installed, and a warm must never
copy from a tree that is being deleted.

`maintenance.olderThanDays`, the age of the age sweep, defaults to 3 days. The
simulator runtime keep (LLP 0002) still uses at least 7 days.

Maintainer decision: "Is 7 days for age sweep a bit much, maybe 3", 2026-11-12.

Maintainer decision: "Do we have diff rules for worktrees vs main checkout i
think we should prio cleaning up worktrees, then main since this is what new
worktree are created from, ideally it will also be clear that when a main
checkout is cleaned it should be rebuilt first", 2026-11-12.

Maintainer decision: "I think we should consider deleting main checkout deps
and pods on critical", 2026-11-12. Superseded by #6025: rung 8 only reports
them.

Maintainer decision: "I think a main checkout could also be considered idle but
with maybe like 7 d", 2026-11-12. Maintainer decision: "I meant deps yes",
2026-11-12: the 7 days apply to dependencies, not build output.

Maintainer decision: "2 min is good, yes to rest", 2026-11-12, for the idle
window at critical and the editor-reading rule.

The setting name, the definition of
activity, the 7-day floor on the runtime keep and the mount-point rule were
chosen by the coordinator and the reviews of #5540, not by the maintainer.

The hourly size scan reuses shared, leftover and registered cache sizes for
6 hours. For each capped category (build, Metro and Swift compilation), reuse
requires a complete cached measurement under 6 hours old for every existing
entry and a total at or under the nonzero cap, decided once before the scan's
walks; otherwise the whole category is measured fresh. Uncapped
categories and a cap of zero use the age limit alone. Cargo targets reuse sizes
at or under their cap for 6 hours; over-cap targets are measured fresh. Growth
makes these sizes stale low, delaying a trim safely; fresh over-cap totals avoid
stale high sizes trimming more after removals. The folders a Cargo trim will
remove still get fresh walks, since stale low there could delete more. Other
Stim homes and private machine-cache report folders reuse sizes for 1 hour;
either stale direction affects display only. An acting `stim gc` plans its
caps from the same scan, so it too can leave a cache that grew past its cap
for up to the 6 hours. The 6 hour and 1 hour maximum
ages and the under-cap reuse rule were chosen by the implementer of #6389,
not by the maintainer.

The maintenance pass plans its cap trims (workspace outputs, the build, Metro
and Swift compilation caches, and Cargo targets) only from a measurement that
succeeded in that same pass: the size check, or, while host load defers it,
the Cargo-only cap measurement, which plans only the Cargo caps. A pass whose
size check did not run or failed plans no cap trim, and leaves the trims that
the last measuring pass kept in the plan until a pass that measures; a
Cargo-only measurement replaces them with its Cargo trims alone. The sizes
saved in the maintenance state from earlier passes never decide a trim: an
acting `stim gc`, a ladder trim or the idle stage can shrink a cache without
updating them, and a cache refilled since then would be trimmed or emptied
whole on the old, larger size. The same-pass rule does not cover a disk pass
that takes the turn between the measurement and the trim (One task runs every
gc deletion); the worst case there is evicting more of a regenerable cache.
Chosen by the implementer of #6497, not by the maintainer.

## A dependency tree's size holds until its clone group changes

A `node_modules` or `ios/Pods` measurement is reused while the tree's install
signature (inode and mtime of its root and install markers) is unchanged: for
6 hours in any case, then up to a day while its clone group is unchanged, and
never past a day. The clone group is the same relative path in every checkout
of the repository, the main checkout and each linked worktree, read from git's
own files without running git. Its stamp, a hash of each member's path and
install signature, is taken before the walk and saved in the size cache entry
beside the signature. The daemon's dependency scan reads the members'
signatures through its bounded reads; a caller that supplies a bounded
signature without a stamp records none, which reads as changed.

Reason: a tree's private size changes without the tree changing when the
checkout it was cloned from reinstalls or is warmed from again, or when a
sibling clone is removed or reinstalled. Each of those changes a member's
signature or existence, so an unchanged stamp means nothing Stim can relate
changed. Removals and reinstalls make a cached private size read too small,
which under-reports what deleting frees and deletes nothing wrongly. The only
case that reads too large is the source checkout right after a warm clones
from it; the dormant stage and the ladder decide on the same trusted size they
did before, and that exposure is bounded by the same 6 hours as before. The
day bounds clones made outside Stim that no member records.

Maintainer decision: "can we avoid remesuring when we know smt didnt change
tho?", 2026-11-25 (#6378).

Maintainer decision: "lets do it and also see if we can improve caching and set
a bigger max age like maybe 1 day", 2026-11-25 (#6378).

The 6 hour floor for a changed group was chosen by the implementer of #6378,
not by the maintainer: the daemon scans every 10 minutes, so re-walking on
every group change would walk a busy repository's trees more often than the
old 6 hour expiry did.

`stim worktree list` sizes a linked worktree as its `node_modules` and
`ios/Pods` under this rule plus a walk of the rest of the worktree when that is
over an hour old. Reason: ignored build output in the rest changes by gigabytes
without moving git or any install signature, so no cheap signal holds it
longer. A worktree with a project-local `.pnpm-store` is walked whole hourly,
because real-size counts a file shared between two measured paths as private in
neither, and the store shares its files with `node_modules`. So is one whose
`node_modules`, `ios` or `ios/Pods` is anything but an absent path or a plain
directory: a symbolic link, which the whole walk does not follow and a split
walk would count twice or outside the worktree, or a path that cannot be read. The rest is
measured as its top-level entries, so the same holds for a file linked between
two of them; real-size takes directories only, so a top-level file with one
link counts its allocated bytes, overstating a clone. Both errors are bounded
by files a regular worktree rarely has. The composition
and that fallback were chosen by the implementer of #6385, not by the
maintainer.

A worktree whose walk left part of it out (an unreadable entry, or a volume
that cannot report private sizes, mounted inside it or at a top-level entry)
lists its sizes as lower bounds, "at least", and so does every total that
includes it, in the listing, its JSON and the doctor note (#6415). Reason: the
private bytes of the rest are still measured, and a lower bound tells more
than an unknown size. The JSON field names (`partial` on a worktree and a kept
group, `realPartial`, `removePartial` and `keptPartial` on a summary) were
chosen by the implementer of #6415, after `freedPartial`.

## A tree of hard links stays

A `node_modules` or Pods tree whose private size is unknown when it is ranked
(never measured, its walk failed or timed out, a partial count under 256 MB,
or a volume that cannot tell) is sampled: the link counts of up to 36 regular
files, at most 3 from each of up to 12 packages spread over the sorted package
list (`.pnpm/*/node_modules/<name>` for pnpm's isolated layout, the top-level
folders otherwise), read without following a symlink. The sample, the listing
and the build output check below each have 2 seconds, so one tree can take up
to about 6 seconds and a stat of the store, but no read starts once the 10
seconds of the whole step are spent and each read gets only what is left of
them, so all trees of one step take at most about 10 seconds. The tree counts as hard links only
when its `.modules.yaml` records a pnpm `storeDir` that is a directory outside
the tree, it has no dot directory at its root other than a package manager's
own (a cache such as `.cache` holds its own bytes), at least 20 distinct files
(by device and inode) from 5 packages were read, at least 90% of them have more
than one link and sit on the store's device, and no package holds output a
native build wrote in place (`android/build`, `android/.cxx`,
`android/.gradle`, `android/app/build`, `.build`, `ios/build`,
`apple/.DerivedData`). For that last check, once a sample finds links, the
packages holding an `android`, `ios`, `apple` or `.build` folder are listed
once per install signature, one directory read per package, 2 seconds at a
time from after the last package listed (by path, in sorted order), so a large tree on a slow disk is
listed over a few runs and has no `links` verdict until the list is complete
(a package whose listing fails other than by being absent stops the listing
there, to be retried on the next run, and a `.pnpm` or scope folder that
cannot be listed gives no verdict at all until it can);
every use of a `links` verdict, a recorded one included, then reads the
`android`, `ios` and `apple` folders of those packages once each (and
`android/app` when present) for build output folders, and a build output
folder or a check that does not answer or fails ends it. No read starts with
less than 500 ms of its budget left, so a read near the end of the budget does
not become the pending read that stops the discovery and source scans; one that
does not answer in the time it got is the pending read, as any other, and a
sample that the step's limit left less than its full 2 seconds records no
`timeout` verdict, so it is sampled again on the next run. The verdict and the
listing are written under their file's lock, waited for at most 200 ms; when
the lock or the write fails or times out there is no verdict, and the tree
stays unknown. Build
output outside those folders is not seen: a `.build` folder that appears after
the listing in a package with none of them, `android/<module>/build` or
`android/<module>/.cxx` of a library with several modules, or
`node_modules/react-native/ReactAndroid/build` and `.cxx` when React Native is
built from source. Such a tree is kept by the 7-day source rule and the
dormant step, with a kept reason that gives the counts. The pressure ladder
does not sample: rungs 5 and 8 only report (Rungs 5, 7 and 8 only report), and
report a tree of unknown size as freeing an unknown amount. Anything else (no recorded or existing store, as for
every tree pnpm did not install, too few files, or reads that did not answer)
leaves the tree unknown and the rules above unchanged. The verdict is recorded
beside the size cache with the install signature and the store, and reused for
6 hours while the signature holds; a `links` verdict is reused only while its
store is still a directory (one bounded stat). The 6 hours keep the cost at a
few dozen stats per unknown tree per 6 hours. Only a tree with no measurement
is sampled; at the 7-day rule `stim gc` first tries to measure it, so the sample never replaces a
measurement.

Reason: with pnpm on a volume without clones, a tree's files are hard links
into the package store, so deleting the tree frees little and costs a
reinstall, and on a slow disk the walk that would show it is the one that
fails. A link count proves that another name holds the file's data, not where
that name is: copies hard-linked to each other inside the tree, such as pnpm
peer variants of one package, raise it too, and deleting the tree frees them.
The recorded store outside the tree, on the same device as the linked files, is
the evidence that the other name is outside. Matching a sampled file to its
store entry would mean hashing the file, since the store is addressed by
content, so the sample does not do it. The case it leaves is a store that still
exists but no longer holds these files while copies inside the tree link to
each other; the 6 hour reuse and the store check bound how long a verdict
outlives a removed store. A sample sees a few packages, so a package outside it
can still hold gigabytes of its own files. A tree copied with `cp`,
as `stim worktree warm` copies where the volume cannot clone, has files with one
link, and the tests check a `cp -R` copy. The implementer expects the same of
`package-import-method=copy`, a store on another volume and APFS clones, and
did not verify them; where that holds, the sample leaves those trees unknown.

Maintainer decision: "Like if wr detect it is links", 2026-11-18, quoted in
#5942.

The sample size, the per-package spread, the 90% share, the 20 file and 5
package minimums, the store, cache and build output checks, the 2 and 10 second
limits and the 6 hour reuse were chosen by the
implementer of #5942 and its reviews, not by the maintainer.

## Links

- Issues: #5492, #5512, #5524, #5877, #5933, #5942, #5998, #6011, #6025, #6067. Pull requests: #5514, #5540.
- Code: `packages/stim-cli/src/policy/checkout-order.ts`,
  `packages/stim-cli/src/workspace/source-dependencies.ts`,
  `packages/stim-cli/src/stimd/passes/artifacts.ts`,
  `packages/core/state/settings-registry.ts` (defaults),
  `packages/stim-cli/src/daemon/ladder.ts` (rungs),
  `packages/stim-cli/src/commands/gc.ts`.

## Filesystem history makes marks dirty

On macOS, one packaged `stim-fsevents` child of stimd replays filesystem
history and then streams changed checkout roots. The watched roots come from
current authorized marks, grouped by their recorded source device; newly
unmarked roots are already due. Scan-only roots whose current route cannot yet
be proved stay outside this watch set until [#6093](https://github.com/appandflow/stim/issues/6093).
A root-list change replaces the watch with a
new generation. Output indexes belong only to that generation, and older
output cannot index the replacement list or advance its checkpoint.

Watch membership is read on the passes worker, including bounded asynchronous
checkout identities. A cancelled or timed-out filesystem read retains that
isolate's single pending-read slot. Git cleanup failures use the daemon's
existing containment policy, including during shutdown.

The passes worker persists each batch's `dirtyAt` updates before acknowledging
it. Publication and dirty updates use the same isolate's synchronous
read-modify-write, so a change during a mark's reads survives publication. Only
that acknowledgement lets the main thread atomically replace the per-device
UUID, event id, timestamp and root membership in `gc/fsevents.json`. A failed
write keeps the old cursor for replay. This orders process-crash recovery;
ordinary atomic renames do not promise a power-loss transaction across files.
Build-end measurements consume only their captured marker batch after a strict
dirty acknowledgement; failed mark I/O leaves that batch for the timer backoff.

The helper purges history whose UUID changed, whose cursor is ahead, whose
saved timestamp is missing, future or over two hours old, or whose event stream
reports lost events. The caller dirties that device's roots before storing the
new cursor. History remains a refresh hint: a parent renamed away and back or
a snapshot restored with the same UUID can hide changes. Generation TTLs stay,
and a sweep's deletion rechecks do not change.

A missing, mismatched, failed or unavailable helper makes each known root dirty
once, then Stim activity and generation TTLs supply the fallback. Status names
that source and reason, and doctor reports a binary digest mismatch. Shutdown
closes helper stdin and waits for its exit. EOF also ends it if stimd dies.

The npm package includes one signed universal helper, pinned by release version,
zip SHA-256 and binary SHA-256. Release preparation downloads and verifies it;
stimd verifies the binary once before spawning it. It is never downloaded or
compiled at runtime. A source checkout fetches it with
`node scripts/fetch-fsevents.mjs`.
The CLI declares this private helper in pnpm's `publishConfig.executableFiles`
so packing preserves executable mode without exposing another public command.
Both release paths verify mode 0755 and the pinned binary digest from the packed archive before publishing.

## Opt-in Apple service restarts

[#6256](https://github.com/appandflow/stim/issues/6256) approves this narrow
exception to signalling only Stim-owned processes. It belongs to the separate
root helper in Stim Host, not the cleanup ladder or owned-device teardown.

Maintainer decision: "would it be safe to have stim restart it automatically, it could keep a list of problematic services", 2026-11-24.
Maintainer decision: "Can we do this", 2026-11-24, on the privileged helper in Stim Host.app.
Maintainer decision: "Sounds good, if helper isnt setup and we detect high usage from a process ti could kill can we suggest the command to run to setup the helper", 2026-11-24, accepting the design below.
Maintainer decision: "lets do both", 2026-11-24, for the Desktop toggle and the CLI flag.
Maintainer decision: "Setup command only (Recommended)", 2026-11-24, choosing that the advice without a helper prints only the setup command and drops the one-off kill command.
Maintainer decision: "That should be a candidate for our cleanup automatic", 2026-11-27, on fseventsd, after Stim Desktop showed "fseventsd uses 82.68 GB" with the advice `sudo killall fseventsd` ([#6600](https://github.com/appandflow/stim/issues/6600)).
Maintainer decision: "using our priviledged helper (should be installed right?)", 2026-11-27, on the same fseventsd advice.
Maintainer decision: "so if updating is pretty easy and can be done automatically we prob dont need to separate the process list", 2026-11-27 ([#6604](https://github.com/appandflow/stim/issues/6604#issuecomment-7234079580)), dropping a signed policy file for the service list: the list stays compiled into the helper and Stim Host updates itself.

Registration is opt-in through the signed Stim Host executable, using
SMAppService.daemon and an embedded LaunchDaemon plist with BundleProgram.
An administrator approves it under Login Items & Extensions. Both Desktop
preferences and service install/uninstall --helper use that executable; these
flags affect only the helper. Install --helper first installs or updates the
pinned signed release in ~/Applications as the full service install does, so a
Mac that never installed the server service, or installed it before a
helper-capable Host, still registers
([#6297](https://github.com/appandflow/stim/issues/6297)). It replaces only the
bundle: a server already running from the old one keeps running until its next
restart. Uninstall --helper downloads nothing. Desktop does not download Stim
Host; for a missing or too old one it shows that command.

stimd keeps an installed Stim Host current. At each start, which every engine
update causes, it installs the pinned release over a `~/Applications/Stim
Host.app` whose version is older, through the same download, digest and
signature checks, under a machine-wide lock in `~/.stim/machine/host` so the
stimds of several Stim homes do not swap the bundle at once. A failed attempt
retries hourly until one succeeds. It never installs Stim Host on a Mac that
has none there, never downgrades a newer one, and skips the update when
`engine.autoUpdate` is `off`. Replacing the bundle under a running stimd is
safe: on the maintainer's MacBook on 2026-11-27 macOS left the running
processes alone when a notarized same-team build replaced the bundle.

The helper exits when its own executable is replaced, so launchd's KeepAlive
starts the new binary. It records its path and device and inode at start, and
at the end of each sample cycle, never between a restart attempt and its
result, it checks that path. A missing path, which the two renames of an
install leave for a moment, keeps it running. A different regular executable
file must show the same inode, size and modification time on two cycles in a
row, so a copy still being written does not end it. It then writes an
`update` event to its log and exits 0. Cooldowns are already durable and come
back from the log, but the sample windows start over, so a service over a
limit needs another 10 minutes. launchd's `ThrottleInterval` of 60 seconds
bounds a relaunch loop if the new binary cannot run. On 2026-11-27 a 0.2.0
helper killed after such a swap came back on the new binary, still
registered, with no approval prompt ([#6604](https://github.com/appandflow/stim/issues/6604#issuecomment-7234079580));
the next boot or login after a swap was not tested. A helper from a release
before this rule, such as 0.2.0, keeps its old binary until a reboot or
`sudo launchctl kickstart -k system/dev.stim.host.helper`.

The release preflight runs `scripts/host-release-check.mjs`, which fails when
`packages/server/host/` changed since the `host-v*` tag of the pinned release,
so a stim release never ships helper changes without a Host release. Tagging
`host-v*` stays a maintainer step. The helper has no listener, Mach service, socket
or request file. It does not accept targets, paths or thresholds from callers.
Its registration is independent of daemon.mode and STIM_HOME until unregistered.

Only the exact system executable paths of PerfPowerServices, mds_stores,
mdworker_shared, photoanalysisd, mediaanalysisd and fseventsd qualify. These
paths were checked on macOS 27.0 (26A428), the first five on 2026-11-24 and
fseventsd on 2026-11-27. New entries go at the end of the list because log
lines record a service by its index. Once a minute libproc samples CPU time,
RSS and physical footprint. Memory is the larger of RSS and footprint, because
RSS leaves out compressed and swapped pages: on the maintainer's MacBook on
2026-11-27 fseventsd had about 10 GB RSS against a 77 GiB footprint, 67 GiB of
it compressed, after nine days up ([#5910](https://github.com/appandflow/stim/issues/5910)
covers an earlier 52 GB case). More than 150% CPU or 2 GiB of memory for 10
continuous minutes qualifies one process for SIGTERM; a changed identity, missing sample,
sample gap over 90 seconds, or recovery resets the relevant window. CPU and
memory each need their own continuous window. The helper verifies path and
start identity again immediately before signalling. Nothing else is signalled:
WindowServer, launchd, coreaudiod and CoreSimulator stay outside this exception.
Restarting fseventsd makes every FSEvents client, such as Metro, Watchman and
Spotlight, rescan the folders it watches once; launchd starts fseventsd again
at once.

A service gets at most one attempt per hour across all its instances. The
helper syncs an attempt before signalling and restores cooldowns from its
root-owned log after restart; a crash between the receipt and signal costs an
attempt rather than allowing another. Rotation carries cooldowns into the new
log. A root-owned lock prevents multiple helper instances. The helper opens
only root-owned regular logs without symlinks under a
root-owned non-writable directory. Logs are readable by other users and rotate
at 4 MiB, keeping one previous file. Samples, attempts and signal outcomes are
JSON lines; reporting uses successful signal outcomes from the last hour.
This reports a restart request, not proof of launchd's replacement.

stimd's Apple service sample leaves fseventsd out; its advice comes from the
memory culprit report, which reads footprint from `top`. That report keeps
`sudo killall fseventsd` until a Stim Host release whose helper lists
fseventsd is pinned, because the setup command would install a helper that
does not restart it. The pin switches the command to the setup command
([#6604](https://github.com/appandflow/stim/issues/6604)).

Only the home maintenance pass samples Apple services, reusing its process
table for device activity. stimd names an allowlisted process over either limit
on two consecutive samples and logs the same advice status shows: stim service install --helper.
Status reads these observations for up to ten minutes and never warns from its
own process sample. stimd never sends a signal to these services. An enabled
helper's recent restart receipts appear in plain and JSON status and daemon logs. An approval-pending helper remains
eligible for the advice because it cannot run yet. Registration suppresses
warnings only with a successful heartbeat less than three minutes old. The
helper atomically refreshes `/Library/Logs/Stim/helper.heartbeat` each cycle,
including errors; transient failures retry in the helper loop. A stale, missing
or failed heartbeat names the health problem and `/Library/Logs/Stim/helper.err`.
Registration checks are cached in-process for five minutes; a cached registered
state is rechecked when its heartbeat is unhealthy. Readers scan only
the tails of the current and rotated logs for restart results. stimd logs each
restart once and warnings only when they start or their state changes.

Chosen by the implementer within the issue's approximate limits: strict
threshold comparisons, separate CPU and memory windows, the 90-second maximum
sample gap, durable attempted-restart cooldowns, log rotation size and retention,
and reporting the last hour. For #6600: the 2 GiB limit for fseventsd, the CPU
limit applying to it as to the others, and footprint counting for every listed
service, not only fseventsd. Footprint can only raise the measured memory, so
a service that qualified before still qualifies. For #6604: updating only an
older installed Host and never downgrading one, since the stimds of worktree
builds and scratch homes share the real `~/Applications`; reusing
`engine.autoUpdate` `off` as the opt-out; the hourly retry; the two-cycle
settle check; and the lock path. No settings are added.

Code: [helper](../packages/server/host/stim-host-helper.c),
[policy](../packages/server/host/helper-policy.h),
[ServiceManagement bridge](../packages/server/host/helper-service.m),
[CLI and reporting](../packages/stim-cli/src/apple-services.ts),
[Desktop preferences](../apps/desktop/Sources/StimDesktop/Views/AppPreferencesView.swift).
