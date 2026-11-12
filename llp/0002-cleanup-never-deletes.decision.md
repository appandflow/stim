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
- the `node_modules` of a source (main) checkout, until #5524 lands
  (LLP 0001, Planned).

Only git-ignored regenerable directories go: a real directory inside the
checkout whose files git ignores, with no tracked or unignored file, not reached
through a link.

Reason: everything Stim deletes must come back by rebuilding or reinstalling.
Work a person made cannot.

## Machine-wide deletion refuses in a scoped home

Deleting an unused iOS simulator runtime and rung 9 (LLP 0003) act on the whole
machine, not on one Stim home. Both do nothing in a home that `STIM_HOME`
scopes, and under the test runner while the real process executor is active.

Reason: a scoped home is a test or scratch home, and its runs must not delete
the real machine's runtimes or tool caches. During the work on #5514 a lane
emptied the real Yarn cache by running `yarn cache clean --help`, which cleans
on Yarn 1.

## Runtimes: the one exception to ownership

An unused simulator runtime is the only thing Stim deletes that it neither
created nor caches. A runtime stays when any simulator on the machine uses it,
when simctl does not mark it deletable, when it is the only runtime or the
newest one with none in use, when a project's `ios.runtime` pins it, when it
has the major version of the active Xcode's simulator SDK, or when simctl
recorded a use within `maintenance.olderThanDays` or none at all.

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

## Planned

- A hand edit to `project.pbxproj`, or a tracked file marked `skip-worktree`
  or `assume-unchanged`, keeps a registered worktree too (#5520, pull request
  #5526). Today removal of a registered worktree treats a change to
  `Podfile.lock` or `project.pbxproj` as `pod install` churn and restores the
  file.

## Links

- Issues: #5492, #5512, #5520. Pull requests: #5514, #5519.
- Code: `packages/stim-cli/src/stimd/passes/runtimes.ts` (`planRuntimes`),
  `packages/stim-cli/src/stimd/passes/unowned.ts` (`machineCleanupRefusal`).
