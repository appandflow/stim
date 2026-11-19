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
- high: the pressure ladder, rungs 0 to 7, including the `node_modules` and
  Pods of linked worktrees idle an hour; every Cargo `target/` on the volume
  loses its stale profiles and `incremental/` data (LLP 0005).
- critical: rungs 0 to 8 with shorter idle times and no grace, idle Cargo
  build units (LLP 0005), then rung 9, the caches of tools Stim does not own
  (LLP 0003).

Maintainer decision: "1 hour", 2026-11-11, for the idle time before a linked
worktree loses `node_modules` and Pods at high.

Maintainer decision: "make sure all things we can delete are actually deleted
at max pressure level", 2026-11-11.

The full table lives in `website/docs/commands.md` (the `gc` section) and in
`stim guide cleanup`; this document records why the levels are shaped this
way, not the table.

## Pressure acts without waiting for measurement or load

While any volume is at high or critical, no cleanup step waits for a size
scan, a `du` of what it frees, or host load to drop. A step whose decision
needs no byte count (the Cargo `target/` trim, LLP 0005) plans from structure
and runs at once; a step that needs sizes measures them at once. Host load
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
minutes), so it waited 3 h 26 min from the previous Cargo measurement.

Maintainer decision: "we def should not have to wait on full disk measurement
to be able to remove caches", 2026-11-14.

Maintainer decision: "Lets make sure that if disk space is low we do any needed
measurement right away since disk space is prio over cpu use", 2026-11-14.

Chosen by the coordinator, not the maintainer: the Cargo trim runs as the first
step of ladder rung 3, at most every 10 minutes per level in the long-lived daemon (a build command's
ladder runs it once, and leaves its own workspace's `target/` alone), so a
checkout in use does not lose its `incremental/` data every tick; walks above
normal are not niced.

## A ladder pass that frees nothing waits

After a daemon ladder pass that took no action, the next pass waits four times
that pass's duration, at most 15 minutes. A rise of the disk or the memory
level, any measured volume that is new, lost 1 GB or reached a higher level
since that pass, or a command that asks the daemon for a tick (the hard floor)
runs it at once. The rest of the tick, the idle and dormant stages included,
still runs every minute. A build's headroom ladder and
`stim gc` are not paced.

Reason: on a Linux worker held at critical by space Stim cannot free, 615 of
657 ladder passes in a day freed nothing, and the ladder ran about 53% of the
wall clock with a git spawn per checkout per rung, so stimd used 30 to 40% of
a core for days (#5933). The factor keeps a pass that frees nothing under a
fifth of the time; the cap bounds how late a newly idle tree is taken, and
the bypasses keep a disk that is filling, or new memory pressure, from waiting.

Maintainer decision: "Good for both points", 2026-11-18, in answer to whether
a wait of up to 15 minutes after a pass that freed nothing is acceptable, given
that disk space comes before CPU use (#5933, pull request #5939).

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
under the critical level (LLP 0003). Disk pressure alone never gives the
activity pass the 2-minute idle threshold; memory pressure idles every
workspace. The ladder a build runs for its
headroom (LLP 0006) plans its Cargo trim at high and treats only the build's
volume as short. The Gradle, Kotlin and watchman stops relieve memory and are
not gated. `stim gc --pressure` treats every volume as short; `stim gc` at the
measured level is gated.

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
`idle.minutes`, in the stim-daemon and in `stim gc` (a forced `--pressure` run
included: it uses the 2-minute stop only when memory measures above normal).

- Under disk pressure, at high and critical, rung 1 deletes the regenerable
  build outputs of a workspace idle 2 minutes or more whether or not its dev
  server or an owned device runs, and stops nothing. Idle is judged on the same
  evidence and with the same keeps as the idle stage (a dev server whose
  requests Stim cannot see, a hosted placement, `maintenance.keep`, and so on),
  and every other guard of rung 1 holds. The workspace's Metro store stays
  while its own dev server runs, as it does while another workspace's server
  shares it; a Cargo `target/` is left to the Cargo trim of rung 3.
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

## At critical a deletion stops only what it needs

At critical disk pressure a workspace idle 2 minutes or more is taken even
while its dev server or an owned device runs, judged as the idle stage judges
it. Something is stopped only as part of a deletion on a volume under pressure
that needs it, in one action under the workspace's native-run and metro-start
claims, after every other check of that deletion passed and the workspace was
judged idle again; the deletion checks everything again after the stop.

- Rung 4 shuts down each owned device to delete it, through teardown, and only
  a device whose data lies on a volume under pressure. The dev server keeps
  running, the logs stay and the workspace is not marked dormant.
- Rung 5 stops the dev server to delete the workspace's Metro store, when no
  other running dev server shares it, and to delete the `node_modules` and Pods
  of a linked worktree. The stop is an idle stop that `stim revive` resumes;
  the devices keep running. A tree the dev server's own processes do not keep,
  but something else does (another process working in the worktree, an agent
  session, `maintenance.keep`), keeps the dev server running.
- Rungs 7 and 8 still keep a workspace whose dev server or owned device runs.
  Under disk pressure alone, a finished worktree or a source checkout whose
  dev server or device runs now waits until the idle stage stops it at
  `idle.minutes`; before, the 2-minute stop let these rungs take it 2 minutes
  after its last activity.

Chosen by the implementer of #5998, not by the maintainer: the Metro store goes
in rung 5, after the parked devices and shared caches of rungs 2 and 3, rather
than in rung 1; the deletions at rung 4 do not archive logs or mark the
workspace dormant while its dev server runs; a booted device is deleted
without first reaping its log collector, whose end with the device was not
verified.
Rungs 7 and 8 were left out of this change: rung 7 removes through the worktree
check's plan and removal guard, which keep a workspace whose dev server runs or
whose device is booted, and rung 8 judges a source checkout by its full
evidence under the claims of every workspace in it; neither takes the dev
server stop that rung 5 uses yet.

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
`stim gc` reports; nothing else refreshes them on a schedule, because the hourly
size scan measures only the Stim workspace folders. The disk-usage cache is keyed by the exact path string, so each folder is
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
build admission reads them: the caps read the maintenance size scan, the
dependency ranking reads only `node_modules` and Pods entries, which this job
never writes, and the headroom estimate (LLP 0006) reads the build ledger.

Maintainer decision, 2026-11-14: "Yes, add it", in answer to the proposal to add
a size measurement at the end of each build to the second pull request for this
issue (#5759).

Maintainer decision, 2026-11-15: "For rest for with ur recs", which accepts a
marker plus a 30 second timer with no protocol change, no cap check brought
forward when a measurement crosses a cap, no use of the measurement in the
headroom estimate, and no new setting (#5759).

## One idle day reduces a workspace

A workspace with no activity for `idle.dormantDays` (default 1) is reduced to
its minimal size at every level: build outputs, owned devices, logs archived,
and in a linked worktree `node_modules` and Pods.

The stim-daemon runs the build output step and then the dependency step at most
hourly at every level, and `stim gc` on each run. Build outputs go only by the
full evidence, for a registered workspace as for a discovered checkout: Stim
activity, source and git writes, and processes running from or working in the
checkout, its git checkout as a whole for an app nested in one. A locked
worktree, or one git cannot list, keeps them. Where the running processes
cannot be listed, always on Windows, that evidence cannot be read, so no
output goes for dormancy there; ladder rung 1 still takes them under
pressure, except a Cargo `target/` and a locked worktree's. Each output is
measured before the workspace's native-run and metro-start claims are taken,
checked again under them, and removed one at a time. A removal puts its parent
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

A main checkout's `node_modules` and Pods go in two cases only, after those of
every linked worktree:

- no activity for `idle.sourceDormantDays` (default 7, 0 for never), at any
  level;
- at critical, at the start of rung 8, once it is idle 2 minutes and its volume
  is still under the critical level.

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
and pods on critical", 2026-11-12.

Maintainer decision: "I think a main checkout could also be considered idle but
with maybe like 7 d", 2026-11-12. Maintainer decision: "I meant deps yes",
2026-11-12: the 7 days apply to dependencies, not build output.

Maintainer decision: "2 min is good, yes to rest", 2026-11-12, for the idle
window at critical and the editor-reading rule.

The setting name, the placement at the start of rung 8, the definition of
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
not become the pending read that makes the launcher scan incomplete; one that
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
built from source. Such a tree is kept at normal and high by the 7-day
source rule, the dormant step and rung 5, with a kept reason that gives the
counts; at critical, rung 5 takes it after every measured tree and every other
tree of unknown size, and rung 8 takes it in the same batch as the other trees
of the source checkouts it clears. Anything else (no recorded or existing store, as for
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
can still hold gigabytes of its own files; that is why the verdict keeps a tree
only below critical, and at critical only orders it last, so the maintainer's
rule that everything goes at maximum pressure holds. A tree copied with `cp`,
as `stim worktree warm` copies where the volume cannot clone, has files with one
link, and the tests check a `cp -R` copy. The implementer expects the same of
`package-import-method=copy`, a store on another volume and APFS clones, and
did not verify them; where that holds, the sample leaves those trees unknown.

Maintainer decision: "Like if wr detect it is links", 2026-11-18, quoted in
#5942.

The sample size, the per-package spread, the 90% share, the 20 file and 5
package minimums, the store, cache and build output checks, the 2 and 10 second
limits, the 6 hour reuse and the critical ordering were chosen by the
implementer of #5942 and its reviews, not by the maintainer.

## Links

- Issues: #5492, #5512, #5524, #5877, #5933, #5942, #5998. Pull requests: #5514, #5540.
- Code: `packages/stim-cli/src/policy/checkout-order.ts`,
  `packages/stim-cli/src/workspace/source-dependencies.ts`,
  `packages/stim-cli/src/stimd/passes/artifacts.ts`,
  `packages/core/state/settings-registry.ts` (defaults),
  `packages/stim-cli/src/daemon/ladder.ts` (rungs),
  `packages/stim-cli/src/commands/gc.ts`.
