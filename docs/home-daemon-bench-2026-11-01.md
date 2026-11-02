# Home daemon: prototype and benchmark (2026-11-01)

A prototype of one background daemon per `STIM_HOME`, and measurements against today's per-workspace supervisor
and command-triggered maintenance. Investigation, not a finished feature. Issue #4790, branch
`feat/4790-home-daemon-prototype`.

## Why

Every gap in Stim's idle and resource policy is policy that needs a clock with no process alive to run it:

- The only background timer is the workspace's Metro supervisor (`supervisor/run.ts`, `supervisor/idle-stop.ts`).
  When Metro never started (a Release `stim ios`, a build that failed after the simulator booted) nothing checks the
  owned simulator at all, and when Metro idles out the supervisor is gone.
- Metro and the owned devices stop on two clocks (`metro.idleStopMinutes`, `devices.idleShutdownMinutes`), which
  leaves a half-alive workspace between the two stops.
- Automatic maintenance runs only when some command runs; build-slot admission polls the slot claims every second.

## What was built

Gated behind a new machine setting, `daemon.enabled` (env `STIM_DAEMON`), default off. With it off, every path is
today's.

- **Process.** `stim-daemon`, a detached Node entry (`daemon-run`, `src/daemon/run.ts`) started like the supervisor
  and maintenance through `spawnEntry`. One per Stim home. It takes an exclusive ownership claim at
  `$STIM_HOME/daemon/claim` through `@stim-cli/core/ownership-claim`, with its own `ProcessRecord` as the owner; a
  second daemon finds the claim held and exits. A claim whose owner is proven gone is recovered by the existing claim
  protocol; there is no heartbeat, mtime or staleness threshold.
- **Socket.** `$STIM_HOME/daemon/daemon.sock`, or `/tmp/stim-sockets-<uid>/<sha256>.sock` past the 103-byte macOS
  limit, through the same helper as stim-server's local socket (generalized in `core/state/paths.ts`). Directory
  0700 owned by the user, socket 0600, a stale file probed before it is replaced, the same rules as stim-server's
  `listenLocal`. Newline-delimited JSON with four messages: `hello`, `slot.wait` (answered `slot.waiting`, then
  `slot.changed` on each release), `slot.released`. No network listener, no paths or commands from clients.
- **Start on demand.** The CLI's `preAction` hook calls `ensureDaemon()` for `start`, `ios` and `android` (not
  `--plan`): a live claim gets a `hello` (so the daemon does not exit under the command), no claim spawns one, an
  unresolvable claim prints a notice naming the claim and its `rm` command and the command runs without the daemon.
- **Exit when idle.** Every tick (60 s) the daemon checks for a live or unverified supervisor, a build in progress, a
  held build slot, a connected slot waiter, or a booted owned device (simctl only when some workspace owns a
  device). Two consecutive empty ticks with no contact for a tick, and it releases its claim, removes its socket and
  exits. It also exits when `daemon.enabled` is turned off.
- **Idle timers (`src/daemon/idle.ts`).** One pass per tick over the registered workspaces:
  - *Supervised workspace*, when the supervisor reports bundle and HMR requests and both idle settings are on: the
    daemon decides with maintenance's existing `idleStopEvidence` (Stim commands, native runs, agent-device actions,
    live views, Metro bundle and HMR requests, held leases, builds, drivers, hosted sessions) plus the client log,
    against **one threshold, the smaller of `metro.idleStopMinutes` and `devices.idleShutdownMinutes`**. When idle,
    it re-decides under the workspace's native-run and metro-start locks and runs `stim stop`'s `runStop`, which
    stops Metro and shuts the owned devices down through `devices/teardown.ts` in one pass. The supervisor's own two
    watchers stand down while the daemon claim is live and resume when it is gone.
  - *Workspace with no live supervisor*: the supervisor's device path, `dueIdleDevices` then `shutDownIdleDevices`
    under `withIdleWorkspace`, with `devices.idleShutdownMinutes`. Teardown revalidates ownership through the
    created-devices ledger, so it works in a scoped `STIM_HOME`, unlike maintenance's device sweeps.
  - Maintenance's `planIdleShutdown` stands down while the daemon is live, so the daemon is the only writer of idle
    shutdowns.
- **Pressure.** The daemon calls `triggerMaintenance('daemon')` each tick, as the supervisor does, so disk and memory
  pressure reactions run without a command (still subject to maintenance's own gates: off under `STIM_HOME` unless
  `STIM_MAINTENANCE` is set).
- **Build admission.** `acquireBuildSlot` keeps its one-second poll as the fallback but also subscribes once to the
  daemon; `releaseBuildSlot` sends `slot.released`. The slot stays the builder's own claim under `build-slots/`: the
  daemon never holds or grants a slot, it only wakes waiters. A crashed holder sends nothing, and the poll still finds
  its dead claim.

Not built: device-lease expiry (a lease carries its own expiry and needs no action), local Gradle daemon stops
(#4638 is in flight with its own policy), a status view (#3474), and anything for web or macOS apps.

### Diff summary

```
 .oxlintrc.json                                 |   1 +   daemon/** joins the detached-entry allowlist
 packages/core/state/config-types.ts            |   1 +
 packages/core/state/paths.ts                   |  28 ++-  localSocket helper, daemon paths
 packages/core/state/settings-registry.ts       |   9 +   daemon.enabled / STIM_DAEMON
 packages/stim-cli/bin/cli.ts                   |   6 +   ensureDaemon for start, ios, android
 packages/stim-cli/src/daemon/client.ts         | 190 +  enable check, liveness, spawn, slot waiter
 packages/stim-cli/src/daemon/idle.ts           | 151 +  idle pass
 packages/stim-cli/src/daemon/run.ts            | 198 +  entry, claim, socket, ticks, exit
 packages/stim-cli/src/engine/build-slots.ts    |  12 +-  wake-or-poll, release notification
 packages/stim-cli/src/guide/settings.ts        |  11 +   setting documented
 packages/stim-cli/src/maintenance/devices.ts   |   3 +-  planIdleShutdown stands down
 packages/stim-cli/src/maintenance/idle-stop.ts |  12 +-  export evidence, 'client log' basis
 packages/stim-cli/src/spawn-entry.ts           |   9 +-  daemon-run entry
 packages/stim-cli/src/supervisor/run.ts        |   5 +   watchers stand down while the daemon owns idle
 packages/stim-cli/tsdown.config.ts             |   1 +
 tests: daemon.integration.test.ts (3), supervisor-run.test.ts (+1)
```

New surface: the machine setting `daemon.enabled` and its environment override `STIM_DAEMON`; the `daemon-run`
spawn entry and `stim-daemon` process; the files under `$STIM_HOME/daemon/` (claim, socket, `daemon.log`). No new
command or flag.

## Method

- Machine: the shared development Mac, loaded by another benchmark throughout (1-minute load 29 to 210). Native
  builds started only below a 1-minute load of 40.
- Builds: baseline is unmodified `origin/main` (`635195672`) built in its own worktree; "after" is this branch's
  build. Both run from `packages/stim-cli/dist/cli.mjs` with a private `STIM_HOME` under the session scratch
  directory (long enough that every socket takes the `/tmp/stim-sockets-<uid>` fallback). The real `~/.stim` was not
  touched.
- Project: trailhead (Expo 58) at `78c2b74`, three detached worktrees `th-a`, `th-b`, `th-c` warmed with
  `stim worktree warm`, then `bundle exec pod install` (the Pods carried from the main checkout had dangling
  `rncore-facades` header links and failed both configurations).
- Device and Metro state: a poller samples `xcrun simctl list devices` for the workspace's owned simulator and
  `lsof` for the Metro port every 2 s (15 s for the long baseline), recording the first sample in each new state.

### Measurements and the bar set before the numbers

1. **Admission latency.** `concurrency.maxBuilds` 1. A holder process takes the slot through `acquireBuildSlot`, holds
   it 1.5 to 2.5 s (random, so release falls at a random point of the waiter's poll), releases it; a waiter process
   started while it is held calls `acquireBuildSlot`. Lag = waiter's acquisition time minus holder's release time,
   same clock. 30 trials polling (`STIM_DAEMON=0`), 30 with the daemon. Real `acquireBuildSlot` and
   `releaseBuildSlot` from source, real claim files; no native build (the lag does not depend on what the holder
   does). Expected by arithmetic: polling mean about half the 1 s interval, so the largest possible win is under one
   second per contended build.
2. **Device idle shutdown with no Metro.** `devices.idleShutdownMinutes` 2. An owned simulator left booted by a
   `stim ios` run with no dev server. Bar: with the daemon it shuts down within threshold plus one tick (3 min of
   idle); without it, it is still booted after at least 10 minutes.
3. **Metro and device stopping together.** `devices.idleShutdownMinutes` 1, `metro.idleStopMinutes` 2, for both runs,
   so the "before" gap is about one minute by construction and the measurement isolates the together property. Bar:
   gap under 10 s with the daemon.
4. **`stim status` from memory.** Not built; see below.
5. **Processes and memory for N = 3 workspaces running Metro** (`stim start` in each, idle, no bundle served): count
   and RSS of each supervisor's process tree, plus the daemon.
6. **Daemon cost.** Its RSS; spawn-to-listening time from the built `daemon-run.mjs`; `ensureDaemon()` time when the
   daemon is running and when it must be started; end-to-end `stim start` on an already-running workspace (10 runs
   each: baseline, branch with the daemon off, branch with the daemon running). Bar: under 50 ms added to a command
   when the daemon runs, under 100 ms when it must start (the command never waits for the daemon to listen), and a
   daemon RSS under 80 MB.

A draft PR only if 2 and 3 pass their bars, 6 stays within budget, and nothing breaks.

## Results

RESULTS_PLACEHOLDER
