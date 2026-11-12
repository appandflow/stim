# LLP 0003: Caches of tools Stim does not own

**Type:** Decision
**Status:** Active
**Systems:** Cleanup
**Author:** Janic Duplessis / Claude
**Date:** 2026-11-12
**Related:** LLP 0001, LLP 0002, LLP 0006

## What rung 9 clears

Rung 9 empties caches Stim does not own, each through the tool's own command
and only while no process of that tool runs: `npm cache clean --force`,
`yarn cache clean`, `pnpm store prune`, `pod cache clean --all`. Gradle's
`modules-2`, `transforms-N` and `build-cache-N` and the SwiftPM cache have no
clean command, so Stim renames each aside on the same volume and deletes it,
only while no Stim build lock or build slot is live or unresolved. Android
NDKs, system images no AVD uses and `~/.cache/exact` are reported with the
command that removes them, never deleted.

The rules below answer a question the maintainer asked on 2026-11-11: "Can
critical also delete caches stim dont own (maybe just if it is unable to free
enough space? or the cache is getting really big?)". The question approves
nothing by itself; the choices below record what was decided.

## Rung 9 runs only at critical

Rung 9 runs only at the critical level and only after rungs 0 to 8. The daemon
runs it at most hourly. A `stim gc` that measured critical measures again after
the earlier rungs and runs rung 9 only if the disk is still under the critical
level; an explicit `stim gc --pressure critical` always runs it.

Reason: on a machine that is short because of a person's own files, which no
rung can reclaim, rung 9 at high would empty these caches on every pass. The
next build downloads them again, and the disk is no better. They are shared by
every project on the machine, not only Stim's, so they go only when nothing
cheaper is left.

Chosen in the review of #5514, not by the maintainer, following the question's
"critical" and "if it is unable to free enough space".

## Only on the short volume

Rung 9 clears a cache only when the volume holding it is one of those under the
critical level, measured again after the earlier rungs. `stim gc --pressure
critical` treats every volume as short.

Reason: a full external disk must not empty caches on a healthy internal one.
Clearing them there frees nothing where space is needed.

Chosen in the review of #5514, not by the maintainer.

## Never from a build command

The ladder a build command runs in its own process, at the hard floor or for its
headroom (LLP 0006), stops at rung 8. Only the stim-daemon and `stim gc` run
rung 9. It never runs in a scoped home (LLP 0002).

Reason: the build is about to read the Gradle and SwiftPM caches; clearing them
would slow the build that asked for room.

Chosen in the review of #5514, not by the maintainer.

## Links

- Issues: #5492, #5512. Pull request: #5514.
- Code: `packages/stim-cli/src/daemon/ladder.ts` (`unownedRung`),
  `packages/stim-cli/src/stimd/passes/unowned.ts`,
  `packages/stim-cli/src/daemon/passes.ts` (`runCommandLadder`).
