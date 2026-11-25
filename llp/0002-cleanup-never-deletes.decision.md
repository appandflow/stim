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
  except after `idle.sourceDormantDays` without activity, and always after
  every linked worktree's (LLP 0001, the main checkout goes last);
- a node_modules or Pods folder with detected hand edits (below).

Only git-ignored regenerable directories go: a real directory inside the
checkout whose files git ignores, with no tracked or unignored file, not reached
through a link, and not a mount point. When the dormant reduction deletes a
recognised Cargo `target/`, it counts as one regenerable directory, apart from
a `deploy/` folder holding a Solana `*-keypair.json` (LLP 0005).

Reason: everything Stim deletes must come back by rebuilding or reinstalling.
Work a person made cannot.

## Rescue copies

Two things in folders cleanup deletes cannot come back by rebuilding or
reinstalling: a `pnpm patch` edit folder in a node_modules `.pnpm_patches`, and
a Solana `*-keypair.json` in a Cargo `target/`. Before maintenance or
`stim gc` deletes a node_modules (every delete that runs the dependency edit
check) or removes a finished or discovered worktree, Stim copies them to
`$STIM_HOME/rescued/<workspace id>/<time>/`, at their paths relative to the
checkout, with a `manifest.json` naming each source path, its size and the
time. Then the delete goes ahead.

- What is copied: for a node_modules delete, every file of its
  `.pnpm_patches` (the edit folders and `state.json`, so `pnpm patch-commit`
  still finds an edit after a restore, including one made with
  `pnpm patch --edit-dir` elsewhere).
  For a worktree removal, one walk of the whole worktree, which does not ask git
  or recognise Cargo targets: it skips `.git`, looks into each node_modules only
  for its `.pnpm_patches` as above, and copies every `*-keypair.json` in any
  letter case anywhere else. A keypair-named fixture is copied too, which costs
  little. The walk took 190 to 310 ms on three checkouts of 28,000 to 33,000
  entries outside node_modules and `.git`, one with a 6.6 GB Cargo `target/`.
- Only plain files are copied, as clones where the volume supports them, with
  no size limit. Links are neither followed nor copied: a linked `target/` or
  node_modules is removed as a link, as before.
- A search or copy that fails or does not finish in 30 s through the bounded
  reader keeps the folder or worktree, with the reason, and removes the partial
  copy. Nothing else holds a delete.
- Each rescue gets its own new folder; the store is created when missing.
- `stim gc` removes rescued copies older than 30 days, lists what it copied in
  that run (`rescued` in `--json`), and `stim doctor` lists every rescued copy
  with its source and age, so an agent restores a file by copying it back.
- Cargo `target/` deletes themselves go through one remover that never unlinks
  a `*-keypair.json` (LLP 0005), so they copy nothing.

The maintainer chose this in the coordinating session on 2026-11-20, answering
"Rescue copies" to the question of rescuing protected items before deleting
instead of detecting committed patches. The 30 days is the coordinator's
choice, a constant in the code rather than a setting.

The copy handles the layouts a regular project has and nothing more. A hold
for an unusual layout kept a folder for good, while what copying anyway can
lose is limited to layouts a regular project does not have, such as a keypair
on another volume mounted inside the worktree.

Not covered:

- a keypair inside a node_modules, which an install restores;
- build folders other than Cargo targets, which are deleted with a plain
  recursive delete;
- `stim worktree remove`, which is explicit and runs none of these checks;
- rescued copies made by the background maintenance pass expire only when a
  `stim gc` runs.

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

Automatic maintenance and `stim gc` never delete a node_modules or Pods folder
in which they detect hand edits, at any pressure level. Such a folder can block
freeing disk at critical: the maintainer chose keeping an agent's fix over its
disk. Detection is best effort. `stim worktree remove` runs no check and
deletes the worktree with its dependency folders.

- Where it applies: before automatic maintenance or `stim gc` deletes a
  node_modules or Pods folder out of a checkout that stays (`stim gc
--dry-run` shows it kept), and before automatic maintenance removes a
  finished or discovered worktree, which waits while one of its dependency
  folders has detected edits.
- A kept folder's reason names the files, in the kept action, the cleanup
  log, `stim gc --dry-run`, `stim status` (`dependencyEdits`) and
  `stim doctor`, which says its disk is not freed and how to release it: make
  the change a patch (`pnpm patch`, `yarn patch`, `patch-package`) or
  reinstall.
- Detection lists files modified after a reference, from file times alone.
  The reference is when an install, `pod install` or `stim worktree warm` that
  Stim ran there finished. Otherwise it is the package manager's stamp
  (`.modules.yaml`, `.package-lock.json`, `.yarn-state.yml`,
  `.yarn-integrity`, `Pods/Manifest.lock`), the nearest one above for a
  package's own node_modules, or for a tree no stamp covers (Bun) its own and
  its `.bin` directory's modification times plus one minute. Files inside a
  10-minute window after the stamp are install-script output when the root
  `package.json` declares `preinstall`, `install`, `postinstall` or
  `prepare`; Pods get 60 seconds for `pod install`'s own late writes. A tree
  with no usable reference, or with a directory that cannot be read, is kept.
- A later install does not hide an edit already seen: edits are recorded with
  their size and modification time and stay edits while the file is
  unchanged. Before Stim runs an install or `pod install` into a tree it
  records the edits first. When an install Stim did not run moved the stamp,
  a file changed after the previous reference is still an edit unless its
  package (`package.json`) or pod (its directory) was created after that
  reference; inside such a package, a file changed more than 5 seconds after
  its `package.json` was created is an edit (installs wrote every package's
  files within 0.5 s in measurements with npm, pnpm, Yarn and Bun). A tree
  with no record yet uses its stamp file's creation time as the previous
  reference. Acting passes write the record; `stim doctor`, `stim gc
--dry-run` and report-mode passes write nothing.
- Not counted as edits: the package manager's state files, dot-directories
  at a node_modules root other than `.pnpm`, `.bun` and `.deno` (treated as
  tool caches and not checked, a custom pnpm virtual-store directory
  included), the `.bin` directory of any node_modules, where package managers
  regenerate executable links and shims on every install (pnpm 11 writes its
  shims after `.modules.yaml`), `.gradle`, `.kotlin` and `.cxx` in a package's
  `android` directory or beside a Gradle build script, a `build` directory
  there that holds Gradle output and that the package's `package.json` points
  nothing into, a package's `ios/build`, and `xcuserdata` in Pods.

Known misses, accepted as best effort: an edit that keeps an older
modification time (`cp -p`, `rsync -t`, a tar extract); a file deleted by
hand; edits inside the directories above; an edit made inside an install
window, or inside the first window once a project install moves the stamp; an
edit to a package whose `package.json` an editor replaced (`sed -i`, save by
rename), once an install Stim did not run follows. A dependency's own install
script that writes into its package more than 5 seconds after the package was
created looks like an edit after a later install Stim did not run, which keeps
the folder. A record of a tree that is gone is dropped when its volume is shown
mounted (on Linux, where Stim lists only `/`, only while the tree's parent
directory exists).

Reason: an agent patches a library in node_modules to get a build working, and
a reinstall silently undoes it.

The maintainer raised the case ("there is 1 case i worry about is agwnt doing
changes locally in node modules to fix libs and it being deleted on
maintenance"), approved the measures of #5581, and then decided how far they
go:

Maintainer decision: "I approve of all fixes", 2026-11-12.

Maintainer decision: "I think it is fine to be best effort and accept some edge cases", 2026-11-13.

Maintainer decision: "Lets also never delete it even on critical pressure, but maybe it can be noted", 2026-11-13.

Maintainer decision: "on worktree remove lets delete it and not even do the check", 2026-11-13.

Maintainer decision: "only for automatic maintenance", 2026-11-13, completed by "/ gc", 2026-11-13.

The coordinator read the last two as: an explicit `stim worktree remove` runs
no check, while automatic maintenance and `stim gc` keep the folder and hold
automatic worktree removal. The reference times, windows, margins, exclusions
and record handling were chosen by the implementing lane and the coordinator in
#5581 and #5615, not by the maintainer.

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
work or breaks a build in progress. For regenerable build output, a build that
starts after the last check is the accepted exception: it loses that output and
rebuilds (LLP 0005, The loss budget for regenerable build output).

## Links

- Issues: #5492, #5512, #5520, #5581. Pull requests: #5514, #5519, #5526, #5615.
- Code: `packages/stim-cli/src/stimd/passes/runtimes.ts` (`planRuntimes`),
  `packages/stim-cli/src/stimd/passes/unowned.ts` (`machineCleanupRefusal`),
  `packages/stim-cli/src/commands/worktree.ts` (`provenPodChurn`),
  `packages/stim-cli/src/workspace/hidden-edits.ts`,
  `packages/stim-cli/src/workspace/dependency-edits.ts`.

## Kept worktrees are listed, never acted on

List and doctor report what cleanup keeps and its real size; they delete nothing.
Sizes come from saved whole-worktree measures: private bytes for real size,
allocated bytes for apparent size. Real size is unknown when private bytes
cannot be counted. Neither includes Stim workspace data outside the checkout.
Old is 30 days idle; large is 1 GiB real.
Doctor reports one note from saved verdicts and measures only, stating their
age; it never measures or runs the check. List and doctor describe removals
disabled by `maintenance.removeFinishedWorktrees` or
`maintenance.removeIdleWorktrees`, and idle removals while
`maintenance.olderThanDays` is 0, as kept with reason `removal-off`.

[Issue #6365](https://github.com/appandflow/stim/issues/6365)

Maintainer decision: "Another thing that I don't know if we do would be to warn about worktrees that cannot be deleted, once in a while maybe in doctor?", 2026-11-25

Maintainer decision: "Esp if pas certain size / age", 2026-11-25

Maintainer decision: "Lets start with surfacing in doc, can we also add a command in stim worktrees that could list them and surface old / large", 2026-11-25

Maintainer decision: "Can doctor also have a summary of all the worktrees with the list to know total that could be reclaimed, also is it per project? Can it also be machine wide?", 2026-11-25
