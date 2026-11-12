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
`--older-than`, `--worktrees`) are not re-added as flags. They are refused with
a message that names the setting or command that replaced each, and never run a
pass ([LLP 0015](./0015-compatibility-removals.decision.md#removed-gc-flags-name-their-replacement)).
An earlier version of this section read "no need for replacement" as "no
replacement hint"; the coordinator chose the hint in #5621, and the maintainer
has not stated whether it is wanted.

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

## One idle day reduces a workspace

A workspace with no activity for `idle.dormantDays` (default 1) is reduced to
its minimal size at every level: build outputs, owned devices, logs archived,
and in a linked worktree `node_modules` and Pods.

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

## Links

- Issues: #5492, #5512, #5524. Pull requests: #5514, #5540.
- Code: `packages/stim-cli/src/policy/checkout-order.ts`,
  `packages/stim-cli/src/workspace/source-dependencies.ts`,
  `packages/stim-cli/src/stimd/passes/artifacts.ts`,
  `packages/core/state/settings-registry.ts` (defaults),
  `packages/stim-cli/src/daemon/ladder.ts` (rungs),
  `packages/stim-cli/src/commands/gc.ts`.
