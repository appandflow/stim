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

On macOS, with the new path on the source checkout's volume and the clone
helper available, the command does not check files out:

1. `git worktree add --no-checkout` registers the worktree.
2. One `clonefile(2)` call per top-level entry of the source checkout clones
   the tracked and the ignored files together, skipping `.git`, every entry
   that is or holds another worktree, and every ignored directory the warm
   leaves out or checks before carrying. An entry that holds such a directory
   is cloned child by child around it, 256 clones to a helper call. One more call clones the source's index.
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

Git creates the worktree and the normal warm fills it when the platform is not
macOS, the new path is on another volume, the helper cannot be compiled, git
is older than 2.41, the
source index marks a file assume-unchanged or skip-worktree or is a split
index, `core.autocrlf=true` or `core.eol=crlf` makes a checkout write CRLF,
`core.symlinks=false` makes it write links as files,
`attr.tree` or `GIT_ATTR_SOURCE` names another source of attributes,
`core.attributesFile` names a file in the worktree, two
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

Linux file systems with reflinks take the plain path today.

Maintainer decision: "Can we support submodules? Can we fallback instead of refuse if not possible?", 2026-11-26 (#6542).

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
or 0 MB against 113 MB at the source's own commit. Git work started beside the
`clonefile` call waits for it, so the two do not overlap.

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
  bytes (#6547).
