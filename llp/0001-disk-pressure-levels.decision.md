# LLP 0001: Disk pressure levels and what each deletes

**Type:** Decision
**Status:** Active
**Systems:** Cleanup
**Author:** Janic Duplessis / Claude
**Date:** 2026-11-12
**Related:** LLP 0002, LLP 0003

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
`STIM_LOW_DISK`). High and critical only reclaim, so raising them adds no
refusal.

Reason: at the old defaults (high 20 GB, critical 6 GB) a cold Xcode build took
a MacBook from 15 GB to 7.3 GB in three minutes and the ladder never reached
critical. The high level stays above critical so high always acts first.

The maintainer set critical to 20 GB on 2026-11-11; the 40 GB high level
followed from it (#5492, #5514).

## What each level deletes

Each level includes the ones below it.

- normal: the automatic maintenance plan (caps, the age sweep, orphans, stale
  records, finished linked worktrees after `gc.worktreeGraceMinutes`, unused
  simulator runtimes), and every workspace idle `idle.dormantDays` reduced to
  its minimal size.
- high: the pressure ladder, rungs 0 to 7.
- critical: rungs 0 to 8 with shorter idle times and no grace, then rung 9,
  the caches of tools Stim does not own (LLP 0003).

The full table lives in `website/docs/commands.md` (the `gc` section) and in
`stim guide cleanup`; this document records why the levels are shaped this
way, not the table.

## One idle day reduces a workspace

A workspace with no activity for `idle.dormantDays` (default 1) is reduced to
its minimal size at every level: build outputs, owned devices, logs archived,
and in a linked worktree `node_modules` and Pods. Keep rules exist for work
that would be lost, not for time spent rebuilding.

Maintainer decision: "I think projects not touched for like 1 day should be
reduced to minimal size", 2026-11-11.

Maintainer decision: "Need to be more aggressive in our resources reclaim, i
dont want to have computers in this situation again", 2026-11-11.

Maintainer decision: "make sure all things we can delete are actually deleted
at max pressure level", 2026-11-11.

## Planned

- `maintenance.olderThanDays` default 7 to 3, and linked worktrees reduced
  before the main checkout, which loses `node_modules` and Pods at critical or
  after 7 idle days (#5524). Until it lands the main checkout's dependencies
  are never deleted (LLP 0002).

## Links

- Issues: #5492, #5512. Pull request: #5514.
- Code: `packages/core/state/settings-registry.ts` (defaults),
  `packages/stim-cli/src/daemon/ladder.ts` (rungs),
  `packages/stim-cli/src/commands/gc.ts`.
