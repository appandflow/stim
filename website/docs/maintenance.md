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
`android`, `web`, `macos` and `revive` start. Every minute (every 5 when
quiet) it measures free
disk and memory, stops what has been idle, and deletes what can be rebuilt.
`stim gc` runs the same pass on demand, even with automatic cleanup off, which
is the default in CI. Everything Stim deletes is regenerable, archived first,
or one of the exceptions below.

<StimTabs code="stim gc --dry-run" />

## What it never touches

- Your source: tracked files, and untracked files git does not ignore,
  unless you run `stim worktree remove --force`.
- Commits that are not pushed.
- Anything building, driven by an agent or leased.
- A workspace pinned with `maintenance.keep`: no idle or dormant stage, and
  its build outputs, owned devices and worktree stay. Log trimming, recording
  retention, the idle stop of a device hosted on another Mac, and the
  shutdown of a booted device when a run waits for a device slot still apply.
- A worktree locked with `git worktree lock`: never removed, and its
  dependencies stay. The idle stage still stops it and deletes its build
  outputs, and the dormant stage deletes its owned devices.
- Simulators and emulators you created, and physical devices, except that a
  run uninstalls and reinstalls its own app when the installed copy conflicts:
  a different signing team on an iPhone, or an Android install conflict in a
  release run.
- Checkouts no `stim` command ran in, unless
  [discovery](#which-checkouts-it-maintains) reaches them.
- A `node_modules` or Pods folder with hand edits, and `ios/build`.
- Xcode DerivedData outside Stim, except Xcode's own compilation cache,
  emptied at critical disk pressure.

## Exceptions

- **Finished worktrees are removed.** A linked worktree whose branch merged
  or whose pull request merged or closed goes two hours after it was last used
  or finished, and so does a clean one with no commits of its own.
  Uncommitted and untracked changes are archived first, for 30 days. A
  git-ignored file the main checkout lacks or holds differently, outside
  dependency and build folders, keeps the worktree; ignored files identical
  to the main checkout's go with it. Its
  [workspace services](./dev-server-and-logs.md#workspace-services) are torn
  down first, **which deletes their data**; so are the services of a project
  whose folder is gone. The branch goes too when Stim created it.
- **The main checkout's `node_modules` and Pods** go after 7 idle days.
- **Machine-wide files**: iOS simulator runtimes no simulator uses, Gradle
  versions in `~/.gradle` no registered project pins, Jest's default cache,
  and Instruments (`xctrace`) and SwiftPM temporary folders in `TMPDIR`. At
  critical disk pressure only: the npm, Yarn, pnpm, CocoaPods, Gradle and
  SwiftPM caches and Xcode's compilation cache.
- **Processes it stops**: idle Gradle and Kotlin daemons, a Watchman that
  nothing uses over 2 GiB (1 GiB under memory pressure), and orphaned EAS
  cloud sessions: in `stim gc`, and in an `ios` or `android` run that could not
  finish setting up the `--remote eas` session it created (a cancelled or
  timed-out create, no agent-device endpoint, a failed connect, or state it
  could not record). Besides an idle workspace's own dev server, services and
  devices, it shuts down the longest-idle booted device of
  another workspace idle 2 minutes when a run waits for a device slot.
- **Reusing a parked device clears it.** Before a workspace takes a parked
  simulator or emulator, Stim uninstalls the previous workspace's apps and
  clears the kept app's data. An Android emulator also has its caches trimmed,
  and its user data wiped when `/data` is still short. A hosted simulator on a
  hosting Mac has its privacy settings and keychain reset too.
- **`daemon.mode off`** still stops the dev server and devices of an idle
  workspace whose dev server `stimd` runs.

## When you run `stop` or `worktree remove`

- `stim stop` stops the dev server, its tunnel and log collectors, shuts the
  owned devices down (an iOS simulator may stay booted for
  `pool.bootedGraceMinutes`), closes the owned Chrome, quits the macOS app or
  ends its session on another Mac, ends an EAS session, cancels a running
  `ios` or `android` run, ends web shares, releases device leases and removes
  adb reverses. It deletes no local device. A device hosted on another Mac is
  parked there, or deleted when the host parks none or parking fails.
- `stim worktree remove` does the same, runs each service's `teardown`, parks
  the owned devices (deletes them at critical disk pressure, with parking set
  to `0`, or when parking fails), deletes the owned Chrome profile and
  archives the logs, then deletes the workspace's folder in the Stim home,
  build outputs included, frees the Metro port, and removes the worktree and
  the branch when Stim created it. With `--force` it discards uncommitted and
  untracked work without archiving it.

## Phases

### A workspace over time

1. **In use**: nothing is touched.
2. **Idle** after `idle.minutes` (15), when something of it runs: the dev
   server and services stop with their ports kept, the owned devices shut
   down, and its build outputs and Metro cache are deleted. `stim revive`
   resumes it. With a device on another Mac it stops after
   `maintenance.idleStopHours` (6) instead.
3. **Dormant** after `idle.dormantDays` (1): its owned devices are deleted,
   its logs archived, and a linked worktree's `node_modules` and Pods deleted
   when they hold 256 MB of their own or are not measured yet (a copy-on-write
   clone stays).
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
- **3**: Stim's shared caches trimmed to half their caps (critical: emptied,
  with the fingerprint index),
  then Cargo `target/` folders lose stale profiles and incremental data.
- **1**: the idle stage, at 2 minutes under memory pressure; stopped
  workspaces idle 2 minutes lose their build outputs.
- **4**: workspaces idle 10 minutes (critical: 2) lose their owned devices
  and archive their logs.
- **6**: idle Gradle, Kotlin and Watchman daemons stop; unpinned Gradle
  versions, `TMPDIR` leftovers and the worktree trash go.
- **8**, critical: device recordings not being written, and archived logs,
  recordings and agent actions.
- **9**, critical, if still short: other tools' caches.
- **5 and 7** only report, in `stim gc`: dependencies and worktrees.

The ladder itself deletes no `node_modules`, Pods or worktree; the dormant and
finished-worktree rules above still apply at every level. Memory pressure
alone runs rungs 0, 1 and 6. High-level cleanup also runs above 40 GB before a
native build that may not fit, and when a volume fills fast.

## Deletion rules

Defaults in parentheses; "sweep" is the daily age sweep.

| What                                                                                                                                                                                                                                                                                  | When                                                                                                                                                                                                                      | Done                                                                      | Setting                                                                       |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| Dev server and owned devices of a workspace                                                                                                                                                                                                                                           | idle; 2 min under memory pressure; a booted device of a workspace idle 2 min when a run waits for a device slot                                                                                                           | stopped, shut down                                                        | `idle.minutes` (15)                                                           |
| Workspace services Stim started (`stim services`)                                                                                                                                                                                                                                     | idle                                                                                                                                                                                                                      | stopped, data kept                                                        | `idle.minutes` (15)                                                           |
| Workspace with a device hosted on another Mac                                                                                                                                                                                                                                         | idle 6 h, `maintenance.keep` or not; the host also ends the session after 6 h without its client                                                                                                                          | stopped                                                                   | `maintenance.idleStopHours` (6)                                               |
| Build outputs: Stim's derived data and Gradle output, `android/build`, `android/app/build`, `android/.gradle`, `.build`, `.cxx`, a `.dd` DerivedData, an Exact or tagged Cargo `target/`, the app's Metro cache                                                                       | idle; dormant; over the cap; unused 3 days; at high or critical when stopped 2 min, a Cargo `target/` excepted                                                                                                            | deleted                                                                   | `maintenance.workspaceOutputsMaxGb` (20), `maintenance.olderThanDays` (3)     |
| Owned simulators and emulators of a workspace                                                                                                                                                                                                                                         | dormant; idle 10 min at high, 2 min at critical; a finished worktree kept for its changes, idle 2 h                                                                                                                       | deleted                                                                   | `idle.dormantDays` (1), `gc.worktreeGraceMinutes` (120)                       |
| Workspace logs                                                                                                                                                                                                                                                                        | Metro, client and device logs rotate at 8 MiB, keeping one older file, in every `daemon.mode`; a file over 16 MiB is cut to its newest 8 MiB; dormant, archived                                                           | rotated, trimmed, archived                                                | `archive.enabled` (true)                                                      |
| `node_modules` and Pods of a linked worktree, 256 MB of their own or not measured yet                                                                                                                                                                                                 | dormant                                                                                                                                                                                                                   | deleted, restored by warm                                                 | `idle.dormantDays` (1)                                                        |
| `node_modules` and Pods of a main checkout                                                                                                                                                                                                                                            | idle 7 days                                                                                                                                                                                                               | deleted                                                                   | `idle.sourceDormantDays` (7)                                                  |
| Finished linked worktree (merged, pull request merged or closed), or a clean one with no commits of its own                                                                                                                                                                           | 2 h after last use; checked every 15 min                                                                                                                                                                                  | removed, changes archived first; its services torn down                   | `maintenance.removeFinishedWorktrees` (true), `gc.worktreeGraceMinutes` (120) |
| Clean, pushed, unmerged worktree                                                                                                                                                                                                                                                      | unused 3 days                                                                                                                                                                                                             | removed                                                                   | `maintenance.removeIdleWorktrees` (false)                                     |
| Parked simulators and emulators                                                                                                                                                                                                                                                       | the oldest at once when parking one more would pass the cap; unused 3 days; high, oldest first; critical, all                                                                                                             | deleted                                                                   | `pool.iosParkedMax`, `pool.androidParkedMax` (3)                              |
| Parked simulator kept booted, or one `stim stop` left booted                                                                                                                                                                                                                          | after 15 min, or at once under memory pressure or when a run waits for a device slot                                                                                                                                      | shut down                                                                 | `pool.bootedGraceMinutes` (15)                                                |
| Shared build cache and Metro cache                                                                                                                                                                                                                                                    | over the cap, to 80%; entries unused 3 days; high, to half the cap; critical, emptied except entries in use                                                                                                               | trimmed                                                                   | `caches.buildCacheMaxGb` (10), `caches.metroCacheMaxGb` (5)                   |
| Swift compilation cache, ccache, Xcode's compilation cache, other caches Stim registered or detected                                                                                                                                                                                  | Swift cache over its cap, or over half of it at high; critical, emptied; ccache evicts itself at its limit                                                                                                                | emptied                                                                   | `caches.swiftCompilationCacheMaxGb` (0, no cap), `caches.ccacheMaxGb` (5)     |
| Fingerprint index and memo                                                                                                                                                                                                                                                            | critical                                                                                                                                                                                                                  | emptied                                                                   |                                                                               |
| Cargo `target/` of an Exact app or a Cargo workspace root, tagged or not                                                                                                                                                                                                              | over the cap; high, every stale profile and `incremental/`, in use or not; critical, idle build units too; dormant, deleted whole except lock files and keypairs                                                          | trimmed, deleted                                                          | `maintenance.cargoTargetMaxGb` (25), `idle.dormantDays` (1)                   |
| Idle Gradle and Kotlin daemons, a Watchman nothing uses over 2 GiB (1 GiB under memory pressure)                                                                                                                                                                                      | sweep; at once under pressure                                                                                                                                                                                             | stopped                                                                   |                                                                               |
| Gradle versions no registered project pins                                                                                                                                                                                                                                            | unmodified 7 days, sweep or pressure; critical, all                                                                                                                                                                       | deleted                                                                   | `maintenance.gradleVersionIdleDays` (7)                                       |
| `TMPDIR` leftovers (Stim, stopped hosted agent-device state, `xctrace`, SwiftPM), Metro file maps, Jest's default cache                                                                                                                                                               | unchanged 24 h (Metro, Jest: unused 3 days); sweep or pressure                                                                                                                                                            | deleted                                                                   | `maintenance.sweepHours` (24), the sweep interval                             |
| Worktree trash: what a removal moved aside                                                                                                                                                                                                                                            | right after the removal                                                                                                                                                                                                   | deleted                                                                   |                                                                               |
| iOS simulator runtimes no simulator uses, deletable, not pinned, not the active Xcode's major version, not used for 7 days; never the only one, or the newest when none is used                                                                                                       | sweep                                                                                                                                                                                                                     | deleted with `simctl`                                                     | `maintenance.olderThanDays` (0 turns it off)                                  |
| Devices, records, folders and service data of removed projects; owned simulators whose runtime is gone; expired leases and stale locks                                                                                                                                                | sweep                                                                                                                                                                                                                     | deleted                                                                   |                                                                               |
| Orphaned EAS sessions of the current project; parked hosted devices on a hosting Mac                                                                                                                                                                                                  | `stim gc` (EAS); a session a `--remote eas` run created but could not set up, by that run; sweep (hosted)                                                                                                                 | stopped, deleted                                                          |                                                                               |
| On a hosting Mac: a hosted session in an unknown state                                                                                                                                                                                                                                | each idle sweep, up to 5 tries; then the device is kept and its claim released                                                                                                                                            | stopped                                                                   |                                                                               |
| Stim engine versions other than the current, previous and staged ones, those in use, and client builds an offload job used in the last 24 hours; engine scratch folders; the engine's npm download cache, emptied except the tarballs of those jobs once any file in it is 7 days old | every engine install, use, update and rollback, and `stim gc`                                                                                                                                                             | deleted                                                                   |                                                                               |
| On a hosting Mac: the private home of a hosted session stopped for an hour, its logs included                                                                                                                                                                                         | stim-server, whatever `daemon.mode` says                                                                                                                                                                                  | deleted                                                                   |                                                                               |
| Machine cleanup log (`gc/gc.ndjson` in the Stim home)                                                                                                                                                                                                                                 | rotates at 1 MiB, keeping one older file; that file goes after 30 days                                                                                                                                                    | rotated, deleted                                                          | `maintenance.logMaxMb` (1), `maintenance.logRetentionDays` (30)               |
| On a build worker: a repository area under `server.workerRoot`, keeping each client's newest                                                                                                                                                                                          | unused 7 days, or the volume near its free disk floor; stim-server, whatever `daemon.mode` says                                                                                                                           | deleted                                                                   | `server.workerAreaMaxAgeDays` (7)                                             |
| Device recordings                                                                                                                                                                                                                                                                     | footage beyond the newest 15 min recorded per device, however old, or over 1 GiB per home; critical, all not being written; all of a workspace at once when `recording.enabled` is set to false                           | deleted                                                                   | `recording.enabled` (true)                                                    |
| Archives and rescued files                                                                                                                                                                                                                                                            | past retention: records 30 days, 200, 5 GB; logs 14 days, 100 MB per workspace; recordings 3 days, 2 GB; agent actions 7 days; rescued files 30 days, by `stim gc`; critical, archived logs, recordings and agent actions | deleted                                                                   | `archive.*`                                                                   |
| npm, Yarn, pnpm, CocoaPods, Gradle and SwiftPM caches                                                                                                                                                                                                                                 | critical only, disk still short after the steps above, at most hourly                                                                                                                                                     | cleaned                                                                   | `disk.criticalFreeGb` (20)                                                    |
| Android NDKs, unused system images, Exact's cache, Xcode device support, agent-device state                                                                                                                                                                                           | never                                                                                                                                                                                                                     | reported by `stim gc --dry-run`, the first three at `--pressure critical` |                                                                               |

## Settings you might change

| To                                                            | Run                                                                                                         |
| ------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| See what it would do, deleting nothing                        | `stim settings set daemon.mode report --scope machine`                                                      |
| Turn automatic cleanup off                                    | `stim settings set daemon.mode off --scope machine`                                                         |
| Keep one workspace from idle, dormant and cleanup             | `stim settings set maintenance.keep true --scope workspace`                                                 |
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
  under the registered rules, worktree removal included. A plain Node checkout
  there (git and a `package.json`) only has its finished linked worktrees
  removed.
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
