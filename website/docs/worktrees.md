---
title: 'Worktree isolation'
sidebar_position: 2
description: 'Parallel worktrees that share expensive build caches'
---

import StimTabs from '@site/src/components/StimTabs';

Commands use `stim`. If it is not installed globally, replace `stim` with
`npx stim`.

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

Warm uses the repository's main checkout as its source, regardless of either
branch's `HEAD`. The main checkout must still be available. It copies missing
ignored entries, including installed dependencies, Pods, native build output,
`.env`, and local configuration files. APFS clones keep copies space-efficient
where supported; a normal byte copy is used when cloning is unavailable.
Copies go directly to the destination with no intermediate staging. Keep main
and the linked worktree on the same volume to benefit from CoW; `STIM_TMPDIR`
and `tempDir` do not affect warming.

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
- Any `.DerivedData` directory.
- `android/build/generated/autolinking`, including in nested apps, so Gradle
  regenerates paths for the new checkout.
- Paths matched by main's nonempty `.worktreeexclude`, or its resolved
  `worktree.exclude` setting when that file is absent or empty.
- Destination paths that overlap a registered nested worktree or have symlink
  ancestors.

Warm writes only to stderr: copied, kept, and failed entry counts, plus any
lockfile remedies. A failure exits 1; files already copied remain. Inspect
the named failure before retrying, because a partially copied directory is
kept on retry. A completed copy does not prove dependencies are installed or
match the current branch. Install missing dependencies with the project's
package manager when main has none to copy.

## Refresh the main checkout first

Every worktree is a copy of the main checkout, so a stale main checkout seeds
stale worktrees. `stim worktree warm --refresh` updates it before the copy:

<StimTabs
code={`stim worktree warm --refresh`}
/>

It fetches the branch's remote, fast-forwards **whatever branch the main
checkout has** to its `@{upstream}`, and then installs only what the new commits
moved: the lockfile's own install command where the lockfile lives (the
repository root in a monorepo), and `pod install` for the app you ran the
command from. Every step prints what it did or why it skipped.

The flag is opt-in because it writes to a checkout you are not standing in. It
refuses one it cannot move -- uncommitted changes to tracked files or a rebase
or merge in progress (`STIM_MAIN_DIRTY`), a detached `HEAD`
(`STIM_MAIN_DETACHED`), or a branch both ahead of and behind its upstream
(`STIM_MAIN_DIVERGED`) -- and names the git command that clears it. Untracked
files are not a reason to refuse, a branch with no upstream is left alone, and a
fetch that fails is reported as a fact while the run continues on local state.
It never switches branches, merges, or resets. When the main checkout is not on
the default branch it warns and continues, because the copy then carries that
branch's dependencies; set `worktree.defaultBranch` in the repository-root
`.stim.json` when `origin/HEAD` is missing or wrong.

One lock per repository protects this, with or without the flag: `--refresh`
holds it exclusively, and every copy holds it shared, so no copy can read a
`node_modules` a refresh is rewriting. Two plain warms still run at the same
time, and a holder that dies frees the lock.

## Parallel environments

Each workspace receives a unique Metro port, state directory, and owned
device when Stim starts and runs the app. Build and Metro caches remain shared.
Several agents can work in parallel without sharing live resources.

`stim status` shows linked worktrees with their environment state, including
those with no Stim environment yet.

## Remove a worktree

<StimTabs
code={`stim stop
stim worktree remove`}
/>

Removal works with any linked worktree, warmed or not. Git registration
identifies the worktree; no Stim registry entry is required. The command
reclaims any owned resources before removing the linked checkout. It parks
the iOS simulator when parking is enabled and deletes owned Android emulators.
It refuses uncommitted, untracked, or unpushed work unless you pass `--force`.

Git-created branches stay. An existing Stim ownership record permits deleting
a branch only when it has no unique commits.

On the main checkout, `worktree remove` only reclaims the Stim environment. It
does not remove the source directory.
