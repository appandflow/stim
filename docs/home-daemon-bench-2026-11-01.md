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
  - _Supervised workspace_, when the supervisor reports bundle and HMR requests and both idle settings are on: the
    daemon decides with maintenance's existing `idleStopEvidence` (Stim commands, native runs, agent-device actions,
    live views, Metro bundle and HMR requests, held leases, builds, drivers, hosted sessions) plus the client log,
    against **one threshold, the smaller of `metro.idleStopMinutes` and `devices.idleShutdownMinutes`**. When idle,
    it re-decides under the workspace's native-run and metro-start locks and runs `stim stop`'s `runStop`, which
    stops Metro and shuts the owned devices down through `devices/teardown.ts` in one pass. The supervisor's own two
    watchers stand down while the daemon claim is live and resume when it is gone.
  - _Workspace with no live supervisor_: the supervisor's device path, `dueIdleDevices` then `shutDownIdleDevices`
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
 packages/stim-cli/src/daemon/client.ts         | 191 +  enable check, liveness, spawn, slot waiter
 packages/stim-cli/src/daemon/idle.ts           | 160 +  idle pass
 packages/stim-cli/src/daemon/run.ts            | 222 +  entry, claim, socket, ticks, exit
 packages/stim-cli/src/engine/build-slots.ts    |  12 +-  wake-or-poll, release notification
 packages/stim-cli/src/guide/settings.ts        |  11 +   setting documented
 packages/stim-cli/src/maintenance/devices.ts   |   3 +-  planIdleShutdown stands down
 packages/stim-cli/src/maintenance/idle-stop.ts |  14 +-  export evidence helpers, 'client log' basis
 packages/stim-cli/src/spawn-entry.ts           |   9 +-  daemon-run entry
 packages/stim-cli/src/supervisor/run.ts        |   7 +-  stand down while the daemon owns idle; record idle minutes
 packages/stim-cli/tsdown.config.ts             |   1 +
 tests: daemon.integration.test.ts (4), supervisor-run.test.ts (+1)
```

New surface: the machine setting `daemon.enabled` and its environment override `STIM_DAEMON`; the `daemon-run`
spawn entry and `stim-daemon` process; the files under `$STIM_HOME/daemon/` (claim, socket, `daemon.log`); an
`idleMinutes` field in the supervisor's `state.json` record; a `client log` idle basis. No new
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

The machine stayed loaded by another benchmark (1-minute load 29 to 210), so absolute times carry noise; the
decisive numbers are the ones a 60 s tick or a 1 s poll sets, which load does not move.

| #   | Measurement                                                           | Before (today)                                                                                                               | After (daemon)                                                                                                                   |
| --- | --------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Admission lag past the holder's release, `maxBuilds` 1, n = 30 each   | mean **481 ms**, p50 422, p90 899, max 988                                                                                   | mean **8.2 ms**, p50 8.2, p90 11.4, max 17.7                                                                                     |
| 2   | Owned simulator booted with no Metro, `devices.idleShutdownMinutes` 2 | **never**: still booted 12 min 21 s after a failed Release build, and 9 min 55 s after a successful one (114 of 114 samples) | **shut down 2 min 55 s** after a successful Release run (idle 2 min 53 s at the tick), then the daemon exited                    |
| 3   | Gap between the Metro stop and the device stop, devices 1 / Metro 2   | **59.5 s** (device 04:54:24.4, Metro 04:55:24.0); 58.0 s on an earlier failed Debug run                                      | **about 5 s** (Metro 04:57:50.6, device shut down by 04:57:55.6, one `runStop`)                                                  |
| 3   | Command end to the last of the two stops                              | 183 s (device at 124 s, Metro at 183 s)                                                                                      | 109 s (both, one tick after the 1 min threshold)                                                                                 |
| 4   | `stim status` from memory                                             | not built                                                                                                                    | not built                                                                                                                        |
| 5   | Three idle Metro workspaces: processes, RSS                           | 6 processes, 470 MB (3 supervisors 55-57 MB, 3 Expo children 88-114 MB)                                                      | 7 processes, 496 MB (the same plus the daemon, 48 MB); nothing replaced                                                          |
| 6   | Daemon RSS                                                            | n/a                                                                                                                          | 44-48 MB over 20 min                                                                                                             |
| 6   | Daemon CPU, idle home with 3 supervised workspaces                    | n/a                                                                                                                          | 0.49 s over 16 min                                                                                                               |
| 6   | Daemon spawn to listening (built `daemon-run.mjs`)                    | n/a                                                                                                                          | median 118 ms (109-131, n = 8) at load 39; 0.46-2.8 s at load 145-210                                                            |
| 6   | `ensureDaemon()` when the daemon runs                                 | n/a                                                                                                                          | 0.5-1.6 ms (connect, `hello`)                                                                                                    |
| 6   | `ensureDaemon()` when it must start                                   | n/a                                                                                                                          | 1.5-10.5 ms (spawn only; the command never waits for it)                                                                         |
| 6   | `stim start` on a running workspace, median of 10                     | baseline 325-339 ms; branch, daemon off 323 ms                                                                               | branch, daemon running 328 ms                                                                                                    |
| 6   | Same, 20 + 20 interleaved, load 109-169                               | daemon off median 1288 ms                                                                                                    | daemon running median 1249 ms                                                                                                    |
| 6   | Daemon tick                                                           | n/a                                                                                                                          | 79 ms to 1.5 s (simctl list dominates once a device is booted); 8.3 s for the tick that ran the together stop, teardown included |

### 1. Admission

Polling lands where arithmetic puts it: a waiter wakes on its next one-second poll, so the lag is uniform over 0 to
1 s (mean 481 ms). With the daemon the release notification wakes the waiter in 4 to 18 ms. The win is real but at
most one second per contended build, against builds of minutes: a fairness and polish gain, not a reason to run a
daemon. The same latency would come from each waiter watching the release itself, without a daemon; what only a
central process can add is ordering (wake the oldest waiter, not all of them), which this prototype does not do.

### 2. Device idle shutdown with no Metro

Today nothing times an owned simulator that no supervisor watches. The baseline ran in a private `STIM_HOME`, where
automatic maintenance is off unless `STIM_MAINTENANCE` is set and its device sweeps skip scoped homes; in a real home,
maintenance would shut the device down only when some later command happens to trigger its idle check, and never if
no command runs. With the daemon the device went down one tick after the threshold, through `shutDownIdleDevices` and
centralized teardown, and the same `device_idle_shutdown` event the supervisor writes landed in the workspace's
Metro log. Two empty ticks
later the daemon released its claim and exited, leaving nothing running in the home.

The first baseline was a Release `stim ios` whose build failed after the simulator had booted (a broken Pods carry):
that is the same gap in another shape, since a failed build also leaves the owned simulator up with no Metro.

### 3. Metro and device together

Before, the two clocks fire on their own minute ticks, so the device goes down at its threshold and Metro one minute
later (59.5 s here; 30 min apart at today's 30/60 defaults). With the daemon the workspace is idle only when neither
Metro nor its devices saw activity for the smaller threshold, and one `runStop` takes both down: Metro's stop record
(`requested by stim daemon (no activity for 1 minutes)`) is written 5 s before the simulator finishes shutting down,
the length of the teardown. Stopping together on the smaller threshold also ended the workspace 74 s sooner here,
which is the policy's cost as well: Metro now stops at `devices.idleShutdownMinutes` when that is smaller than its
own `metro.idleStopMinutes` (1 min instead of 2 here, 30 instead of 60 at today's defaults).

This property does not need a daemon for a supervised workspace: the supervisor could apply one threshold to both
itself. The daemon is what extends it to workspaces with no supervisor (row 2).

### 4. Status from memory

Not built. The daemon keeps no workspace view, and `stim status --json` over three running workspaces took 345-395 ms
warm here, of which about 320 ms is the Node process floor any `stim` command pays (the `stim start` fast path).
A daemon-served status would save at most the file reads above that floor, tens of milliseconds; #3474 covers
status as live sources.

### 5. Processes and memory

The daemon adds one Node process of 44-48 MB and replaces nothing in this prototype: each workspace still has its
supervisor (about 55 MB) and its Expo child. Folding supervisors into the daemon would save about 55 MB per
workspace, but the supervisor also owns the dev server's process tree, its log writer and its tunnel, and a crash of
one shared process would then take every workspace's Metro with it.

### 6. Cost

The daemon costs nothing measurable on the command path: `ensureDaemon()` is a sub-2 ms socket round trip when it
runs and a non-blocking spawn when it does not, and the `stim start` medians differ by less than run-to-run noise in
both series. It starts listening in about 120 ms on a quiet machine. Idle, it used 0.49 s of CPU in 16 min.

## What broke

- **A directory watcher woke waiters in a loop.** The first wake-up path had the daemon watch `build-slots/`
  recursively. A waiter's own failed `tryAcquireClaim` publishes and removes a staging file there, so every retry woke
  every waiter again, and FSEvents delivered changes 50-370 ms late (smoke lag 56-369 ms). Replaced by an explicit
  `slot.released` message from `releaseBuildSlot`; a holder that crashes sends nothing, and the 1 s poll still finds
  its dead claim.
- **A release could land between two waits.** A waiter that reconnected for each wait missed a release that arrived
  between its failed try and its next `slot.wait`. It now holds one subscription for the whole acquisition, and a
  release that arrives while it is trying counts for its next wait. A release in the few milliseconds before its very
  first subscription still waits for the next poll.
- **SIGTERM took up to a tick to exit.** The tick sleep kept the event loop alive after shutdown; shutdown now cancels
  it. Found by the integration test's teardown.
- **The process title hides the script.** `stim-daemon` replaces the command line, so `pgrep -f daemon/run` finds
  nothing; the claim file names the pid.
- **Stopping through `runStop` is `stim stop`, not an idle stop.** The dev server's stop record reads `requested by
stim daemon` instead of the supervisor's `idle` record, and `stim stop` releases the Metro port reservation, which
  the supervisor's own idle stop keeps. A real version needs an idle variant of the stop.
- **Review findings, fixed on the branch.** Two independent reviews (one Claude, one Codex) of the first version found
  that a tick that threw (a malformed `config.json`) left a daemon holding its claim with no loop running, so the
  supervisors stood down for good; that a `simctl list` failure read as "no devices", so a busy simulator could fall
  out of the evidence and `runStop` take it down; that the idle exit lingered a tick after releasing the claim; and
  that a refused bind unlinked another listener's socket. Now a failed tick releases the claim and exits, so the
  supervisors take their timers back; a device list that cannot be read, or an owned emulator that runs but was not
  read, keeps the workspace (as maintenance's idle stop already does); the exit breaks the loop; and only a bound
  socket is removed. The supervisor also records the idle minutes it was started with, and the daemon decides from
  those, so a setting changed after `stim start` cannot leave the two disagreeing about who owns the stop. A
  supervisor from an older Stim records none and keeps its own clocks. The numbers in the table were taken before these fixes, which change only failure
  paths; a `stim start` smoke run after them (both idle settings at 1) reproduced the together stop on the first tick
  past the threshold and the exit one tick later.
- Not the daemon: the trailhead worktrees needed `pod install` (dangling `rncore-facades` links in the carried Pods),
  and a build that fails after booting the simulator leaves it booted with no Metro on today's code.

Gaps left on purpose: workspaces running `metro.command`, a supervisor that does not report HMR requests, and a 0 in
either idle setting keep today's separate supervisor clocks; the daemon log has no rotation; Windows has no daemon;
an older CLI releasing a slot sends no notification, so its waiters fall back to the poll.

Open for a decision, not fixed here:

- **Scoped homes.** Maintenance and `gc` skip device sweeps whenever `STIM_HOME` is set. The daemon does not: its
  device path is the supervisor's, which revalidates ownership through the created-devices ledger and already runs in
  scoped homes, and the task wanted one daemon per scoped home. A copied config that marks a device `owned: true`
  without the ledger still counts as ownership there, so this is a human-review question under AGENTS.md ("a new way
  to decide that Stim owns it"), not a settled point.
- **One `simctl list` per idle workspace per tick.** `dueIdleDevices` lists simulators for each workspace it checks,
  synchronously. With many registered worktrees this blocks the daemon's event loop for seconds each minute, which
  delays slot wake-ups and can time out a `hello`, after which the CLI spawns a second daemon that loses the claim and
  exits. One listing per tick, shared by every workspace, is the fix.
- A workspace whose supervisor is `unverified` gets no idle device shutdown while the daemon runs, since
  `planIdleShutdown` stands down and the daemon skips it.
- `STIM_DAEMON=1` in the daemon's own environment outlives `daemon.enabled false`, by the usual environment-wins rule.
- The idle-stop reasons reuse maintenance's text, which names `maintenance.idleStopHours`.

## Recommendation

**Opened as draft PR #4792, a prototype behind `daemon.enabled` (off), not as a shipping default.** Rows 2 and 3 pass the
bars set before the numbers, and row 6 is well inside its budget:

- Row 2 is the one result only a daemon can produce: an owned simulator booted with no dev server shuts down one tick
  after its threshold instead of never. That closes the gap for Release runs, build-only runs, failed builds and any
  workspace whose supervisor is gone.
- Row 3 removes the half-alive window (59.5 s to 5 s here, 30 min at today's defaults), but for a supervised
  workspace the supervisor could do the same alone. The daemon matters for it only because it lets one process be the
  single writer of idle decisions.
- Row 1 is real and small: under one second per contended build.
- The cost is one 45 MB process while anything runs in the home, and nothing when nothing does.

Before shipping it on by default: an idle-stop variant of `runStop` that keeps the port and writes the idle record,
log rotation, waking waiters in arrival order, the Gradle daemon policy from #4638 moved onto the daemon's tick, and a
`stim status` line that says whether the daemon runs.

## stim-server: core or beside it

**Beside it, sharing the claim, for now.**

- **Who starts what.** The CLI never starts stim-server; Desktop starts its bundled server and `stim-server service`
  installs a LaunchAgent. The daemon is started by `start`, `ios` and `android` and is gone when the home is idle. If
  the daemon were stim-server's core, every `stim start` would start a server that, depending on configuration, opens
  tailnet listeners: a new way for another machine to reach this one, created implicitly. AGENTS.md treats any new or
  wider listener as a human-review change, and an implicit one is the wrong default.
- **Security surface.** stim-server carries Noise authentication, pairing, capabilities, setup tickets and hosted
  devices. The daemon has a 0600 same-user socket, four messages and no paths or commands from clients. Keeping it a
  separate process keeps that surface out of the server and the server's surface out of every CLI user's home.
- **Process count.** A merge saves one process only on machines where stim-server already runs. For a CLI-only user
  the daemon is the only extra process and exists only while something runs.
- **Convergence.** The daemon's work is a library pass (`runIdlePass`, the slot wake) behind one ownership claim, and
  stim-server already depends on the `stim` package. A stim-server for the same home can take the daemon claim and run
  the same pass in-process; the CLI checks only the claim and the socket, so it would not care which process holds
  them. That gives one process where stim-server runs and zero footprint where it does not, without the CLI ever
  starting a network-capable server.

## Reproducing

Branch `feat/4790-home-daemon-prototype`. Build with `pnpm run build`, then run `node packages/stim-cli/dist/cli.mjs`
with `STIM_HOME` set to a private directory and `STIM_DAEMON=1` (or `0`). The daemon logs to
`$STIM_HOME/daemon/daemon.log`, one line per tick. The admission harness drives `acquireBuildSlot` and
`releaseBuildSlot` from source in two processes; the device and Metro poller samples `xcrun simctl list devices` and
`lsof -iTCP:<port> -sTCP:LISTEN`. Only the simulators the bench homes created were booted or shut down, and only
through Stim.
