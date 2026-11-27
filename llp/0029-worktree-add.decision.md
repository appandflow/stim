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
   is cloned child by child around it, 256 clones to a helper call.
3. The source's index, read before the first clone, is written to the new
   worktree with the clones' stat data in every entry the source checkout
   proves unchanged. `git update-index --refresh` runs when an entry is left
   unproven and reads those files only. `git reset --hard` then rewrites only
   the tracked files that differ from the target commit, which restores files
   the source had edited or deleted.
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
a new worktree at the source's commit takes no disk of its own, and git reads
no tracked file the source checkout had not changed.

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
macOS, the new path is on another volume, the helper cannot be compiled, the
source index marks a file assume-unchanged or skip-worktree or is a split
index, or any step from 2 to 5 fails. `git reset --hard` keeps both index flags, so a copied index would
carry the source's hidden edits and its sparse checkout into the new worktree.
A source index that parses and has gained such a flag, or become a split or
sparse index, between that check and the copy counts as a failed step.
After a failed step the command removes the worktree and the branch that call
created, never a branch that existed before, and runs `git worktree add` again
with the same arguments. An interrupt does the same removal and stops. The
output names which path ran and, for the plain one, why.

A refusal from `git worktree add` itself, such as an existing branch or path,
fails the command: the plain path would fail the same way. A failure in the
warm reports as `worktree warm` reports it and leaves the worktree.

Linux file systems with reflinks take the plain path today.

Maintainer decision: "Can we support submodules? Can we fallback instead of refuse if not possible?", 2026-11-26 (#6542).

## The copied index gets the clones' stat data

The command reads the source's index before it clones anything. After the
clone it looks at each entry's file in the source checkout and at its clone,
and writes the clone's change time, inode, device, owner and group into the
entry when all of these hold:

- the entry is a regular file or a symbolic link at stage 0, not intent-to-add;
- the source file still matches the entry in every stat field git compares,
  nanoseconds included, and in type and executable bit;
- a recorded size of 0 belongs to the empty blob;
- the entry's modification time is in an earlier second than the source
  index's own;
- every parent directory of the path is a real directory in both checkouts,
  and in the source checkout the same one, with the same change time, as
  before the clone;
- the clone has the source file's mode, size and modification time.

Every other entry gets zeroed stat data, the state `git read-tree` leaves, and
`git update-index --refresh` then reads those files. The untracked cache, the
fsmonitor bitmap and the entry offset tables of the source index are not
copied. `TREE` and `REUC` are.

Reason: a clone has a new inode and change time, so git sees every entry of a
copied index as changed. A reset on it rewrites every tracked file, and a
refresh before the reset reads every tracked file, which costs about what the
checkout costs. The test above is the one `git status` runs in the source
checkout. A source file that still matches an entry recorded before the clone
did not change in between, so its clone holds the blob the entry names. The
index is read first because one read after the clone could describe a file
that was edited and added in between, with the clone holding the older bytes.
`git reset --hard` checks a path with `lstat` alone, which follows a symbolic
link that replaced a parent directory, so the parents are checked here. A
directory moved away and back keeps the stat data of its files, so a
look-alike cloned in between would pass for them; the move shows in the
directory's own change time. Git compares the device number only when built
for it, and an index keeps the number its volume had when an entry was
written, so the device is not compared.
`core.checkStat=minimal` on the reset was rejected: it compares only size and
whole-second modification time, so an edit in the source that keeps both
survives into the new worktree.

A file git reports unchanged in the source checkout although the checkout
conversion configured now would write other bytes, after `core.autocrlf`, an
`eol` attribute or a filter changed since it was checked out, keeps the
source's bytes in the new worktree, where `git worktree add` would convert it
again (#6549).

An index the command cannot vouch for is copied as it is and refreshed whole
before the reset, with `core.fsmonitor` off and `core.checkStat` at its default
for both, so neither the copied fsmonitor bitmap nor a size and time match
hides a file: a SHA-256 repository, a version other than 2 to 4, a
checksum that does not match, an extension git requires a reader to
understand, or bytes that do not parse to the end. A split index is not
copied, because its entries live in a second file.

Measured with the command itself, medians of 4 alternating runs on a loaded
machine, against a full refresh before the reset and against
`git worktree add` then `stim worktree warm`:

| Source checkout                                                 | Target     | git + warm | Full refresh | Stat data written |
| --------------------------------------------------------------- | ---------- | ---------- | ------------ | ----------------- |
| expo, 19,021 tracked files, no dependencies                     | `HEAD`     | 2.92 s     | 5.94 s       | 2.05 s            |
| expo                                                            | `HEAD~200` | 3.98 s     | 6.99 s       | 3.56 s            |
| this repository, 3,811 tracked files, 18 `node_modules` folders | `HEAD~50`  | 6.78 s     | 7.70 s       | 6.47 s            |

The full refresh column comes from an earlier run of the same script. The
pass over the index takes about 0.2 s for 19,000 entries. Right after a
`git clone` the files written in the second the index was written are racy,
2,939 of them on the expo checkout, and git reads those until a `git status`
in the source checkout records them again. What is left on
a checkout with dependency folders is their `clonefile`, which both paths pay.
Git work started beside that call waits for it, so the two do not overlap. The
disk result does not change: on this repository a worktree 50 commits behind
held 9 MB of private disk against 113 MB, and 0 MB at the source's own commit.

## Not decided

- A branch the command creates is not recorded as Stim's, so
  `stim worktree remove` keeps it.
