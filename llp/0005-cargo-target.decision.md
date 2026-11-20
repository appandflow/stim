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
mount point, holds no file git tracks and only files git ignores; and that no
other process runs from or works in the app. It then removes it through the
Cargo delete (One remover, below), under the target's Cargo locks, as the
dormant reduction does without its use dating; so do the build-output pass of
the maintenance lane and the pressure ladder's artifact pass for a recognised
`target/`. The trims run the git, link and mount checks but not the whole-app
process check; instead they keep each path a process executes from or holds
open and each profile whose lock a build holds (below).

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

## The loss budget for regenerable build output

Regenerable build output (Cargo `incremental/`, stale profiles, workspace build
outputs) may be deleted while a build could start after the check; that build
rebuilds. Never covered: source, worktrees, dependency folders, and anything
Stim does not recognise. Stim still runs the checks this document lists right
before the delete and keeps the output when one of them shows use; the budget
covers only what starts after them. A Solana keypair in a `target/` is never
deleted (below).

Maintainer decision: "I agree lets do this and ur recommendations from prev
messages, also lets do the changes now that u flagged as after 2.0 id rather
delay than ship what we have", 2026-11-20 (#6025), whose list of decisions
states the budget in words that match the first two sentences of this section.

Chosen by the lane of #6025, not by the maintainer: stale target triples and
the dormant reduction's whole `target/` count as covered output, the way stale
profiles do; a command installed as a link into build output is such a later
use, since cleanup does not read PATH (LLP 0004, Cleanup does not read PATH); and
a review finding that a build or process starting after the check loses output
does not block a change to these deletes.

Reason: earlier maintainer decisions already accepted such windows ("ok",
2026-11-19, for a killed trim's staging, because everything it stages is
regenerable Cargo build output; LLP 0002's "best effort" for dependency edits),
and Cargo's own `cargo clean` removes a whole target with no lock. Protecting
against the window drew a large share of the review findings on #5996 and #6013.

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
still idle and the directory is still a recognised `target/`. A path the plan took as a `target/` goes only
through the Cargo delete, never through the plain removal of other outputs.

The Cargo delete then keeps the whole `target/` when it is no longer
recognised, when it holds a leftover of an earlier engine's staging (Leftovers
of the staged trim, below), when it shows use within `idle.dormantDays` or that
use cannot be told, when another filesystem is mounted anywhere in it (on Linux
also any mount point at or under it in `/proc/self/mountinfo`, since a bind
mount keeps the device number; mounts that cannot be read keep it), when a
process executes from, works in or holds open any path in it, the `target/`
itself included, when a process holds Exact's `.exact-sweep.json.lock` or a
file under `.apple-cargo-locks/` up to two levels down, or when a build holds a
Cargo lock (below). Use means a modification time within that time, or one
that cannot be read, on the `target/` itself, on any top-level entry but Stim's
own `.stim-*`, on each direct child of a top-level directory, or on a profile
directory and its `.fingerprint`, `deps`, `build` and `incremental`; or a unit
stamp within that time in Exact's ledger. The times are read two levels down by
the eligibility check; the delete itself also takes the newest modification
time of everything in each entry in the one walk that checks devices, so a file
rewritten in place deep inside, such as a Criterion baseline, keeps the
`target/`. A `target/` with no Cargo profile, such as most Exact app targets,
is dated the same way and has no Cargo lock to take: its evidence is that
dating, the Exact lock probe and the one process read, and a build that starts
after them loses its output under the loss budget.

Then it takes every Cargo lock file of the `target/` that exists, a
`.cargo-lock`, `.cargo-build-lock` or `.cargo-artifact-lock` in a top-level
entry or a directory directly in one, exclusively and without waiting, and
removes each top-level entry in place through the one remover. A lock a build
holds keeps the whole `target/`. Lock files, keypairs and what stands on another
device stay, and so does the `target/` while anything is left in it; an entry
that holds only such files is not planned again. Report mode runs the checks
that need no lock, the use dating among them, and reports the size of what
would go, and gc names a `target/` it keeps and why. Stim's own deletes change
the `target/`'s modification time, so a `target/` a delete left part of looks
used for one more `idle.dormantDays`.

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
in an idle `target/` goes, Exact's folders and records included. A top-level
symbolic link stays, and a `deploy` that is itself a symbolic link, or holds
one, keeps the whole `target/`, since its keys may live anywhere in it. Both
`deploy` and `*-keypair.json` match in any letter case. Anywhere else the
remover never unlinks a `*-keypair.json`: a debug-only `cargo build-sbf --debug`
writes the key under `deploy/debug/`, and `--sbf-out-dir` can put it in any
folder. A dry run leaves an entry that would keep only such files out of the
size it reports. An
earlier version deleted only entries recognised as Cargo or Exact build
output; it freed almost nothing from Exact app targets, whose size sits in
folders that also hold records.

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
use dating and the mount checks. Reason for the dating: the idle evidence skips
writes in a `target/` git ignores, so a build that ran without a source edit
shows only in the target's own times; two levels of times are what a check that
must not walk a large `target/` can read, and on this Mac most Exact app targets
hold no Cargo profile at all.

## The size cap

`maintenance.cargoTargetMaxGb` (default 25 GB) caps every recognised `target/`.
At normal pressure it trims only an idle `target/`: one no process uses any path
in and whose every Cargo lock Stim can take, which it then holds for the whole
trim; a used path or a busy lock keeps the whole `target/` until the next pass.
Under pressure (below) it reaches a `target/` in use. Over the cap, maintenance removes the profile and target-triple
directories no build wrote in the last day, then, if still over, the
`incremental/` directory of each remaining profile, largest first, until the
overage is covered. 0 means no cap and no pressure trim either.

"Wrote in the last day" comes from directory modification times and the unit
stamps in Exact's `.exact-sweep.json`, never from access times. Reason: reads
leave no trace on default APFS.

Under pressure only the paths a process executes from or holds open are kept,
and every profile whose `.cargo-lock`, `.cargo-build-lock` or
`.cargo-artifact-lock` a build holds, or that has no `.cargo-lock` to take. The
process list is read once per trim; an unreadable one keeps everything. Reason:
a single helper running from `target/exact-filesystem-tool/` must not keep a
150 GB `target/` whole when the disk is short.

Maintainer decision: "I agree lets do this and ur recommendations from prev
messages, also lets do the changes now that u flagged as after 2.0 id rather
delay than ship what we have", 2026-11-20 (#6025), whose list of decisions says
the cap trims a target in use only under disk pressure and applies to idle
targets at normal. Chosen by the lane of #6025, not by the maintainer: idle
means the process and lock evidence above, the same evidence that keeps a path
or profile under pressure.

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

- high and critical: every recognised `target/` loses all stale profiles and
  all `incremental/` data.

The pressure trim needs no byte count, so it never waits for a size scan, a
`du` or host load (LLP 0001, Pressure acts without waiting for measurement or
load). The pressure ladder, the daemon's and the one a build command runs before it
builds, plans it from folder structure, lock files
and Exact's ledger at the start of rung 3, before any shared cache is trimmed,
and runs it; the daemon runs it at most every 10 minutes per level, a command
once, and a command leaves its own workspace's `target/` alone. An acting `stim gc` runs it
before it measures anything. It reports the bytes the trim removed. Cap 0,
`maintenance.keep` and the lock, `lsof` and `ps` checks apply unchanged. Two
Stims that trim the same `target/` at once need no claim: each takes the Cargo
locks it deletes under, and the remover counts a path already gone as removed.
Under a headroom deadline the trim stops between steps; at high and critical it
walks nothing before removing, and reports the free space it gained of the
target's own volume, or 0 when either sample is missing. The deadline stop, the
free-space report and the absence of a per-run limit on targets were chosen by
the coordinator and the reviews of #5763, not by the maintainer.

Maintainer decision: "we def should not have to wait on full disk measurement
to be able to remove caches", 2026-11-14.

Maintainer decision: "Lets make sure that if disk space is low we do any needed
measurement right away since disk space is prio over cpu use", 2026-11-14.

Reason: Cargo keeps every old build of a crate, so a `target/` in daily use
grows without bound, and a checkout in use is never cleared by the idle rules.

Maintainer decision: "yes lets do this", 2026-11-12, in answer to the proposal
to tighten the cap under pressure. Not decided: whether
`stim gc --pressure critical` clears the whole `target/` of a checkout in use.

The critical level no longer removes Exact's idle build units: the list of
decisions in #6025 removes that sweep.

## One remover

Every deletion of Cargo build output, the trims, the dormant reduction, the idle
stage, the build-output pass and the artifact pass, goes through one remover. It
deletes in place, deepest first: a symbolic link is unlinked and never followed,
a directory on a device other than the `target/`'s and Exact's
`.apple-cargo-locks/` are not entered, a lock file Cargo or Exact takes
(`.cargo-lock`, `.cargo-build-lock`, `.cargo-artifact-lock`,
`.exact-sweep.json.lock`) and a `*-keypair.json` (any case) are never unlinked,
and a directory goes once it is empty. In a profile it removes `.fingerprint`
first, so a build that starts while the profile is half removed rebuilds it. A
path already gone counts as removed. What it left for those rules is reported,
lock files aside.

Each trim step takes the Cargo locks of the profiles it deletes from, the lock
files that exist and never a new one, exclusively and without waiting, through
`flock` (Perl on macOS and Linux), and deletes while it holds them. A build that
starts meanwhile waits for the delete, as it waits for another Cargo, and then
rebuilds. A profile with no `.cargo-lock` stays. On Windows, Linux NFS, or when
locking cannot be verified, the profile stays. Sizes are measured before the
locks are taken.

Maintainer decision: "I agree lets do this and ur recommendations from prev
messages, also lets do the changes now that u flagged as after 2.0 id rather
delay than ship what we have", 2026-11-20 (#6025), whose list of decisions says
to delete in place under Cargo's own profile locks through one remover that
never follows links, crosses devices, or unlinks keypairs or lock files, and to
remove the staging, its markers and roll back. Reason: 38 of the 78 review
findings on #5996 and #6013 were in the staging, roll back, marker and full-disk
retry code itself; the loss budget above accepts the window that staging closed.

## Leftovers of the staged trim

Earlier engines staged removals in `target/.stim-trimmed/` and kept what they
could not put back as `target/.stim-not-restored-*`. A `target/` that holds
either is left out of every trim and delete, read only: the plan names it with
the remedy (delete the leftover, or move what you need out of it), and the next
pass trims the `target/` again. Chosen by the lane of #6025, not by the
maintainer, following the step-back review: an earlier engine deleted an
unmarked `.stim-trimmed` at its next trim; this one leaves that to a person
rather than keep any knowledge of the staging format.

## A full disk releases the reserve

Before a trim or a delete, and before the dormant reduction takes a workspace's
`native-run` and `metro-start` claims, Stim deletes its 1 MiB maintenance disk
reserve (`$STIM_HOME/maintenance/disk-reserve`, the file the maintenance pass
and an acting `stim gc` already keep) once when the volume it acts on has less
than 64 MiB free, so those claims and the unlinks, which can need space on
APFS, have room. A run that released the reserve says so in its outcome. The
maintenance pass writes the reserve back at its end when there is room.

Reason: on 2026-11-19 at 23:01 UTC, with the maintainer's disk full, a rung 3
trim failed with `ENOSPC` creating `.stim-trimmed` and freed nothing (#6012),
and on a disk with no free bytes the claims fail first (#6016). The in-place
delete writes nothing before it frees, so one release up front replaces the
retry of each write.

Maintainer decision: "I agree lets do this and ur recommendations from prev
messages, also lets do the changes now that u flagged as after 2.0 id rather
delay than ship what we have", 2026-11-20 (#6025), whose list of decisions says
to release the disk reserve once up front. The 64 MiB threshold was chosen by
the lane of #6025, not by the maintainer.

## Links

- Issues: #5512, #5516, #5523, #5528, #5530, #5979, #6012, #6016, #6024, #6025. Pull requests: #5518, #5519,
  #5527, #5539. Locking follow-up: #5542.
- Code: `packages/stim-cli/src/workspace/cargo-target.ts`,
  `packages/stim-cli/src/workspace/cargo-lock.ts`,
  `packages/stim-cli/src/daemon/dormant-outputs.ts`,
  `packages/stim-cli/src/disk-reserve.ts`,
  `packages/stim-cli/src/stimd/passes/cargo-target.ts`,
  `packages/stim-cli/src/stimd/passes/defer.ts`,
  `packages/stim-cli/src/daemon/ladder.ts` (`cargoTargetsStep`),
  `packages/core/state/settings-registry.ts` (`maintenance.cargoTargetMaxGb`).
