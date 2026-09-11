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

Warm copies from the repository's source checkout, regardless of either
branch's `HEAD`. That checkout must still be available. It copies missing
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
match the current branch. Install missing dependencies with the project's
package manager when the source checkout has none to copy.

## Refresh the source checkout first

Every worktree is a copy of the source checkout, so a stale one seeds stale
worktrees. `stim worktree warm --refresh` updates it before the copy:

<StimTabs
code={`stim worktree warm --refresh`}
/>

It fetches the branch's remote, fast-forwards **whatever branch the source
checkout has** to its `@{upstream}`, and then installs only what the new commits
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

One lock per repository protects this, with or without the flag: `--refresh`
holds it exclusively, and every copy holds it shared, so no copy can read a
`node_modules` a refresh is rewriting. Two plain warms still run at the same
time, and a holder that dies frees the lock. A refresh whose install runs in a
spawned process group holds the lock while any member of that group lives, so a
package manager's postinstall writer cannot outlive the protection.

A plain warm that cannot take the lock at all -- an unwritable `STIM_HOME`, say
-- says so in one line and copies without it, exactly as it did before the lock
existed; `--refresh` refuses instead, because it needs the lock. Even that
unsynchronised copy reads the lock first, which takes nothing: if a refresh is
holding this repository, it refuses rather than copying a tree being rewritten.

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
eligible owned iOS simulators and Android emulators when parking is enabled;
see [devices and cleanup](/docs/owned-devices) for reuse and eviction rules.
It refuses uncommitted, untracked, or unpushed work unless you pass `--force`.

Git-created branches stay. An existing Stim ownership record permits deleting
a branch only when it has no unique commits.

On the source checkout, `worktree remove` only reclaims the Stim environment.
It does not remove that checkout.
