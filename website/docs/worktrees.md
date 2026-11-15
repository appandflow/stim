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

A worktree whose workspace has had no activity for `idle.dormantDays` (one day by default) is reduced to its minimal size at every level, by `stim gc` and by the daemon: its build outputs, owned devices, `node_modules` and `ios/Pods` go, and the next Stim command in it restores the dependencies with `stim worktree warm`, or refuses with `STIM_DEPS_FAILED` and asks for an install when warm cannot restore the same versions. The main checkout is reduced last: its `node_modules` and `ios/Pods` go after the worktrees', once it has had no activity for `idle.sourceDormantDays` (7 days; a `stim worktree warm` copying from it counts when the warmed app has a Stim workspace in the source) or at critical. `stim worktree warm` then says on stderr that the main checkout has no installed dependencies to copy, and since when.

Stim keeps active, locked and pinned worktrees. It also keeps unpushed commits unless it can verify they were covered by a merge, including a squash or rebase merge. The default grace period for finished work is two hours. Lock an important checkout with `git worktree lock` or pin it with `maintenance.keep`. To turn off automatic removal, set `maintenance.removeFinishedWorktrees` to `false`. [Cleanup options](./commands.md#gc)

A finished worktree with uncommitted changes can be removed after Stim saves a recovery archive. A `ios/Podfile.lock` change is ignored only when `Pods/Manifest.lock` holds the same text, or gc deleted `Pods` while they matched and the lock is unchanged since; every `project.pbxproj` change is archived or keeps the worktree. A tracked file marked `assume-unchanged`, or `skip-worktree` with the file on disk, keeps the worktree, because git status hides those edits from the archive. Files a sparse checkout leaves out do not count. The archive includes tracked changes and unignored untracked files, which can contain secrets. Stim keeps the worktree if it cannot safely save the archive or archiving is disabled. The removal output gives the exact restore commands.

## Checkouts Stim never ran in

Maintenance and `stim gc` also manage checkouts no `stim` command ever ran in. Discovery finds direct children of the folders that hold the checkouts of your registered projects, direct children of the folders in `maintenance.discoverRoots`, and the linked worktrees of their repositories. Use absolute paths for discovery roots. A leading `~` expands to your home folder. Stim refuses the home folder, its ancestors, and filesystem roots. `stim doctor` reports a configured path that is missing or is not a folder. A child counts only when Stim's project detection recognises it as a project it handles, itself or through a direct child of its `apps/`, `examples/` or `packages/` folder.

Stim acts on a discovered linked worktree only inside its repository's main checkout folder, a folder holding a known project, or a `maintenance.discoverRoots` folder. Worktrees elsewhere, such as another tool's home or a pin checkout, are listed by `stim gc --dry-run` as outside the folders Stim manages and are never touched. Nothing under the system temporary directory or a dot-folder directly inside your home directory is ever touched, except inside a `maintenance.discoverRoots` folder, which is always considered (for example `~/.exact/worktrees`), and the `~/.codex/worktrees` worktrees described below, whose outputs are only reduced. A worktree nested in a registered project is left to that workspace. A `STIM_HOME` scoped home discovers only from its own `maintenance.discoverRoots`.

Two more sources find checkouts that Stim only reduces and never removes. Linked worktrees of your known repositories in `~/.codex/worktrees` are discovered by default. A full scan of your home folder finds other checkouts that Stim's project detection recognises. The daemon runs the scan after a maintenance pass has acted, never before its cleanup and never from a command: weekly, and also while the disk level is above normal when no scan has run for an hour. A scan that failed or ended on a read that timed out is retried after an hour; one that stopped at its folder or time limit is not, since a retry would stop at the same place. The scan reads `~/Documents`, so macOS may ask for permission. A folder that does not answer within 3 seconds, such as one waiting for your answer, is recorded as unreadable and read on the next scan. It skips `~/Desktop`, `~/Downloads`, `~/Library`, the media folders, other volumes, symlinks, dependency or build folders, dot-folders below the first level, the Stim home and every dot-folder starting with `.stim`, and the tool homes and caches among your home folder's other dot-folders (`.npm`, `.gradle`, `.cache` and similar). It enters other dot-folders of your home folder, such as `~/.exact`, and records the checkouts it finds there, but never acts on them: Stim cannot tell an installed tool from a checkout in a dot-folder, so add the folder to `maintenance.discoverRoots` to have it managed. It stops at a recognised project. The scan has a 45 second budget that it checks before every read, including the project checks below, so it can overrun it by at most one read's 3 second timeout plus the time the project check itself takes on the folder in hand; when the budget runs out the scan ends early and keeps the previous finds. Checking the saved finds again has no total budget; each read has the 3 second timeout and the number of reads is capped. Before it checks a folder for a project it makes sure the manifests detection reads can be read without hanging, for that folder, every folder above it down from your home folder, and the `apps`, `examples` and `packages` folders inside it with their children. A folder whose manifest (in any letter case) is not a regular file, whose `ios` or `android` entry is not a real folder, whose `apps`, `examples` or `packages` is a link, or that holds an Xcode project or workspace while its `package.json` does not depend on React Native or Expo, makes that part of the tree not scan checkouts. A manifest or file that does not answer within 3 seconds, such as an evicted iCloud file, ends the scan early. This does not cover the folders above your home folder, a file that becomes unreadable between the check and the project check, an `ios` or `android` folder that is itself a stalled mount point (Stim checks that it is a real folder, not that it answers), or what a cleanup pass reads inside a checkout once it is found, which is the same for every checkout. Discovery uses the last scan's saved result and checks each saved checkout again before using it, so `stim gc` never walks your disk itself, and a checkout that moved or stopped being a project is dropped. A scan that fails or stops early keeps the previous finds. So does a folder whose manifest or listing the system denies during the project checks: it is recorded as unreadable, not rejected, and its earlier finds stay. A checkout found this way that an executable on your `PATH` (or in a user bin folder such as `~/.cargo/bin`) links into is kept whole by every pass that deletes its build output, dependencies or Cargo target. Each deletion reads those folders anew, at the moment it checks which processes use the path, so the only remaining window is the one for a process that starts after that check. A folder that exists but cannot be read, or does not answer within 3 seconds, keeps such checkouts, and while a hung read is pending no other launcher or scan read starts (at most one hung read per daemon thread, so up to two) and a scheduled scan is skipped; fixing the folder restores reduction. A scan stops at the first read that does not answer and keeps the previous finds; the first read of `~/Documents` while macOS waits for your answer can end a scan early, and the next scan reads it. For these checkouts Stim reduces build outputs, `node_modules` and Pods (after `idle.dormantDays` in a linked worktree, `idle.sourceDormantDays` in a main checkout) by the rules below, and keeps the checkout. Every one is evaluated on every cleanup pass, like a checkout found next to your registered ones; the check for finished worktrees inspects every discovered worktree with git, which took about 0.14 seconds each where it was measured. Add the folder to `maintenance.discoverRoots` to give it the full rules, finished-worktree removal included. A scoped `STIM_HOME` uses neither source. Discovery registers nothing and creates no workspace directory; Stim runs no `git fetch` in a discovered repository.

After a scan the daemon also lists what Stim does not fully manage and measures its build output, so `stim doctor` can report it without walking your disk. Doctor groups two kinds by containing folder: checkouts the scan found that Stim reduces and never removes, and checkouts under a dot-folder of your home folder, where Stim does nothing with them. Worktrees in `~/.codex/worktrees` are not listed, since Stim reaches them through git. For each folder doctor prints the number of checkouts, the size of their build output, and the command that adds the folder to `maintenance.discoverRoots`, with the current value plus the folder, quoted so you can paste it. Adding a folder gives its checkouts the full discovered-checkout rules, finished-worktree removal included, and for a dot-folder it lets Stim act where it did not. The listing appears only where `stim doctor` runs, inside a project.

The size counts the build directories Stim recognises (Android `build` and `.gradle`, `.build`, `android/.cxx`, a `.dd` laid out as DerivedData, and a Cargo `target/` that carries `CACHEDIR.TAG` or belongs to an Exact app), not `node_modules` or Pods, and it does not prove the directory could be deleted. The daemon measures at most 25 checkouts per run, one walk at a time on the machine, 10 seconds per directory and 90 seconds per run, and continues with the rest an hour later. A directory that could not be measured in time is reported as could not be measured, a checkout not reached yet as not measured yet, and a total that includes either reads "at least". A scoped `STIM_HOME` never scans, so it lists nothing.

Every read of a checkout's layout by the census goes through the same bounded reader as the scan: 3 seconds per read, one timed-out read outstanding, none started while one is pending, the abort and the run's budget checked before each. A denied or timed-out read makes the checkout "could not be measured", never a measured zero. A group shows its oldest measurement date, and a list made from an earlier scan than the last one shows no sizes until the daemon lists again. The census does not walk source files or run git. For each checkout it records when git last wrote there: the newest modification time of `HEAD`, `index` and `logs/HEAD` in its git directory (for a linked worktree, the `.git/worktrees/<name>` directory its `.git` file names). Commits, checkouts, staging and reflog writes change that date; editing files without touching git does not, and a git directory that cannot be tied to the checkout (a linked worktree's must name it back, with no symlink on the way), or that is unreadable or unusual, shows as unknown, never as old. A find whose check did not answer is listed apart as one that could not be checked, never as managed, and is checked again within the hour. Doctor lists each checkout with that date, oldest first, and sets no threshold. Stim has not checked whether a listed checkout is in use or holds uncommitted or unpushed work, so deleting one is yours to decide. When the disk is critical, the line every command prints on stderr also says how much those checkouts hold, that adopting a folder gives it the full rules (finished linked worktrees are removed), and gives the command for the largest folder that Stim reduces.

With no Stim activity record, idle means the newest of its source file writes (git-ignored files included; `node_modules`, Pods and nested worktrees are skipped, and `build`, `dist`, `target`, `.cache` and similar folders only where git ignores them), its last commit and its git writes, for `idle.dormantDays`. A process running from it, an agent session working in it, a pin with `maintenance.keep`, more source files than the scan reads, or anything Stim cannot read keeps it. An idle discovered checkout loses its regenerable build outputs, and its `node_modules` and Pods too: a linked worktree's after `idle.dormantDays` (default 1 day), a main (source) checkout's after `idle.sourceDormantDays` (default 7 days; 0 never), by the same evidence, whichever way it was discovered and even if no `stim` command ever ran there. A `PATH` launcher keeps a checkout found through `~/.codex/worktrees` or the full scan. A `target/` at a checkout root whose `CACHEDIR.TAG` starts with the standard signature line and whose files git ignores counts as build output.

A clean linked worktree whose branch is merged or whose pull request ended is removed only when it is idle by that same evidence at every pressure level, with no grace shortcut, and every git-ignored file also exists, byte for byte, in the main checkout. The exception is regenerable folders: directories git reports as ignored that are named `node_modules` or like build output (`build`, `dist`, `target`, `.next`, `.turbo`, `.expo` and similar), whose files are deleted with the worktree. An ignored file elsewhere that the main checkout lacks, even inside a tracked `dist/` folder, keeps the worktree. Any change to a tracked file, even `Podfile.lock` or `project.pbxproj`, is dirty work and keeps it, and so does a tracked file marked assume-unchanged or skip-worktree, which hides edits from `git status`. A worktree inside a dot-folder of its main checkout other than `.worktrees` (for example `.claude/worktrees`) belongs to another tool and is never removed, although its build output and dependencies follow the normal idle rules. The same holds for a checkout found through `~/.codex/worktrees` or the full scan. Dirty work is never archived, where a registered finished worktree's dirty work is archived first.

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
