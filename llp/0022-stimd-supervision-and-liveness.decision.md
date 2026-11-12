# LLP 0022: stimd supervision and liveness

**Type:** Decision
**Status:** Proposed
**Systems:** Stimd, Engine, Desktop, Claims
**Author:** Claude (design lane for #5579), not the maintainer
**Date:** 2026-11-12
**Related:** LLP 0007, LLP 0012, LLP 0015, LLP 0016, LLP 0018

Everything below is planned for #5579 (fixes 1 and 2) and is not on `main`. The
maintainer approved the fixes; every mechanism, number and exit code below was
chosen by the agent and awaits the coordinator's answer.

Maintainer decision: "I approve of all fixes", 2026-11-12.

The fixes as approved: (1) commands and Desktop probe stimd and, when it does
not answer, verify the recorded owner's identity, stop it and start a new one,
without killing a stimd that is only slow, with a detached shutdown watchdog
and a socket-presence check; (2) stimd runs as a job the operating system
restarts on failure, with backoff, Desktop gets backoff, and a clean idle exit
does not respawn.

## Planned (#5579): stimd judges its own main thread

A watchdog worker thread in stimd writes `run/stimd.alive.json` atomically every
5 s: `{pid, processToken, instance, seq, mainLagMs, closingSinceMs, holds}`.
`seq` increases on every write. The main thread stores the monotonic time of its
latest turn (a 1 s timer) in a `SharedArrayBuffer`; the worker reads it.
`mainLagMs` counts only time during which the worker's own timer fired on
schedule (less than 2 s late). `holds` lists what makes a stop costly (below).

When `mainLagMs` exceeds 300 s, the worker appends `stimd_watchdog_abort` (with
the lag, load average and last tick) to `daemon.ndjson` and sends SIGKILL to its
own process. It does not abort while `holds` names an offloaded build job or
hosted native work; it logs `stimd_main_stalled` once a minute instead.

Reason: the field log has main-thread stalls of 10 to 90 s under load, and the
audit could not tell blocking from CPU starvation. A hello with a short timeout
cannot tell them apart either. A sibling thread that keeps its own schedule
can: under starvation it is late too, and no lag accrues. Every synchronous
child call on the main thread has a timeout of 12 s or less, so 300 s of lag
while a sibling thread runs is a hang, not slowness. Monotonic clocks
(`performance.now`, `hrtime`) stop during system sleep on macOS and Linux, so
the 900 to 1014 s sleep gaps in the field log accrue no lag. Signalling its own
pid needs no identity check.

## Planned (#5579): socket presence and the detached shutdown watchdog

- The existing 15 s home watch also checks the socket file. Two misses in a row
  while stimd is not closing make it listen again on the same path and rewrite
  `run/stimd.json`. No child is affected. (Audit row 19.)
- `shutdown()` in detached mode arms the timer attached mode already has
  (`waitMs + KILL_GRACE_MS`, with a detached `waitMs` of 60 s) and exits with
  code 75 when it fires. While closing, the alive file carries
  `closingSinceMs`. (Audit row 21.) A shutdown whose main thread hangs is
  covered by the main-thread rule.

## Planned (#5579): a command replaces a stimd that is frozen

The trigger is a failed `hello` or op admission while the `run/stimd` claim's
owner is live. The command then reads the alive file and decides:

| Evidence, gathered by the command over its own awake window                            | Action                                                                                |
| -------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| A hello answers during the window                                                      | slow: continue as today                                                               |
| `seq` advances                                                                         | the process runs; its watchdog owns the main-thread case: wait, or report its `holds` |
| `seq` does not advance for 30 s and `ps` reports the owner stopped (`T`)               | replace                                                                               |
| `seq` does not advance for 120 s of the command's own on-schedule time                 | replace                                                                               |
| `closingSinceMs` set and `seq` advances                                                | wait for the shutdown watchdog                                                        |
| No alive file (a build from before this change), attached stimd, or identity `unknown` | refuse: report the pid and the remedy, as today                                       |

The window is measured with the command's monotonic clock and its own timer
lateness, as in the stimd watchdog, so a command that was itself starved or
asleep does not count that time. Any `seq` change, including a new `instance`
or `processToken`, resets the window.

Stopping it is one synchronous function: `inspectProcessIdentity(owner)` reads
`same`, then SIGTERM, a wait of up to 10 s, `inspectProcessIdentity` again, then
SIGKILL and up to 5 s more. `unknown` at any step ends in
`STIM_CLAIM_UNAVAILABLE` naming the claim. The owner comes from the claim and
must match `run/stimd.json`'s pid and the alive file's `processToken`; never a
pid or a name alone. Once the owner is proven gone, its claim is dead and the
normal `takeClaim` recovery applies. The replacer logs `stimd_replaced` with the
evidence before it signals. Concurrent replacers need no lock: a second
replacer reads `gone` or `different` and signals nothing, and the exclusive
claim picks the one new stimd.

Who may replace: `ensureStimd` and op admission in commands that create running
state, `stim stop` (`stopMetroTree`, which today ends in a manual claim
removal), `stim doctor --fix`, and Desktop through the launch entry below.
Read-only commands (`status`, `doctor` without `--fix`, `logs`) never replace;
`status` says "not answering for <n> s" instead of "running".

Worst case before a replacement: about 30 s for a stopped process, 120 s for a
frozen one, 300 s plus a restart for a hung main thread, 60 s plus grace for a
stuck shutdown, 30 s for a removed socket.

### Differs from LLP 0015 and LLP 0007

LLP 0015 refuses to signal the holder of the daemon claim because that holder is
a Stim 1.40 to 1.42 stim-daemon: Stim did not start it in this release line, and
it exits by itself once its workspaces stop. This rule signals only the owner of
the `run/stimd` claim whose identity, `run/stimd.json` and alive file agree, a
stimd of this release line that will not exit by itself, and only on positive
evidence of a freeze. The legacy-holder refusal stays unchanged.

LLP 0007 says claim liveness uses no heartbeat and no staleness threshold. That
stays true: a claim is still live exactly while its owner's identity reads
`same`. The alive file only gates whether to stop a verified live owner, after
which recovery is identity-only. This reading was chosen by the agent.

### What a forced stop costs

| Running at the time                         | Today's main                                                    | With LLP 0018's helpers and #5575              |
| ------------------------------------------- | --------------------------------------------------------------- | ---------------------------------------------- |
| Metro, Unix                                 | survives, re-adopted; exit code and output until adoption lost  | helper keeps recording; nothing lost           |
| Metro and tunnel, Windows                   | stopped with stimd                                              | unchanged (#5571's Windows check)              |
| Managed tunnel, Unix                        | taken over by claim (LLP 0016)                                  | same                                           |
| Device log streams                          | end; not resumed                                                | resumed by #5575; gap during the restart       |
| Physical iOS console                        | lost until the next command                                     | helper planned (LLP 0018)                      |
| Phone, Desktop connections, hosted sessions | dropped; hosted sessions resume per LLP 0010, clients reconnect | same                                           |
| `stim share` from a share-only net thread   | dropped; not restored (LLP 0011)                                | same                                           |
| Offloaded build running on this worker      | job ends at stdin EOF; the client builds locally                | same; the stimd watchdog refuses while it runs |
| Engine switch or handover in progress       | the shutdown watchdog applies, not a replacement                | same                                           |

## Planned (#5579): the operating system restarts stimd

- macOS: the CLI's launchd job keeps its per-start label
  `dev.stim.stimd.<home hash>.<nonce>` and its plist in `run/` (deleted after
  bootstrap, so nothing starts at login), with `KeepAlive` set to
  `{SuccessfulExit: false}` instead of `false`, and `ThrottleInterval` 10.
- Linux: the transient `systemd-run --user` unit gets `Restart=on-failure` and
  `RestartSec=2`.
- Windows: unchanged for now (detached launcher, no restart); see Not
  determined.
- Desktop launches stimd through the same code (below), not as its own child.

Exit codes: 0 means stay down, and stimd then removes its own job, as today.
Any other code or a signal means restart.

| Exit                                                                                              | Code                           |
| ------------------------------------------------------------------------------------------------- | ------------------------------ |
| Idle exit, `daemon.mode off`, run directory removed, lost the claim race                          | 0                              |
| Refusals only a person can clear: unresolved claims, the legacy daemon claim, the crash-hold stop | 0, with `daemon_failed` logged |
| A job-started stimd whose `run/` is missing at start: it never creates it                         | 0                              |
| Shutdown watchdog fired                                                                           | 75                             |
| Crash, uncaught error, watchdog SIGKILL, OOM                                                      | nonzero or signal              |

Handover keeps today's shape: the old stimd launches the successor in a new job,
then exits 0 and removes its own job. Two jobs exist only during a handover,
and the exclusive claim keeps it to one stimd. `removeExitedJobs` stays, and
every launch from a client runs it too, so a job waiting to respawn a
build that no longer exists is removed by the next start.

Reason for keeping per-start labels instead of one stable label: launchd reads
`ProgramArguments` once at bootstrap, so a stable label would pin one build and
need a bootout of a running job (which signals it) at every engine switch or
npm update. The store's `bin/stimd` shim would follow the engine, but
`stim engine uninstall` deletes it while a job may still point at it.

Coexistence: with `stim service` installed for the home, its job and the CLI's
can both exist. The claim decides, the CLI job's loser exits 0, and the
service's loser becomes the `serveThroughStimd` watcher, as today. Desktop
checks every 10 s (active) or 60 s (inactive). After a failed start it backs
off 10 s, 30 s, 2 min, then 5 min, resetting once a stimd has run 10 min. It
does not start one while a job of this home is waiting to respawn.

Desktop launch: Desktop runs the engine's `bin/stimd` with an internal
`--launch` argument. The entry runs the probe and replacement above, then
`launchStimd`, waits for the claim and exits. It is one implementation, in
TypeScript. stimd's privacy-responsible process then becomes Stim Host or
launchd instead of Desktop; see Not determined.

Crash loops: launchd and systemd restart without a ceiling, so this depends on
fix 4. The crash hold must cover every build, not only store engines, count the
silent exits and replacements, and exit 0 when it stops. Supervision lands only
after that.

Cleanup: a clean exit removes the job. Removing a Stim home ends its stimd with
code 0 through the run-directory watch, and a respawn into a missing `run/`
exits 0. `stim engine uninstall` removes this user's `dev.stim.stimd.*` jobs
that are not running and whose program lies under the engine root. `stim stop`
and `gc` change nothing. Logout or reboot removes every job.

No new user-facing command, flag or setting. Internal additions: the `--launch`
argument of `__stimd`, exit code 75, and `run/stimd.alive.json`.

## Tests

- Unit, fake clocks: the self-watchdog decision (samples of main turn, worker
  lateness and holds giving wait, log or abort), the command's replace decision
  (two alive reads, its own lateness, `ps` state and identity), and the exit
  code for each shutdown reason.
- Integration, real processes, scratch `STIM_HOME`, stimd started directly with
  `node dist/cli.mjs __stimd` and stopped by pid:
  - a SIGSTOPped stimd is replaced by `stim start` within 45 s, and the old pid is
    gone;
  - a removed socket is listened on again;
  - a never-settling thread job in shutdown ends with code 75;
  - an old-format stimd without an alive file is reported, never signalled.
    The main-thread hang needs a test seam (an op that blocks the main thread
    with `Atomics.wait`); see Not determined.
- launchd and systemd: one recorded manual run per platform in a scratch home
  (not `~/.stim`, not the mini). Kill -9 respawns, idle exit stays down and
  removes the job, a handover leaves one job, a deleted home stays down. The
  macOS integration teardown (`vitest.kill-run-processes.ts`) must boot out the
  jobs of its homes before it kills, or a respawn trips the leftover-stimd
  check.

## Pull requests, in order

1. stimd side of fix 1: new `stimd/watchdog.ts` and its thread entry,
   `stimd/main.ts` (main-turn timer, socket re-listen, detached shutdown timer),
   `daemon/status.ts`. After #5571 and the 0021 lane's fix 3 (both edit
   `main.ts`).
2. Client side of fix 1: `daemon/client.ts`, new `daemon/replace.ts`,
   `commands/status.ts`, doctor `--fix`. After 1.
3. Fix 2: `daemon/client.ts` (plist and the client-side `removeExitedJobs`),
   `daemon/systemd-launch.ts`, `stimd/main.ts` (`runStimdEntry` exit codes),
   `commands/engine.ts` (uninstall), the integration teardown. After fix 4
   (`crash-hold.ts`, owned by the 0021 lane) and after 2.
4. Desktop: `ServerController.swift`, `EngineState.swift` (backoff, `--launch`),
   `ci-full`. After 3.

Each PR adds its rules to this document and turns its section from planned to
active. #5575 (`stimd/logs`) does not conflict.

## Not determined

- Whether a forced replacement or watchdog abort counts toward the crash hold
  (and can roll the engine back) or is recorded as a separate kind. Question for
  the 0021 lane.
- Stable label (as the brief proposed) or per-start labels (as chosen above).
- The numbers: 300 s main lag, 120 s and 30 s windows, 60 s detached shutdown
  wait, throttle 10 s, `RestartSec` 2, Desktop backoff steps.
- launchd semantics, verify on the manual run: that `SuccessfulExit: false`
  respawns after a signal death; throttle timing after a long run;
  `launchctl remove` of its own label while `KeepAlive` is set; what launchd
  does when `ProgramArguments` no longer exists.
- Whether `stim-host run` passes on stimd's exit status and signals, and whether
  moving Desktop's stimd under launchd changes TCC prompts. The latter is a
  maintainer question.
- systemd: whether `--collect` with `Restart=on-failure` keeps a unit across a
  restart, and the version floor for `RestartSteps`. There is no Linux machine
  with a user systemd for the manual run yet.
- Windows: a restarting launcher, or the service runner in a per-home mode, or
  no supervision on the CLI path.
- The seam that blocks the main thread in an integration test, and whether a
  test-only op is acceptable.
- Attached stimds: report only, or replace through the host command.
