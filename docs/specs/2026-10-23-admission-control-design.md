# Load-aware admission control

Date: 2026-10-23. Status: proposed, design only. Issue: #4337.

## Summary

Stim starts a local native build or device boot whenever its counting caps
allow, and those caps are off by default. On a Mac shared by many agents, the
host itself fails before Stim's own logic does. This design adds one admission
rule. While this Mac's 5-minute load per core is at or above
`concurrency.maxLoadPerCore`, a `stim ios`, `android` or `macos` invocation
that is about to start local native work waits before it starts. It waits in
a FIFO queue of ownership claims (`load-waits`), with progress on stderr, until
the load falls or a fixed bound passes; then it refuses with a remedy. Remote
placement still runs first.

- **Reuse.** The rule sits next to the existing `saturation()` predicate and
  reuses the claim and ticket code of the device wait queue.
- **Caps.** It leaves the build-slot and device-slot caps and their queues
  unchanged.
- **Surface.** It adds one machine setting, off by default. It adds no command
  or flag and changes no existing flag's meaning, so `stim macos`, which has no
  `--wait`, gets the same fixed bound.

## Motivation

The 2026-10-21 strategy review found that most agent friction comes from an
overloaded host. At load averages of 300 to 900 on this 14-CPU MacBook,
agents hit these failures:

- simulators stopped answering readiness checks;
- taps took about 7 s;
- agents saw `STIM_CLAIM_UNAVAILABLE`, no device, and simulators reclaimed from
  other agents.

Issue #4093 reported `STIM_CLAIM_UNAVAILABLE` at load 600 to 800, likely
from slow child processes outliving a cleanup budget. Earlier runs on the same Mac recorded 0% CPU idle
and about 170 MB free memory at load 900. The Mac routinely sits at load 100 to 300.

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
| Maintenance deferral                          | `maintenance.maxLoadPerCore` (1-minute load, default 4)                      | automatic size scans wait                 | 1-minute load per core                                                                                                                                                                                               |

Remote work already has load admission: a worker declines builds at its
`server.maxLoadPerCore`, and #4321 adds the same field to device offers. Local
work has none. When every remote is full or none is configured, the build or
boot runs here at any load.

## Signal

### Candidates measured

Measured on this MacBook (14 CPUs, 48 GB) on 2026-10-23 from 03:34 to 03:54
UTC, with other agents' work running: 40 samples, 30 s apart. Over the run the
5-minute load per core was 12.4 to 18.9 (load average 173 to 265), and the
1-minute load average reached 449. Each sample read:

- the load average (`os.loadavg()`, in process);
- memory pressure (`sysctl -n kern.memorystatus_vm_pressure_level`, the read
  hosted admission uses);
- CPU idle (`top -l 2 -n 0 -s 1`);
- the CPU of simulator processes (`ps -A -o pcpu=,command=`, lines matching
  `CoreSimulator`);
- the time of `xcrun simctl list devices booted -j`;
- readiness: the time of `xcrun simctl spawn <udid> launchctl list`, the probe
  `ensureIosBooted` runs, on the first booted `stim-` simulator.

| Signal                 | Cost to read                                                                     | Range tonight                                          | Readiness, by signal                                                                                                                                                                                                                        |
| ---------------------- | -------------------------------------------------------------------------------- | ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 5-minute load per core | about 10 ms, no subprocess, never unknown                                        | 12.4 to 18.9                                           | Did not predict it. Spearman correlation with readiness time -0.42, the opposite direction. Under 15/core: median 663 ms, 4 of 22 probes over 2 s, slowest 19.2 s. At 15/core or more: median 538 ms, none over 2 s, slowest 861 ms.        |
| 1-minute load per core | same                                                                             | 8.3 to 32                                              | Did not predict it (Spearman -0.22). Spikes to 32/core passed with sub-second probes.                                                                                                                                                       |
| Memory pressure        | a sysctl subprocess, 2 to 63 ms tonight; it times out under heavier load (#4274) | 19 samples normal, 21 warning, 6 flips, never critical | Did not predict it. Normal: median 657 ms, slowest 2.9 s. Warning: median 538 ms, slowest 19.2 s.                                                                                                                                           |
| CPU idle               | `top`, about 2 s                                                                 | under 1% in 32 of 40 samples                           | Saturated: 0% idle from load 190 up, so it cannot rank anything above that.                                                                                                                                                                 |
| Simulator CPU          | `ps` over about 900 processes, 0.1 to 0.2 s                                      | 7.5% to 698%                                           | Tracked it. Every probe over 2 s came with simulator CPU at 150% or more: at 150% or more, median 1.3 s and 4 of 10 over 2 s; under 150%, slowest 1.1 s. The spikes coincide with a simulator booting (the booted count going from 4 to 5). |
| Readiness latency      | needs a booted device and a subprocess, about 0.5 s                              | median 615 ms, p90 2.1 s, slowest 19.2 s               | It is the harm itself, per device. It cannot gate a boot that has no device yet.                                                                                                                                                            |

A second run, from 03:54 to 04:04 UTC at 14.7 to 19.1 per core, probed every
booted `stim-` simulator each 20 s and recorded each one's id. It took 116
probes while two simulators booted, and it separates the booting device from
its neighbours:

| Probes                                                | Count | Median | p90   | Slowest | Over 2 s |
| ----------------------------------------------------- | ----- | ------ | ----- | ------- | -------- |
| The booting simulator, within 60 s of first appearing | 7     | 1.8 s  | 5.1 s | 5.1 s   | 2        |
| Other simulators within 60 s of a boot                | 41    | 955 ms | 1.7 s | 4.0 s   | 2        |
| No boot within 60 s                                   | 68    | 866 ms | 1.5 s | 2.8 s   | 1        |

The first run probed whichever booted simulator the list named first, so its
19.2 s probe was most likely a simulator that had just booted.

Earlier runs on the same Mac add the high end:

- at load 300 (21 per core), a single `simctl list` had a median of 0.63 s,
  which is healthy;
- at 600 to 900 (43 to 64 per core), claim-taking commands failed with
  `STIM_CLAIM_UNAVAILABLE` (#4093);
- at 900, CPU was 0% idle with about 170 MB free.

The strategy review saw readiness failures and 7 s taps somewhere between load
300 and 900, without a finer breakdown.

### Choice

The gate admits on the 5-minute load per core, as a coarse ceiling. It is not
chosen because it predicts trouble. Across tonight's 12 to 19 per core,
readiness did not get worse as load rose, and what tracked the slow probes was
simulator boots. It is chosen because:

- it is read in process in about 10 ms, with no subprocess. It is never
  unknown, so a loaded host cannot turn it into a refusal the way an
  unreadable memory-pressure sample does (#4274);
- it covers every source of load: builds, emulators, VMs and indexers, not
  only simulators. That includes load Stim did not start;
- the failures that break agents were seen only well above tonight's band, at
  43 to 64 per core. A ceiling below that band holds new work before the host
  reaches it;
- `machineCapacity()` already computes it, so placement and admission read one
  value.

The data brackets a useful limit for this Mac between 19 per core (tonight's
healthy band; a lower limit would have held work that ran fine) and 43 (the
documented failures). It does not say where inside that range harm starts. The
stress test in the test plan has to place it. Until then, 20 is a placeholder.
It is conservative because the Mac routinely reaches it.

The 5-minute average is used instead of the 1-minute one for stability, not
because the data shows harm follows it. Tonight the 1-minute value swung from
190 to 449 within minutes, and gating on it would flap.

Simulator CPU is not the gate, for four reasons:

- it costs a `ps` of about 900 processes;
- it misses builds, emulators and outside load;
- it is mostly caused by Stim's own boots;
- the per-simulator run shows that most of the delay falls on the booting
  device itself, which pays it once, while its neighbours slowed modestly.

Spacing boots would address the neighbours only partly (open decision 10).
Simulator CPU and readiness latency become measurements in the test plan.

Memory pressure stays a placement input, after #4274's fix. Tonight it flipped
between normal and warning six times in 20 minutes at steady load and never
separated slow probes from fast ones.

## Gated actions

A gated action is one that starts sustained CPU and memory use:

- a local native build: iOS, Android or macOS SwiftPM, including prebuild,
  pods and compile, and the local fallback after a failed offload;
- an owned simulator or emulator boot, including adopting a parked device.

Admission is per invocation. A `stim ios`, `android` or `macos` invocation
holds one in-process admission, shared by all of its gated steps:

- The first gated step to start, boot or compile, takes the invocation's one
  ticket and waits.
- A step that starts while that wait is running awaits the same admission. On
  iOS the eager boot and the build run concurrently, so this case is common.
- Once admitted, every later gated step of the invocation proceeds without
  queueing for load again, including an offload fallback build. Each step still
  takes its own cap (build slot, device slot) as today.
- An invocation whose gated work is all skipped never takes a ticket: a cache
  hit on a booted device, a release JS swap, an install only.

A run therefore never holds a booted device idle while its own build waits on
load.

Never gated:

- `stop`, `gc`, `worktree remove`, `ports stop|release`, `device unlock`, park
  and teardown. They free capacity; gating them can deadlock the queue.
- `logs`, `status`, `stats`, `doctor`, `guide`, `settings`.
- `reload`, and install and launch onto a device the run already has.
- `start` and Metro. See open decision 6.
- `worktree warm`. It keeps stdout empty, and an install of JS dependencies is
  not native work.
- Runs on physical devices, which start no simulator, except for their local
  build, which is gated like any build.
- Builds that stim-server runs for other machines. They take build slots
  directly through `tryAcquireBuildSlotClaim` and are already declined at
  `server.maxLoadPerCore`.

Stim has no test command, so test runs are out of scope. Agent-driven taps go
through agent-device, not Stim.

## Behavior over the limit

Order of preference: a remote Mac, then a bounded wait, then a refusal.

1. **Remote.** Placement runs first and is unchanged. `auto` already offloads
   or places remotely at `server.maxLoadPerCore`, which is lower than any
   useful admission limit. By the time the gate holds local work, remotes were
   full, unreachable or not configured. With #4321, `remote-only` never reaches
   the local gate, and `remote` reaches it only after every remote refused. A
   waiting run does not re-ask remotes (open decision 5).
2. **Wait.** The invocation takes a shared ticket in a new claim set,
   `$STIM_HOME/load-waits`, through the same ticket code as `device-waits`.
   - **Order.** Tickets are ordered by sequence, strictly FIFO, with one kind.
   - **Decision.** Under a short core `withDirLockAsync` transaction, so a
     waiter does not block its process's event loop, the head
     ticket is admitted when the load is under the limit and the spacing below
     allows it. Admission releases the ticket.
   - **Reads.** The decision reads only `os.loadavg()`, the ticket set and the
     spacing file. It runs no device listing and no subprocess.
   - **Polling.** Waiters poll every 2 s, as device waiters do, and re-check
     automatic-pool membership (`requireAutomaticMachine`) on each poll.
   - **Progress.** Every 10 s the run prints on stderr:

         admission  waiting for load to fall (load 23.4/core, limit 20; queue position 2 behind ws-a; queue: ~/.stim/load-waits), 1m20s elapsed -- stim guide lifecycle concurrency

     Status reports the wait (below).
3. **Herd control.** The 5-minute average lags. When the load dips under the
   limit, admitting every waiter at once would spike it again. While any
   ticket waits, and for one interval after an admission that followed a
   hold, admissions are spaced apart; otherwise there is no spacing. The interval is a constant that the synthetic-load test calibrates
   by measuring how long one admitted build or boot takes to show in the
   5-minute value. It starts at 60 s; 30 s would admit up to ten runs inside
   one averaging window. The time of the last admission is a small file written
   atomically in the same transaction.
4. **Refuse.** A wait that reaches its bound refuses. The bound is a fixed
   600 s, the device-slot default, for every invocation, counted from when
   the ticket was taken. The refusal uses `STIM_AT_CAPACITY` (open decision
   4). It says which condition held at the bound, the load or the spacing of
   a deep queue, and gives the load, the limit, the queue path and position,
   and this remedy:
   - wait and retry;
   - place the work on a remote Mac (`remote.build`, `ios.remote`,
     `android.remote`);
   - stop an environment this agent owns;
   - or raise `concurrency.maxLoadPerCore`.

   `--wait` and `--no-wait` keep their current meanings, which cover device
   slots and leases only (open decision 3). So `--no-wait` and `--wait 0` still
   wait up to 600 s for load, and `stim macos` cannot shorten the wait. The
   guide says so.

The shared admission and its ticket live on the invocation's signal, not on
either step's. When one step is cancelled, for example the iOS boot wait that
ends when the build finishes, the other keeps the admission. The ticket goes
when the invocation is admitted, ends or is cancelled.

After admission the invocation takes its caps exactly as today. While it
waits for load it holds no build slot, device slot, boot marker or `device-waits`
ticket. A compile step that waits may already hold its workspace's build lock
and the shared-build single-flight lock, so another run waiting for the same
artifact waits behind it. That is accepted.

Load waits never reclaim a device. Queue reclaim of idle devices stays limited
to the head of `device-waits` when blocked by `concurrency.maxDevices`, as
today. Reclaiming under load was one of the reported harms.

### Claim and ownership rules

- **Identity.** A ticket is a shared claim with the waiter's process identity.
  A process that cannot capture its identity takes no ticket and refuses with
  `STIM_CLAIM_UNAVAILABLE`. It never runs gated work unadmitted.
- **Dead holders.** A ticket whose holder is proven gone is reaped by the claim
  protocol, as `inspectClaimSet` does for `device-waits` today.
- **Unresolvable tickets.** A ticket Stim cannot resolve is never skipped,
  reaped or silently waited on. Every run that surveys the queue refuses with
  `ClaimRefusedError`, which names the claim and the `rm` command that removes
  it. With the setting on, one such ticket therefore refuses every gated
  invocation in the home until it is removed. The setting widens that blast
  radius, and the guide states it.
- **Status reads.** `status` and `capacity.load.waiting` read the set with the
  non-reaping `readClaimSet` and report an unresolved ticket instead of
  failing, as `peekDeviceSlots` does for `device-waits`.
- **Housekeeping.** `doctor` reports an unresolved `load-waits` ticket with
  its `rm` command. `gc` clears a free `load-waits` set through
  `clearFreeClaimSet`, as it does for the other claim sets.
- **The transaction.** It reads `os.loadavg()`, the set and the spacing file,
  all in process, and starts no subprocess.
- **Spacing file.** An admitted invocation holds no load claim. The spacing
  file carries no ownership. An unreadable spacing file counts as no recent
  admission. That is a deliberate fail-open on herd control only; the load
  check still holds. The implementation comments it at the call site.
- **No teardown.** Admission never stops, parks, erases or deletes anything,
  so invariants 2 and 4 do not change.
- **Homes and versions.** Queues are per Stim home and load is per machine, so
  two homes on one Mac do not share fairness. Older CLIs sharing a home do not
  know `load-waits` and start work without it. The limit is therefore not a
  machine-wide hard guarantee, in the same way hosted admission is not.
- **Hosted workers.** A hosted native worker's private home is admitted by the
  server's reserve, not the local queue. stim-server removes
  `STIM_MAX_LOAD_PER_CORE` from the environment of the hosted workers and
  offloaded builds it runs, so they cannot inherit the gate.

## Defaults

`concurrency.maxLoadPerCore` defaults to 0, off. Turning it on by default is
open decision 1.

|                      | Opt-in (default 0)                                                         | On by default                                                                                                                                                                                                        |
| -------------------- | -------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Worst case           | Nothing changes: today's failures continue on machines that do not set it. | A machine whose load comes from outside Stim, such as a VM or an indexer, makes Stim wait 600 s, then refuse. A single-agent laptop rarely reaches 20 per core, so it should not notice.                             |
| What it cannot break | Everything else; the gate code runs only when set.                         | `stop`, `gc` and teardown stay ungated, so a user can always free capacity. The gate only delays starts. It never kills, reclaims or deletes. Every wait is bounded and printed, and every refusal names its remedy. |
| Rules                | Matches "Build and device caps are opt-in" in `AGENTS.md`.                 | Needs that rule changed.                                                                                                                                                                                             |

The recommendation is opt-in, with a default decided from the rollout's field
data.

## Interaction with existing mechanisms

| Mechanism                                                                              | Change                                                                                                                                                                                                                                                                               |
| -------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `saturation()` / `MachineCapacity`                                                     | Gains `limit` (`concurrency.maxLoadPerCore`). A new `admission()` next to it returns why local work must wait, or null. Both read the same `loadPerCore`.                                                                                                                            |
| `server.maxLoadPerCore`                                                                | Unchanged as the "prefer another Mac" and "decline remote work" threshold. When `concurrency.maxLoadPerCore` is set lower, `saturation()` uses the lower value, so placement never keeps work here that the gate would then hold.                                                    |
| `maintenance.maxLoadPerCore`                                                           | Unchanged. The guide lists the three load settings together.                                                                                                                                                                                                                         |
| Build slots                                                                            | Unchanged: no queue, first poller wins, 90 min ceiling, `--wait` not involved.                                                                                                                                                                                                       |
| Device queue (`device-waits`, `device-boots`, `peekDeviceSlots`, placement's `queued`) | Unchanged. No build ticket ever enters it, so older CLIs and device placement see the same queue as today.                                                                                                                                                                           |
| Offload                                                                                | Unchanged. A failed offload's local fallback takes the invocation's admission like any gated step.                                                                                                                                                                                   |
| Server build offers                                                                    | Unchanged. They decline at `server.maxLoadPerCore`, below the gate.                                                                                                                                                                                                                  |
| Hosted admission                                                                       | The reserve declines with the same `admission()` reason when the host's limit is set, as one more skip reason next to memory pressure. It does not queue: the client has other hosts, and for a named Mac it waits as #4321 describes. Lands after #4274 and #4275.                  |
| Stats                                                                                  | Load waits and refusals go to `stats.json` `capacityWaits` and `capacityRefusals` with `kind: "load"`. `StatsCapacityRefusal.kind` is the literal `'device'` today, so the type, `stim stats` and the guide change. Desktop's device-limit suggestion keeps filtering on `"device"`. |

## Capacity visibility

This is aligned with #3919, which adds `capacity.builds` and
`capacity.devices` when a cap is set. This design adds `capacity.load`, always
present because the busy threshold always applies:

    "load": {
      "cpus": 14,
      "loadPerCore": 17.6,
      "busyAt": 2,
      "limit": 20,
      "state": "busy",
      "waiting": [
        { "workspace": "...", "label": "ws-a", "kind": "ios", "since": "...", "position": 1 }
      ]
    }

- **`state`.** It is `free` (under `busyAt`), `busy` (placement prefers another
  Mac) or `holding` (at or over `limit`; new local work waits). `limit` is 0
  when off.
- **`waitingFor`.** A waiting run's `waitingFor` gets `kind: "load"`. It keeps
  the integer `inUse` and `max` fields that Desktop's `WaitingFor` decoder
  requires. Both are the limit, rounded to an integer, the way a full slot
  reads, and it adds the exact `limit`. It carries no live load value, so the
  workspace payload does not change while the wait goes on. Older Desktop and phone builds return no text for an
  unknown kind and show their generic waiting state. That is accepted.
- **Watch.** `status --watch --json` already never repeats an identical payload
  (`watchChangeKey`). So that `capacity.load` does not change on every tick,
  `watchPayload` reuses the previous `capacity.load` object until `state` or
  `waiting` changes, or the load moves by at least 1 per core from the value
  last emitted. That last rule is hysteresis, not rounding, so it does not flap
  at a boundary.
- **Plain status.** `stim status` prints `load 17.6/core (busy at 2, holding at
20); 2 waiting: ws-a ios 1m10s, ws-b android 20s`.
- **Desktop.** A Load item in the toolbar resource summary next to CPU, toned by
  `state`. CPU percent reads 100% from about one load per core and says
  nothing past it. The Machine page lists the waiters next to #3919's meters.
- **Phone.** The same item and list on the Mac status screen.

## Settings

| Key                          | Type                      | Scope   | Default | Env                      |
| ---------------------------- | ------------------------- | ------- | ------- | ------------------------ |
| `concurrency.maxLoadPerCore` | number, 0 or at least 0.1 | machine | 0 (off) | `STIM_MAX_LOAD_PER_CORE` |

Description: "5-minute load per core at or above which Stim starts no new
local native build or device boot; 0 means no limit". It goes into
`settings-registry.ts` first, so validation, doctor, `stim settings`, the JSON
schema and the guide contract tests follow.

No new commands or flags, and no change to an existing flag.

## Open decisions

| #   | Decision                                                                                                                                                                                                                                                            | Recommendation                                                                                                                                                                                                                                                                                                                                                                                                          |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Opt-in or on by default                                                                                                                                                                                                                                             | Opt-in. Set it on this MacBook only after the synthetic-load test places the limit, then decide a default from two weeks of `kind: "load"` stats.                                                                                                                                                                                                                                                                       |
| 2   | Reuse `server.maxLoadPerCore` or add a setting; its name                                                                                                                                                                                                            | Add `concurrency.maxLoadPerCore`, next to `maxBuilds` and `maxDevices`. `server.maxLoadPerCore` means "prefer another Mac" at 2 per core; as a gate it would have held every local build on this Mac all night. With `maintenance.maxLoadPerCore` there are three similar names, so the guide lists them together. A distinct name such as `concurrency.admitLoadPerCore` is the alternative.                           |
| 3   | Should `ios`/`android` `--wait <seconds>` and `--no-wait` also bound load waits? Today they cover device slots and leases. With `--device`, `--no-wait` means "install on a leased phone without a lease", and `--wait` defaults to 60 s. `stim macos` has neither. | No, not in the first version: a fixed 600 s bound for every invocation, and no flag changes meaning. Widening them would couple lease bypass and load refusal in one flag. It would also change runs with `--device` and leave `macos` unbounded, so it needs a product decision of its own. The cost: `--no-wait` and `--wait 0` still wait up to 600 s for load, and an agent cannot opt out of that wait.            |
| 4   | Refusal code: reuse `STIM_AT_CAPACITY` or add one                                                                                                                                                                                                                   | Reuse it, with the load named in the message and a `reason: "load"` field in JSON. Agents already handle it as "wait, place elsewhere, or stop something".                                                                                                                                                                                                                                                              |
| 5   | Should a waiting run re-ask remote Macs? The issue text expects over-limit work to go to a remote Mac; this design asks once, before waiting.                                                                                                                       | Not in the first version. Revisit with #4321's placement order.                                                                                                                                                                                                                                                                                                                                                         |
| 6   | Gate `start` and Metro                                                                                                                                                                                                                                              | No. Metro serves running apps and reload, and its bundling is bounded.                                                                                                                                                                                                                                                                                                                                                  |
| 7   | Also hold at `critical` memory pressure                                                                                                                                                                                                                             | Not in the first version (see Signal). Revisit if the stress test shows critical pressure under the load limit.                                                                                                                                                                                                                                                                                                         |
| 8   | Queue: reuse `device-waits` or a separate `load-waits`                                                                                                                                                                                                              | Separate `load-waits`, using the same ticket code. Build tickets in `device-waits` would make older CLIs wait behind them, make placement's `queued` count report the Mac as device-full, and need a device listing inside the lock to decide cross-kind room.                                                                                                                                                          |
| 9   | Limit value                                                                                                                                                                                                                                                         | No recommended value yet: the data brackets it between 19 and 43 per core on this Mac. Use 20 as the placeholder and place it with the synthetic-load test.                                                                                                                                                                                                                                                             |
| 10  | Always space owned-device boots, also under the load limit                                                                                                                                                                                                          | Not in the first version. In 116 probes, a boot slowed its neighbours' readiness by about 10% at the median (955 ms against 866 ms, 41 and 68 probes) and 13% at p90 (1.7 s against 1.5 s). The booting device itself took up to 5.1 s in 7 probes, and most likely 19.2 s in the first run. Spacing helps the neighbours only partly. Record boot start times in phase 1 and decide from the test plan's measurements. |

## Rollout

| Phase | Content                                                                                                                                                                                                                                  | Behavior change                                       |
| ----- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------- |
| 1     | `capacity.load` in status; #3919 meters; Desktop and phone items; each build and boot records `loadPerCore` and its start time in the build ledger (#4332) and stats. Depends on #3919 and #4332.                                        | None. Gives the field data for decisions 1, 9 and 10. |
| 2     | The setting, `admission()`, the `load-waits` queue, spacing, wait lines, refusals, the server environment exemption; guide `lifecycle concurrency`, `settings`, `facts`; website `settings.md`, `owned-devices.md`, `remote-machines.md` | Only where the setting is set                         |
| 3     | Hosted reserve declines on the host's limit; device offers report it beside #4321's `maxLoadPerCore`                                                                                                                                     | Only where set; after #4274, #4275, #4321             |
| 4     | Default decision                                                                                                                                                                                                                         | Maintainer                                            |

## Test plan

Unit tests on `admission()` and the queue decision as pure functions of load,
limit, tickets, last admission time and now. Each case names the failure it
catches:

- a run under the limit with no queue is admitted at once, with no spacing;
- at or over the limit it waits, and refuses at the bound with the queue path
  and remedy;
- when the load dips with three waiters, only the head is admitted, and the
  next one interval later;
- an unresolvable ticket in the set refuses with its `rm` command; a dead
  holder's ticket is reaped;
- an invocation's concurrent boot and build take one ticket, and both proceed
  on one admission;
- `stop` from a workspace with a waiting run is not gated, and the waiter's
  ticket goes when its process ends.

Real-tool and real-load checks:

1. **Synthetic load, scratch home, controlled comparison.** On this MacBook in
   a quiet window (load under 80, per the local rules), use a private
   `STIM_HOME`. Hold the load with busy-loop processes at a fixed level above
   the limit under test. Run the same script twice, once with the setting off
   and once on: four `stim ios` and two `stim android` invocations in separate
   worktrees, started together.
   - **Measure:** readiness of each new simulator and of its neighbours (the
     per-simulator probe from the Signal section, every 20 s); boots that
     overlap within 60 s; boot and build failures; total time to all apps
     launched.
   - **Count as costs:** the time spent waiting and any refusals.
   - **Calibrate:** the spacing interval, and how long one admitted build or
     boot takes to show in the 5-minute value.
   - **Check:** the stderr lines, queue order, `status --json`
     `capacity.load.waiting`, and that `stim stop` during a wait is not gated.
   - **Repeat:** at several held load levels to place the limit (decision 9).

   The gate passes when, at the same held load, it lowers overlapping boots and
   readiness p95 against the setting-off run, at a waiting cost the maintainer
   accepts.

2. **Real agent load, with the maintainer's OK.** Run one evening with the
   setting at the limit from check 1 on this MacBook's real home. Record the
   same measurements and the `kind: "load"` waits and refusals from
   `stats.json`. This observes the cost in practice; it is not the acceptance
   test, because tonight's ungated baseline had no readiness timeouts at all.
3. **Hosted.** After phase 3, start a hosted session to a mini with the mini's
   limit set just under its current load. It is declined with the load reason,
   and the client places it elsewhere or waits as for a named Mac.
