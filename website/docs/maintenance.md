---
title: 'How cleanup works'
sidebar_label: 'How cleanup works'
description: 'What Stim stops and deletes by itself, when, and the settings that change it'
---

import StimTabs from '@site/src/components/StimTabs';
import PromptBox from '@site/src/components/PromptBox';

:::note[Command examples]

Commands use `stim`. If it is not installed globally, replace `stim` with
`npx stim`.

:::

Stim's background process, `stimd`, stops what is idle and deletes what can be
rebuilt: build outputs, caches, the simulators and emulators it created, and
worktrees whose work is merged. Your source, unpushed commits and anything in
use stay. It is on by default and off in CI. Preview what it would do now:

<StimTabs code="stim gc --dry-run" />

## Phases

A workspace moves through these as it sits unused:

| Phase    | Starts                                                                                                          | Setting (default)               |
| -------- | --------------------------------------------------------------------------------------------------------------- | ------------------------------- |
| Idle     | 15 minutes without activity                                                                                     | `idle.minutes` (15)             |
| Dormant  | 1 day without activity                                                                                          | `idle.dormantDays` (1)          |
| Finished | 2 hours after it last changed or finished, for a linked worktree that is merged or whose pull request has ended | `gc.worktreeGraceMinutes` (120) |

Activity is a Stim command, a build, a Metro request, an agent-device command
or input to a device; for dormant, also a file or git write or a process in
the checkout. App logs do not count. A clean linked worktree with no commits of
its own counts as finished.

The machine has one level, set every minute from memory and the free disk of
every volume Stim writes to:

| Level    | When                                                                                                           |
| -------- | -------------------------------------------------------------------------------------------------------------- |
| high     | free disk under `disk.minFreeGb` (40 GB), a macOS memory warning for 10 minutes, or under 10% of RAM available |
| critical | free disk under `disk.criticalFreeGb` (20 GB), or critical memory on macOS                                     |
| refuse   | free disk under `disk.hardFloorGb` (5 GB) after cleanup ran                                                    |

Above normal, cleanup works down a ladder, cheapest to rebuild first, on the
short volume only, and stops once the level is normal. High cleanup also runs
above 40 GB when a volume fills fast, and before a native build that may not
fit. Memory pressure alone shuts down booted parked simulators, runs the idle
stage and stops daemons. At
refuse, `start`, `ios` and `android` fail with
`STIM_LOW_DISK`: free space or run `stim gc`, then retry.

## Deletion rules

Caps are checked hourly, finished worktrees every 15 minutes, and unused things
daily. High and critical add to the rows above them.

| Phase                 | Stops                                                                                                                                                                                                  | Deletes                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Idle                  | the dev server and workspace services, data kept; owned simulators and emulators shut down. With a device on another Mac, after `maintenance.idleStopHours` (6) instead                                | build outputs, an Exact or tagged Cargo `target/` included, and the app's Metro cache                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| Dormant               |                                                                                                                                                                                                        | owned simulators and emulators; any other root Cargo `target/`; a linked worktree's `node_modules` and Pods holding 256 MB of their own. Logs are archived                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| Main checkout, 7 days |                                                                                                                                                                                                        | its `node_modules` and Pods (`idle.sourceDormantDays`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| Finished              | its dev server, devices and services                                                                                                                                                                   | the worktree, and its branch when Stim created it, after archiving uncommitted changes for 30 days. One kept for its changes loses its owned devices                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| Any time              | idle Gradle and Kotlin daemons; an unused Watchman over 2 GiB (1 GiB under memory pressure); a parked simulator left booted for 15 minutes; an idle workspace's booted device, when a run needs a slot | over a cap: build outputs (20 GB), the build (10) and Metro (5) caches, stale Cargo `target/` profiles (25), parked devices (3 per platform). Unused for `maintenance.olderThanDays` (3): build outputs, cache entries, parked devices. Also unpinned Gradle versions (all at critical), `TMPDIR` leftovers, Jest's cache, unused iOS simulator runtimes (never one simctl does not mark deletable, one used in the last 7 days, one of the active Xcode's major version, the only one, the newest when none is used, or one `ios.runtime` pins), what removed projects left behind, logs over 8 MiB, recordings past the newest 15 minutes per device or 1 GiB per home, oldest first, and archives past `archive.*` |
| High                  | workspaces idle 2 minutes, under memory pressure; booted parked simulators                                                                                                                             | parked devices, oldest first; shared caches to half their caps; stale Cargo profiles and incremental data; build outputs of stopped workspaces; owned devices of workspaces idle 10 minutes                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| Critical              |                                                                                                                                                                                                        | every parked device; shared caches and the fingerprint index, except entries in use; owned devices of workspaces idle 2 minutes; recordings, archived logs and archived agent actions. If still short: the npm, Yarn, pnpm, CocoaPods, Gradle and SwiftPM caches and Xcode's compilation cache, each while its tool is idle                                                                                                                                                                                                                                                                                                                                                                                           |
| A Mac hosting others  | a hosted session without its client for 6 hours; idle Gradle daemons at low memory                                                                                                                     | a stopped session's home after an hour; parked hosted devices; a build client's repository area unused for `server.workerAreaMaxAgeDays` (7), or sooner when its disk runs low                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |

Only reported, by `stim gc --dry-run`: Android NDKs, unused system images,
Exact's cache and Xcode device support.

**Never touched:**

- Tracked files, untracked files git does not ignore, and unpushed commits.
- Anything building, driven by an agent, leased, shared or hosted.
- A workspace pinned with `maintenance.keep`.
- A worktree locked with `git worktree lock`, and its dependencies.
- Simulators and emulators you created, physical devices, `ios/build`, and
  Xcode DerivedData outside Stim, except its compilation cache at critical.
- Checkouts no `stim` command ran in, unless
  [discovery](#which-checkouts-it-maintains) reaches them.

**Exceptions:**

- A finished worktree goes with its uncommitted changes, once archived. A
  git-ignored file the main checkout lacks or holds differently, outside dependency and build
  folders, keeps it.
- Removing a finished worktree tears down its
  [workspace services](./dev-server-and-logs.md#workspace-services), which
  deletes their data.
- You reinstall the main checkout's dependencies yourself.
- A pinned workspace still has its logs trimmed, its recordings expire, its
  hosted device stopped and its booted device shut down for a waiting run.
- A locked worktree still goes idle and dormant; only the worktree and its
  dependencies stay.
- `daemon.mode off` still stops an idle dev server that `stimd` runs, and its
  devices. In every mode logs rotate, recordings expire, and stim-server on a
  Mac hosting others stops abandoned sessions and deletes their homes.

## Settings you might change

| To                                           | Set                                                                                                                 |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| See what it would do, deleting nothing       | `daemon.mode report`                                                                                                |
| Turn automatic cleanup off                   | `daemon.mode off`                                                                                                   |
| Pin one workspace, from inside it            | `maintenance.keep true --scope workspace`                                                                           |
| Stop removing finished worktrees             | `maintenance.removeFinishedWorktrees false`                                                                         |
| Keep a finished worktree that has changes    | `archive.enabled false`                                                                                             |
| Wait longer before idle (15 minutes)         | `idle.minutes 60`                                                                                                   |
| Wait longer before dormant (1 day)           | `idle.dormantDays 3`                                                                                                |
| Never touch the main checkout's dependencies | `idle.sourceDormantDays 0`                                                                                          |
| Clean earlier or later (40, 20 and 5 GB)     | `disk.minFreeGb`, `disk.criticalFreeGb`, `disk.hardFloorGb`                                                         |
| Raise or lower a cap                         | `caches.buildCacheMaxGb`, `caches.ccacheMaxGb`, `maintenance.workspaceOutputsMaxGb`, `maintenance.cargoTargetMaxGb` |

Each is `stim settings set <setting> <value> --scope machine`, except
`maintenance.keep`:

<StimTabs code="stim settings set daemon.mode report --scope machine" />

`git worktree lock` keeps one worktree from removal.
`maintenance.removeIdleWorktrees` (off) also removes clean, pushed, unmerged
worktrees unused for 3 days. `idle.minutes 0` turns the idle and dormant stages off. The rest is in
[All settings](./settings.md#all-settings).

## Which checkouts it maintains

- **Registered**: a checkout where a project command ran, such as
  `worktree warm`, `start`, `ios` or `android`.
- **Named folders**: the recognised projects directly inside each
  `maintenance.discoverRoots` folder, and their linked worktrees inside it,
  under the same rules. A plain Node checkout there only has its finished
  linked worktrees removed.
- **Automatic discovery** (`maintenance.autoDiscover`, off): also the folders
  next to registered checkouts and the linked worktrees of every known
  repository. Checkouts in `~/.codex/worktrees` and a weekly home-folder scan
  only lose build outputs and dependencies.

A discovered worktree is removed only when finished, clean, idle for
`idle.dormantDays`, and holding no ignored file the main checkout lacks or holds differently
outside build and dependency folders. Nothing is archived, and no `git fetch`
runs.

To exclude a checkout, run
`stim settings set maintenance.keep true --scope committed` in it, or drop its
folder from the list.

<StimTabs code={`stim settings set maintenance.discoverRoots '["~/Developer"]' --scope machine
stim gc --dry-run`} />

## What commands delete

This page leaves out what a command does to its own target:

| Command or action              | Where                                                                         |
| ------------------------------ | ----------------------------------------------------------------------------- |
| `stim stop`                    | [Commands](./commands.md#stop), [web](./web.md#cleanup)                       |
| `stim worktree remove`         | [Remove a worktree](./worktrees.md#remove-a-worktree)                         |
| `stim gc` and its flags        | [Commands](./commands.md#gc)                                                  |
| Reusing a parked device        | [What Stim deletes](./owned-devices.md#what-stim-deletes)                     |
| A device hosted on another Mac | [Hosted parking and restart](./remote-machines.md#hosted-parking-and-restart) |
| `stim-ci run`                  | [What a run deletes](./ci.md#what-a-run-deletes)                              |

## See what it did

`stim logs --source gc` lists what `stim gc` and the maintenance passes
removed; the pressure ladder logs to `daemon.ndjson` in the Stim home.
`stim status` shows
the level and each workspace's stage.

<PromptBox title="Explain cleanup on this machine">
{`Read stim guide cleanup, then run stim gc --dry-run and stim worktree list --all. Explain what Stim would delete or stop on this machine and why. Do not run stim gc without asking me.`}
</PromptBox>
