# LLP 0005: Cargo target directories

**Type:** Decision
**Status:** Active
**Systems:** Cleanup, Exact
**Author:** Janic Duplessis / Claude
**Date:** 2026-11-12
**Related:** LLP 0001, LLP 0004

## Which targets Stim manages

Stim recognises two kinds of Cargo `target/`: an Exact app's, beside
`exact.mjs`, and one at a checkout root whose files git ignores and whose
`CACHEDIR.TAG` starts with the standard signature line. Both count in a
registered workspace and in a discovered checkout (LLP 0004).

The idle and dormant stages clear an idle workspace's `target/` whole. A
process running from or working in the checkout keeps all of it.

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

The cap is planned at the hourly size scan, and hourly on its own while host
load defers that scan; the size scan itself runs after at most 3 hours of
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

Reason: Cargo keeps every old build of a crate, so a `target/` in daily use
grows without bound, and a checkout in use is never cleared by the idle rules.
Directory times say nothing about whether a fresh dependency was used, so units
go only where Exact's ledger records use.

Maintainer decision: "yes lets do this", 2026-11-12, in answer to the proposal
to tighten the cap under pressure. The ledger conditions and the one unit per
crate were added by the reviews of #5539. Not decided: whether
`stim gc --pressure critical` clears the whole `target/` of a checkout in use.

## Never delete what a build took back

Each removal renames a directory into `target/.stim-trimmed/` after the lock
check and checks the locks again at the new path. A build that took a lock in
between gets the directory back. A directory that cannot be put back is never
deleted: it moves to `target/.stim-not-restored-*`, which later trims skip, for
a person to merge or delete. If that move fails too, it stays in
`.stim-trimmed` with a marker, and later trims of that `target/` stop until a
person removes it.

Build units move aside in chunks of 25 and are put back path by path when a
lock appears after a chunk. A unit path a build has recreated in the meantime
is left alone and the copy aside is deleted, since the build made its own. A
unit that cannot be put back stays in `.stim-trimmed` with the marker.

Reason: a directory a build locked during the move is that build's live output;
deleting it breaks the build rather than slowing the next one.

Chosen by the coordinator and the reviews of #5518 and #5539, not by the
maintainer.

## Links

- Issues: #5512, #5516, #5523, #5528, #5530. Pull requests: #5518, #5519,
  #5527, #5539.
- Code: `packages/stim-cli/src/workspace/cargo-target.ts`,
  `packages/stim-cli/src/stimd/passes/cargo-target.ts`,
  `packages/stim-cli/src/stimd/passes/defer.ts`,
  `packages/core/state/settings-registry.ts` (`maintenance.cargoTargetMaxGb`).
