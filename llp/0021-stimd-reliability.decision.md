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
in between does not erase them, a startup failure after the claim is taken (a
detached boot only) is counted, and `stim status` reads the file. Three abnormal
boots of one build among those started in the last 10 minutes hold the next
start. Reason: the history in the claim vanished with the claim on a clean exit
and on the first startup cleanup, so a corrupt `config.json` looped forever.

A failure that comes from the Stim home (a `config.json` that does not parse, ENOSPC
or EDQUOT, EACCES or EROFS on a path inside the home) is recorded with what to fix.
Such boots count toward the hold but not toward a rollback: the build is not marked
bad and the engine does not go back, and stimd stops naming the file or the disk.
Only three boots not attributable to the home roll the engine back.

The hold covers every build and launch mode: a store engine rolls back when it
can, and a stimd without a previous engine (an npm or global install, an attached
stimd, which refuses to host while the hold stands) stops restarts with a remedy
until the boots leave the 10-minute window, or the person removes the file. No
rollback is invented for them.

Three rules for what supervises stimd (an OS job restarts it on any exit but 0):

- A stimd that stops because of the hold exits with code 0, so a supervised job
  stays down. Any other code or a signal is a restart. Code 75 is reserved for a
  shutdown watchdog.
- Every abnormal boot carries a free-text `reason` and is classified like any other
  one: a later watchdog self-kill or a forced replacement of a stimd that does not
  answer records its boot through the same call (`recordAbnormalBoot(boot, reason,
cause)`), and counts toward the hold.
- Silent exits (SIGKILL, out of memory, SIGHUP on a stimd that did not handle it)
  count through `stimd_predecessor_lost`. `stim status`,
  `status --json` (`crashHold`, `abnormalExits`, additive) and `stim doctor` show the
  hold and the last abnormal exits.

## A handover with no successor

When a stimd hands the home over and its successor does not bind within 10 s, or the
relaunch is skipped because cleanup was not verified, it logs `successor_missing`
with the reason and writes `run/successor-missing.json`. A client that was refused
by the old stimd and finds the marker with no stimd running starts one at once
instead of waiting out the handover wait. The next stimd removes the marker. The
Desktop poll already starts a stimd when `run/stimd.json` is missing, so it needs no
marker.

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
second signal, the classification of home faults, the stop-with-remedy hold for
non-store and attached stimds, and the marker file.

Related: #5579.
