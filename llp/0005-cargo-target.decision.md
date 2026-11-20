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
`git worktree lock`: every top-level entry but a `deploy/` directory holding a
`*-keypair.json` and a symbolic link, and the `target/` itself once nothing is
left in it. It runs the idle stage's
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
number; mounts that cannot be read keep it), when a process executes from,
works in or holds open any path in it, the `target/` itself and the entries
that stay included, or when a build holds a lock file: a `.cargo-lock`,
`.cargo-build-lock` or `.cargo-artifact-lock` in a top-level entry or a
directory directly in one, Exact's `.exact-sweep.json.lock`, or a file under
`.apple-cargo-locks/` up to two levels down. Use means a modification time
within that time, or one that cannot be read, on the `target/` itself, on any
top-level entry but Stim's own `.stim-*`, on each direct child of a top-level
directory, or on a profile directory and its `.fingerprint`, `deps`, `build` and
`incremental`; or a unit stamp within that time in Exact's ledger. The times
are read two levels down by the eligibility check; the delete itself also takes
the newest modification time of everything in each entry in the walk that checks
devices and keypairs, before the move and on the moved entries before the
delete, so a file rewritten in place deep inside, such as a Criterion baseline,
keeps the `target/`. A `target/` with no Cargo profile, such as an
Exact app's, is dated the same way.

Then, as the trims do (Never delete what a build took back, below), it renames
each entry into `target/.stim-trimmed/` and reads that entry's lock
files again at the new path. Once every entry is moved it measures them, reads
the processes again and dates the moved entries again the same way. Right before the delete it
checks that a staged `deploy/` still holds no keypair, lists the `target/` again
(an entry's original name that reappeared, or a new entry, means a build is
back), dates the entries that stayed in place, and on Linux reads the mounts
again. A lock a build took, any path in the `target/` a process used, a write
made meanwhile or any of those findings puts every moved entry back, and so does
a cancellation or an error before those checks pass. An entry whose original
name exists again is not put back over it; like one that cannot be put back,
it moves to `.stim-not-restored-*` or stays in a `.stim-trimmed` marked
`NOT-RESTORED`, for a person. A file is put back with `link` then `unlink`, which
fails rather than replace a name a build recreated meanwhile. A directory is put
back with `rename` after checking its name is free: `rename` fails onto a
directory that is not empty, but replaces an empty one, so a directory a build
recreates empty in that instant is replaced. An entry that
cannot be renamed, such as one on another device (`EXDEV`), stays and the rest
goes. The moved entries are deleted without entering a directory on another
device, and the emptied `target/` goes too. Report mode runs the checks that
need no claim, the use dating among them, and reports the size of what would
go, and gc names a `target/` it keeps and why. Putting entries back after a
cancellation, an error, a lock or a process, and a delete that ends with entries
left, give the `target/` its own modification time back, so Stim's own moves
do not count as use on the next run; a rollback caused by a write or a new
entry does not. For the dormant reduction only, a `target/` holding a `.stim-trimmed` directory
counts as a recognised `target/` even when its Cargo files were staged; the
size cap and the pressure trims do not see such a `target/`, as before: a staging tree
whose marker is cleared was committed for deletion, and the next run removes
it after the same idle, process, lock and mount checks.

Maintainer decision: "lets full delete it instead of trim on idle", 2026-11-19
(#5979). Reason: a trim by profile left everything that is not a profile, such
as Exact's `clients/` and `web-js-modules/`, on an idle checkout, and left an
untagged `target/` at its full size. Reason the size cap and the pressure trims
stay trims: they also reach a `target/` in use.

Maintainer decision: "yea lets do that", 2026-11-19 (#5979), in reply to
"switch #5996 to that, full delete except Solana keypairs", after the worst
cases were listed: Solana keypairs, Exact's receipts and development tokens,
benchmark baselines and Cargo's reports. A `deploy/` directory holding a
`*-keypair.json`, or one that cannot be read to tell, stays because Solana's `cargo build-sbf` and Anchor keep a
program's private key there, and a new key is a new program ID. Everything else
in an idle `target/` goes, Exact's folders and records included. A symbolic
link stays because deleting through it would reach what it points at, and a
`deploy` that is itself a symbolic link, or holds one, keeps the whole
`target/`, since its keys may live anywhere in it. Both `deploy` and
`*-keypair.json` match in any letter case. Any other top-level entry holding a
`*-keypair.json` at any depth stays too, found in the same walk that checks
devices, before the move and again on the moved entries before the delete: a
debug-only `cargo build-sbf --debug` writes the key under `deploy/debug/`, and
`--sbf-out-dir` can put it in any folder. A dry run leaves such entries out of
the size it reports. A `.stim-trimmed` that is not a real directory
keeps the `target/` too: the staging directory is made fresh, never reused. An
earlier version deleted only entries recognised as Cargo or Exact build
output; it freed almost nothing from Exact app targets, whose size sits in
folders that also hold records.

The delete notes the `target/`'s device and inode first and checks them again
before it makes the staging directory, before each move and before the final
delete. If the `target/` is no longer that real directory, it stops without
putting anything back through the new path; what was staged stays in the
original directory's `.stim-trimmed`, marked `NOT-RESTORED`, for a person. A
swap made deliberately between one of those checks and the call that follows is
not covered.

Known limit: a Linux bind mount that exposes part of the `target/` elsewhere,
such as `target/doc` mounted at `/srv/docs` for a server outside the checkout,
is not detected; the mount checks look only for mount points at or under the
`target/`.

Known limit: the process checks see a path in the `target/` only when a process
runs from it, works in it, holds a file in it open or names it absolutely on
its command line. A process whose working directory is outside the checkout
and that names the `target/` only by a relative path, such as a static file
server for `target/doc` started from elsewhere, is not seen, and its files can
go while it serves them.

Chosen by the coordinator and the reviews of #5996, not by the maintainer: the
use dating, the move aside with its recheck and roll back, the mount checks and
the NOT-RESTORED marker written before the first move. Reason for the dating: the idle evidence skips
writes in a `target/` git ignores, so a build that ran without a source edit
shows only in the target's own times; two levels of times are what a check that
must not walk a large `target/` can read, and on this Mac most Exact app targets
hold no Cargo profile at all. Reason for the move aside: the trim claim
excludes only other Stim processes, and a Cargo build sharing the target can
take a profile lock while later profiles are checked. Reason for the marker:
it records each staged entry's original name in `.stim-trimmed/NOT-RESTORED`
before the first move and is cleared only once the final checks pass or every
entry is back, so a delete that dies midway leaves a `target/` that later trims
and deletes refuse until a person acts, instead of one whose staged entries the
next trim deletes unchecked.

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

## A full disk releases the reserve

The trim and the dormant delete write before they free anything: the trim
claim under `~/.stim/machine/cargo-trim/`, on the dormant path the
workspace's `native-run` and `metro-start` claims, the `target/.stim-trimmed`
directory, the `NOT-RESTORED` marker, and the trim's moves of profiles,
`incremental/` directories and unit files into it. When one of those writes
fails with `ENOSPC`, or `EDQUOT` over a quota, Stim deletes its 1 MiB
maintenance disk reserve (`$STIM_HOME/maintenance/disk-reserve`, the file the
maintenance pass and an acting `stim gc` already keep) and tries that write
once more. The dormant delete's renames of each entry into `.stim-trimmed` are
not retried: an entry that cannot be moved stays, as above. The retry runs the
same staged path with every check above unchanged. Before the trim retries a
staging write, it reads the processes and the launchers again, and for a
profile its lock files; a launcher into the checkout or process evidence that
cannot be read stops the rest of that run, and a path in use keeps that path.
The dormant delete checks that the `target/` is still the same directory
before each try. For the workspace claims the whole removal of that output
runs again. A run that released the reserve says so in its outcome. When the
write fails again, or there was no reserve to release, the `target/` is kept
as before.

The trim, like the dormant delete, writes the `NOT-RESTORED` marker before its
first move and removes it only right before it deletes what it staged, or when
the run stops with nothing it could not put back. A directory that could not
be put back therefore stays marked for every later trim and delete, from any
process. When the marker cannot be written even after the reserve is
released, the trim moves nothing; the dormant delete removes a marker it could
not finish writing with its empty `.stim-trimmed`, and the `target/` gets its
modification time back, so nothing blocks the next run. A trim that stops
with its marker in place, such as one whose process was killed, leaves the
`target/` for a person, as an interrupted dormant delete does. The maintenance
pass writes the reserve back at its end when there is room.

Reason: on 2026-11-19 at 23:01 UTC, with the maintainer's disk full, a rung 3
trim failed with `ENOSPC` creating `.stim-trimmed` and freed nothing (#6012),
and on a disk with no free bytes the claims fail first (#6016). Deleting in
place without staging would need every guarantee of the staged path proven
again; the reserve gives the staged path the room it needs instead.

Asked for in #6012 and #6016; reusing the reserve was chosen by the
coordinator of that work, not by the maintainer.

## Links

- Issues: #5512, #5516, #5523, #5528, #5530, #5979, #6012, #6016. Pull requests: #5518, #5519,
  #5527, #5539. Locking follow-up: #5542.
- Code: `packages/stim-cli/src/workspace/cargo-target.ts`,
  `packages/stim-cli/src/daemon/dormant-outputs.ts`,
  `packages/stim-cli/src/disk-reserve.ts`,
  `packages/stim-cli/src/stimd/passes/cargo-target.ts`,
  `packages/stim-cli/src/stimd/passes/defer.ts`,
  `packages/stim-cli/src/daemon/ladder.ts` (`cargoTargetsStep`),
  `packages/core/state/settings-registry.ts` (`maintenance.cargoTargetMaxGb`).
