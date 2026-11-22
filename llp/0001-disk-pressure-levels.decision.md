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

The full table lives in `website/docs/commands.md` (the `gc` section) and in
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
  queues after peers already waiting at its rank. Releasing an old ticket
  cannot release the current owner. Pass identity, listeners and results stay
  with the ticket while it waits, and are current again when it resumes.
  A cancelled queued request withdraws its own ticket; a cancelled executing
  pass keeps ownership through its current work and observes cancellation
  after regrant. Only the current owner recreates the reserve.
- The lane uses these ticket boundaries. Pressure, manual and headroom sweep
  candidates still run within their whole pass; candidate-loop integration
  and fresh rechecks after resumption are the remaining part of #6101.
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
  A removal exception remains a failed rung, as before; accounting for bytes
  removed before a later removal failed is an existing separate limitation. Registered
  roots without marks are reported; unmarked discovered roots are not listed
  during a critical sweep.
- A mark is due after 10 minutes for activity under a day old, hourly for idle
  checkouts, and daily after `idle.dormantDays`. Dirtiness brings the interval
  to 10 minutes, never sooner. Unknown activity uses the 10-minute interval.
  These constants implement the approved generation policy; this selector is
  brought forward so high-pressure refresh does not invent a temporary TTL.
  The normal lane still walks hourly and publishes due marks; a normal
  mark-first sweep scheduler is pending the generation/lane integration.
- The writer also recognizes untagged Cargo targets by the existing Cargo
  manifest/profile rules and marks targets in the holder's `apps/` and
  `packages/` children. The normal lane reads actual Git holders reached by
  its artifact scanner and publishes their own marks. A registered app's
  current buffered Git worktree metadata can authorize its exact holder's
  Cargo candidates, without authorizing the holder's other outputs. The
  helper may watch that holder; a watch grants no deletion authority. A holder
  reached only through a discovered nested app stays when its own ordinary
  route cannot be proved; targeted proof for that layout remains required.
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
- Worktree/dependency marks and pressure discovery, normal mark-first
  scheduling, per-candidate disk-turn yielding and yield ranking remain
  pending. The no-discovery guarantee applies to output rung 1 and Cargo
  pressure candidate selection, not the other maintenance stages or normal
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
build admission reads them, only the order of the pressure ladder's Cargo
trims: the
caps read the maintenance size scan, the
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
store is still a directory (one bounded stat). The 6 hours match how long a
dependency tree's size stays fresh and keep the cost at a few dozen stats per
unknown tree per 6 hours. Only a tree with no measurement is sampled; at the
7-day rule `stim gc` first tries to measure it, so the sample never replaces a
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
