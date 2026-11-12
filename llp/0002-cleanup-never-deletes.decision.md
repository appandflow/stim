# LLP 0002: What cleanup never deletes, and failing closed

**Type:** Decision
**Status:** Active
**Systems:** Cleanup
**Author:** Janic Duplessis / Claude
**Date:** 2026-11-12
**Related:** LLP 0001, LLP 0004

## Never deleted

At every level, maintenance, the pressure ladder and `stim gc` never delete:

- source: tracked files, and untracked files git does not ignore;
- uncommitted or unpushed work. A finished registered worktree with
  uncommitted files is archived under `$STIM_HOME/archive` before removal; a
  discovered one is kept instead (LLP 0004);
- anything building, driven, leased, hosted, or pinned with `maintenance.keep`;
- simulators and emulators a person created (`AGENTS.md`, invariant 2);
- the dependencies (`node_modules` and Pods) of a source (main) checkout,
  except after `idle.sourceDormantDays` without activity or at critical after
  2 idle minutes, and always after every linked worktree's (LLP 0001, the main
  checkout goes last).

Only git-ignored regenerable directories go: a real directory inside the
checkout whose files git ignores, with no tracked or unignored file, not reached
through a link, and not a mount point.

Reason: everything Stim deletes must come back by rebuilding or reinstalling.
Work a person made cannot.

## Edits git status does not show

A registered worktree counts as having uncommitted work, so `stim worktree
remove` refuses and the sweep keeps it, or archives it first when finished,
when:

- `project.pbxproj` has any change;
- `Podfile.lock` has a change that is not proven `pod install` output: proven
  means `Pods/Manifest.lock` has the same text, or gc deleted `Pods` while the
  two matched and the lock still has the hash gc recorded;
- a tracked file is marked `assume-unchanged`, or `skip-worktree` with the file
  on disk. A sparse checkout alone does not count.

Reason: Stim cannot tell what `pod install` wrote into a project file from a hand
edit, and a file hidden from `git status` hides its edit too, so removal would
lose work silently.

Chosen by the coordinator and the reviews of #5519 and #5526, not by the
maintainer.

## Machine-wide deletion refuses in a scoped home

Deleting an unused iOS simulator runtime and rung 9 (LLP 0003) act on the whole
machine, not on one Stim home. Both do nothing in a home that `STIM_HOME`
scopes, and under the test runner while the real process executor is active.

Reason: a scoped home is a test or scratch home, and its runs must not delete
the real machine's runtimes or tool caches.

## Runtimes: the one exception to ownership

An unused simulator runtime is the exception to device ownership. A runtime
stays if any simulator on the machine uses it, simctl lacks its runtime
identifier or does not mark it deletable, a project's `ios.runtime` pins it,
or it shares the major version of the active Xcode's simulator SDK. It also
stays if simctl records a use within `maintenance.olderThanDays` (at least
7 days), or its last use is unknown. Setting `maintenance.olderThanDays` to
zero disables runtime deletion. If every installed runtime would otherwise be
removed, keep the newest. Recheck these conditions before each deletion.

The SDK and recency checks avoid making the active Xcode or a recently used
workflow download a runtime again. Keeping at least one installed image
leaves a runtime available for new simulators. [Runtime safeguards](https://github.com/appandflow/stim/pull/5540).

Maintainer decision: "Yes delete old runtimes", 2026-11-11.

## Fail closed

When Stim cannot establish a fact a deletion depends on, it keeps the item and
says why. A failed device or runtime listing plans nothing. Unreadable
activity evidence, an unreadable process list, an unparseable ledger, or a
path on a volume that may be unmounted keeps the item (`AGENTS.md`,
invariant 8). A runtime deletion that cannot read the SDK version or a
project's settings deletes no runtime and reports why under "Needs a person".

Reason: a wrong keep costs space until the next pass; a wrong delete loses
work or breaks a build in progress.

## Links

- Issues: #5492, #5512, #5520. Pull requests: #5514, #5519, #5526.
- Code: `packages/stim-cli/src/stimd/passes/runtimes.ts` (`planRuntimes`),
  `packages/stim-cli/src/stimd/passes/unowned.ts` (`machineCleanupRefusal`),
  `packages/stim-cli/src/commands/worktree.ts` (`provenPodChurn`),
  `packages/stim-cli/src/workspace/hidden-edits.ts`.
