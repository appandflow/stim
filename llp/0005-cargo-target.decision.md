# LLP 0005: Cargo target directories

**Type:** Decision
**Status:** Active
**Systems:** Cleanup, Exact
**Author:** Janic Duplessis / Claude
**Date:** 2026-11-12
**Related:** LLP 0001, LLP 0004, LLP 0007

## Which targets Stim manages

Stim recognises three kinds of Cargo `target/`: an Exact app's, beside
`exact.mjs`; one at a checkout root whose `CACHEDIR.TAG` starts with the
standard signature line; and one at a checkout root beside `Cargo.toml`, with
no such tag, that holds files only Cargo writes: a `.rustc_info.json` at its
root, or a direct child profile holding `.fingerprint`. Stim's own `.stim-*`
directories never count as that evidence. All three count in a registered
workspace and in a discovered checkout (LLP 0004), and all three get the size
cap and the pressure trims below.

Only the first two are listed as build output. Two steps delete a `target/`
whole: the idle stage, for an idle workspace whose dev server or devices it
stops, deletes one of the first two, and the dormant reduction (below) deletes
any of the three. Before that the idle stage checks that the directory is real, inside its checkout, not a
mount point, holds no file git tracks and only files git ignores; that no PATH
launcher resolves into the checkout; that no other process runs from or works
in the app; and that it holds no copy a trim could not put back
(`.stim-not-restored-*`, or `.stim-trimmed` marked `NOT-RESTORED`). It reads
no Cargo lock file. The trims run the git, link, mount and launcher checks but
not the whole-app process check; instead they keep each path a process
executes from or holds open and each profile whose lock a build holds (below).

Ladder rung 1, for a workspace with nothing running, leaves a `target/` to the
trim of rung 3.

Maintainer decision: "Yes leys have same rules for cargo as exact", 2026-11-19
(#5958). Reason for the third kind: a Cargo `target/` can lack the root tag.
On the maintainer's MacBook on 2026-11-19, 3 of the 7 `~/.exact/exact2`
worktrees with a `target/` had none, among them an 18 GB and a 31 GB one. Both
held `.rustc_info.json` and a profile with `.fingerprint`, and one carried the
tag only in `target/wasm32-unknown-unknown/`. The check takes only Cargo's own
files as evidence, so a project's `target/` folder that Cargo never wrote stays
out. A `CACHEDIR.TAG` in a child is not evidence: it is a generic standard any
tool may write. Reason the third kind is never listed as build output: such a
`target/` can also hold another tool's output, as Exact's `bake/` and `web/`
are, and Cargo's files in it do not show the rest is build output, so the idle
stage leaves it and the trims remove only Cargo's profiles from it. Only the dormant
reduction deletes it whole, under the maintainer decision in the next section.

## The dormant reduction deletes an idle target whole

The dormant reduction (`stim gc` and the daemon's hourly step) deletes every
recognised `target/` whole, tagged, Exact app's and untagged alike, in a
workspace or discovered checkout that has had no activity for
`idle.dormantDays` by the full evidence, and whose worktree is not locked with
`git worktree lock`. Only the benchmark baseline folders `target/criterion`,
`target/gungraun` and `target/iai` stay. It runs the idle stage's
checks above, the process check included, for all three kinds, then, under the
workspace's claims and checked again right before the delete: the workspace is
still idle, the directory is still a recognised `target/`, and no PATH launcher
resolves into the checkout. A path the plan took as a `target/` goes only
through the Cargo delete, never through the plain removal of other outputs.

Under the target's trim claim the Cargo delete then keeps the whole `target/`
when it is no longer recognised, when it holds a copy a trim could not put back,
when it shows use within `idle.dormantDays` or that use cannot be told, when
another filesystem is mounted anywhere in it (on Linux also any mount point at
or under it in `/proc/self/mountinfo`, since a bind mount keeps the device
number; mounts that cannot be read keep it), when a process executes from or
holds open a path in it, or when a build holds a lock file: a `.cargo-lock`,
`.cargo-build-lock` or `.cargo-artifact-lock` in a top-level entry or a
directory directly in one, Exact's `.exact-sweep.json.lock`, or a file under
`.apple-cargo-locks/` up to two levels down. Use means a modification time
within that time, or one that cannot be read, on the `target/` itself, on any
top-level entry but Stim's own `.stim-*`, on each direct child of a top-level
directory, or on a profile directory and its `.fingerprint`, `deps`, `build` and
`incremental`; or a unit stamp within that time in Exact's ledger. The times
are read two levels down and no deeper, so a write deeper inside a folder that
is not a profile is not seen. A `target/` with no Cargo profile, such as an
Exact app's, is dated the same way.

Then, as the trims do (Never delete what a build took back, below), it renames
each top-level entry into `target/.stim-trimmed/` and reads that entry's lock
files again at the new path. Once every entry is moved it reads the processes
again, matching both an entry's original and its moved path, and dates the
moved entries again the same way. A lock a build took, a path a process opened
or a write made meanwhile puts every moved entry back, and so does a
cancellation or an error before those checks pass. An entry whose original
name exists again is not put back over it; like one that cannot be put back,
it moves to `.stim-not-restored-*` or stays in a `.stim-trimmed` marked
`NOT-RESTORED`, for a person. Node offers no rename that refuses to replace, so
a name recreated between that check and the rename is still overwritten. An entry that
cannot be renamed, such as one on another device (`EXDEV`), stays and the rest
goes. The moved entries are deleted without entering a directory on another
device, and the emptied `target/` goes too. Report mode runs the checks that
need no claim, the use dating among them, and reports the whole size, and gc
names a `target/` it keeps and why.

Maintainer decision: "lets full delete it instead of trim on idle", 2026-11-19
(#5979). Reason: a trim by profile left everything that is not a profile, such
as Exact's `clients/` and `web-js-modules/`, on an idle checkout, and left an
untagged `target/` at its full size. Reason the size cap and the pressure trims
stay trims: they also reach a `target/` in use.

Chosen by the coordinator and the reviews of #5996, not by the maintainer: the
use dating, the move aside with its recheck and roll back, the mount checks,
and keeping the benchmark baseline folders. Reason for the dating: the idle evidence skips
writes in a `target/` git ignores, so a build that ran without a source edit
shows only in the target's own times; two levels of times are what a check that
must not walk a large `target/` can read, and on this Mac most Exact app targets
hold no Cargo profile at all. Reason for the move aside: the trim claim
excludes only other Stim processes, and a Cargo build sharing the target can
take a profile lock while later profiles are checked. Reason for
the benchmark baseline folders: Criterion keeps saved baselines in `criterion/`
and Gungraun (formerly iai-callgrind) in `gungraun/` or `iai/`; they describe
old code and no build can recreate them. These named folders are the only
exceptions, not a list of what may go; another tool's data in `target/` is
deleted with it.

## The size cap

`maintenance.cargoTargetMaxGb` (default 25 GB) caps every recognised `target/`,
in use or not. Over the cap, maintenance removes the profile and target-triple
directories no build wrote in the last day, then, if still over, the
`incremental/` directory of each remaining profile, largest first, until the
overage is covered. 0 means no cap and no pressure trim either.

"Wrote in the last day" comes from directory modification times and the unit
stamps in Exact's `.exact-sweep.json`, never from access times. Reason: reads
leave no trace on default APFS.

Only the paths a process executes from or holds open are kept, and every
profile whose `.cargo-lock`, `.cargo-build-lock` or `.cargo-artifact-lock` a
build holds. The process list is read again before each step; an unreadable
one keeps everything. Reason: a single helper running from
`target/exact-filesystem-tool/` must not keep a 150 GB `target/` whole.

Each size scan measures every registered target and at most 6 discovered ones,
the least recently measured first, so every target is reached within a few
scans. Reason: a size walk of a large `target/` can take its full 120-second
limit, and the walks run one at a time.

At normal, the cap is planned at the hourly size scan, and hourly on its own
while host load defers that scan; the size scan itself runs after at most 3 hours of
deferral. Reason: agents build under load, which is when `target/` grows
fastest.

The 25 GB default and the mechanics above were chosen by the coordinator and
the reviews of #5518, #5527 and #5539, not by the maintainer.

## Pressure tightens the cap

The level of the volume holding a `target/` tightens the cap, whatever its
size:

- high: every recognised `target/` loses all stale profiles and all
  `incremental/` data;
- critical: it also loses build units no build used for a day, only where
  Exact's `.exact-sweep.json` ledger exists, shows use and is at most 3 days
  old. One unit per crate name, the most recently used, always stays.

The pressure trim needs no byte count, so it never waits for a size scan, a
`du` or host load (LLP 0001, Pressure acts without waiting for measurement or
load). The pressure ladder, the daemon's and the one a build command runs before it
builds, plans it from folder structure, lock files
and Exact's ledger at the start of rung 3, before any shared cache is trimmed,
and runs it; the daemon runs it at most every 10 minutes per level, a command
once, and a command leaves its own workspace's `target/` alone. An acting `stim gc` runs it
before it measures anything. It reports the bytes the trim removed. Cap 0,
`maintenance.keep`, the lock, `lsof` and `ps` checks and the rename with its
re-check apply unchanged. Every trim of a target, from any process and any Stim home, holds that
target's exclusive ownership claim (LLP 0007) under `~/.stim/machine/cargo-trim/`;
one that cannot take it keeps the target and names the claim. Reason: two Stim
homes can register or discover the same checkout, and a second trim starts by
deleting `target/.stim-trimmed`, which the first may still need to put back. The
claim is outside `target/` because `cargo clean` or the trim itself would delete
it, and outside the project tree, as runtime state is. Under a headroom
deadline the trim stops between units; at high and critical it walks nothing
before removing, and reports the free space it gained of the target's own volume, or 0 when
either sample is missing. The claim, the deadline stop, the free-space report
and the absence of a per-run limit on targets were chosen by the coordinator and
the reviews of #5763, not by the maintainer.

Maintainer decision: "we def should not have to wait on full disk measurement
to be able to remove caches", 2026-11-14.

Maintainer decision: "Lets make sure that if disk space is low we do any needed
measurement right away since disk space is prio over cpu use", 2026-11-14.

Reason: Cargo keeps every old build of a crate, so a `target/` in daily use
grows without bound, and a checkout in use is never cleared by the idle rules.
Directory times say nothing about whether a fresh dependency was used, so units
go only where Exact's ledger records use.

Maintainer decision: "yes lets do this", 2026-11-12, in answer to the proposal
to tighten the cap under pressure. The ledger conditions and the one unit per
crate were added by the reviews of #5539. Not decided: whether
`stim gc --pressure critical` clears the whole `target/` of a checkout in use.

## Never delete what a build took back

Each whole profile or incremental removal, and each top-level entry of a
`target/` the dormant reduction deletes, renames a directory into
`target/.stim-trimmed/` after the lock check and checks the locks again at the
new path. A build that took a lock in
between gets the directory back. A directory that cannot be put back is never
deleted: it moves to `target/.stim-not-restored-*`, which later trims skip, for
a person to merge or delete. If that move fails too, it stays in
`.stim-trimmed` with a marker, and later trims of that `target/` stop until a
person removes it.

A unit sweep takes exclusive, non-blocking locks on Exact's ledger lock and the
profile's `.cargo-lock`, `.cargo-build-lock` and `.cargo-artifact-lock` before
each chunk of 25. A busy or unavailable lock stops the sweep of that profile.
Cargo can hold `.cargo-build-lock` in a separate intermediate build directory,
and Exact takes `.cargo-lock` while it resets fingerprint access times. Under
the locks, Stim confirms the ledger has stayed current, rechecks the candidate
fingerprints, and renames the units aside. It releases the locks before measuring
or deleting the batch. If a rename fails, it tries to restore the batch while
locked. If restoration fails, Stim keeps the batch in `.stim-trimmed` and
attempts to write the marker that protects it from later trims.

This uses Perl to apply `flock` on macOS and Linux. On Windows, Linux NFS, or
when locking cannot be verified, the profile keeps its units.

The maintainer [approved the locking improvement and kept the existing pressure
level and age cutoff](https://github.com/appandflow/stim/issues/5542#issuecomment-6864811661).

Reason: a directory a build locked during the move is that build's live output;
deleting it breaks the build rather than slowing the next one.

Chosen by the coordinator and the reviews of #5518 and #5539, not by the
maintainer.

## Links

- Issues: #5512, #5516, #5523, #5528, #5530, #5979. Pull requests: #5518, #5519,
  #5527, #5539. Locking follow-up: #5542.
- Code: `packages/stim-cli/src/workspace/cargo-target.ts`,
  `packages/stim-cli/src/daemon/dormant-outputs.ts`,
  `packages/stim-cli/src/stimd/passes/cargo-target.ts`,
  `packages/stim-cli/src/stimd/passes/defer.ts`,
  `packages/stim-cli/src/daemon/ladder.ts` (`cargoTargetsStep`),
  `packages/core/state/settings-registry.ts` (`maintenance.cargoTargetMaxGb`).
