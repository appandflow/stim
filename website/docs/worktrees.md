---
title: 'Worktree isolation'
sidebar_position: 2
description: 'Run parallel worktrees with separate devices and shared build caches.'
---

import StimTabs from '@site/src/components/StimTabs';
import PromptBox from '@site/src/components/PromptBox';

:::note[Command examples]

Commands use `stim`. If it is not installed globally, replace `stim` with
`npx stim`.

:::

Give each task its own Git worktree. Stim gives each one its own Metro port and
device, and they all share the build cache, so a second worktree usually skips
the native build.

<PromptBox title="Work on two changes at once">
{`Make this change in a separate worktree and validate it on iOS. Keep my current checkout untouched.`}
</PromptBox>

## Create and warm

<StimTabs
code={`git worktree add -b feature-x ../feature-x HEAD
cd ../feature-x
stim worktree warm`}
/>

`stim worktree warm` copies the Git-ignored files the worktree is missing from
the source checkout, such as `node_modules`, Pods and `.env`. It skips an entry
the worktree's branch does not ignore. It never overwrites tracked files or
entries that already exist, and it does not install packages. If it reports a
lockfile mismatch, run your install command.

- To leave files out, list patterns in the source checkout's
  `.worktreeexclude` or set `worktree.exclude`.
- `stim worktree warm --refresh` first fast-forwards the source checkout to its
  upstream and installs what changed. It refuses a dirty or diverged source
  checkout.

## Work in parallel

Each worktree is its own workspace, so stopping one leaves the others running.
Watch them all in Stim Desktop or with `stim status --watch`.

## Remove a worktree

From the worktree root:

<StimTabs
code={`stim stop
stim worktree remove`}
/>

This deletes the checkout, its build outputs and Metro port, parks its owned
devices for reuse, and
the branch if Stim created it and nothing else uses it. It refuses uncommitted,
untracked or unpushed work and initialized submodules. `--force` removes them
anyway and discards that work. A Git-locked worktree, one that contains another
worktree, and the one your running Stim comes from are protected even with
`--force`.

Run from the source checkout, it reclaims the Stim environment and leaves the
checkout. If you deleted a worktree by hand, pass its path to
`stim worktree remove` to reclaim what it held.

## Remove finished worktrees in bulk {/* #remove-finished-worktrees-in-bulk */}

`stim worktree list` shows each worktree's size, age and what cleanup would do,
without deleting anything.

<StimTabs
code={`stim gc --dry-run
stim gc`}
/>

Automatic maintenance, and `stim gc` when you run it:

- Removes worktrees Stim used once their branch or pull request merged or the
  pull request closed, after a two-hour grace period (`gc.worktreeGraceMinutes`).
- Removes clean, inactive worktrees with no commits of their own.
- Keeps active, locked and pinned worktrees, and unpushed commits it cannot
  prove were merged.
- Saves a recovery archive before removing a finished worktree with
  uncommitted changes, and prints the restore commands. The archive can contain
  secrets. A git-ignored file the main checkout lacks, such as a `.env.local`,
  keeps the worktree.
- Shrinks a worktree idle for `idle.dormantDays` (1 day): its build outputs,
  devices, `node_modules` and Pods go. The next Stim command there restores
  the dependencies with `stim worktree warm`.

To protect a checkout, run `git worktree lock` or pin it with
`maintenance.keep`. To stop automatic removal, set
`maintenance.removeFinishedWorktrees` to `false`. [How cleanup
works](./maintenance.md) has the automatic rules and settings.

## Checkouts Stim never ran in {/* #checkouts-stim-never-ran-in */}

Stim can also clean checkouts where no `stim` command ever ran, but only in
folders you name:

<StimTabs
code={`stim settings set maintenance.discoverRoots '["~/Developer"]' --scope machine
stim gc --dry-run`}
/>

In those folders Stim treats recognised projects and their linked worktrees
like its own, and removes a finished worktree only when it is clean, idle, and
holds no ignored file the main checkout lacks. `maintenance.autoDiscover`
(off by default) reaches further. [Which checkouts it
maintains](./maintenance.md#which-checkouts-it-maintains) has the rules.

<PromptBox title="Find reclaimable checkouts">
{`Add my Developer folder to maintenance.discoverRoots, run stim gc --dry-run, and tell me which discovered checkouts hold the most regenerable space and why each is kept or cleared.`}
</PromptBox>

## Archived workspaces

Removed workspaces keep their build history, logs and device replay as a
read-only archive. Open **Archived** in Stim Desktop or the phone app. Logs and
recordings can contain secrets. `stim gc` deletes archives past their retention
limits, and `--pressure critical` deletes the logs and recordings of every
archive. Retention is set in [settings](./settings.md).

## Agent detail

The agent reads `stim guide lifecycle` for the workflow and
`stim guide cleanup gc` for what removal and `gc` delete, keep and refuse.
