# LLP 0021: stimd records every exit and detects crash loops

**Type:** Decision
**Status:** Active
**Systems:** Stimd, Engine, Claims
**Author:** Janic Duplessis / Claude
**Date:** 2026-11-12
**Related:** LLP 0007, LLP 0015

## Every exit leaves a record

A stimd that ends leaves a reason in `daemon/daemon.ndjson`. A signal (SIGTERM,
SIGINT, and on the detached path SIGHUP) is a clean, logged shutdown. An uncaught
exception, or an unhandled rejection, which Node routes to the same handler, is
written to the log with its stack (bounded to 8000 characters) before the exit. A
second signal during a shutdown logs once and forces a logged exit after 5 s; it
is never a silent default kill. A forced exit, after a second signal or when an
attached stimd's shutdown outlasts its wait, writes its boot record and then sends
itself SIGKILL, so it ends on that signal rather than exit code 1. Reason:
`process.exit` joins worker threads, and a worker whose filesystem request waits
on a libuv thread that never returns, such as a hung directory open, never joins.
A stimd that cannot record its own end (SIGKILL,
out of memory, a native abort) is recorded by the next stimd: a dead holder of the
stimd claim whose details lack `kept` is logged as `stimd_predecessor_lost` with
its pid, build, start time and last tick, and its boot counts as abnormal. A stimd
that leaves its claim on purpose (an abnormal exit, an unverified child, a crash
hold) marks the claim `kept`. A holder that died in an earlier system boot is not
counted, and neither is one whose boot id cannot be compared with this process's,
because a reboot or a logout is not a crash. Reason: these exits wrote nothing, so a
crash loop made of them was invisible to the hold and to a person reading the log.

## The crash hold keeps its history

The abnormal boots of this home live in `run/stimd-boots.json`, written by stimd
under a directory lock and read through core, not in the stimd claim. A clean exit
in between does not erase them, and a startup failure after the claim is taken (a
detached boot only) is counted. Reasons kept in the file are bounded to 500
characters; the stack an uncaught exception writes to `daemon.ndjson` to 8000.

## Every abnormal boot has a cause

Each abnormal boot carries a cause, and only some can blame a build.

- `engine`: an uncaught exception, a non-zero exit, a failBackground, or a tick that
  threw for a reason below. Three of them in the last 10 minutes hold the next
  start; on a store engine they roll the engine back and mark the build bad.
- `home`: a fault of the Stim home, with what to fix: a `config.json` that does not
  parse, or ENOSPC, EDQUOT, EACCES, EPERM, EROFS, EISDIR or ENOTDIR on a path inside the
  home (compared by real path at a path separator, so `~/.stim-agent` is not inside
  `~/.stim`). The remedy names that path, and so the volume to free. These boots count
  toward the three that hold, but never toward a rollback: the build is not marked
  bad and stimd stops naming the file or the disk. ENOSPC outside the home blames the
  build.
- `unknown`: the predecessor died with no record (SIGKILL, out of memory, a logout,
  a harness killing the process group) or was force-exited after a second signal.
  Nothing says the build is to blame, so these are logged and shown, never roll back
  and never mark a build bad. As a loop guard five of them in 10 minutes hold the
  next start, with a remedy that says stimd was killed or ran out of memory, cause
  unknown. A logout that kills a stimd within its boot session cannot be told from a
  kill and is `unknown` too.
- A refusal is no crash and is not recorded: a claim another stimd holds, the
  engine-follow claim error, an engine switch, the socket directory or "another
  process answers" refusals, a socket EACCES or EPERM outside the home, a sandbox
  denial. They log `startup_refused` and count toward nothing.

Two consequences, chosen by the coordinating session and the reviews, not the
maintainer. The counter of `engine` and `home` boots and the counter of `unknown`
boots are independent: two `engine` boots and three `unknown` ones hold nothing. A
silent death of the engine itself (a native crash, an out-of-memory kill caused by a
leak) is `unknown`, so it stops a restart loop after five but never rolls the engine
back or marks the build bad.

A full home may be unable to record the boot. The write never throws; such a loop is
then visible only through the log writer's line on stderr.

The hold stops automatic detached restarts for every build and launch mode. On a
store engine with three `engine` boots the engine goes back; otherwise stimd exits
without starting, and a command that needs it falls back to the attached host as
when a detached start fails, printing one line that names the hold and its remedy. An
attached stimd is never refused by the hold. `stim doctor --fix` clears the hold by
removing the boots file, as a person's `rm` does, and the remedy names it first; no
new flag. `stim status`, `status --json` (`crashHold`, `abnormalExits` with their
cause, additive) and `stim doctor` show the hold and the last abnormal exits.

Rules for what supervises stimd (an OS job restarts it on any exit but 0):

- A stimd that stops because of the hold exits with code 0, so a supervised job stays
  down; so does every clean exit. Every abnormal shutdown, detached or attached, exits
  1, a tick failure and a failBackground included. Code 75 is reserved for a
  shutdown watchdog.
- Every abnormal boot carries a free-text `reason`, and `recordAbnormalBoot(boot,
reason, cause)` is the call a later watchdog self-kill or forced replacement of a
  stimd that does not answer uses to record its boot.
- Silent exits count through `stimd_predecessor_lost`, as `unknown`. On Windows the
  boot id cannot be compared, so silent exits are not counted there.

## A resume counts a crash twice

A command waiting on stimd continues once with the stimd that replaces a crashed
one (#5612). A request that crashes stimd therefore gives two abnormal boots: the
stimd that took the request and the one started for the repeat. The thresholds
count exits, so they are unchanged: with a known cause (`engine` or `home`), one
crashing command leaves 2 of 3, and the hold, and on a store engine the rollback
for cause `engine`, arrives with the next crash, after about 1.5 crashing
commands. With an unknown cause, a kill or out-of-memory exit repeats only if the
new stimd is killed as well, so 5 unknown exits still mean about 2.5 to 5 commands.
A resume that meets the hold fails at once with the hold's remedy, naming
`stim doctor --fix`, and starts no stimd. Chosen by the coordinating session, not
the maintainer: two crashes in a row on the same request are evidence, the hold
clears after 10 minutes or with `stim doctor --fix`, and only cause `engine` rolls
a build back. `stim doctor --fix` clears the hold only after its repairs and
report completed, so an unreadable config leaves the hold in place.

## A shutdown has a deadline

A stimd that has begun to shut down exits within 10 minutes of awake time. If its
shutdown has not finished by then, it logs `daemon_shutdown_timeout` with the parts it still
waits on (the tick, the maintenance pass, the dependency scan, Metro and tunnel
children, the net thread and device logs, the worker threads) and makes a forced
exit, as after a second signal: it records its boot and sends itself SIGKILL. A
stimd that already kept its claims for unverified cleanup records no boot there,
and its claims stay as that rule leaves them, so the next stimd takes the home
over as after any dead holder. A forced exit during an engine switch, before the
shutdown's cleanup settled, also logs `successor_missing` and writes the marker
below, since no successor was started. The boot carries cause `engine`, as for
the attached shutdown watchdog. Reason: a shutdown waited 5.7 hours on work that
never settled (#5981), holding the home's claim while a new stimd started and was
refused every minute; nothing ended it but a person's signal. The deadline covers
the slow parts of a normal shutdown: the net thread's 15 s stop, a report's 35 s
cleanup, a cancelled child's exit, and a cache trim, which checks for the cancel
between entries but sizes and removes one entry at a time.

Two waits outlast it on purpose:

- While this stimd's engine switch runs, the forced exit waits for it, then
  gives the shutdown 10 more minutes. The selector child holds the store's
  `.lock.sock` and `.flip.sock` through this process, and killing the process
  would free both while the selector still migrates a home or collects the
  store. The selector has its own 10-minute timeout.
- Before the process exits, stimd terminates each worker thread it started and
  waits up to 10 minutes for them to exit, then logs `daemon_shutdown_timeout`
  and sends itself SIGKILL. `process.exit` joins worker threads, so a worker
  stuck in a filesystem request would otherwise keep a stimd that kept its
  claims alive.

Each of these limits counts awake time: libuv's timers on macOS read
`mach_continuous_time`, which advances during sleep, so a plain timer armed
before a sleep fires on wake, before the cleanup it waits for has had a turn.
stimd adds the time between 5 s steps instead, and a gap over 60 s counts as
nothing, so counting resumes from the wake. A main thread stalled for over 60 s
between steps is not counted either; a watchdog off the main thread is #5995.

Limit: these timers run on stimd's main thread. A main thread blocked in a
synchronous call, such as a recursive `rmSync`, runs none of them.

## A step that runs long is named

A step of a tick or of the maintenance pass that runs 10 minutes logs
`daemon_step_running` with its name every 10 minutes until it ends, so a step
that never ends is named in the log. While `daemon.mode` is off and stimd stays
up only for work it still serves, each pass of its loop logs `daemon_tick_off`.
These records only log: nothing ends stimd for a slow step. Timers on macOS
count time asleep, so a bound on a step would fire on wake after a long sleep;
a stall bound needs a watchdog off the main thread that tells sleep from a
stall (#5995). Reason: in #5981 the ticks stopped without a record for 3.5
hours while the net thread went on serving, and the log did not say where.

The deadline, the waits past it and the 10-minute records were chosen by the
implementing lane of #5981 and its coordinating session, not the maintainer.
The forced exit ends on SIGKILL, not code 75, for the reason under "Every exit
leaves a record".

## A handover with no successor

When a stimd hands the home over and its successor does not bind within 10 s, or the
relaunch is skipped because cleanup was not verified, it logs `successor_missing`
with the reason and writes `run/successor-missing.json`. A client that was refused
by the old stimd and finds the marker with no stimd running starts one at once
instead of waiting out the handover wait. The next stimd removes the marker. A service unit's stimd that hands the home to its unit's job starts no successor and writes neither, unless a forced exit ends its shutdown; it logs `successor_job` instead (LLP 0009, Service and engine updates). The
Desktop poll already starts a stimd when `run/stimd.json` is missing, so it needs no
marker.

## A stimd that does not answer is reported

`stim status` and `stim doctor` send a stimd that holds the daemon claim a probe
frame, `{kind: "probe"}`, and wait 3 s for any reply, connecting again while the
socket refuses or is missing. stimd answers it with `{op: "probe", pid, build}`
and closes the connection. That path runs before the client checks: it sets no
contact time, so a probed stimd still exits when idle, notes no client build, so a
probe never starts a handover, and logs nothing. The accept-time engine check
still runs for every connection; it depends only on stimd's own state and the
engine on disk, so a probe only brings it forward. A stimd that predates the
frame answers `unknown-kind`, which also counts as a reply. A stimd that is
shutting down closes the connection with no reply and has already removed its
socket file, so the probe reports it as not answering with the file missing.

Without a reply the commands say so with the pid, the wait and the age of the last
tick (`daemon.unanswered` in `--json`, the finding `stimd-not-answering`, a cost).
The wording is an observation, never "dead" or "hung": event-loop stalls of up to
85 s were measured while awake. The result belongs to the stimd it was taken
against: it is dropped when the claim holder changed during the probe, and never
joined to a status that names another pid. The probe starts no stimd, writes no
claim and signals nothing; stopping or replacing a stimd that does not answer is
not decided here.

Limit: a stimd that predates the probe frame cannot be told from a live one by its
pid, so the claim's pid stands, and its `unknown-kind` reply is the only evidence
that it answers.

`status --watch` and the stim-server status worker probe in the background, at most
every 10 s, and never wait for it: the first paint and each refresh come first, and
a silent stimd adds one more line when the 3 s end. `status` and `doctor` run the
probe beside the rest of their read, so a healthy stimd adds no measurable time and
a silent one adds the 3 s. Through the `status --json` shortcut that asks stimd
first, which already waits 5 s, a silent stimd takes about 8 s.

## stimd runs at the priority of an app

On macOS every launchd job that runs stimd sets `ProcessType` to `Interactive`:
the transient job `launchStimd` writes, which a command and a handover at an
engine switch go through, and the LaunchAgent `stim service install` writes.
launchd.plist(5) gives a job without `ProcessType`, or with `Standard`, light
CPU and I/O throttling, and stimd's children inherit it:
Metro, the builds it runs, the offload probes and the tools it starts. On a
loaded worker stimd missed `build.offer` and health deadlines while it ran
throttled (#5925); that the throttling caused the misses is not proven end to
end. `Adaptive` moves a job between Background and Interactive by its XPC
transactions, and stimd's clients reach it over a Unix socket and HTTP, never
XPC, so an Adaptive stimd stays in Background. The man page reserves
`Interactive` for a job that an app's responsiveness depends on and that cannot
be made Adaptive, which is stimd's case.

Measured on macOS 27 with throwaway jobs in the user's domain, each running a
shell and a child, read with `ps -o pri` and `launchctl print`:

| `ProcessType` | spawn type  | priority, job and child |
| ------------- | ----------- | ----------------------- |
| unset         | daemon      | 20                      |
| `Standard`    | daemon      | 20                      |
| `Adaptive`    | adaptive    | 4                       |
| `Background`  | background  | 4                       |
| `Interactive` | interactive | 31                      |

31 is the priority of a process started from a shell. A stimd that Desktop
starts as its child, or that a command hosts attached, runs outside launchd and
is not changed here; its priority was not measured.

The priority of a running stimd follows the job that started it. A stimd that
an older build started, including the first successor an engine switch onto
this build starts, runs at 20 until the next handover. Stim does not edit an
existing LaunchAgent for this: a unit installed before keeps `Standard`, also
when it is rewritten onto the engine shim, until `stim service install` runs
again, and launchd reads a plist only at bootstrap, so after a reboot or a login
such a unit starts stimd at 20 again. The stale-unit check (#6009) compares
the unit's `ProcessType` with what `renderPlist` writes, and `stim service
status`, `stim doctor` and `stim setup` print the `stim service install`
remedy, the only path for such a unit.

Maintenance children keep the priority they had: they run at stimd's priority,
now 31, except the size walks that already ran under `nice -n 19` and the
fingerprint children at nice 10. On macOS `nice` lowers only CPU, not I/O. A
QoS clamp that lowered every maintenance child at normal pressure was built for
this change and dropped before 2.0 (#6025). It had to exempt every child that
holds a lock a command waits on, and every child that may start a long-lived
shared process, such as git's fsmonitor daemon, an ssh `ControlPersist` master
or the adb server, which keeps the clamp for later foreground work. That list
cannot be completed from inside Stim. Less maintenance work comes first and is
done before 2.0 under #6025: the ladder paces on bytes freed and the
maintenance lane never runs beside it. After 2.0: measure a foreground build
with the lane running, and only if that shows a cost, do not start maintenance
at normal pressure while foreground work runs, never holding it back at high or
critical pressure.

Maintainer decision: "yea stim itself is fine at interactive I am good with", 2026-11-19.
[Decision on #5925](https://github.com/appandflow/stim/issues/5925#issuecomment-7023460880).

The request "Can priority be based on disk / ram load, so if high/critical it
becomes very important" (2026-11-19,
[#5925](https://github.com/appandflow/stim/issues/5925#issuecomment-7023456720))
is met at high and critical pressure, where maintenance runs at 31, and deferred
at normal pressure by #6025.

Maintainer decision: "I agree lets do this and ur recommendations from prev messages, also lets do the changes now that u flagged as after 2.0 id rather delay than ship what we have", 2026-11-20.
[Decision on #6025](https://github.com/appandflow/stim/issues/6025).

## Collect diagnostics with the existing reports

The [diagnostic procedure](../website/docs/dev-server-and-logs.md#collect-diagnostics-for-a-stimd-problem)
uses `status`, `doctor`, `engine status`, and the affected home's daemon logs
and state records. It tells the reporter what to preserve for correlation and
how to redact the excerpts before sharing.

Maintainer decision: "start with a documented redacted diagnostic collection procedure. Proceed with the daemon logging fixes. Defer a public `stim doctor --bundle` flag.", 2026-11-13.

[Decision on #5582](https://github.com/appandflow/stim/issues/5582#issuecomment-6864811705).

## Provenance

Maintainer decision: "I approve of all fixes", 2026-11-12.

That approval covers fixes 3, 4 and 6 of issue #5579 as proposed: the next stimd logs
that its predecessor died uncleanly and counts it, uncaught errors go to
`daemon.ndjson`, SIGHUP is handled on the detached path; the crash hold keeps its
count across clean exits, counts startup failures, does not blame the build for
home-state faults and is shown in `stim status` and `stim doctor`; a handover that
ends with no successor is logged and makes the client start one. How they are built
was chosen by the implementing lane and the coordinating session: the history file,
the `kept` mark on the claim, the boot-id comparison, the forced exit 5 s after a
second signal, the classification of home faults, and the marker file. A review of
the first version and the coordinating session added the cause classes, the
threshold of five for unknown deaths, the rule that a refusal is no crash, the
hold that never refuses an attached stimd and lets commands fall back, `doctor
--fix`, and the exit code 1 for every abnormal shutdown; none of these is the
maintainer's wording.

The implementing lane of issue #5774 chose the whole section on reporting a stimd that
does not answer, none of which is the maintainer's wording: the 3 s wait, the 100 ms
retry, the probe frame, the 10 s watch interval, probing on every `status` and
`doctor`, the finding code and its cost level, and dropping a result taken against
another claim holder. The maintainer's "Work on all those and lmk tomorrow",
2026-11-15, made #5774 part of the 2.0 work; it did not choose these. The
socket-presence check that fix 1 of #5579 names is not part of this change.

Related: #5579.
