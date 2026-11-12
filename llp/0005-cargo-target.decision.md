# LLP 0005: Cargo target directories

**Type:** Decision
**Status:** Active
**Systems:** Cleanup, Exact
**Author:** Janic Duplessis / Claude
**Date:** 2026-11-12
**Related:** LLP 0001, LLP 0004

## An idle target is cleared whole

The idle and dormant stages clear the whole Cargo `target/` of an idle
workspace: an Exact app's `target/` beside `exact.mjs`, and, for every checkout,
a `target/` at the checkout root whose files git ignores and whose
`CACHEDIR.TAG` starts with the standard signature line. A process running from
or working in the checkout keeps all of it.

## The in-use cap

`maintenance.cargoTargetMaxGb` (default 25 GB, 0 for none) caps an Exact app's
`target/` while the app is in use. Over the cap, maintenance removes the profile
and target-triple directories no build wrote in the last day, then, if still
over, the `incremental` directory of each remaining profile, largest first,
until the overage is covered.

"Wrote in the last day" comes from directory modification times and the unit
stamps in Exact's `.exact-sweep.json`, never from access times. Reason: reads
leave no trace on default APFS, shown in the review of #5518.

The cap skips only the paths a process executes from or holds open, read once
with `lsof` and `ps`, and every profile whose `.cargo-lock` a build holds. An
unreadable process list keeps everything. Reason: one helper running from
`target/exact-filesystem-tool/` used to keep a 150 GB `target/` whole.

## Never delete what a build took back

Each removal renames the directory into `target/.stim-trimmed/` after the lock
check and reads the lock again at the new path. A build that took the lock in
between gets the directory back. A directory that cannot be put back is never
deleted by the cap. It moves to `target/.stim-not-restored-*`, which later trims
skip, for a person to merge or delete. If that move fails too, it stays in
`.stim-trimmed` with a marker, and later trims of that `target/` stop until a
person removes it.

Reason: a directory a build locked during the move is that build's live output;
deleting it breaks the build rather than slowing the next one.

Chosen in the reviews of #5518, not by the maintainer.

## Planned

- The cap also covers a Cargo workspace root's `target/` and the targets of
  discovered checkouts (#5523, pull request #5527). Today a root `target/` in
  use is unbounded; that is the 150 GB case.
- Under pressure the cap tightens: at high every recognised `target/` loses
  all stale profiles and all `incremental` data whatever the cap; at critical
  also the compiled artifacts inside in-use profiles that no build used in the
  last day, keeping the newest unit of each crate (#5528).
  Maintainer decision: "yes lets do this", 2026-11-12, in answer to the
  proposal to tighten the cap under pressure. Not decided: whether
  `stim gc --pressure critical` clears the whole `target/` of a checkout in
  use.

## Links

- Issues: #5512, #5516, #5523, #5528. Pull requests: #5518, #5519.
- Code: `packages/stim-cli/src/workspace/cargo-target.ts`,
  `packages/stim-cli/src/stimd/passes/cargo-target.ts`,
  `packages/core/state/settings-registry.ts` (`maintenance.cargoTargetMaxGb`).
