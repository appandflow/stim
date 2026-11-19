# LLP 0005: Cargo target directories

**Type:** Decision
**Status:** Active
**Systems:** Cleanup, Exact
**Author:** Janic Duplessis / Claude
**Date:** 2026-11-12
**Related:** LLP 0001, LLP 0004, LLP 0007

## Which targets Stim manages

Stim recognises two kinds of Cargo `target/`: an Exact app's, beside
`exact.mjs`, and one at a checkout root whose files git ignores and whose
`CACHEDIR.TAG` starts with the standard signature line. Both count in a
registered workspace and in a discovered checkout (LLP 0004).

The idle stage clears an idle workspace's `target/` whole. The dormant
reduction (`stim gc` and the daemon's hourly step) never does: it runs the
trim below on every profile no build wrote for `idle.dormantDays`, under the
trim claim and the profile lock checks, and leaves `.stim-trimmed`,
`.stim-not-restored-*` and everything that is not a profile in place. A process
running from or working in the checkout keeps all of it.

Reason: a whole delete took the recovery data of a trim that could not put a
directory back, and raced a Cargo build that holds a profile lock. Chosen by
the coordinator and the review of #5966 (#5968), not by the maintainer.

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

Each whole profile or incremental removal renames a directory into `target/.stim-trimmed/` after the lock
check and checks the locks again at the new path. A build that took a lock in
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

- Issues: #5512, #5516, #5523, #5528, #5530. Pull requests: #5518, #5519,
  #5527, #5539. Locking follow-up: #5542.
- Code: `packages/stim-cli/src/workspace/cargo-target.ts`,
  `packages/stim-cli/src/stimd/passes/cargo-target.ts`,
  `packages/stim-cli/src/stimd/passes/defer.ts`,
  `packages/stim-cli/src/daemon/ladder.ts` (`cargoTargetsStep`),
  `packages/core/state/settings-registry.ts` (`maintenance.cargoTargetMaxGb`).
