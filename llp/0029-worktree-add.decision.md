# LLP 0029: Adding a worktree

**Type:** Decision
**Status:** Active
**Systems:** Worktrees
**Author:** Claude
**Date:** 2026-11-26

## One command creates a warmed worktree

`stim worktree add [-b <branch>] <path> [<commit-ish>]` creates a linked
worktree and warms it. It takes the path, `-b <branch>` and commit of
`git worktree add`, no other option of it, and runs `git worktree add` with
them from the current directory, so a relative path, a default `HEAD` and Git's branch
guessing behave as they do in Git, and the result is an ordinary Git worktree.
The source checkout is the one `stim worktree warm` copies from. `worktree warm`
stays for a worktree something else created. The path is required: Stim has no
default worktree location. The command keeps stdout empty.

Maintainer decision: "I would create stim worktree add, and keep warm only if a worktree already exists, add would automatically warm I think", 2026-11-26 (#6542).

Maintainer decision: "Yea I think we should keep using source checkout as template", 2026-11-26 (#6542).

Maintainer decision: "Everything sounds good so lets impl it and delay 2.0 a bit", 2026-11-26 (#6542).

## The source checkout is cloned when it can be

On macOS and Linux, where a tracked file of the source checkout clones to the
new path's directory, the command does not check files out. The clones are
made by the prebuilt binary of the `cow-clone` package: `clonefile(2)` on
APFS, one call for a whole directory; `ioctl(FICLONE)` file by file on btrfs
and XFS. On Windows the command takes the plain path (see below).

1. `git worktree add --no-checkout` registers the worktree.
2. One clone per top-level entry of the source checkout brings the tracked
   and the ignored files together, skipping `.git`, every entry that is or
   holds another worktree, and every ignored directory the warm leaves out or
   checks before carrying. An entry that holds such a directory is cloned
   child by child around it. One more clone is the source's index. All of
   them go to one `cow-clone` process, which reads the pairs on stdin.
3. Every cloned tracked file that is not what a checkout of the target commit
   writes is removed, and the permission bits and extended attributes of the
   rest are set to a new file's.
   `git update-index --refresh` then reads every tracked file and records the
   clones' stat data in the copied index, and `git reset --hard` writes the
   tracked files that are missing or differ from the target commit, which
   restores files the source had edited or deleted. Both read
   `.gitattributes` from the target commit.
4. Every submodule path of the target commit is emptied, as `git worktree add`
   leaves it.
5. `git clean -ffd` removes what the target commit neither tracks nor ignores,
   including a nested repository.
6. The warm runs with the entries already in place counted as carried.
7. Every ignored entry the warm did not carry is removed.
8. `post-checkout` runs with the arguments `git worktree add` gives it, since
   `--no-checkout` skipped it. It runs last so the ignored files it writes
   stay. A hook that fails is reported, the command exits 1 and the worktree
   stays, as with `git worktree add`. On the plain path git runs the hook, and
   a worktree git created before failing is warmed the same way. The hook's
   output goes to stderr on both paths.

Reason: a checkout writes every tracked file again, and the warm then clones
the dependency folders beside them. A clone shares the source's disk blocks, so
a new worktree at the source's commit takes no disk of its own. The clone path
saves disk, not time.

Maintainer decision: "since we'd change api a bit I kind of want to include the new worktree add, also can it be combined with warm to run at smae time to make it faster", 2026-11-26 (#6542).

## The result equals git worktree add then warm

The clone brings everything, so two steps make it what the plain path gives.
The warm's own selection decides what counts as carried: `.worktreeexclude`,
`worktree.exclude`, the entries no warm carries, an Expo native folder without
a recorded prebuild, an Exact `target/`. Then every ignored entry outside the
carried ones is removed. This runs whether the warm succeeds, refuses or is
interrupted, so a refused warm leaves the worktree as `git worktree add` alone
does.

An entry the warm checks under a claim before carrying it, such as an Expo
`ios/` whose prebuild record it compares while holding the source's native-run
claim, is deleted and copied again under that claim. The first clone ran
outside it, so a prebuild in the source checkout could have been rewriting the
folder.

The directories the warm will not carry are worked out before the clone and
never cloned; the removal afterwards is the safety net for what that misses,
such as files. Reason: cloning a large folder only to delete it costs more than
the checkout it replaces. On a checkout with an ignored `.pnpm-store` of 88,000
files and another ignored folder of 154,000, the command took 20 s against 6 s
for the plain path until those were skipped. A wrong guess costs time only: the
warm copies what is missing and the removal takes what it did not carry.

A submodule folder is emptied by removing files, and no git command runs inside
it. Submodules are supported, not refused.

## The source claim spans the clone and the warm

On the clone path the command takes one shared warm claim on the source
checkout before `git worktree add --no-checkout` and releases it when the warm
has checked what it carried, before the prune and `post-checkout`.

Reason: a `stim worktree warm --refresh` between the clone and the warm could
fast-forward and reinstall the source, and the warm would then compare an older
clone with the newer source. Taking the claim first means an interrupt, a lock
timeout or an unavailable claim while the command waits leaves nothing behind:
git has not registered the worktree or created the branch yet. Releasing it
before the hook lets a hook run `stim worktree warm --refresh`, which needs the
source exclusively, and keeps a slow hook from holding off a refresh or
maintenance.

## It falls back instead of refusing

Before git registers anything, the command clones one tracked, non-empty file
of the source checkout to a temporary name in the nearest existing directory
above the new path and removes it. A clone that fails there decides the plain
path, and its reason from `cow-clone` (`unsupported`, `cross-device`, or
`failed` with the errno name) is the reason the output gives. Reason: without
the test, every run on ext4 would register a worktree and a branch, fail at
the first file, remove both and add them again. A device number comparison
cannot stand in for it: two btrfs subvolumes have different device numbers
and clone into each other. The file is not empty, because cloning an empty
file shares no blocks and need not fail where cloning cannot work.

Git creates the worktree and the normal warm fills it on Windows, when the
file system cannot clone (ext4), the new path is on another volume, git
is older than 2.41, the
source index marks a file assume-unchanged or skip-worktree or is a split
index, `core.autocrlf=true` or `core.eol=crlf` makes a checkout write CRLF,
`core.symlinks=false` makes it write links as files,
`attr.tree` or `GIT_ATTR_SOURCE` names another source of attributes,
`core.attributesFile` names a file in the worktree, `GIT_CONFIG_GLOBAL` or
`GIT_CONFIG_SYSTEM` is a relative path, which git reads from the worktree
while it is still being cloned, two
tracked paths of the target commit differ only in case or Unicode form, a
tracked folder is spelled another way on disk, or any step from 2 to 5 fails. `git reset --hard` keeps both index flags, so a copied index would
carry the source's hidden edits and its sparse checkout into the new worktree.
After a failed step the command removes the worktree and the branch that call
created, never a branch that existed before, and runs `git worktree add` again
with the same arguments. An interrupt does the same removal and stops. The
output names which path ran and, for the plain one, why.

A refusal from `git worktree add` itself, such as an existing branch or path,
fails the command: the plain path would fail the same way. A failure in the
warm reports as `worktree warm` reports it and leaves the worktree.

Maintainer decision: "Can we support submodules? Can we fallback instead of refuse if not possible?", 2026-11-26 (#6542).

## On Windows only the warm clones

On Windows `worktree add` always takes the plain path, and the warm clones the
ignored entries on ReFS and a Dev Drive.

Reason: `cow-clone` copies a junction as its reparse data, so a cloned
junction keeps its target, and a pnpm `node_modules` is full of junctions
into the source checkout. Git for Windows takes a junction for a directory:
a reset that puts a file where a cloned folder is deletes through its
junctions, and one that writes tracked files below a junction writes into
what it leads to. Pointing the links at the new worktree before git runs was
tried and did not hold: Node cannot tell a junction from a directory symbolic
link, reads a junction to a volume mount point as a plain directory, and a
link spelled through another path or through another link still led out.
Git for Windows also records no inode and uses creation time as change time,
which a ReFS clone keeps, so a copied index would vouch for files git never
read. The warm runs no git command that writes, so it can clone: git has
already checked out the tracked files into an empty directory.

After cloning an entry on Windows, the warm walks it and points every
absolute link that leads into the source checkout at the same place in the
new worktree, as its copy does (#6464). It does not walk into a junction
that Node reads as a directory. Without the create-symbolic-link privilege
`cow-clone` fails a tree that holds a symbolic link with `EPERM`, and the
warm copies that entry, with a junction for a directory link.

The cost is disk for the tracked files only: the ignored folders, the bulk
of a checkout, are still shared. #6554 tracks what cloning the tracked files
on Windows would need.

## The index is refreshed before the reset

The refresh runs right after the clone, with git's normal stat checks, and the
reset follows it.

Reason: the cloned index describes the source's inodes and change times. A
reset on it rewrites every tracked file, which is the checkout the clone was
meant to avoid. `core.checkStat=minimal` on the reset avoids that by comparing
only size and whole-second modification time, but an edit in the source that
keeps both then survives into the new worktree, although `git status` in the
source sees it through the change time. Refreshing first reads every tracked
file, so the reset restores exactly the files whose content differs, and the
index the command leaves is current: the first `git status` reads nothing, and
no refresh holds `index.lock` after the command returns. A split index is not
copied, because its entries live in a second file.

The refresh costs about what the checkout it replaces costs, so the clone path
saves disk, not time. On a clone of this repository with 18 `node_modules`
folders (3.9 GB), a worktree 50 commits behind took about the same time as
`git worktree add` then `stim worktree warm`, a `clonefile` of the dependency
folders being about 2 s of both, and held 9 MB of private disk against 113 MB,
or 0 MB against 113 MB at the source's own commit. The refresh reads the
clones, so it starts after the `clonefile` call. The configuration checks,
`git ls-tree -l` and `git check-attr --source=HEAD` read only the
configuration and the object database, so they run beside it; the index is
cloned first, because `check-attr` reads it.

## A clone is kept only as a checkout writes it

The tracked files of the new worktree equal what `git worktree add` writes for
the target commit in bytes, permission bits, names and extended attributes.
Before the refresh, for every path of the target commit:

- a file is removed, so the reset writes it, when the commit's attributes give
  it an `ident`, a `filter`, a `working-tree-encoding` or an `eol` other than
  `lf`, when its size is not its blob's, or when its name is spelled another
  way on disk, in case or Unicode form;
- a link or a file standing where the commit has a folder is removed;
- a file gets mode 0666, or 0777 when the commit marks it executable, and a
  folder or a link 0777, each less the umask;
- every extended attribute is removed from the files and folders that stay.

The refresh and the reset run with `--attr-source=HEAD`, `core.checkStat` at
its default and `core.fsmonitor` off. The configuration is read in the new
worktree, which can differ from the source checkout's. Three things are not
made equal: a cloned file keeps the source checkout's modification time, its
BSD file flags, and the `com.apple.provenance` attribute, which macOS sets and
`xattr` cannot remove. When the `uchg` flag stops a change, it is cleared
from the paths in that call, or from the whole new worktree, and the change
runs again. Blob sizes are read with `GIT_NO_LAZY_FETCH`, so in a
partial clone a file whose blob is missing is left to the reset, which
fetches in one batch.

Reason: the refresh proves that a file cleans to its blob, not that it is the
file a checkout of that blob writes. A file written with LF where the commit
asks for CRLF, a `$Id$` expanded for another blob and a file a smudge filter
would rewrite are all clean and all differ from a checkout. Once the paths a
checkout converts are left to git, the only conversion the refresh can still
apply is CRLF to LF, which changes a file's size, so a file of its blob's size
that the refresh accepts holds the blob's bytes. That holds only while the
refresh, the reset and this step read the same attributes, and the working
tree's are the source checkout's, with its untracked `.gitattributes`. So all
three read the target commit's. The refresh must also read every file:
under `core.checkStat=minimal` a clone matches its source's entry by size and
whole-second time, and the fsmonitor bitmap of the copied index marks files
git then skips. `clonefile(2)` copies permission bits, names
and extended attributes as they are on disk, and it does not copy access
control lists. Every path is reached only through folders that are real
folders in the new worktree, because a cloned link can lead into the source
checkout.

A case this would need more than a file's removal for takes the plain path: a
folder spelled another way on disk holds ignored files, and of two paths that
differ only in case a case-insensitive volume holds one. A path that names
`.git` takes it too, where git refuses the commit.

On Linux the extended attributes and the link modes are left alone:
`cow-clone` copies no extended attribute there, and a Linux link's mode is
always 0777, which no call changes. The file and folder modes are set as on
macOS, since a clone there keeps the source's permission bits too. Those
modes come from the umask, so the command first makes a folder and a file in
the new worktree and takes the plain path when their modes are not the
umask's: under a set-group-ID folder or a default ACL a checkout writes other
bits, and a clone set to the umask's could be readable where the ACL denies
it.

Extended attributes are cleared with `xattr -c -s`, 1,000 paths to a call and
four calls at a time. On a checkout of 19,021 tracked files the step adds about
0.6 s to the command, half of it those calls; one call after another took
0.74 s for them alone. On this repository, 3,811 tracked files, it adds about
0.2 s.

## Not decided

- A branch the command creates is not recorded as Stim's, so
  `stim worktree remove` keeps it.
- Writing the clones' stat data into the copied index directly, which would
  remove the refresh. Stat data cannot prove that a clone holds its blob's
  bytes (#6547). Every clone has a new inode and change time, so no subset of
  the entries matches its stat data without that. The refresh is the hashing:
  on 19,021 tracked files it took 2.7 s, against 2.4 s for
  `git hash-object --stdin-paths` over the same files (#6562).
