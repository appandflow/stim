---
title: 'Worktree isolation'
sidebar_position: 2
description: 'Run parallel worktrees with separate devices and shared build caches.'
---

import StimTabs from '@site/src/components/StimTabs';

Give each task a linked Git worktree. Stim gives each workspace its own Metro port and device while sharing build caches.

If Stim is not installed globally, use `npx stim`.

## Create with Git

Create a sibling directory so Metro and Watchman stay out of your other checkouts. If your agent already created the worktree, run just the last line from it.

<StimTabs
code={`git worktree add -b feature-x ../feature-x HEAD
cd ../feature-x
stim worktree warm`}
/>

## Warm ignored state

Warm copies missing Git-ignored entries from the source checkout, such as `node_modules`, Pods and `.env`. It preserves tracked files and existing entries, including entire directories. On the same APFS volume it can clone files to save disk space. Wait for warm to finish before editing, installing or building in the worktree.

- **Dependencies missing or stale?** Run the project's install command when warm reports a lockfile mismatch or has nothing to copy. Warm itself does not install packages.
- **Expo generated native directories?** Warm copies ignored `ios/` and `android/` only when Stim recorded a current prebuild. Run `stim doctor --fix` in the source checkout to prepare them, or let the first run generate them in the worktree. [Doctor](./commands.md#doctor)
- **Exact app?** Warm leaves the app's Cargo `target/` out, because Exact refuses a `target/` built in another checkout. The worktree's first `stim ios` compiles it.
- **Need to leave files out?** Add patterns to the source checkout's `.worktreeexclude` or set `worktree.exclude`. Patterns match whole entries Git reports. If Git lists an ignored directory as one entry, a pattern for a file inside it has no effect.

<StimTabs code="stim guide lifecycle" />

## Refresh the source checkout first

<StimTabs code="stim worktree warm --refresh" />

This can fast-forward the **source checkout's current branch** to its upstream and update its dependencies and Pods before copying. It refuses a dirty tracked tree, detached HEAD, divergent branch or in-progress merge or rebase. If a refresh failed during installation, rerun it before warming from that checkout.

## Parallel environments

Run these from each app's directory. Each worktree gets its own workspace, so you can stop one without stopping the others.

<StimTabs
code={`stim start
stim ios        # or: stim android
stim status`}
/>

Look in Stim Desktop or run `stim status --watch` to see builds, devices and Git status. Warming from the app directory also registers it, so it appears while warm is running.

## Remove a worktree

Run from the linked worktree root.

<StimTabs
code={`stim stop
stim worktree remove`}
/>

Stim reclaims owned resources and removes the linked checkout. It refuses uncommitted, untracked or unpushed work and initialized submodules unless you pass `--force`. A Git-locked worktree, a worktree containing another worktree, or one providing your running CLI or server is protected even with `--force`. Git-created branches stay.

From a linked worktree's app subdirectory, removal reclaims that app's environment and leaves the checkout. From the source checkout root, it reclaims the Stim environments and leaves the source checkout. If you deleted a worktree outside Stim, pass its missing path to `stim worktree remove` to reclaim its resources. Use `stim ports stop` separately to stop any server you started on a [named port](./dev-server-and-logs.md#named-server-ports).

## Remove finished worktrees in bulk

<StimTabs
code={`stim gc --dry-run
stim gc
stim gc --pressure critical`}
/>

- **Preview.** `stim gc --dry-run` lists what `stim gc` would keep or remove. It uses local refs and cached pull request status. `stim gc` refreshes them.
- **Clean up finished work.** `stim gc` removes worktrees Stim has used after their branch merges or their pull request merges or closes, once the grace period has passed. It also removes clean, inactive worktrees based on the default branch with no commits of their own. Automatic maintenance does this by default. At `--pressure high` the grace period still applies; at `--pressure critical` it is skipped. With `maintenance.removeFinishedWorktrees` false, no level removes a finished worktree.
- **Include idle work.** `--pressure critical` also removes clean, pushed worktrees unused by Stim for seven days, even if unmerged, only while `maintenance.removeIdleWorktrees` is true (false means never, at any level). Deleting them drops ignored files such as `.env.local`.

A worktree whose workspace has had no activity for `idle.dormantDays` (one day by default) is reduced to its minimal size at every level, by `stim gc` and by the daemon: its build outputs, owned devices, `node_modules` and `ios/Pods` go, and the next Stim command in it restores the dependencies with `stim worktree warm`, or refuses with `STIM_DEPS_FAILED` and asks for an install when warm cannot restore the same versions.

Stim keeps active, locked and pinned worktrees. It also keeps unpushed commits unless it can verify they were covered by a merge, including a squash or rebase merge. The default grace period for finished work is two hours. Lock an important checkout with `git worktree lock` or pin it with `maintenance.keep`. To turn off automatic removal, set `maintenance.removeFinishedWorktrees` to `false`. [Cleanup options](./commands.md#gc)

A finished worktree with uncommitted changes can be removed after Stim saves a recovery archive. A `ios/Podfile.lock` change is ignored only when `Pods/Manifest.lock` holds the same text; every `project.pbxproj` change is archived or keeps the worktree. A tracked file marked `assume-unchanged` or `skip-worktree`, or a sparse checkout, keeps the worktree, because git status hides those edits from the archive. The archive includes tracked changes and unignored untracked files, which can contain secrets. Stim keeps the worktree if it cannot safely save the archive or archiving is disabled. The removal output gives the exact restore commands.

## Checkouts Stim never ran in

Maintenance and `stim gc` also manage checkouts no `stim` command ever ran in. Discovery finds direct children of the folders that hold the checkouts of your registered projects, direct children of the folders in `maintenance.discoverRoots` (absolute paths below your home folder, a leading `~` expanded; the home folder and `/` are refused, and `stim doctor` reports one that is not a folder), and the linked worktrees of their repositories. A child counts only when Stim's project detection recognises it as a project it handles, itself or through a direct child of its `apps/`, `examples/` or `packages/` folder.

Stim acts on a discovered linked worktree only inside its repository's main checkout folder, a folder holding a known project, or a `maintenance.discoverRoots` folder. Worktrees elsewhere, such as another tool's home or a pin checkout, are listed by `stim gc --dry-run` as outside the folders Stim manages and are never touched. Nothing under the system temporary directory or a dot-folder directly inside your home directory is ever touched. A worktree nested in a registered project is left to that workspace. A `STIM_HOME` scoped home discovers only from its own `maintenance.discoverRoots`. Discovery registers nothing and creates no workspace directory; Stim runs no `git fetch` in a discovered repository.

With no Stim activity record, idle means the newest of its source file writes (git-ignored files included; `node_modules`, Pods and nested worktrees are skipped, and `build`, `dist`, `target`, `.cache` and similar folders only where git ignores them), its last commit and its git writes, for `idle.dormantDays`. A process running from it, an agent session working in it, a pin with `maintenance.keep`, more source files than the scan reads, or anything Stim cannot read keeps it. An idle discovered checkout loses its regenerable build outputs, a linked worktree also loses `node_modules` and Pods, and a `target/` at a checkout root whose `CACHEDIR.TAG` starts with the standard signature line and whose files git ignores counts as build output.

A clean linked worktree whose branch is merged or whose pull request ended is removed only when it is idle by that same evidence at every pressure level, with no grace shortcut, and every git-ignored file also exists, byte for byte, in the main checkout. The exception is regenerable folders: directories git reports as ignored that are named `node_modules` or like build output (`build`, `dist`, `target`, `.next`, `.turbo`, `.expo` and similar), whose files are deleted with the worktree. An ignored file elsewhere that the main checkout lacks, even inside a tracked `dist/` folder, keeps the worktree. Any change to a tracked file, even `Podfile.lock` or `project.pbxproj`, is dirty work and keeps it, and so does a tracked file marked assume-unchanged or skip-worktree, which hides edits from `git status`. A worktree inside a dot-folder of its main checkout other than `.worktrees` (for example `.claude/worktrees`) belongs to another tool and is never removed, although its build output and dependencies follow the normal idle rules. Dirty work is never archived, where a registered finished worktree's dirty work is archived first.

<StimTabs
code={`stim settings set maintenance.discoverRoots '["~/Developer"]' --scope machine
stim gc --dry-run`}
/>

`stim gc --dry-run` lists every discovered checkout and what it would lose, or why it is kept. To try it with an agent, paste: "Add my Developer folder to maintenance.discoverRoots, run stim gc --dry-run, and tell me which discovered checkouts hold the most regenerable space and why each is kept or cleared."

## Archived workspaces

Open **Archived** in Desktop or the phone app to view retained build history, logs and device replay. An archived workspace is read-only. Logs and recordings can contain secrets, and retention limits apply. [Archive retention settings](./settings.md#archive-retention)

<StimTabs
code={`stim gc --dry-run
stim gc --pressure critical`}
/>

`stim gc` deletes archives past their retention limits at every level. At `--pressure critical` it also deletes the logs, recordings and agent actions of every archive and keeps each archive record. The CLI cannot delete one archive; Stim Desktop can.
