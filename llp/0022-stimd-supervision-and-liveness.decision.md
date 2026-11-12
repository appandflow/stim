# LLP 0022: stimd supervision and liveness

**Type:** Decision
**Status:** Proposed
**Systems:** Stimd, Engine, Desktop, Claims
**Author:** Claude (design lane for #5579), not the maintainer
**Date:** 2026-11-12
**Related:** LLP 0007, LLP 0012, LLP 0015, LLP 0016, LLP 0018

Everything below is planned for #5579 (fixes 1 and 2) and is not on `main`. The
maintainer approved the fixes. The mechanisms, numbers and exit codes were
chosen by the agent, and the coordinator answered the open questions; none of
them is the maintainer's.

Maintainer decision: "I approve of all fixes", 2026-11-12 (#5579).

Maintainer decision: "another important consteaint of stimd is being resumable", 2026-11-12. The maintainer said it to the coordinating session, which relayed it; https://github.com/appandflow/stim/issues/5579#issuecomment-6835670519 quotes it.

## Why stopping stimd is safe: resumability

Replacing a stimd that does not answer, or letting it kill itself, is
acceptable only because a new stimd picks up everything the old one ran. What
is not resumable yet blocks a replacement and a self-kill:

- an offloaded build job running on this worker (it ends at stdin EOF);
- hosted native work in flight (LLP 0010 sends it down the stop path).

The list shrinks as the resumability work lands. A read-only audit of
resumability will post its findings on #5579, and this list follows them.

Lost but tolerated today, since the next stimd or the client recovers:

| Running at the time                | Today's main                                                   | With LLP 0018's helpers and #5575        |
| ---------------------------------- | -------------------------------------------------------------- | ---------------------------------------- |
| Metro, Unix                        | survives, re-adopted; exit code and output until adoption lost | helper keeps recording; nothing lost     |
| Metro and tunnel, Windows          | stopped with stimd                                             | unchanged (#5571's Windows check)        |
| Managed tunnel, Unix               | taken over by claim (LLP 0016)                                 | same                                     |
| Device log streams                 | end, not resumed                                               | resumed by #5575; gap during the restart |
| Physical iOS console               | lost until the next command                                    | helper planned (LLP 0018)                |
| Phone and Desktop connections      | dropped; clients reconnect                                     | same                                     |
| Ready hosted iOS/Android session   | resumes (LLP 0010); a macOS session takes the stop path        | same                                     |
| Share-only net thread `stim share` | dropped, not restored (LLP 0011)                               | same                                     |

## Planned (#5579): stimd judges its own main thread

A watchdog worker thread writes `run/stimd.alive.json` atomically every 5 s:
`{pid, processToken, instance, socket, seq, mainLagMs, tickStartedMs, closingSinceMs, holds}`.
`seq` increases on every write, and the worker keeps writing while stimd
closes, after `run/stimd.json` is gone. The main thread stores the monotonic
time of its latest turn (a 1 s timer) in a `SharedArrayBuffer`. `mainLagMs`
counts only time during which the worker's own timer fired on schedule (less
than 2 s late). `holds` names the non-resumable work above.

When `mainLagMs` exceeds 300 s, the worker appends `stimd_watchdog_abort` (lag,
load average, last tick) to `daemon.ndjson` and sends SIGKILL to its own
process. While `holds` is non-empty it logs `stimd_main_stalled` once a minute
instead.

Reason: the field log has main-thread stalls of 10 to 90 s under load, and the
audit could not tell blocking from CPU starvation; neither can a short hello.
A sibling thread that keeps its own schedule can: under starvation it is late
too, and no lag accrues. Monotonic clocks stop during system sleep on macOS and
Linux, so the 900 to 1014 s sleep gaps in the field log accrue none. The audit's
unverified inventory puts each synchronous main-thread call at 12 s or less,
but calls can chain in a turn, so 300 s is a starting value. A tick that never
ends while the main thread still turns (a hung volume `stat`) accrues no lag;
`tickStartedMs` shows it in `status` and `doctor`, and its time limit is fix 5's.
Signalling its own pid needs no identity check.

## Planned (#5579): socket presence and the detached shutdown watchdog

- The 15 s home watch also checks the socket file. Two misses in a row while
  stimd is not closing make it listen again on the same path and rewrite
  `run/stimd.json`. No child is affected. (Audit row 19.)
- `shutdown()` in detached mode arms the timer attached mode has
  (`waitMs + KILL_GRACE_MS`, detached `waitMs` 60 s) and exits 75 when it fires.
  (Audit row 21.) A shutdown whose main thread hangs falls to the rule above.

## Planned (#5579): a command replaces a frozen stimd

The trigger is a failed `hello` or op admission while the `run/stimd` claim's
owner is live. The command reads the alive file twice across the time it waits
today (250 ms for a contact, 30 s for op admission) and on any earlier stalled
reading, and decides:

| Evidence                                                                                                    | Action                  |
| ----------------------------------------------------------------------------------------------------------- | ----------------------- |
| A hello answers, or `seq` advances                                                                          | slow: continue as today |
| `seq` unchanged for 30 s and `ps` shows the owner stopped (`T`)                                             | replace, then continue  |
| `seq` unchanged for 300 s of on-schedule time                                                               | replace, then continue  |
| `seq` unchanged, threshold not met yet                                                                      | report and exit         |
| `holds` non-empty, `closingSinceMs` set, no alive file (older build), attached stimd, or identity `unknown` | report and exit         |

"Unchanged for" is measured from the alive file's own monotonic stamps and the
command's monotonic clock and timer lateness, so a command that was itself
starved or asleep does not count that time. A new `instance` or
`processToken` resets it.

A command never waits longer than it does today. When the threshold is not met
it prints the stimd pid, how long it has made no progress, that it will be
replaced once the bound passes, and the command that replaces it now
(`stim doctor --fix`), and exits with the existing code for an unavailable
daemon (`STIM_DAEMON_UNAVAILABLE`).

Stopping is one synchronous function: `inspectProcessIdentity(owner)` reads
`same`, SIGTERM, up to 10 s, identity again, SIGKILL, up to 5 s more. `unknown`
at any step ends in `STIM_CLAIM_UNAVAILABLE` naming the claim. The owner comes
from the claim and must match the alive file's pid and `processToken` (and
`run/stimd.json` when it exists); never a pid or a name alone. The replacer logs
`stimd_replaced` with the evidence before it signals. A second replacer reads
`gone` or `different` and signals nothing; the exclusive claim picks the one new
stimd.

Who replaces: `ensureStimd` and op admission in commands that create running
state, `stim stop` (`stopMetroTree`, which today ends in a manual claim
removal), and `stim doctor --fix`. Desktop does not (see below). Read-only
commands (`status`, `doctor` without `--fix`, `logs`) report "not answering for
<n> s" instead of "running". Attached stimds are reported, never replaced.

A watchdog self-kill and a forced replacement are abnormal exits and count
toward the crash hold like any other, subject to fix 4's classification: a
cause in home state does not blame the build. A hang loop is a crash loop.

### Claims: LLP 0007 and LLP 0015 stand

LLP 0007's rule stands: a claim is live exactly while its owner's process
identity reads `same`, and no heartbeat or staleness decides it. The alive file
never decides claim liveness. It only decides whether to stop an owner whose
identity is verified alive; once that owner is gone, recovery is identity-only.
The implementation PR adds a sentence saying so to LLP 0007.

LLP 0015 refuses to signal a Stim 1.40 to 1.42 stim-daemon holding the daemon
claim: Stim did not start it in this release line, and it exits by itself once
its workspaces stop. This rule signals only the identity-verified owner of the
`run/stimd` claim, a stimd that will not exit by itself, on positive evidence of
a freeze. The legacy refusal is unchanged.

## Planned (#5579): the operating system restarts stimd on the CLI path

- macOS: the CLI's launchd job keeps its per-start label
  `dev.stim.stimd.<home hash>.<nonce>` and its plist in `run/`, deleted after
  bootstrap so nothing starts at login. `KeepAlive` becomes
  `{SuccessfulExit: false}`, with `ThrottleInterval` 10.
- Linux: the transient `systemd-run --user` unit gets `Restart=on-failure` and
  `RestartSec=2`.
- Windows: no supervision in this work; the detached launcher stays.

Per-start labels, not one stable label (accepted by the coordinator): launchd
reads `ProgramArguments` only at bootstrap, so a stable label would pin one
build, and every engine switch or npm update would need a bootout, which
signals the running stimd. The store's `bin/stimd` shim would follow the
engine, but `stim engine uninstall` deletes it while a job may point at it.

| Exit                                                                                   | Code                      |
| -------------------------------------------------------------------------------------- | ------------------------- |
| Idle, `daemon.mode off`, run directory removed, lost the claim race, SIGTERM           | 0                         |
| Refusals only a person clears: unresolved claims, legacy daemon claim, crash-hold stop | 0, `daemon_failed` logged |
| A job-started stimd whose `run/` is missing: it never creates it                       | 0                         |
| Shutdown watchdog                                                                      | 75                        |
| Crash, uncaught error, watchdog SIGKILL, forced replacement, OOM                       | nonzero or signal         |

0 means stay down, and stimd removes its own job, as today; anything else
restarts. Only an entry that honours this contract runs under `KeepAlive`: a
build from before it exits 1 on refusals and would respawn every 10 s. Each
build records that it honours the contract, and the launcher starts any other
entry (crash-hold rollback, `stim engine use` of an older version, an npm
handover to an older build) with `KeepAlive` false, as today.

Handover keeps today's shape: the old stimd launches the successor in a new
job, exits 0 and removes its own. Two jobs exist only then, and the exclusive
claim keeps one stimd. `removeExitedJobs` stays and also runs on every client
launch, so a job respawning a build that no longer exists is removed by the
next start.

Crash loops depend on fix 4, which lands first: the hold covers every build,
counts silent exits, and exits 0 when it stops restarts.

Coexistence with `stim service`: both jobs may exist; the claim decides, the CLI
job's loser exits 0, and the service's loser becomes the `serveThroughStimd`
watcher, as today.

Stim Desktop keeps launching stimd as its own child, so the app macOS holds
responsible for stimd's privacy permissions stays Desktop. It gets exponential
backoff on restarts (10 s, 30 s, 2 min, then 5 min, reset after a stimd has run
10 min) and starts none while a CLI job of this home exists. Routing Desktop's
stimd through launchd was considered and not taken because it would move TCC
attribution to Stim Host or launchd; it can be revisited with the maintainer.

Elsewhere nothing changes: an attached stimd has no job; a runner that kills
descendants (#5084) is already escaped by the job; CI and machines without a
user launchd domain or systemd manager (`XDG_RUNTIME_DIR` unset, SSH without a
login session) fall back to the unsupervised detached process.

Cleanup: a clean exit removes the job. Removing a Stim home ends its stimd with
0 through the run-directory watch, and a respawn into a missing `run/` exits 0,
if launchd gets as far as exec (see verification). `stim engine uninstall`
removes this user's `dev.stim.stimd.*` jobs that are not running and whose
program lies under the engine root. `stim stop` and `gc` change nothing. Logout
or reboot removes every job.

No new command, flag or setting. Internal additions: exit code 75,
`run/stimd.alive.json`, and the build's exit-contract marker.

## Verification before building fix 2

launchd and systemd behaviour above is recalled, not observed. Before building
on it, the fix 2 author runs the product's own launch path in a scratch
`STIM_HOME` on the maintainer's MacBook and records the results here, replacing
this section's open items:

- respawn after a signal and after a nonzero exit; none after exit 0;
- throttle timing after a short and a long run;
- deleting the home's `run/` (the plist's `WorkingDirectory` and log paths live
  there; fallback: put them in the per-user temporary directory);
- `launchctl remove` of a job's own label while `KeepAlive` is set;
- a job whose program no longer exists;
- whether `stim-host run` passes on stimd's exit status and signals.

Only jobs that the lane's build creates for a scratch home, removed afterwards;
never the maintainer's jobs. Linux systemd stays "not verified" until a machine
with a user systemd exists, and the PR says so.

## Tests

- Unit, fake clocks: the watchdog decision (main turn, worker lateness, holds),
  the command's decision (alive reads, its own lateness, `ps` state, identity),
  and the exit code per shutdown reason.
- Integration, real processes, scratch `STIM_HOME`, stimd started with
  `node dist/cli.mjs __stimd` and stopped by pid: a SIGSTOPped stimd is reported
  before the threshold and replaced after it, and its pid is gone; a removed
  socket is listened on again; a never-settling thread job in shutdown exits 75;
  an older stimd without an alive file is reported, never signalled.
- Main-thread hang: in-process `runStimd` with a blocked main thread. No
  test-only operation ships in the product.
- The macOS integration teardown (`vitest.kill-run-processes.ts`) boots out its
  homes' jobs before it kills, or a respawn trips the leftover-stimd check.

## Pull requests, in order

Implementation starts after #5571 and the fixes 3, 4 and 6 lane have landed.

1. Fix 1, stimd side: new `stimd/watchdog.ts` and its thread entry,
   `stimd/main.ts`, `daemon/status.ts`.
2. Fix 1, client side: `daemon/client.ts`, new `daemon/replace.ts`,
   `commands/status.ts`, doctor `--fix`, and the LLP 0007 sentence.
3. Fix 2, after fix 4 and the verification above: `daemon/client.ts`,
   `daemon/systemd-launch.ts`, `stimd/main.ts` (`runStimdEntry`),
   `commands/engine.ts`, the integration teardown.
4. Desktop backoff: `ServerController.swift`, `ci-full`.

Each PR turns its section from planned to active. #5575 does not conflict.

## Not determined

- The numbers are starting values: 300 s lag and window, 30 s for a stopped
  process, 60 s detached shutdown, throttle 10 s, `RestartSec` 2, Desktop
  backoff.
- Where the build's exit-contract marker lives (engine build record or
  `package.json`).
- The launchd items under verification; all systemd behaviour.
