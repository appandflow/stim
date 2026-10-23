# Load-aware admission control

Date: 2026-10-23. Status: proposed, design only. Issue: #4337.

## Summary

Stim starts a local native build or device boot whenever its counting caps
allow, and those caps are off by default. On a Mac shared by many agents the
host then fails before Stim does. This design adds one admission rule: while
this Mac's 5-minute load per core is at or above `concurrency.maxLoadPerCore`,
a new local native build or owned-device boot waits in the existing FIFO
device wait queue, with progress on stderr, until the load falls, the run's
wait bound passes, or a remote Mac takes the work. The rule extends the
existing `saturation()` predicate and the existing queue. It adds one
machine setting, off by default, and no command or flag.

## Motivation

The 2026-10-21 strategy review found that most agent friction comes from an
overloaded host. At load averages of 300 to 900 on this 14-CPU MacBook,
simulators stopped answering readiness checks, taps took about 7 s, and agents
saw `STIM_CLAIM_UNAVAILABLE` (#4093), no device, and simulators reclaimed from
other agents. Earlier runs on the same Mac recorded 0% CPU idle and about
170 MB free memory at load 900. The Mac routinely sits at load 100 to 300.

The review ranked admission control and capacity visibility second, after a
reliability release.

## What exists

| Mechanism                                     | Where                                                                        | Decides                                   | Signal                                                                                                                                                                                                               |
| --------------------------------------------- | ---------------------------------------------------------------------------- | ----------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `concurrency.maxBuilds` (machine, default 0)  | `engine/build-slots.ts` `acquireBuildSlot`, claim set `build-slots/slot-<n>` | a local native build takes one of N slots | slot count. First poller wins, no queue. 90 min ceiling, `STIM_BUILD_SLOT_TIMEOUT`. At 0 it returns at once.                                                                                                         |
| `concurrency.maxDevices` (machine, default 0) | `engine/device-capacity.ts` `withDeviceBootAdmission`                        | an owned device boots                     | owned booted devices. `device-admission` lock, FIFO tickets in `device-waits`, boot markers in `device-boots`, `--wait` (600 s) or `--no-wait`, `STIM_AT_CAPACITY`, idle reclaim at the head. At 0 it boots at once. |
| `saturation(machineCapacity())`               | `core/state/build-capacity.ts`                                               | this Mac counts as busy                   | build slots, and 5-minute load per core against `server.maxLoadPerCore` (default 2)                                                                                                                                  |
| Offload placement                             | `offload/client.ts` `offloadPlacement`                                       | `auto` sends a build to a remote Mac      | `saturation()` here, the remote's offer                                                                                                                                                                              |
| Server build offer                            | `server/src/build.ts` `capacity()`                                           | a remote build is declined                | `saturation()` on the worker                                                                                                                                                                                         |
| Device placement                              | `device-host/placement.ts`                                                   | `auto` looks for a remote host            | load per core under `server.maxLoadPerCore` and memory pressure `normal`                                                                                                                                             |
| Hosted admission                              | `device-host/offer.ts`, `server/src/device-host.ts`                          | a hosted session is reserved              | memory pressure `normal` (#4274), hosted device cap (#4275)                                                                                                                                                          |

Remote work already has load admission: a worker declines builds at its
`server.maxLoadPerCore`, and #4321 adds the same field to device offers. Local
work has none. When every remote is full or none is configured, the build or
boot runs here at any load.

## Signal

### Candidates measured

Measured on this MacBook (14 CPUs, 48 GB) on 2026-10-23 from 03:34 to 03:54
UTC, with other agents' work running: 40 samples, 30 s apart. Over the run
the 5-minute load per core was 12.4 to 18.9 (load average 173 to 265), and
the 1-minute load average reached 449. Each sample read:

- the load average (`os.loadavg()`, in process);
- memory pressure (`sysctl -n kern.memorystatus_vm_pressure_level`, the read
  hosted admission uses);
- CPU idle (`top -l 2 -n 0 -s 1`);
- the CPU of simulator processes (`ps -A -o pcpu=,command=`, lines matching
  `CoreSimulator`);
- the time of `xcrun simctl list devices booted -j`;
- readiness: the time of `xcrun simctl spawn <udid> launchctl list`, the probe
  `ensureIosBooted` runs, on the first booted `stim-` simulator.

A second run, from 03:54 to 04:04 UTC at 14.7 to 19.1 per core, probed every
booted `stim-` simulator each 20 s and recorded each one's id: 116 probes, two
simulators booting during the run. It separates the booting device from its
neighbours:

| Probes                                                | Count | Median | p90   | Slowest | Over 2 s |
| ----------------------------------------------------- | ----- | ------ | ----- | ------- | -------- |
| The booting simulator, within 60 s of first appearing | 7     | 1.8 s  | 5.1 s | 5.1 s   | 2        |
| Other simulators within 60 s of a boot                | 41    | 955 ms | 1.7 s | 4.0 s   | 2        |
| No boot within 60 s                                   | 68    | 866 ms | 1.5 s | 2.8 s   | 1        |

The first run probed whichever booted simulator the list named first, so its
19.2 s probe was most likely a simulator that had just booted.

| Signal                 | Cost to read                                                                     | Range tonight                                          | Readiness, by signal                                                                                                                                                                                                                        |
| ---------------------- | -------------------------------------------------------------------------------- | ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 5-minute load per core | about 10 ms, no subprocess, never unknown                                        | 12.4 to 18.9                                           | Did not predict it. Spearman correlation with readiness time -0.42. Under 15/core: median 663 ms, 4 of 22 probes over 2 s, slowest 19.2 s. At 15/core or more: median 538 ms, none over 2 s, slowest 861 ms.                                |
| 1-minute load per core | same                                                                             | 8.3 to 32                                              | Did not predict it (Spearman -0.22). Spikes to 32/core passed with sub-second probes.                                                                                                                                                       |
| Memory pressure        | a sysctl subprocess, 2 to 63 ms tonight; it times out under heavier load (#4274) | 19 samples normal, 21 warning, 6 flips, never critical | Did not predict it. Normal: median 657 ms, slowest 2.9 s. Warning: median 538 ms, slowest 19.2 s.                                                                                                                                           |
| CPU idle               | `top`, about 2 s                                                                 | under 1% in 32 of 40 samples                           | Saturated: 0% idle from load 190 up, so it cannot rank anything above that.                                                                                                                                                                 |
| Simulator CPU          | `ps` over about 900 processes, 0.1 to 0.2 s                                      | 7.5% to 698%                                           | Tracked it. Every probe over 2 s came with simulator CPU at 150% or more: at 150% or more, median 1.3 s and 4 of 10 over 2 s; under 150%, slowest 1.1 s. The spikes coincide with a simulator booting (the booted count going from 4 to 5). |
| Readiness latency      | needs a booted device and a subprocess, about 0.5 s                              | median 615 ms, p90 2.1 s, slowest 19.2 s               | It is the harm itself, per device. It cannot gate a boot that has no device yet.                                                                                                                                                            |

Earlier runs on the same Mac add the high end. At load 300, a single
`simctl list` had a median of 0.63 s. At 600 to 900, claim-taking commands
failed with `STIM_CLAIM_UNAVAILABLE` (#4093). At 900, CPU was 0% idle with
about 170 MB free. The strategy review saw readiness failures and 7 s taps at
300 to 900, which is 21 to 64 per core here.

### Choice

The gate admits on the 5-minute load per core, as a coarse ceiling. Tonight's
data does not show that it predicts trouble: across 12 to 19 per core,
readiness did not get worse as load rose. It is chosen because:

- the failures that break agents (readiness timeouts, 7 s taps,
  `STIM_CLAIM_UNAVAILABLE`) were seen only at 21 to 64 per core;
- it is read in process in about 10 ms, with no subprocess, and is never
  unknown, so a loaded host cannot turn it into a refusal the way an
  unreadable memory-pressure sample does (#4274);
- it covers every source of load: builds, emulators, VMs and indexers, not
  only simulators;
- `machineCapacity()` already computes it, so placement and admission read one
  value.

The healthy band tonight sets the floor for the limit: a limit at or under 19
would have held work that ran fine. The earlier failures set the ceiling at
about 21. The recommended limit for this Mac is 20.

The 5-minute average is used instead of the 1-minute one: 1-minute spikes to
32 per core passed with sub-second probes, so harm follows sustained load, and
the 5-minute value does not flap.

Simulator CPU is the signal that tracked tonight's slow probes, and those
probes came with simulator boots. The per-simulator run shows that the
booting device itself was the slow one; its neighbours slowed only a little.
Simulator CPU is not the gate: it costs a `ps` of about 900 processes, misses
builds, emulators and outside load, and is mostly caused by Stim's own boots.
Spacing boots would address the neighbours' slowdown only partly, because most
of the delay falls on the booting device, which pays it once (open decision
10). Simulator CPU and readiness latency become the acceptance metrics of the
test plan.

Memory pressure stays a placement input, after #4274's fix. Tonight it flipped
between normal and warning six times in 20 minutes at steady load and never
separated slow probes from fast ones.

## Gated actions

A gated action is one that starts sustained CPU and memory use. Each is gated
once, at the point where it already takes its cap:

| Action                                                                   | Gate point                                                              |
| ------------------------------------------------------------------------ | ----------------------------------------------------------------------- |
| Local native build: iOS, Android, macOS SwiftPM; prebuild, pods, compile | `acquireBuildSlot`, including the local fallback after a failed offload |
| Owned simulator or emulator boot, including adopting a parked device     | `withDeviceBootAdmission`                                               |
| Hosted session reserve on a worker                                       | the server's reserve, as a decline (below)                              |

A run is admitted for load once. When its first gated step is admitted, its
other gated steps in the same invocation take their caps as today but do not
queue for load again. Without this, a run could hold a booted device idle while
its build waited behind other runs.

Never gated:

- `stop`, `gc`, `worktree remove`, `ports stop|release`, `device unlock`, park
  and teardown. They free capacity; gating them can deadlock the queue.
- `logs`, `status`, `stats`, `doctor`, `guide`, `settings`.
- `reload`, install and launch onto a device this run already has, cache hits
  that need no compile, and release JS swaps.
- `start` and Metro. See open decision 6.
- `worktree warm`. It keeps stdout empty, and an install of JS dependencies is
  not native work.
- Device leases on physical devices, which start no simulator.

Stim has no test command, so test runs are out of scope. Agent-driven taps go
through agent-device, not Stim.

## Behavior over the limit

Order of preference: a remote Mac, then a bounded wait, then a refusal.

1. **Remote.** Placement runs first and is unchanged. `auto` already offloads
   or places remotely at `server.maxLoadPerCore`, which is lower than any
   useful admission limit, so by the time the gate holds local work, remotes
   were full, unreachable or not configured. With #4321, `remote-only` never
   reaches the local gate and `remote` reaches it only after every remote
   refused. A waiting run does not re-ask remotes (open decision 5).
2. **Wait.** The run takes a ticket in the existing `device-waits` FIFO claim
   set; the ticket's details gain `kind: "build" | "device"`. Under the
   existing `device-admission` lock, the oldest ticket whose own cap has room
   is admitted when load per core is under the limit. A ticket blocked only by
   its own cap does not block tickets of the other kind. Every 10 s the run
   prints on stderr:

       admission  waiting for load to fall (load 21.4/core, limit 20; queue position 2 behind ws-a; queue: ~/.stim/device-waits), 1m20s elapsed -- stim guide lifecycle concurrency

   and status reports the wait (below).

3. **Herd control.** The 5-minute average lags. When the load dips under the
   limit, admitting every waiter at once would spike it again. While any
   ticket waits, admissions are spaced at least 30 s apart; with no queue there
   is no spacing. The time of the last admission is a small file written
   atomically under the `device-admission` lock. An unreadable file counts as
   no recent admission, which only skips spacing; the load check still holds.
4. **Refuse.** `--no-wait` or `--wait 0` refuse at once. A wait that reaches
   its bound refuses. Both use `STIM_AT_CAPACITY` (open decision 4) with the
   load, the limit, the queue path and position, and the remedy: wait and
   retry, place the work on a remote Mac (`remote.build`, `ios.remote`,
   `android.remote`), stop an environment this agent owns, or raise
   `concurrency.maxLoadPerCore`.

Load waits never reclaim a device. Queue reclaim of idle devices stays limited
to a head ticket blocked by `concurrency.maxDevices`, as today. Reclaiming under
load was one of the reported harms.

### Claim and ownership rules

- A ticket is a shared claim with the waiter's process identity. A process
  that cannot capture its identity takes no ticket and refuses with
  `STIM_CLAIM_UNAVAILABLE`; it never runs gated work unadmitted.
- A ticket whose holder is proven gone is reaped by the claim protocol, as
  `inspectClaimSet` does for the queue today. A ticket Stim cannot resolve is
  never skipped, reaped or silently waited on: every run that surveys the
  queue refuses with `ClaimRefusedError`, which names the claim and the `rm`
  command that removes it.
- The admission decision reads `os.loadavg()` and the queue, both in process.
  It starts no subprocess inside the lock. The device listing that
  `concurrency.maxDevices` needs stays where it is today.
- Admitted work holds no load claim. Caps keep their own claims: build slots
  and boot markers. The spacing file carries no ownership.
- Admission never stops, parks, erases or deletes anything, so the
  ownership and teardown invariants do not change.
- Queues are per Stim home and load is per machine, so two homes on one Mac do
  not share fairness. This matches the device cap. A hosted session's private
  home does not queue: the server's reserve admits it.

## Defaults

`concurrency.maxLoadPerCore` defaults to 0, off. Turning it on by default is
open decision 1.

|                      | Opt-in (default 0)                                                         | On by default                                                                                                                                                                                                        |
| -------------------- | -------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Worst case           | Nothing changes: today's failures continue on machines that do not set it. | A machine whose load comes from outside Stim, such as a VM or an indexer, makes Stim wait until the bound, then refuse. A single-agent laptop rarely reaches 20/core, so it should not notice.                       |
| What it cannot break | Everything else; the gate code runs only when set.                         | `stop`, `gc` and teardown stay ungated, so a user can always free capacity. The gate only delays starts. It never kills, reclaims or deletes. Every wait is bounded and printed, and every refusal names its remedy. |
| Rules                | Matches "Build and device caps are opt-in" in `AGENTS.md`.                 | Needs that rule changed.                                                                                                                                                                                             |

The recommendation is opt-in now, with the setting on for this MacBook and the
minis, and a default decided from the rollout's field data.

## Interaction with existing mechanisms

| Mechanism                          | Change                                                                                                                                                                                                                                                             |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `saturation()` / `MachineCapacity` | Gains `limit` (`concurrency.maxLoadPerCore`). A new `admission()` next to it returns why local work must wait, or null. Both read the same `loadPerCore`.                                                                                                          |
| `server.maxLoadPerCore`            | Unchanged. It stays the "prefer another Mac" and "decline remote work" threshold. When `concurrency.maxLoadPerCore` is set lower, `saturation()` uses the lower value, so placement never keeps work here that the gate would then hold.                           |
| Build slots                        | `acquireBuildSlot` enters the ticket queue when the load limit or `maxBuilds` is set. Build waits become FIFO. The slot claims and the 90 min slot ceiling are unchanged.                                                                                          |
| Device queue                       | Same queue, same lock, same tickets, now with `kind`. A ticket's own cap still decides its slot; the load rule is one more condition.                                                                                                                              |
| Offload                            | Unchanged. A failed offload's local fallback passes the gate like any local build.                                                                                                                                                                                 |
| Server build offers                | Unchanged. They decline at `server.maxLoadPerCore`, below the gate.                                                                                                                                                                                                |
| Hosted admission                   | The reserve declines with the same `admission()` reason when the host's limit is set, as one more skip reason next to memory pressure. It does not queue: the client has other hosts, and for a named Mac it waits as #4321 describes. Land after #4274 and #4275. |
| `STIM_AT_CAPACITY` stats           | Load waits and refusals are recorded in `stats.json` `capacityWaits` and `capacityRefusals` with `kind: "load"`.                                                                                                                                                   |

## Capacity visibility

Aligned with #3919, which adds `capacity.builds` and `capacity.devices` when a
cap is set. This design adds `capacity.load`, always present because the busy
threshold always applies:

    "load": {
      "cpus": 14,
      "loadPerCore": 17.6,
      "busyAt": 2,
      "limit": 20,
      "state": "busy",
      "waiting": [
        { "workspace": "...", "label": "ws-a", "kind": "build", "since": "...", "position": 1 }
      ]
    }

- `state` is `free` (under `busyAt`), `busy` (placement prefers another Mac)
  or `holding` (at or over `limit`; new local work waits). `limit` is 0 when
  off.
- A waiting run's `waitingFor` gets `kind: "load"`. It keeps the integer
  `inUse` and `max` fields that Desktop's `WaitingFor` decoder requires
  (rounded load and limit) and adds `loadPerCore` and `limit`. Older Desktop
  and phone builds already show nothing for an unknown kind.
- `status --watch --json` treats `capacity.load` as changed only when `state`,
  `waiting` or the load rounded to a whole number changes, so the watch does
  not emit a payload on every tick.
- Plain `stim status` prints `load 17.6/core (busy at 2, holding at 20); 2
waiting: ws-a build 1m10s, ws-b device 20s`.
- Desktop: a Load item in the toolbar resource summary next to CPU, toned by
  `state`. CPU percent reads 100% from about one load per core and says
  nothing past it. The Machine page lists the waiters with #3919's meters.
- Phone: the same item and list on the Mac status screen.

## Settings

| Key                          | Type                      | Scope   | Default | Env                      |
| ---------------------------- | ------------------------- | ------- | ------- | ------------------------ |
| `concurrency.maxLoadPerCore` | number, 0 or at least 0.1 | machine | 0 (off) | `STIM_MAX_LOAD_PER_CORE` |

Description: "5-minute load per core at or above which Stim starts no new
local native build or device boot; 0 means no limit". It goes into
`settings-registry.ts` first, so validation, doctor, `stim settings`, the JSON
schema and the guide contract tests follow. Doctor warns when it is set below
`server.maxLoadPerCore`.

No new commands or flags are needed. The open decisions below include the
one existing flag whose meaning would widen.

## Open decisions

| #   | Decision                                                                                                                                     | Recommendation                                                                                                                                                                                                                                                                                                                           |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Opt-in or on by default                                                                                                                      | Opt-in now. Set it on this MacBook and the minis; decide a default after two weeks of `kind: "load"` stats and the stress test.                                                                                                                                                                                                          |
| 2   | Reuse `server.maxLoadPerCore` or add `concurrency.maxLoadPerCore`                                                                            | Add it. `server.maxLoadPerCore` means "prefer another Mac" at 2/core; as a gate it would have held every local build on this Mac all night.                                                                                                                                                                                              |
| 3   | Wait bound for builds. There is no build wait flag; `ios` and `android` have `--wait <seconds>` and `--no-wait` for device slots and leases. | Let the run's existing `--wait` and `--no-wait` bound every admission wait of that run, default 600 s. `stim macos` uses the default. No new flag. This widens an existing flag's meaning, so it needs the maintainer.                                                                                                                   |
| 4   | Refusal code: reuse `STIM_AT_CAPACITY` or add one                                                                                            | Reuse it, with the load named in the message and a `reason: "load"` field in JSON. Agents already handle it as "wait, place elsewhere, or stop something".                                                                                                                                                                               |
| 5   | Should a waiting run re-ask remote Macs?                                                                                                     | Not in the first version. Revisit with #4321's placement order.                                                                                                                                                                                                                                                                          |
| 6   | Gate `start` and Metro                                                                                                                       | No. Metro serves running apps and reload, and its bundling is bounded.                                                                                                                                                                                                                                                                   |
| 7   | Also hold at `critical` memory pressure                                                                                                      | Not in the first version (see Signal). Revisit if the stress test shows critical pressure under the load limit.                                                                                                                                                                                                                          |
| 8   | Queue directory name                                                                                                                         | Keep `device-waits`, adding `kind`. Renaming needs a migration while mixed CLI versions share a home.                                                                                                                                                                                                                                    |
| 9   | Default limit value when set                                                                                                                 | 20 on this MacBook (see Signal). Other Macs start at the same per-core value and adjust from their stats.                                                                                                                                                                                                                                |
| 10  | Always space owned-device boots, also under the load limit                                                                                   | Not in the first version. Tonight a boot slowed its neighbours' readiness by about 10% at the median and 18% at p90 (955 ms against 866 ms, 1.7 s against 1.5 s), while the booting device itself took up to 5.1 s. Spacing helps the neighbours only partly. Record boot start times in phase 1 and decide from the test plan's probes. |

## Rollout

| Phase | Content                                                                                                                                                                                                         | Behavior change                                   |
| ----- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------- |
| 1     | `capacity.load` in status; #3919 meters; Desktop and phone items; each build and boot records `loadPerCore` at its start in the build ledger (#4332) and stats                                                  | None. Gives the field data for decisions 1 and 9. |
| 2     | The setting, `admission()`, builds joining the ticket queue, spacing, wait lines, refusals; guide `lifecycle concurrency`, `settings`, `facts`; website `settings.md`, `owned-devices.md`, `remote-machines.md` | Only where the setting is set                     |
| 3     | Hosted reserve declines on the host's limit; device offers report it beside #4321's `maxLoadPerCore`                                                                                                            | Only where set; after #4274, #4275, #4321         |
| 4     | Default decision                                                                                                                                                                                                | Maintainer                                        |

## Test plan

Unit tests on `admission()` and the queue decision as pure functions of
load, limit, tickets, caps, last admission time and now. Each case names the
failure it catches:

- a run under the limit with no queue is admitted at once, with no spacing;
- at or over the limit it waits, and with `--no-wait` it refuses with the
  queue path and remedy;
- when the load dips with three waiters, only the head is admitted, and the
  next 30 s later;
- a build ticket blocked by `maxBuilds` does not block a device ticket behind
  it, and vice versa;
- a ticket that cannot be resolved ahead of the run refuses with its `rm`
  command; a dead holder's ticket is skipped;
- the second gated step of an admitted run does not queue for load;
- `stop` from a workspace with a waiting run is not gated and its release
  wakes the queue.

Real-tool and real-load checks:

1. **Synthetic load, scratch home.** On this MacBook in a quiet window (load
   under 80, per the local rules), a private `STIM_HOME` with
   `STIM_MAX_LOAD_PER_CORE` set just under the current 5-minute load per core.
   Start busy loops to hold the load, run two `stim ios` and one `stim android`
   in separate worktrees, and check the stderr lines, the queue order, the 30 s
   spacing, `status --json` `capacity.load.waiting`, a `--no-wait` refusal, and
   that `stim stop` during a wait is not gated. Stop the busy loops and check
   that the queue drains.
2. **Real agent load, with the maintainer's OK.** One busy evening with the
   setting at 20 on this MacBook's real home, and one comparable evening
   without. Readiness latency is the acceptance metric: the per-simulator
   `simctl spawn <udid> launchctl list` probe used in the Signal section, every
   20 s. Compare its p50, p95 and timeouts, boot failures,
   `STIM_CLAIM_UNAVAILABLE` counts from the logs, and the
   `kind: "load"` waits and refusals from `stats.json`. Pass: p95 readiness
   under 5 s and no readiness timeouts on the gated evening, with every wait
   visible and bounded.
3. **Hosted.** After phase 3, a hosted session to a mini started by the
   tester, with the mini's limit set just under its current load, is declined
   with the load reason, and the client places it elsewhere or waits as for a
   named Mac.
