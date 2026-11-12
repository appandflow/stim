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

## Edits inside dependency folders

A node_modules or Pods tree whose files changed after its install is never
deleted silently. Below critical it is kept; at critical its changed files are
saved, then it is deleted. Two cases keep it even at critical, so they can block
freeing disk: more changed files than are saved (over 1000 files or 64 MB), or
a directory in it that cannot be read.

- Before a tree is deleted, Stim lists its files modified after a reference,
  from file times alone; it never reads or hashes them.
- The reference is when an install, `pod install` or `stim worktree warm`
  that Stim ran there finished, after every script. Otherwise it is the
  package manager's stamp (`.modules.yaml`, `.package-lock.json`,
  `.yarn-state.yml`, `.yarn-integrity`, `Pods/Manifest.lock`). A package's
  node_modules without a stamp uses the nearest one above it. A tree no stamp
  covers (Bun) uses its own and its `.bin` directory's modification times
  plus one minute, which is not saved at critical. With no usable reference
  the tree is kept.
- A 10-minute window after the stamp is install-script output, not an edit,
  only when the root `package.json` (the tree's or the worktree's) declares
  `preinstall`, `install`, `postinstall` or `prepare`. With none the reference
  is the bare stamp. Pods get 60 seconds, since `pod install` writes its
  project after `Manifest.lock`. At critical, files inside the window are saved
  too, except the Pods project, `Target Support Files`, `Headers` and `Local
Podspecs`.
- A later install does not hide an edit. Edits found once are recorded with
  their size and modification time and stay edits while the file is unchanged,
  whatever happens to the stamp. Before Stim runs an install or `pod install`
  into an existing tree it records the edits first. When an install Stim did
  not run moved the stamp past the last reference, a file changed after that
  older reference is still an edit unless its package was reinstalled (its
  `package.json`, or for Pods the pod's directory, was created after it).
- Not counted as edits: the package manager's state files at the tree's root,
  `node_modules/.cache`, `.gradle`, `.kotlin` and `.cxx` directories in a
  package's `android` directory or beside a Gradle build script, a `build`
  directory there that holds Gradle's own output (`intermediates`,
  `generated`, `outputs`, `tmp`, `.transforms`, `kotlin` or `classes`) and
  that the package's `package.json` points nothing into, a package's
  `ios/build`, and `xcuserdata` in Pods.
- Not seen: an edit that keeps an older modification time (`cp -p`,
  `rsync -t`, a tar extract), a file deleted by hand, edits inside the
  excluded directories, and an edit made within the script window after an
  install Stim did not run (seen only at critical, where it is saved).
- At normal and high a tree with edits is kept with a reason naming them, in
  the kept action, `stim status` and `stim doctor`. A kept tree is not walked
  again while its install signature and its recorded edits are unchanged.
- At critical the files are copied into the worktree archive with a manifest;
  each copy is checked by size only. The tree is deleted and the action gives
  the `cp -R` command that puts them back. `stim status`, `stim doctor` and
  `stim worktree warm` name the copy until it is restored or retention removes
  it (`archive.maxAgeDays`, 30 days by default, and `archive.maxTotalGb`).
- `stim worktree remove` saves the edits of every dependency tree it deletes,
  nested ones included, the same way. Without `--force` it refuses when a save
  cannot be done; `--force` still saves and only lets a failed save not stop
  the removal.
- `stim doctor`, `stim gc --dry-run` and a report-mode pass write nothing.

Reason: an agent patches a library in node_modules to get a build working, and
a reinstall silently undoes it. Below critical, a wrong keep costs disk until
the next reinstall; at critical, saving every changed file costs kilobytes, so
a guess that build output is an edit does not lose a fix.

The maintainer raised the case ("there is 1 case i worry about is agwnt doing
changes locally in node modules to fix libs and it being deleted on
maintenance"), was shown the measures of #5581, and approved them:

Maintainer decision: "I approve of all fixes", 2026-11-12.

The coordinator decided, in the review of #5615, that a later install must not
hide edits, that the script window applies only with an install script and is
saved at critical, that `--force` still saves, that an unreadable directory
keeps the tree at critical, that removal checks nested trees, and that
read-only commands write nothing. The reference times, the exclusion list, the
1000-file and 64 MB caps, the Pods window and the save location were chosen by
the implementing lane and the coordinator in #5581 and #5615, not by the
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

- Issues: #5492, #5512, #5520, #5581. Pull requests: #5514, #5519, #5526, #5615.
- Code: `packages/stim-cli/src/stimd/passes/runtimes.ts` (`planRuntimes`),
  `packages/stim-cli/src/stimd/passes/unowned.ts` (`machineCleanupRefusal`),
  `packages/stim-cli/src/commands/worktree.ts` (`provenPodChurn`),
  `packages/stim-cli/src/workspace/hidden-edits.ts`,
  `packages/stim-cli/src/workspace/dependency-edits.ts`.
