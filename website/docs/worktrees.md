---
title: 'Worktree isolation'
sidebar_position: 2
description: 'Parallel worktrees that share expensive build caches'
---

import StimTabs from '@site/src/components/StimTabs';

:::note[Command examples]

Commands use `stim`. If it is not installed globally, replace `stim` with
`npx stim`.

:::

## Create with Git

Use Git to choose the branch, path, and starting commit. Prefer a sibling
worktree directory: nested worktrees can confuse Metro, TypeScript, and other
filesystem scanners even when Git ignores them.

<StimTabs
code={`git worktree add -b feature-x ../feature-x HEAD
cd ../feature-x
stim worktree warm`}
/>

If a harness already created the linked worktree, skip Git creation and run
`stim worktree warm` there.

## Warm ignored state

Warm copies from the repository's source checkout, regardless of either
branch's `HEAD`. That checkout must still be available. In a bare-repository
layout, where every checkout is a linked worktree beside a bare `.git`, the
source checkout is the worktree on the branch the bare repository's `HEAD`
names; warm refuses with the exact Git command to run when that branch has no
worktree or `HEAD` is detached. It copies missing
ignored entries, including installed dependencies, Pods, native build output,
`.env`, and local configuration files. APFS clones keep copies space-efficient
where supported; a normal byte copy is used when cloning is unavailable.
Copies go directly to the destination with no intermediate staging. Keep the
source checkout and the linked worktree on the same volume to benefit from CoW;
`STIM_TMPDIR` and `tempDir` do not affect warming.

Warm preserves the current branch, tracked files, and every existing
destination entry, including dangling symlinks. An existing ignored directory
such as `node_modules` is skipped whole; warm does not fill missing children.
Untracked files that Git does not ignore are not copied.

Wait for warm to exit successfully before editing, installing dependencies,
starting Metro/builds, or running another warm in that worktree. **Concurrent
writes to the destination are unsafe:** existing entries are checked before
copying, not during it. Concurrent files can be overwritten or removed.

Stim excludes:

- Nested registered Git worktrees, including ignored parents containing them.
- `.DS_Store` files and any `.DerivedData` or `.idea` directory, including inside newly copied directories.
- `android/build/generated/autolinking`, including in nested apps, so Gradle
  regenerates paths for the new checkout.
- Paths matched by the source checkout's nonempty `.worktreeexclude`, or its
  resolved `worktree.exclude` setting when that file is absent or empty.
- Destination paths that overlap a registered nested worktree or have symlink
  ancestors.

Tracked `.idea` settings come from Git and stay untouched by warm.

Other generated state stays eligible: `.gradle`, `.cxx`, `*.tsbuildinfo`,
`build` directories, and embedded JavaScript need project-specific decisions
about regeneration. Native intermediates can record the source checkout's
paths; warm does not relocate them. Excluding the whole `.expo` directory can
drop generated TypeScript inputs.

Choose exclusions against the entries Git lists from the source checkout's
repository root:

```sh
git ls-files --others --ignored --exclude-standard --directory --no-empty-directory
```

Patterns match these entries with the trailing `/` removed; they do not prune
children of a whole ignored directory. If Git lists
`android/app/src/main/assets/`, excluding its `bundle.jsbundle` child has no
effect. Exclude `android/app/src/main/assets` only when the project regenerates
everything inside it. Existing destination entries are always preserved.

Warm writes only to stderr: copied, kept, and failed entry counts, plus any
lockfile remedies. A failure exits 1; files already copied remain. Inspect
the named failure before retrying, because a partially copied directory is
kept on retry. A completed copy does not prove dependencies are installed or
match the current branch. When the carried `node_modules` records the lockfile
it was installed from (npm `node_modules/.package-lock.json`, pnpm
`node_modules/.pnpm/lock.yaml`, Yarn `node_modules/.yarn-integrity` or
`node_modules/.yarn-state.yml`), warm compares it with this worktree's lockfile
and prints the install command when they differ. A pnpm install run with
`--filter` or `--prod` records only part of the lockfile and also reads as a
difference. Otherwise it compares the source checkout's lockfile with
this one. Warm never installs. Install missing dependencies with the project's
package manager when the source checkout has none to copy.

## Refresh the source checkout first

Every worktree is a copy of the source checkout, so a stale one seeds stale
worktrees. `stim worktree warm --refresh` updates it before the copy:

<StimTabs
code={`stim worktree warm --refresh`}
/>

It checks the branch's upstream, fetches changes when needed, and fast-forwards
**whatever branch the source checkout has** to its `@{upstream}`, and then installs only what the new commits
moved: the lockfile's own install command where the lockfile lives (the
repository root in a monorepo), and `pod install` for the app you ran the
command from. Each dependency and Pods step names its source directory and
prints what it did or why it skipped.

The flag is opt-in because it writes to a checkout you are not standing in. It
refuses one it cannot move -- uncommitted changes to tracked files or a rebase
or merge in progress (`STIM_MAIN_DIRTY`), a detached `HEAD`
(`STIM_MAIN_DETACHED`), or a branch both ahead of and behind its upstream
(`STIM_MAIN_DIVERGED`) -- and names the git command that clears it. Untracked
files are not a reason to refuse, a branch with no upstream is left alone, and a
fetch that fails is reported as a fact while the run continues on local state.
It never switches branches, merges, or resets. When the source checkout is not
on the default branch it warns and continues, because the copy then carries that
branch's dependencies; set `worktree.defaultBranch` in the repository-root
`.stim.json` when `origin/HEAD` is missing or wrong.

An install that fails is remembered, and a plain warm reads that before it
copies. The refresh records the install it completed for the lockfile it read;
when the last install of the lockfile as it stands now did not finish, a plain
warm refuses with `STIM_DEPS_INCOMPLETE` and copies nothing, because the
dependencies in the source checkout are partial and only the refresh's own
terminal ever said so. Run `stim worktree warm --refresh`, which reinstalls for
the same reason. A record of a different lockfile does not block a copy, and a
repository with no record copies exactly as it did before.

One lock per repository protects this, with or without the flag. A refresh
first checks under a shared claim: `git ls-remote` confirms the upstream commit
without changing local Git refs. If the checkout, dependencies and Pods are
current, it reports `acquired shared (seed current)` and copies alongside other
warms. It takes an exclusive claim only when it needs to fetch changes,
fast-forward or install, or cannot confirm the upstream. After waiting, it
checks the checkout again before writing. Every copy holds shared, so no copy
reads a `node_modules` a refresh is rewriting. A holder that dies frees the lock.
A refresh whose install runs in a
spawned process group holds the lock while any member of that group lives, so a
package manager's postinstall writer cannot outlive the protection.

Both plain warm and `--refresh` refuse before copying when they cannot record a
claim. Missing process identity, denied write access or read-only claim storage
report `STIM_CLAIM_UNAVAILABLE` with recovery instructions. Restore access to the
same claim store before retrying; a different `STIM_HOME` would hide concurrent
warm operations. A non-directory claim path reports `STIM_CLAIM_REFUSED`, names
the blocking file and prints a move-aside command that preserves its contents.
Inspect that file first, and preserve any existing backup when prompted.

## Parallel environments

Each workspace receives a unique Metro port, state directory, and owned
device when Stim starts and runs the app. Build and Metro caches remain shared.
Several agents can work in parallel without sharing live resources.

`stim status` shows linked worktrees with their environment state, including
those with no Stim environment yet. It covers every repository with a
registered environment, plus the repository you run it from. A worktree whose
app lives in a subdirectory, such as `apps/mobile`, counts as having an
environment once that app is registered.
`stim status --json` lists the others under `unprovisionedWorktrees`, each
with its `path`, `branch`, and `repository`. `worktree warm` copies
dependencies but does not create an environment, so a warmed worktree stays in
that list until `start`, `ios`, `android`, or `doctor` registers it.

Each worktree also reports its git state: the number of changed and untracked
files, its upstream with commits ahead and behind, and whether its branch is
merged into the default branch. In `--json` that is the `git` object on each
`unprovisionedWorktrees` entry and on each environment's `worktree`, with
`changed`, `untracked`, `upstream`, `ahead`, `behind`, and `mergedInto`. The
merge check is the one `stim gc` uses, applied to the refs already fetched;
status never fetches. `git` is `null` when git fails or does not answer within
3 seconds.
`stim status --watch` rereads a worktree's git state when a commit, checkout,
staging change, push or fetch touches its git files, and at least once a
minute, so an edit that is not staged can take up to a minute to show.

Status reads the worktree list from git's records in the repository. It runs
`git status` only in worktrees outside macOS-protected folders, or in ones with
a registered environment, so a worktree under `~/Documents` or `~/Desktop` is
listed without triggering a privacy prompt, with `git` set to `null`.

## Remove a worktree

<StimTabs
code={`stim stop
stim worktree remove`}
/>

Removal works with any linked worktree, warmed or not. Git registration
identifies the worktree; no Stim registry entry is required. The command
reclaims any owned resources before removing the linked checkout. It parks
eligible owned iOS simulators and Android emulators when parking is enabled;
see [devices and cleanup](/docs/owned-devices) for reuse and eviction rules.
It refuses uncommitted, untracked, or unpushed work and initialized submodules
unless you pass `--force`. It refuses a worktree locked with `git worktree lock`
even with `--force`; unlock it first. Both checks run before any resource is
reclaimed.

Git-created branches stay. An existing Stim ownership record permits deleting
a branch only when it has no unique commits.

On the source checkout, `worktree remove` only reclaims the Stim environment.
It does not remove that checkout.

Windows cannot delete a directory another process holds open. The adb server
inherits the working directory of the adb client that starts it, and the
emulator launcher passes its own to qemu and its crash handler, so Stim runs
its first adb command and the emulator from your home directory rather than
the worktree. When removal still reports `Permission denied`, a server or
another process was started from inside the worktree; `adb kill-server`
releases the server.

Named ports allocated by `stim ports get <label>` belong to the workspace.
`worktree remove` stops their TCP listeners and releases the allocations;
`gc --delete` does the same for missing workspaces. `stim stop` leaves them
alone. See [named server ports](./dev-server-and-logs.md#named-server-ports).

## Remove finished worktrees in bulk

<StimTabs
code={`stim gc
stim gc --delete
stim gc --delete --worktrees --older-than 3`}
/>

`gc` lists every linked worktree that has a Stim workspace and says why each
one is removed or kept. A worktree is finished when its branch is merged into
the default branch, or when its pull request was merged or closed, and plain
`gc --delete` removes it. `--worktrees` also
removes a worktree that is idle: no Stim command has used it for
`--older-than` days, or 7 days without that option. Either way, gc keeps a
worktree that is the source checkout, bare, locked, in use, dirty (untracked
files count), unpushed, or has initialized submodules. In use includes a
running dev server, a Stim run or live build, a booted owned simulator or
emulator, and a held device lease; a device left booted keeps the worktree
until `stim stop` or `stim gc --idle` shuts it down. With `--delete`, gc runs
`stim worktree remove` without `--force` on each removable worktree. That
command checks the worktree again before removing it, parks or shuts down its
devices, and handles branches as it does when you run it yourself. A worktree that fails is
reported and the others still run. A worktree removed with
`git worktree remove` or `rm -rf` leaves its Stim workspace directory behind;
plain `gc --delete` removes those.

To decide that a branch is merged, gc takes the default branch from
`origin/HEAD` and runs `git fetch origin <default>` once per repository, with a
30-second timeout. It skips the fetch when that checkout fetched in the last 10
minutes. The branch counts as merged when:

- a merge commit brought its HEAD into the default branch, and the branch's
  reflog shows a commit made on it that HEAD contains. A branch with no commits
  of its own, such as one just created, cut from another branch, or reset onto
  one, is not merged.
  The next two apply only to a branch that changes the tree:

- it has no merge commits and each of its commits has the same
  `git patch-id --verbatim` as a commit on the default branch, as after a
  rebase merge.
- its whole diff has the same verbatim patch id as a commit on the default
  branch, compared on the files the branch changes, as after a squash merge.

From git alone, a squash merge whose content changed while merging, such as a
conflict resolution or even a whitespace edit, does not match; neither does a
branch that was fast-forwarded, or a stacked pull request merged after the one
below it. The pull request check covers those. When `origin/HEAD` is not set, the fetch fails, or git
cannot answer, gc does not treat the branch as merged and reports why. After a
squash or rebase merge whose remote branch was deleted and pruned locally, the
branch's commits exist only locally; gc still removes the worktree, because
their change is on the default branch, and keeps the branch.

gc also asks GitHub, with one `gh api graphql` query per repository that
looks up the 20 newest pull requests of each worktree's branch, as
`gh pr list --head <branch> --state all` would. For each worktree it takes the pull
request whose head is the worktree's HEAD, or contains it. A pull request from
an older use of the same branch name, or one HEAD has moved past, does not
count, and an open one never finishes a worktree. A merged or closed pull
request finishes it, with the same clean-state rules. After a merge, commits
whose remote branch was deleted do not keep the worktree, because GitHub keeps
them in the pull request. After a close they do: gc reports the worktree as
unpushed. When `gh` is not installed, not signed in, or fails, gc says so
(`pullRequestUnknown` in `--json`) and decides from git alone.
`stim worktree remove` makes the same check when local-only commits would
refuse the removal, so a worktree whose pull request was squash-merged and
whose branch was deleted is removed without `--force`.

gc also waits out a grace period, 2 hours by default, before it removes a
finished worktree. The period starts at the worktree's latest activity: a
change to its git index, HEAD or reflog, a Stim state or log write, or the
merge of its branch into the default branch or of its pull request. An agent that just merged its
pull request still has time to run `stim stop` and `stim worktree remove`
itself. gc reports such a worktree as kept with the reason `recent-activity`
and the time it becomes removable (`eligibleAt` in `--json`). When gc cannot
read that activity, it keeps the worktree (`activity-unknown`). Set the period
in minutes with [`gc.worktreeGraceMinutes`](./settings.md); `0` turns it off.

Ask your agent:

```text
Run `stim gc --json` and show me which merged worktrees it would remove and
why it keeps the others. Do not pass --delete until I confirm.
```
