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
is never a silent default kill. A stimd that cannot record its own end (SIGKILL,
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

## A handover with no successor

When a stimd hands the home over and its successor does not bind within 10 s, or the
relaunch is skipped because cleanup was not verified, it logs `successor_missing`
with the reason and writes `run/successor-missing.json`. A client that was refused
by the old stimd and finds the marker with no stimd running starts one at once
instead of waiting out the handover wait. The next stimd removes the marker. The
Desktop poll already starts a stimd when `run/stimd.json` is missing, so it needs no
marker.

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

Related: #5579.
