# LLP 0029: Adding a worktree

**Type:** Decision
**Status:** Active
**Systems:** Worktrees
**Author:** Claude
**Date:** 2026-11-26

## One command creates a warmed worktree

`stim worktree add [-b <branch>] <path> [<commit-ish>]` creates a linked
worktree and warms it. It runs `git worktree add` with the same arguments from
the current directory, so a relative path, a default `HEAD` and Git's branch
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
   the tracked and the ignored files together, skipping `.git` and every entry
   that is or holds another worktree. One more clones the source's index.
3. `git -c core.checkStat=minimal reset --hard` rewrites only the tracked files
   that differ from the target commit, which restores files the source had
   edited or deleted.
4. Every submodule path of the target commit is emptied, as `git worktree add`
   leaves it.
5. `git clean -ffd` removes what the target commit neither tracks nor ignores,
   including a nested repository.
6. `post-checkout` runs with the arguments `git worktree add` gives it, since
   `--no-checkout` skipped it.
7. The warm runs with the entries already in place counted as carried.
8. Every ignored entry the warm did not carry is removed.
9. `git update-index --refresh` records the cloned files' stat data.

Reason: a checkout writes every tracked file again, and the warm then clones
the dependency folders beside them. A clone shares the source's disk blocks, so
a new worktree at the source's commit takes almost no disk.

The cloned index keeps the source index's modification time, so git still
rereads a file changed in the second that index was written. An edit that keeps
a file's size and modification time is invisible to git in the source checkout
too, and survives.

Maintainer decision: "since we'd change api a bit I kind of want to include the new worktree add, also can it be combined with warm to run at smae time to make it faster", 2026-11-26 (#6542).

## The result equals git worktree add then warm

The clone brings everything, so two steps make it what the plain path gives.
The warm's own selection decides what counts as carried: `.worktreeexclude`,
`worktree.exclude`, the entries no warm carries, an Expo native folder without
a recorded prebuild, an Exact `target/`. Then every ignored entry outside the
carried ones is removed. This runs whether the warm succeeds, refuses or is
interrupted, so a refused warm leaves the worktree as `git worktree add` alone
does.

A submodule folder is emptied by removing files, and no git command runs inside
it. Submodules are supported, not refused.

## It falls back instead of refusing

Git creates the worktree and the normal warm fills it when the platform is not
macOS, the new path is on another volume, the helper cannot be compiled, the
source index marks a file assume-unchanged or skip-worktree, or any step from 2
to 6 fails. `git reset --hard` keeps both index flags, so a copied index would
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

## The index is refreshed before the command returns

The refresh runs while the warm does and the command waits for it.

Reason: without it the cloned index describes the source's inodes, so the first
`git status` reads every tracked file, and Stim's own reads, which pass
`--no-optional-locks`, would do so every time until some git command rewrote
the index. A refresh left running after the command returned holds
`index.lock` until it ends, and a `git add` in that time fails with `Unable to
create '.../index.lock': File exists`, reproduced on 2026-11-26. `git status`
as the background job takes the lock only to write, but it reads the index
first and can then overwrite what a `git add` staged meanwhile.

The refresh costs about what the checkout it replaces costs. On a clone of this
repository with 18 `node_modules` folders (3.9 GB), creating a worktree 50
commits behind took about the same time either way, a `clonefile` of the
dependency folders being most of it in both, and the new worktree held 8.8 MB
of private disk against 113.4 MB.

## Not decided

- A branch the command creates is not recorded as Stim's, so
  `stim worktree remove` keeps it.
- Running the refresh detached, which returns sooner at the cost above.
