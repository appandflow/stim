# Resource model: one daemon, one activity clock, one pressure ladder

Status: approved design, 2026-11-02. It replaces the per-command budget gate, maintenance's pressure levels, the
supervisor's two idle timers and the opt-in daemon prototype (#4792) with one model. Breaking changes to settings and
behavior are accepted; the sections below say which.

## Goals

- Everything is automatic. Stim keeps the machine healthy on its own; `stim gc --delete` becomes rare.
- Idle workspaces hold as little memory and disk as possible, at the cost of time to revive them.
- Under pressure Stim sacrifices build performance (caches, build outputs) before anything else, never loses work, and
  never touches what is in use.
- Under extreme concurrency Stim queues and completes every build and boot. It refuses only at the disk hard floor.
- One model, fewer settings, one process that owns the clock.

## Non-goals

stim-server's offload gates (`server.maxLoadPerCore`, `server.maxOffloadedBuilds`, hosted-session idle, the
low-memory Gradle sweep for offloaded builds), hosted devices, and Desktop beyond reading the daemon's snapshot and
dropping its own autopilot thresholds.

## 1. The daemon

- One `stim-daemon` per Stim home, scoped homes included. It is the only writer of idle and pressure decisions.
- Started by every command that creates running state (`start`, `ios`, `android`, `web`, `macos`, `revive`) through
  `ensureDaemon` from #4792. It exits after two consecutive ticks with nothing running in the home and no waiter. Any
  command restarts it. Amended 2026-11-04 (#5023, approved): automatic maintenance and the dormant stage's dependency
  step run beside the ticks, one pass at a time, never inside the tick that serves waiters; a pass still running counts
  as something running for this rule. Amended 2026-11-02 (approved): "nothing running" for this rule also means no workspace has
  pending future work. While any workspace is idle but not yet dormant, the daemon stays alive and ticks every 5 minutes instead of 60 s while the pressure level is normal, and every 60 s while
  it is high or critical, until it clears; it exits two ticks after every registered workspace is dormant or removed and
  nothing runs. A workspace counts only until its dormant due time plus one slow tick, and never while the dormant pass
  keeps skipping it for a reason the daemon's presence does not change (a hosted placement, an unreadable state, a
  failing device listing, `maintenance.keep`, `idle.minutes` 0, `idle.dormantDays` 0), nor without any activity
  recorded in its state. A finished-worktree removal does not keep it alive: in `on` mode maintenance's plan holds only
  removals it already tried and did not finish, and a finished worktree inside its grace window counts through its
  workspace until that workspace's dormant due time. After that the daemon exits as if nothing were pending, and the
  next command restarts it.
- Ownership claim `$STIM_HOME/daemon/claim` through `@stim-cli/core/ownership-claim`; a second daemon finds the claim
  held and exits. A tick that throws logs the error, releases the claim and exits, so the fallbacks resume.
- Socket `$STIM_HOME/daemon/daemon.sock` (mode 0600, same long-path fallback as stim-server), messages: `hello`,
  `slot.wait` / `slot.released` (build slots, from #4792), `boot.wait` / `boot.released` (device boots, new), and
  `snapshot` (the last tick's measurement, new).
- One tick every 60 s, plus one on demand when a waiter arrives or a slot is released. Tick order: measure, activity
  pass (section 2), pressure pass (section 3), admission (section 4), then write `$STIM_HOME/daemon/snapshot.json`
  atomically.
- One measurement per tick: `statfs` on the config dir's volume, every registered project's volume and the build
  worker root; memory on macOS from `kern.memorystatus_vm_pressure_level` and `vm_stat` available pages, elsewhere
  `freemem`; the 1-minute load; one `simctl list devices -j`; one `adb devices`; supervisor liveness through process
  identity; the human-interaction probe (2.3).
- The activity and pressure passes never defer under load. Size scans (`du` of caches and outputs) run at most once an
  hour and defer while the 1-minute load per core exceeds 4.
- Log: `$STIM_HOME/daemon/daemon.ndjson`, rotated at 8 MiB like workspace logs. Every action also goes to the
  workspace's `metro.ndjson` as maintenance's log copies do today, with the reason, bytes freed and the restore command.
- Fallbacks: a supervisor keeps today's own idle timer but acts only when no daemon claim is held (checked once a
  minute). Maintenance's command-triggered child is removed; `gc` and `doctor` call the same passes in-process.
  Windows has no daemon: supervisor fallback plus command-time passes, and build slots keep the 1 s poll.
- Scoped homes: the daemon runs there too, on ledger-only ownership. A device is a scoped home's only when its
  `created-devices.json` lists it; the pre-ledger config fallback does not apply in scoped homes. This is a new
  ownership decision and gets a human review. The unit suite sets `daemon.mode off` in `vitest.setup.ts` so no test
  spawns a daemon; tests exercise the passes as library calls.
- `stim status` shows a daemon line (running since, last tick age, pressure level). `stim doctor` reports a dead daemon,
  a stale snapshot, or a stuck claim with the command that removes it.

## 2. Activity: one definition

A workspace's last activity is the newest of:

1. a Stim command run in it (`lastUsedAt`);
2. a bundle or HMR request its Metro served (`bundle_response_*` records and the supervisor's HMR update counter);
3. an agent-device action on one of its devices (the session events mtime of a live agent-device claim);
4. an input stim-server forwarded to one of its devices (new per-device `lastInputAt` in the viewer record; frames
   streamed without input count for nothing);
5. a `stim device lock` lease on one of its devices, for the lease's duration;
6. a human interacting with the focused simulator or emulator window (2.3).

Never activity: device logs, in-app console logs (`client.ndjson`), Metro and Expo stdout, collector events, log mtimes.

Blockers keep a workspace in its stage: a build in progress, a live driver (agent-device claim or lease, driver
process, Android instrumentation), a held device lease, a live web share, a hosted placement, unreadable evidence (fail
closed), and `maintenance.keep`.

Amended 2026-11-02 (approved): a web share (`stim share`) that has started, not ended and not passed its expiry is a
blocker, whether or not a viewer is connected, for every automatic path that would shut down or delete its workspace's
devices: the idle stage, every pressure rung, the dormant stage, the admission reclaim (4.3) and the deletion of a
finished worktree's devices by automatic maintenance and `gc --delete`. The activity reader asks this home's stim-server
for `share.list`. No running stim-server, or one without `share.list` (a server before 1.39), means no share, since a
share lives only in its server's memory; a list a running server cannot give keeps the workspace. Each path reads it
again under the workspace's native-run claim before it acts. `share.start` takes no workspace lock, so a share started
during that locked shutdown can still lose its device (#4863). With no daemon, the supervisor fallback reads it before
its own idle stop and device shutdown, and logs nothing new: the share blocks the idle probe as a driver does. `stim
share stop` or the expiry lets the idle stage proceed.

Per-slot exceptions: none. Release and native-process slots use signals 1 and 3 to 6; their app has no Metro, so 2
never fires. This replaces the #4799 rule that device logs count for those slots.

### 2.1 Stages

| Stage   | Enters after                                                             | Actions                                                                                                                                                                                                                                                                                                                                                                             | Leaves on                                                             |
| ------- | ------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| running | activity                                                                 |                                                                                                                                                                                                                                                                                                                                                                                     |                                                                       |
| idle    | `idle.minutes` (15) without activity and no blocker                      | the idle stop: Metro stopped with the port reservation and launch records kept and `IDLE_STOP_KEY` written; owned devices shut down through teardown with the idle reason; the collector ends with its device; workspace `derived-data/`, the Metro store and the regenerable in-tree dirs (`android/app/build`, `android/build`, `android/.gradle`, `ios/build`, `.build`) deleted | any activity, `stim revive`, `stim ios`, `stim android`, `stim start` |
| dormant | `idle.dormantDays` (3) without activity                                  | owned devices deleted through ledger teardown (the parked pool untouched); workspace logs archived; node_modules and Pods holding 256 MB of their own deleted, clones kept                                                                                                                                                                                                          | a Stim command                                                        |
| removed | a finished worktree (merged or closed PR) plus `gc.worktreeGraceMinutes` | today's removal; devices parked when the pool has room                                                                                                                                                                                                                                                                                                                              |                                                                       |

Amended 2026-11-02 (approved): the dormant stage needs a running daemon, so a quiet home keeps it alive at the 5-minute
cadence of section 1 until every registered workspace is dormant or removed.

The idle stop, device shutdown and output deletion are one pass under the workspace's native-run and metro-start
locks. Revive reads only state that survives idle: the port reservation, the launch records with their
`artifact.cacheKey`, and the build cache entry. Every cache key named by a slot's launch record is protected from every
trim (added to `maintenance/protect.ts`), so a revivable launch is never orphaned.

### 2.2 One clock

`metro.idleStopMinutes` and `devices.idleShutdownMinutes` become `idle.minutes`. Metro and devices stop together.
`devices.reclaimIdleMinutes` is replaced by the admission reclaim rule (4.3).

### 2.3 Human-interaction probe (macOS)

Each tick: the frontmost app from `lsappinfo front` and `lsappinfo info -only name`; when it is Simulator.app, the
focused device from `defaults read com.apple.iphonesimulator CurrentDeviceUDID`; when it is an emulator window
(`qemu-system-*`), the AVD from the process arguments; and `HIDIdleTime` from `ioreg -c IOHIDSystem`. When input idle
is under 120 s, that device's workspace records activity at now minus the idle time. No permissions are needed. Not
available on Windows or Linux.

Amended 2026-11-02 (approved): Xcode 27 replaces Simulator.app with Device Hub (`com.apple.dt.Devices`), which keeps
its focused device where the probe cannot read it without a permission. When Device Hub is the frontmost app, or
Simulator.app is and `CurrentDeviceUDID` cannot be read, every booted simulator this home owns records the activity.

## 3. Pressure: one ladder

Each tick classifies the machine:

| Level    | Condition                                                                                                                                    |
| -------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| normal   | otherwise                                                                                                                                    |
| high     | free disk on any relevant volume under `disk.minFreeGb` (20), or memory pressure at warning for 10 min, or available memory under 10% of RAM |
| critical | free disk under `disk.criticalFreeGb` (6), or memory pressure critical                                                                       |

The ladder runs top-down each tick until the level clears. Each rung re-measures before it acts, never touches a
workspace with a blocker, and takes the longest-idle workspace first.

| Rung                                                                                  | Normal                                         | High                                       | Critical                                                                                                                      |
| ------------------------------------------------------------------------------------- | ---------------------------------------------- | ------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------- |
| 1. idle stage                                                                         | at 15 min                                      | now for every workspace idle 2 min or more | same                                                                                                                          |
| 2. parked devices                                                                     | kept to the pool caps                          | delete the oldest until the level clears   | delete all                                                                                                                    |
| 3. shared caches (build cache, Metro cache, compilation cache, fingerprint memo)      | LRU trim to their caps on the hourly size scan | LRU trim to half their caps                | Metro and compilation caches emptied; build cache trimmed to protected entries                                                |
| 4. dormant stage                                                                      | at 3 days                                      | now for workspaces idle 10 min or more     | now for every idle workspace                                                                                                  |
| 5. node_modules and Pods of idle workspaces                                           | never                                          | never                                      | those holding 256 MB of their own deleted, most first, recorded with the `stim worktree warm` restore; clones kept            |
| 6. Gradle daemons, unpinned Gradle versions idle 7 days, TMPDIR leftovers 24 h, trash | daily sweep                                    | now                                        | now                                                                                                                           |
| 7. refuse                                                                             | never                                          | never                                      | `start`, `ios` and `android` refuse `STIM_LOW_DISK` only while free disk is under `disk.hardFloorGb` (5) after the ladder ran |

Memory never refuses: it holds admission (section 4) and the ladder reclaims idle devices first.

"Their own" is a tree's private bytes: the blocks APFS reports no copy-on-write clone or outside hard link shares
(`ATTR_CMNEXT_PRIVATESIZE`). `stim worktree warm` clones node_modules and Pods from the source checkout, so a fresh
clone frees almost nothing when deleted and costs a re-warm; a reinstalled tree holds 1 to 2 GB of its own. 256 MB is
about 4% of `disk.criticalFreeGb`. The daemon measures each tree in the background after its install changes. Rung 5
deletes a tree of unknown size after the measured ones; the dormant stage keeps it.

Removed: the per-command budget gate (`budget.ts` enforce and reclaim), maintenance levels 1 to 3, the memory
daemon-stop plan, the 15-minute "lighten" rule, and Desktop's own autopilot thresholds (Desktop reads the snapshot
and shows the level and the last actions).

## 4. Admission

Every boot (simulator or emulator create and boot) and every native build (xcodebuild, Gradle, SwiftPM) takes a slot
from the daemon. stim-server's offloaded builds keep taking build-slot claims, which stay compatible.

Caps are derived. `concurrency.*` overrides them; 0 means derived, no longer unlimited.

| Cap               | Derived default                                                                                                       |
| ----------------- | --------------------------------------------------------------------------------------------------------------------- |
| concurrent builds | max(1, floor(cores / 6))                                                                                              |
| boots in flight   | 2                                                                                                                     |
| booted devices    | max(2, floor((RAM - 4 GB) / 1.5 GB)); no boot while memory pressure is critical, or warning with under 2 GB available |

Waiting: a run past a cap waits with a progress line every 10 s naming its position and what it waits for. It never
refuses while its position improves or while every holder ahead of it is provably alive (a claim whose process identity
is live, a device the listing shows). It refuses `STIM_AT_CAPACITY` with the queue state only when a holder's liveness
cannot be established for max(10 min, position x 5 min), such as an unverifiable slot claim or a device listing that
fails, or at an absolute ceiling of 90 minutes, or when `--wait <seconds>` expires; `--no-wait` refuses at once. A boot
held only by memory follows the same rule: it keeps waiting while the ladder reclaims, up to the ceiling. Waiters wake in
arrival order per resource.

### 4.3 Reclaim

While a run waits for a device slot, the daemon shuts down the longest-idle booted device of another workspace that has
been idle 2 min or more and has no blocker, one per tick, and wakes the waiter.

Amended 2026-11-02 (approved): a device whose workspace has a live web share (section 2) is never reclaimed. The
waiter keeps waiting, since the shared device is a live holder, and its progress line names the share as what keeps
that holder booted. The daemon and the waiter read shares through the same reader.

Build slots: `acquireBuildSlot` subscribes through the daemon and keeps the 1 s poll as the fallback when no daemon
runs.

## 5. gc

`stim gc` reports: what the ladder would do at each level with sizes, and each workspace's stage. `stim gc --delete`
runs the ladder to the end now, regardless of level, skipping rung 5 unless `--cache all`. Kept flags: `--delete`,
`--cache all|parked|<name>`, `--older-than`, `--worktrees`, `--json`. Removed: `--idle`. `doctor` reports the snapshot
and the daemon state.

## 6. Settings

Removed. Validation refuses each with the replacement named:

| Removed                                                                                                                                                                                                                                                                                          | Replacement                                                                                                               |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------- |
| `metro.idleStopMinutes`, `devices.idleShutdownMinutes`                                                                                                                                                                                                                                           | `idle.minutes` (15; 0 disables idle and dormant)                                                                          |
| `devices.reclaimIdleMinutes`                                                                                                                                                                                                                                                                     | the reclaim rule (4.3)                                                                                                    |
| `maintenance.idleStopHours`, `maintenance.deviceIdleDays`                                                                                                                                                                                                                                        | `idle.dormantDays` (3; 0 disables dormant)                                                                                |
| `budget.minFreeDiskGb`                                                                                                                                                                                                                                                                           | `disk.minFreeGb` (20)                                                                                                     |
| `budget.hardFloorDiskGb`                                                                                                                                                                                                                                                                         | `disk.hardFloorGb` (5)                                                                                                    |
| `maintenance.criticalFreeDiskGb`                                                                                                                                                                                                                                                                 | `disk.criticalFreeGb` (6)                                                                                                 |
| `maintenance.mode`, `daemon.enabled`                                                                                                                                                                                                                                                             | `daemon.mode` on / report / off (report logs the plan and acts on nothing; off means no daemon, supervisor fallback only) |
| `budget.maxCommittedMemoryGb`, `budget.maxLiveWorkspaces`, `maintenance.pressureCheckMinutes`, `sizeCheckMinutes`, `maxLoadPerCore`, `memoryPressureLevel`, `memoryWarningMinutes`, `minAvailableMemoryGb`, `capTargetPercent`, `idleCheckMinutes`, `urgentFreeDiskGb`, `pressureProtectMinutes` | none; the ladder has fixed rules                                                                                          |

Kept: `concurrency.maxBuilds`, `maxDevices`, `maxIosDevices`, `maxAndroidDevices`, `maxMacosApps` (override the derived
caps), `caches.*MaxGb`, `maintenance.keep`, `maintenance.olderThanDays`, `protectRecentHours`, `sweepHours`,
`worktreeCheckMinutes`, `removeFinishedWorktrees`, `removeIdleWorktrees`, `gradleVersionIdleDays`,
`workspaceOutputsMaxGb`, `logMaxMb`, `logRetentionDays`, `logChecks`, `pool.*`, `archive.*`, `gc.worktreeGraceMinutes`.

Scoped homes run the model with the same defaults. `pool.*` stays 0 and `archive.enabled` false there as today; the
disk floors apply (they were 0).

## 7. Surfaces

`status`: daemon line, each workspace's stage and time in it, pressure level, waiting runs. `doctor`: daemon health,
claim, snapshot age, removed settings found in config. Desktop: reads the snapshot through stim-server; its autopilot
timer and thresholds are removed. Guides: `agent`, `lifecycle`, `cleanup`, `metro`, `settings`, `facts`, `errors`,
`worktrees` (node_modules, Pods, DerivedData and build dirs are disposable; dependency changes belong in the project's
patch mechanism and are committed). Website: settings, dev-server-and-logs, owned-devices, the gc and cleanup pages.

## 8. Delivery

- PR 1 (feat): daemon on by default; sections 1 and 2 (activity definition, idle stage, interaction probe, viewer
  `lastInputAt` in stim-server and core, the idle-stop variant of stop, launch cache-key protection, status and doctor
  lines, scoped-home ownership with human review, the test guard, the supervisor fallback). Old settings keep working
  until PR 3: `metro.idleStopMinutes` and `devices.idleShutdownMinutes` are read as `idle.minutes` (the smaller wins).
- PR 2 (feat, stacked on PR 1): sections 3 and 4 and the dormant stage; removes the budget gate, the levels, the memory
  plan and the lighten rule.
- PR 3 (feat, stacked on PR 2): sections 5, 6 and 7, including Desktop.
- PR 4 (chore): the end-to-end harness and the Mac mini runs, with a report.

Acceptance on the Mac mini (16 GB RAM, 10 cores, so the derived device cap is 8):

- Normal: 3 workspaces; at 15 min idle Metro and devices are down, DerivedData is gone, `stim revive` restores all
  three; dormant on a shortened clock deletes the devices and keeps node_modules and Pods.
- Disk pressure: a ballast file steps free space to 19, 11 and 5 GB; the ladder frees in rung order, the active
  workspace is untouched, an in-flight build completes, and only the hard floor refuses.
- Stress: 16 to 20 `stim ios` at once; every run exits 0; boots in flight never exceed 2; booted devices never exceed
  the cap; zero refusals; memory never critical for more than one tick; then everything idles down and three revive.

## 9. Risks

- Daemon death: covered by the fallbacks; `status` shows the snapshot age so staleness is visible.
- The interaction probe reads one focused device; a human only watching is invisible, as today.
- The viewer record gains a field; Desktop and the phone app do not decode it, so it is additive.
- Windows keeps the fallback paths only.
