---
title: 'How cleanup works'
sidebar_label: 'How cleanup works'
description: 'What Stim deletes or stops by itself, when, and how to see or change it'
---

import StimTabs from '@site/src/components/StimTabs';
import PromptBox from '@site/src/components/PromptBox';

:::note[Command examples]

Commands use `stim`. If it is not installed globally, replace `stim` with
`npx stim`.

:::

Each Stim home has one background process, `stimd`, which `start`, `ios`,
`android`, `web`, `macos` and `revive` start. Every minute it measures free
disk and memory, stops what has been idle, and deletes what can be rebuilt.
`stim gc` runs the same pass on demand, even with automatic cleanup off, which
is the default in CI. Everything Stim deletes is regenerable, archived first,
or one of the exceptions below.

<StimTabs code="stim gc --dry-run" />

## What it never touches

- Your source: tracked files, and untracked files git does not ignore.
- Commits that are not pushed.
- Anything building, driven by an agent, leased, locked with
  `git worktree lock`, hosted on another machine, or pinned with
  `maintenance.keep`.
- Simulators and emulators you created, and physical devices.
- Checkouts no `stim` command ran in, unless
  [discovery](#which-checkouts-it-maintains) reaches them.
- A `node_modules` or Pods folder with hand edits, `ios/build`, and Xcode
  DerivedData outside Stim.

## Exceptions

- **Finished worktrees are removed.** A linked worktree whose branch merged,
  whose pull request merged or closed, or that has no commits of its own goes
  two hours after it was last used or finished. Uncommitted and untracked
  changes are archived first, for 30 days. **Git-ignored files, such as a
  `.env.local`, are deleted, not archived.** Its
  [workspace services](./dev-server-and-logs.md#workspace-services) are torn
  down first, **which deletes their data**. The branch goes too when Stim
  created it.
- **The main checkout's `node_modules` and Pods** go after 7 idle days.
- **Machine-wide files**: iOS simulator runtimes no simulator uses, Gradle
  versions in `~/.gradle` no registered project pins, Jest's default cache,
  and Instruments (`xctrace`) and SwiftPM temporary folders in `TMPDIR`. At
  critical disk pressure only: the npm, Yarn, pnpm, CocoaPods, Gradle and
  SwiftPM caches.
- **Processes it stops**: idle Gradle and Kotlin daemons, a Watchman over
  2 GiB that nothing uses, and orphaned EAS cloud sessions, besides an idle
  workspace's own dev server, services and devices.
- **`daemon.mode off`** still stops the dev server and devices of an idle
  workspace whose dev server `stimd` runs.

## Phases

### A workspace over time

1. **In use**: nothing is touched.
2. **Idle** after `idle.minutes` (15), when something of it runs: the dev
   server and services stop with their ports kept, the owned devices shut
   down, and its build outputs and Metro cache are deleted. `stim revive`
   resumes it. With a device on another Mac it stops after
   `maintenance.idleStopHours` (6) instead.
3. **Dormant** after `idle.dormantDays` (1): its owned devices are deleted,
   its logs archived, and a linked worktree's `node_modules` and Pods deleted.
   The next Stim command restores them with `stim worktree warm`.
4. **Main checkout dependencies** go after `idle.sourceDormantDays` (7).
5. **Finished** linked worktrees go after `gc.worktreeGraceMinutes` (120),
   whatever the stage.

Activity is a Stim command, a build, a Metro request, an agent-device command
or input to a device, and for dependencies also a file or git write. App logs
do not count. Separately, the daily age sweep removes build outputs, cache
entries and parked devices unused for `maintenance.olderThanDays` (3), and an
hourly check trims what is over its cap.

### The machine

`stimd` sets one level a minute from memory and the free disk of every volume
it writes to:

| Level    | When                                                                                                           | What runs                                                                                    |
| -------- | -------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| normal   | otherwise                                                                                                      | the phases and schedule above                                                                |
| high     | free disk under `disk.minFreeGb` (40 GB), a macOS memory warning for 10 minutes, or under 10% of RAM available | the pressure ladder                                                                          |
| critical | free disk under `disk.criticalFreeGb` (20 GB), or critical memory on macOS                                     | the ladder at shorter idle times, plus rungs 8 and 9                                         |
| refuse   | free disk under `disk.hardFloorGb` (5 GB) after the ladder ran                                                 | `start`, `ios`, `android` fail with `STIM_LOW_DISK`; free space or run `stim gc`, then retry |

The ladder runs its rungs in this order, checks again before each, acts only
on the short volume, and stops once the level is normal. `stim gc` and the
daemon log use these numbers:

- **0**: parked simulators kept booted shut down.
- **2**: parked devices deleted, at high oldest first until the level clears,
  at critical all.
- **3**: Stim's shared caches trimmed to half their caps (critical: emptied),
  then Cargo `target/` folders lose stale profiles and incremental data.
- **1**: the idle stage, at 2 minutes under memory pressure; stopped
  workspaces idle 2 minutes lose their build outputs.
- **4**: workspaces idle 10 minutes (critical: 2) lose their owned devices.
- **6**: idle Gradle, Kotlin and Watchman daemons stop; unpinned Gradle
  versions, `TMPDIR` leftovers and the worktree trash go.
- **8**, critical: device recordings not being written, and archived logs and
  recordings.
- **9**, critical, if still short: other tools' caches.
- **5 and 7** only report, in `stim gc`: dependencies and worktrees.

Under pressure no `node_modules`, Pods or worktree is deleted. Memory pressure
alone runs rungs 0, 1 and 6. High-level cleanup also runs above 40 GB before a
native build that may not fit, and when a volume fills fast.

## Deletion rules

Defaults in parentheses; "sweep" is the daily age sweep.

| What                                                                                                                                                                                                            | When                                                                                                                            | Done                                                       | Setting                                                                       |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------- | ----------------------------------------------------------------------------- |
| Dev server and owned devices of a workspace                                                                                                                                                                     | idle; 2 min under memory pressure                                                                                               | stopped, shut down                                         | `idle.minutes` (15)                                                           |
| Workspace services Stim started (`stim services`)                                                                                                                                                               | idle                                                                                                                            | stopped, data kept                                         | `idle.minutes` (15)                                                           |
| Workspace with a device hosted on another Mac                                                                                                                                                                   | idle 6 h                                                                                                                        | stopped                                                    | `maintenance.idleStopHours` (6)                                               |
| Build outputs: Stim's derived data and Gradle output, `android/build`, `android/app/build`, `android/.gradle`, `.build`, `.cxx`, a `.dd` DerivedData, an Exact or tagged Cargo `target/`, the app's Metro cache | idle; dormant; over the cap; unused 3 days; at high or critical when stopped 2 min                                              | deleted                                                    | `maintenance.workspaceOutputsMaxGb` (20), `maintenance.olderThanDays` (3)     |
| Owned simulators and emulators of a workspace                                                                                                                                                                   | dormant; idle 10 min at high, 2 min at critical                                                                                 | deleted                                                    | `idle.dormantDays` (1)                                                        |
| Workspace logs                                                                                                                                                                                                  | dormant; a file over 16 MiB is cut to its newest 8 MiB                                                                          | archived, trimmed                                          | `archive.enabled` (true)                                                      |
| `node_modules` and Pods of a linked worktree                                                                                                                                                                    | dormant                                                                                                                         | deleted, restored by warm                                  | `idle.dormantDays` (1)                                                        |
| `node_modules` and Pods of a main checkout                                                                                                                                                                      | idle 7 days                                                                                                                     | deleted                                                    | `idle.sourceDormantDays` (7)                                                  |
| Finished linked worktree (merged, pull request merged or closed, or no commits of its own)                                                                                                                      | 2 h after last use; checked every 15 min                                                                                        | removed, dirty ones archived first; its services torn down | `maintenance.removeFinishedWorktrees` (true), `gc.worktreeGraceMinutes` (120) |
| Clean, pushed, unmerged worktree                                                                                                                                                                                | unused 3 days                                                                                                                   | removed                                                    | `maintenance.removeIdleWorktrees` (false)                                     |
| Parked simulators and emulators                                                                                                                                                                                 | unused 3 days; high, oldest first; critical, all                                                                                | deleted                                                    | `pool.iosParkedMax`, `pool.androidParkedMax` (3)                              |
| Parked simulator kept booted                                                                                                                                                                                    | after 15 min, or at once under memory pressure                                                                                  | shut down                                                  | `pool.bootedGraceMinutes` (15)                                                |
| Shared build cache and Metro cache                                                                                                                                                                              | over the cap, to 80%; entries unused 3 days; high, to half the cap; critical, emptied except entries in use                     | trimmed                                                    | `caches.buildCacheMaxGb` (10), `caches.metroCacheMaxGb` (5)                   |
| Swift compilation cache, ccache, other caches Stim registered                                                                                                                                                   | Swift cache over its cap; critical, emptied                                                                                     | emptied                                                    | `caches.swiftCompilationCacheMaxGb` (0, no cap), `caches.ccacheMaxGb` (5)     |
| Cargo `target/` of an Exact app or a Cargo workspace root                                                                                                                                                       | over the cap; high, every stale profile and `incremental/`, in use or not; critical, idle build units too                       | trimmed                                                    | `maintenance.cargoTargetMaxGb` (25)                                           |
| Idle Gradle and Kotlin daemons, Watchman over 2 GiB nothing uses                                                                                                                                                | sweep; at once under pressure                                                                                                   | stopped                                                    |                                                                               |
| Gradle versions no registered project pins                                                                                                                                                                      | unmodified 7 days, sweep or pressure; critical, all                                                                             | deleted                                                    | `maintenance.gradleVersionIdleDays` (7)                                       |
| `TMPDIR` leftovers (Stim, `xctrace`, SwiftPM), Jest's default cache, the worktree trash                                                                                                                         | unchanged 24 h (Jest: unused 3 days); sweep or pressure                                                                         | deleted                                                    | `maintenance.sweepHours` (24)                                                 |
| iOS simulator runtimes no simulator uses, not pinned, not the active Xcode's major version, not used for 7 days                                                                                                 | sweep                                                                                                                           | deleted with `simctl`                                      | `maintenance.olderThanDays` (0 turns it off)                                  |
| Devices, records and folders of removed projects; owned simulators whose runtime is gone; expired leases and stale locks                                                                                        | sweep                                                                                                                           | deleted                                                    |                                                                               |
| Orphaned EAS sessions of the current project; parked hosted devices on a hosting Mac                                                                                                                            | sweep                                                                                                                           | stopped, deleted                                           |                                                                               |
| Device recordings                                                                                                                                                                                               | older than 15 min per device, or over 1 GiB per home; critical, all not being written                                           | deleted                                                    | `recording.enabled` (true)                                                    |
| Archives and rescued files                                                                                                                                                                                      | past retention (30 days, 200 archives, 5 GB); rescued files after 30 days, by `stim gc`; critical, archived logs and recordings | deleted                                                    | `archive.*`                                                                   |
| npm, Yarn, pnpm, CocoaPods, Gradle and SwiftPM caches                                                                                                                                                           | critical only, disk still short after the steps above, at most hourly                                                           | cleaned                                                    | `disk.criticalFreeGb` (20)                                                    |
| Android NDKs, unused system images, Xcode device support, agent-device state                                                                                                                                    | never                                                                                                                           | reported by `stim gc --dry-run`                            |                                                                               |

## Settings you might change

| To                                                            | Run                                                                                                         |
| ------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| See what it would do, deleting nothing                        | `stim settings set daemon.mode report --scope machine`                                                      |
| Turn automatic cleanup off                                    | `stim settings set daemon.mode off --scope machine`                                                         |
| Keep one workspace untouched                                  | `stim settings set maintenance.keep true --scope workspace`                                                 |
| Keep a worktree from removal                                  | `git worktree lock`                                                                                         |
| Stop removing finished worktrees                              | `stim settings set maintenance.removeFinishedWorktrees false --scope machine`                               |
| Keep a finished worktree with changes instead of archiving it | `stim settings set archive.enabled false --scope repo`                                                      |
| Wait longer before idle and dormant                           | `stim settings set idle.minutes 60 --scope machine`, `stim settings set idle.dormantDays 3 --scope machine` |
| Never touch the main checkout's dependencies                  | `stim settings set idle.sourceDormantDays 0 --scope machine`                                                |
| Clean earlier or later                                        | `disk.minFreeGb` (40), `disk.criticalFreeGb` (20), `disk.hardFloorGb` (5)                                   |
| Raise or lower a cap                                          | `caches.buildCacheMaxGb`, `maintenance.workspaceOutputsMaxGb`, `maintenance.cargoTargetMaxGb`               |

`idle.minutes 0` turns the idle and dormant stages off; `STIM_DAEMON`
overrides `daemon.mode`. The rest is in [All settings](./settings.md#all-settings).

## Which checkouts it maintains

- **Registered**: a checkout where a project command ran (`worktree warm`,
  `start`, `ios`, `android`, `macos`, `web`, `services`, `doctor`).
- **Named folders**: the recognised projects directly inside each
  `maintenance.discoverRoots` folder, and their linked worktrees inside it,
  under the registered rules, worktree removal included.
- **Automatic discovery** (`maintenance.autoDiscover`, off): also the folders
  next to registered checkouts and the linked worktrees of every known
  repository; checkouts in `~/.codex/worktrees` and a weekly home-folder scan
  only lose build outputs and dependencies.

A discovered worktree is removed only when clean, idle for `idle.dormantDays`,
and holding no ignored file the main checkout lacks outside build and
`node_modules` folders; it is never archived. Discovery registers nothing, runs
no `git fetch`, and skips `TMPDIR` and home dot-folders unless a named folder
holds them. With it off the scan still runs, deletes nothing, and `stim doctor`
suggests a command once its finds hold 10 GiB of build output. Exclude a
checkout with `stim settings set maintenance.keep true --scope committed` in
it, or drop its folder from the list.

<StimTabs code={`stim settings set maintenance.discoverRoots '["~/Developer"]' --scope machine
stim gc --dry-run`} />

## See it and run it

- `stim gc --dry-run`: what a run would delete now, and why the rest stays;
  `--pressure high|critical` previews a level. `stim gc` deletes.
- `stim logs --source gc`: what gc and maintenance removed. The pressure
  ladder logs to `$STIM_HOME/daemon/daemon.ndjson`.
- `stim worktree list --all`: each worktree's size, idle age and verdict.
- `stim status` and `stim doctor`: the level and each workspace's stage.

<PromptBox title="Explain cleanup on this machine">
{`Read stim guide cleanup and stim guide lifecycle budget, then run stim gc --dry-run and stim worktree list --all. Explain what Stim would delete or stop on this machine and why, then change <what I want, for example: keep worktrees with changes> with stim settings. Do not run stim gc without asking me.`}
</PromptBox>
