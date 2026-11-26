# LLP 0007: Claims and child cleanup

**Type:** Decision
**Status:** Active
**Systems:** Claims, Fingerprint
**Author:** Janic Duplessis / Claude
**Date:** 2026-11-12
**Related:** LLP 0002, LLP 0005

## One ownership protocol

Lock every read-modify-write to global config or workspace
state. Use atomic writes. An ownership claim held across a long operation -- a
build, an install, a supervisor lifetime -- goes through
`@stim-cli/core/ownership-claim` (re-exported by the CLI): a claim built privately
and renamed into place, named
by its own token, whose liveness is the holder's `ProcessRecord` read through
`inspectProcessIdentity`. No mtime, no heartbeat, no staleness threshold, and
no second implementation. A state it cannot establish is a refusal naming the
claim and the command that removes it, never a silent wait or a reap. A
process that cannot capture its own identity takes no claim and refuses with
`STIM_CLAIM_UNAVAILABLE`; it never runs the guarded operation unprotected.

## Short transactions and claim-set removal

Short synchronous transactions use core `withDirLock`, which shares that
claim protocol at `<lock>.claims` and retains reentrant nesting and bounded
waiting. The claim is the only lock state. Keep subprocess work outside short
locks and protect it with a child-aware claim. Only a complete claim whose
owner is proven gone is automatically recovered.
Core owns the `unique-pid` dependency and process-identity implementation;
cache packages remain usable without the CLI.
Removing a claim set is `clearFreeClaimSet`, which takes the set's own claim
first, so no sweep can delete a claim taken since it was surveyed. Device
leases use a declared expiry because the holder can be an agent with no
process. `pidExists` answers only "does a process with this pid exist"; it
cannot answer whether a record on disk still describes its writer.

A process ID can be reused after a crash, and a busy build can outlive any age limit. The claim binds ownership to process identity. The claim-set lock closes the gap between a cleanup survey and a new claimant arriving. The shared protocol also lets cache packages recover claims without depending on the CLI. [Shared ownership claims](https://github.com/appandflow/stim/pull/681), [Claim-only directory locks](https://github.com/appandflow/stim/pull/5340).

## A null child is never recovered

A claim whose child file reads `{"record":null}` means an unidentified child may
still run. A claim in that state is never reaped, whatever its owner's
liveness, and Stim refuses with the claim's path, its owner and the command that
removes it. Reason: a recovered claim lets a build start while the child still
reads or writes the tree.

The unresolved-claim reason in `stim status`, `stim gc` and maintenance names
the claim path, its owner (pid and claim time, and whether it still runs) and the
command that removes the claim and child files.

Exception: the hosted device agent-device daemon claim (next section) records no child.

## A hosted device daemon launch shares nothing with the next

Each hosted iOS or Android agent-device launch gets its own daemon state
directory and its own device-claims directory,
`<tmpdir>/stim-server-agent-device-<hash>/<launch id>/{state,device-claims}`, and
no later launch reuses them. The daemon claim records no child, pending or
captured. It means "no daemon that shares state with, or can be reached by, a
successor", not "no daemon this driver started still runs".

- Teardown signals only the proxy, through the child process and the identity
  the driver captured, and a daemon of that launch. A captured daemon is stopped
  through `agent-device daemon stop --state-dir` and its identity. When no
  daemon was captured (a failed launch, or a stop after the server restarted),
  teardown retires the launch as described below. The claim is released once
  the proxy is proven gone and the daemon is proven stopped, or the launch has
  neither `daemon.json` nor `daemon.lock`.
- A launch that failed before its daemon registered can leave that daemon
  running in its own directories. Its proxy is gone, so nothing can reach it,
  and agent-device's idle reaper ends it: 5 minutes after it last had work
  (`AGENT_DEVICE_DAEMON_IDLE_TIMEOUT_MS`), unless it holds a lease, which a
  failed launch never put.
- Every launch first takes the daemon claim, then retires the launch recorded
  in `<state dir>/agent-device-launch`. Retiring needs `agent-device daemon stop
--state-dir <launch>/state --json` to report `not-running`, unless that
  directory has neither `daemon.json` nor `daemon.lock`, and needs this
  device's agent-device iOS runners stopped. Otherwise the launch refuses and
  releases the claim, and a stop refuses and keeps it. So a daemon that
  registered and survived a server crash is never left driving the device
  beside its replacement.
- That command's deadline covers agent-device's own forced stop: the SIGTERM
  grace (75 seconds in 0.21.42, which accepts no shorter one), the SIGKILL wait
  and its metadata cleanup, plus the driver's stop timeout. A daemon that
  hangs while it shuts down is then force-stopped by agent-device instead of
  making every retry refuse.
- The driver deletes a launch directory only after it stopped that launch's
  captured daemon. `stim gc` removes a launch directory idle for 24 hours once
  `agent-device daemon status --state-dir <dir>/state --json` reports its
  daemon `stopped`, whatever lock or claim directories it holds, and lists each
  launch on its own under TMPDIR leftovers. gc never stops a daemon: a live
  session's daemon may sit idle that long, and an unreachable one ends through
  agent-device's idle reaper.
- 2.0.0-rc.3 kept a hosted daemon's state in the root itself
  (`<root>/{daemon.json,daemon.lock,daemon.log,sessions}`) and its device
  claims under `<state dir>/device-claims`. A clean stop removed that root, so
  it is left only after a crash. When `<state dir>/agent-device-launch` names no
  launch and the root holds `daemon.json` or `daemon.lock`, a launch retires the
  root as its previous launch, with the same rules. Later layouts write nothing
  but launch directories in the root, so gc treats every other entry of a root
  that holds a launch, `daemon.json` or `daemon.lock` as one leftover, removed
  under the same rule with `--state-dir <root>`. It removes those entries one by
  one and then the root only if it is empty. A daemon that exits gracefully, or
  that `daemon stop` ends, removes `daemon.json` and `daemon.lock` but leaves
  `sessions` and `daemon.log`; a stale record stays. Both go once no host runs
  rc.3.

Reason: a launch that fails before the daemon is captured cannot prove that
daemon gone. agent-device starts it detached, so stim cannot find it by
inference, and keeping the claim wedged the device until stimd restarted
(#6195). With nothing shared, an unreachable daemon cannot interfere with a
successor. In agent-device 0.21.42, its startup device-claim reconciliation and
Android keyboard restore read only its own state and claims directories.

Maintainer decision: "Yes, allow it", 2026-11-23, answering "May a failed launch
leave one unreachable agent-device daemon to idle out, so stim can never wedge?"
(https://github.com/appandflow/stim/issues/6195#issuecomment-7113973794).

## stimd stays up for a child it can watch

A cleanup refusal that names one child and carries a way to tell when that
child has stopped does not end stimd, whether it comes from the tick, a Metro or
tunnel stop, or a job on the passes or measure thread. stimd logs
`daemon_cleanup_unverified`, holds idle exit and engine switches, and checks
the child again on every tick; once it has stopped, the claims only that
failure retained are released. Any other unverified cleanup, a thread that
crashes, and a net thread failure end stimd. Its home and daemon claims stay, and the next start
recovers them once that stimd is gone. Its engine claim is released once
shutdown cleanup settles, because engine cleanup keeps every build a running
process runs from (#5510).

A thread job's refusal is watched only when no other child its operation
declared is still running. #5510 kept every thread refusal fatal because a
claim must stay held until every child of the operation has stopped, and an
error from exec carries every claim the operation declared while naming only
the child that refused; a second running child would be invisible to the
check. With other children running, the refusal still ends stimd.

A watched job's check stays on its thread, which also releases the claims the
job retained, since the checks are functions that cannot be posted between
threads. The failure crosses to stimd's main thread as its message, code,
remedy and the child's pid and identity token, and stimd's main thread reads a
flag the thread updates when stimd asks it to check again. The thread does not
end on idle while it watches a child, and a thread that ends while it watches
one ends stimd, since nothing can release what that child held any more.

The tick's own containment has no such operation check: the tick's errors reach
stimd's main loop without their operation.

While stimd waits, `stim status` (and `daemon.unverified` in its JSON) and
`stim doctor` list each child with its pid, when the wait started and its
remedy. The remedy says that the wait ends when that child's process group has
stopped, and that stopping this stimd (`kill <pid>`, `taskkill /PID <pid> /F`
on Windows) is safe: its home and daemon claims stay complete, the boot is not
marked abnormal, and the next command starts a new stimd. A command of another
build that this stimd refuses names the children it waits for. The wait has no
time limit: no clock proves that a child stopped, and a stimd that ended for it
would only move the wait to the claims.

This rule was chosen by the coordinator and the lane that implemented #5499,
not by the maintainer. The maintainer's requirement it serves, from #5499:
Maintainer decision: "We really need to fix stimd crashing and not being able to restart automatically", 2026-11-11.

## A killed macOS ps listing is left

On macOS, a report child that a call names as a bare `ps`, with no claims
declared for it, runs as `/bin/ps`. When its cleanup cannot be verified after
its cancel, `exec.ts` does not refuse: it logs `report_child_left` (warn, with
the pid and command), stops reading the child and lets the cancelled call fail
with its own abort or timeout error. No refusal reaches stimd, so the child
does not pin stimd, hold idle exit or an engine switch, or keep a claim. At most
eight such children are left at once in each process or thread, counted until
each one exits; the ninth is refused as before. A `ps` named by a path, any
other program, a `ps` with declared claims and every other platform keep the
refusal. A `ps` with declared claims keeps it because its claim must stay held
until the child stops.

`/bin/ps` is setuid root, so its identity is never captured. It is sent SIGKILL
after its cancel (below), and some take minutes to exit. In this Mac's daemon
logs from 2026-11-09 to 2026-11-20, all 31 refused report children were `ps`
listings refused this way; 9 of them exited more than 35 s after their cancel,
the slowest after 467 s. Each one held stimd until it exited. `ps` writes
nothing, so a left one costs only a process. The cap bounds that cost when `ps`
hangs for good, for example on a stuck mount.

The 2026-11-15 revisit condition below is met: 22 refusals came after #5778
landed. The issue #6025 lists "A read-only report child never blocks a
successor."

Maintainer decision: "I agree lets do this and ur recommendations from prev messages, also lets do the changes now that u flagged as after 2.0 id rather delay than ship what we have", 2026-11-20.

The design read that as "every claimless report child". An audit found
claimless report children that write (simctl location, privacy and push; adb
changes; `adb reverse` during reload), so the coordinator of #6025 first
generalized it to an allowlist of read commands. That allowlist is narrowed to
the measured case, because classifying arbitrary children after their spawn
could not prove which program ran. This choice was the coordinator's, not the
maintainer's.

## Releasing a claim after a killed fingerprint child

The fingerprint child (`bin/fingerprint-precompute.ts`) runs project code in
detached evaluators, each in its own process group. When the owner stops the
child before it writes its acknowledgement, the owner releases the workspace
claim only when all of these hold:

- the child itself and its process group are proven gone through its recorded
  identity;
- the child bootstrap wrote `observing.json` next to the acknowledgement after
  reading its request and before importing the evaluator module. The import
  loads Stim's own code, and the module installs the detached-group observer
  before any project evaluation. An empty ledger can cover a child killed
  while the module was loading;
- every `group-*.json` entry in the owner directory is a complete record whose
  leader started at or after the child did (compared through the start times in
  the two process records); the owner stops each group whose leader identity
  still matches (never by pid alone) and proves it gone.

An entry that is pending, unreadable, older than the child or not provably gone (a record that reads as a different process ends the wait at once), a missing marker, or
a platform without process groups, keeps the claim as `{"record":null}`. No
file time and no staleness threshold decides anything.

Reason: the acknowledgement already certified exactly this set, the groups the
child started through the single exec wrapper, and a child killed or starved
before it could acknowledge left that certificate unwritten while its evaluators
were still known. Without the ledger every Desktop doctor report that exceeded
its budget under load left a null claim that kept a workspace in use for hours
(#5546).

What the ledger cannot see: a process that project code starts itself outside
exec, for example one that detaches into its own session. The acknowledgement
could not see it either; neither proves that nothing runs.

The ledger is trusted only as far as the project code the child runs, in both
directions. That code runs as the same user and can write the directory, so a
forged entry can draw a kill of a group whose leader is newer than the child, and
a deleted entry can draw a release while an evaluator still runs. No privilege
boundary is crossed: the code could send the same signal itself. The start-time
rule keeps a forged entry from naming a process that was already running when the
child started.

A child killed before its bootstrap writes `observing.json` keeps the claim
as `{"record":null}`. A dead owner with a pending child also keeps the claim.

The child answers a SIGTERM during its module load itself, because a signal
before its handler exists would kill it unacknowledged.

Only the read-only doctor report is gated: with too little budget left, or on a
host above the precompute's load limit, it does not start a fingerprint child,
and the prebuild-record check, the fingerprint notes and the parity check are each
replaced by a note saying so. A fingerprint does not wait for the workspace
native-run lock: while another Stim operation holds it, the fingerprint refuses
at once naming the holder, and the doctor report shows that refusal as a note on
the fingerprint notes and the parity check. The repair, plan and warm reports
are actions the person asked for and need the fingerprint, so they still start a
fingerprint child under load. The kill-and-settle rule above covers them, and a child killed
before it writes `observing.json` on those paths still leaves a null claim.

The start-time comparison reads the process start times in the two process
records; on macOS these are wall-clock times.

The rule, including the start-time condition, was chosen by the coordinator and
the reviews of #5547, not by the maintainer.

Related: #5498, #5510, #5546.

## A report child whose identity was not captured is killed after its cancel

On POSIX, `reportChild.cancel` (`packages/stim-cli/src/exec.ts`) sends SIGKILL to a
report child whose identity capture failed, to that child only: nothing goes to its
process group. The signal is sent from a `setImmediate` callback that `cancel`
awaits, and only when `child.exitCode` and `child.signalCode` are both still
`null` there, in the same synchronous step as the check. Every later step is
unchanged: the group check, the "still has descendants" refusal and the refusal
when a state cannot be established. A kill that throws falls through to those
steps. A captured child, a child whose exit was already delivered, and Windows
are unchanged.

Reason: the child's own `exit` is the only proof that Stim no longer holds its
pid. Node sets `exitCode` or `signalCode` and clears the handle in `onexit`, but
libuv's `uv__wait_children` first calls `waitpid` for every ready child and only
then runs their exit callbacks one by one. JavaScript that runs between two of
those callbacks (nextTicks and microtasks) can see an unexited handle whose pid is
already free, which a probe of 40 children exiting together showed on Node 22 and 24. A `setImmediate` callback runs in the check phase of the same loop, after the
poll phase that reaps, so it never runs inside a batch. Outside a batch, a child
with `exitCode` and `signalCode` null has not been reaped by this process and
holds its pid.

- [`uv__wait_children`](https://github.com/libuv/libuv/blob/v1.51.0/src/unix/process.c#L101-L176), called only from the SIGCHLD watcher and from the kqueue poll.
- [`uv_run`](https://github.com/libuv/libuv/blob/v1.51.0/src/unix/core.c#L436-L480): `uv__io_poll` runs before `uv__run_check`.
- [`CheckImmediate`](https://github.com/nodejs/node/blob/v24.11.1/src/env.cc#L1548), the only caller of the immediate callback.
- [`onexit`](https://github.com/nodejs/node/blob/v24.11.1/lib/internal/child_process.js#L270-L295).

The kill uses `process.kill(pid, 'SIGKILL')` instead of `child.kill`, because a
failed `child.kill` emits an `'error'` event that the exec promise turns into a
rejection.

Maintainer decision, 2026-11-15: "For rest for with ur recs", in answer to a list of open decisions each carrying a recommendation. The recommendations it accepts for this issue, as they were put to the maintainer:

- "May Stim kill a report child whose identity it could not capture, through the handle it holds? Yes, the direct child only, and only before its exit event. The pid cannot have been reused while Stim has not reaped it."
- "Signal its whole process group too? No. The proof covers only the child."
- "Child exited but descendants are alive and unrecorded: keep refusing."
- "Downgrade the refusal to a warning for report-only passes? No. B1 removes the case; revisit only if the new log records show it still happens."
- "The longer-wait PR #5770: close it if you accept B1. It can outlast the shutdown watchdog and B1 replaces it."

The macrotask condition was added by the coordinator after a lane found that the
quoted proof fails inside a reap batch, not by the maintainer.

Related: #5766, #5769, #5771.

## Code

- [Ownership claims](../packages/core/ownership-claim.ts) and [short transactions](../packages/core/dir-lock.ts).
- `packages/stim-cli/src/fingerprint-precompute.ts`: the release decision.
- `packages/stim-cli/src/fingerprint/detached-groups.ts`: the ledger and the
  owner's check.
- `packages/stim-cli/bin/fingerprint-precompute.ts`: the bootstrap.
- `packages/stim-cli/src/exec.ts` (`reportChild`): the kill of an uncaptured report child.
- `packages/stim-cli/src/stimd/cleanup-watch.ts` and `packages/stim-cli/src/stimd/threads.ts`: what stimd stays up for.
- `packages/agent-driver-agent-device/driver.ts` (`launchDir`, `teardown`) and
  `packages/stim-cli/src/commands/gc/temp-leftovers.ts` (`judgeLaunch`): per-launch agent-device directories.
