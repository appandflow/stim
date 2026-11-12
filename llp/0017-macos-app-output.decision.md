# LLP 0017: macOS app output without a supervisor

**Type:** Decision
**Status:** Active
**Systems:** macOS, Logs, Claims
**Author:** Janic Duplessis / Claude
**Date:** 2026-11-12
**Related:** LLP 0007, LLP 0012

## The op launches the app and stimd copies its output

`stim macos`, and a hosted macOS session's worker, start the app through
`spawnOwned`: detached, in a process group of its own that Stim creates for the
launch, with stdout and stderr going to two files in the workspace's logs
directory (`macos-app-<hash>.out` and `.err`) and `NSUnbufferedIO=YES` in its
environment. The app holds the macOS runtime claim itself. No Stim process is the
app's parent and none waits on it, so the app's exit status is not known.

stimd's logs worker copies both files into `macos-app.ndjson` in the same
directory, stdout at info and stderr at warn. It finds the apps to follow from
workspace state when a command asks and when stimd starts, and from hosted macOS
sessions every two seconds; a workspace whose tail another stimd holds is retried
every two seconds. A stimd that starts later so picks up an app that runs or one
whose output it has not finished copying.

Reason: a per-workspace Node supervisor cost a process per app, a registration
handshake per launch, and gave the app the supervisor's environment instead of
the command's.

## How the run's end is recorded

When the run ends, the tail writes one exit record:

- An end Stim requested is `Exited <product>.` at info. Stim requests an end
  with `stim stop`, the next `stim macos`, a hosted stop or app replacement,
  workspace removal, or the cleanup of a failed launch. Each of these writes
  `macos-app-<hash>.stop` before it signals the app, and only while the app's
  recorded identity still runs. A stop that fails or is cancelled while the app
  still runs removes it again. An app that already ended when the stop began
  gets no marker.
- Any other end is at error level: `<product> ended without being stopped by
Stim; its exit status is unknown.` That includes an app the person quits
  (Cmd-Q) and one that exits normally. Stim cannot tell those from a failure, so
  each writes one error record.
- In both cases the tail looks once, read-only, for a crash report of that
  executable under `~/Library/Logs/DiagnosticReports`, written since the app
  started and naming its pid. For an end Stim did not request it first waits
  about two seconds. When it finds one, the record is `<product> exited with a
crash report. Crash report: <path>` at error level, whatever the marker says.
  Any failure of that lookup is ignored.

So a crash, or any exit Stim did not ask for, shows in `stim logs --errors`. A
crash that happens while a requested stop runs and leaves no crash report is
recorded at info. A stop cancelled after it sent SIGTERM removes the marker
while the app still runs, so the app's later death from that signal is recorded
as an error.

This rule was chosen by the coordinator and the reviews of #5559, not by the
maintainer.

## Every writer gone

stimd treats an app's run as ended, writes the exit record, records the end in
`macos-app.tail.json` and removes the two output files only when all of these
hold:

- the app's recorded identity is gone or names another process;
- no process remains in the app's process group;
- both output files exist, and `lsof -t` lists no process other than stimd
  holding either of them open. A missing file proves nothing, since a deleted
  file can still be open.
- everything up to the end of both files is copied.

While a process other than stimd holds the output, the tail asks `lsof` again
after two seconds, then after twice the previous wait, up to 30 seconds.

`stim stop`, the next `stim macos`, a hosted session's stop and its app
replacement, and workspace removal each ask stimd to drain the app's output and
proceed only once that end is recorded. They fail at once while the app runs
or its output cannot be read or recorded. They wait up to five seconds while only
another process holding the output blocks the end, then fail. The failure names
the pid and the command to stop it (`kill <pid>`), or says that `lsof` could not
answer. A local stop or relaunch reports `STIM_MACOS_OWNER_UNVERIFIED`. Stim
sends no signal to a process it found only through `lsof`; the person stops it.

Reason: an app can start a helper that leaves its process group, inherits its
stdout, and outlives it. Neither the app's identity nor its group then proves
that nothing writes the output any more, and removing the files or the workspace
under that helper loses what it writes.

What the check cannot see:

- `lsof` sees only processes it may inspect: one of another user (a setuid
  helper) is not listed.
- A descriptor in flight over a Unix socket, sent by the app and not yet
  received, belongs to no process.
- The scan is not atomic. A process that holds the file can hand it to a new
  child while the scan runs; the parent is listed, so the next scan sees both.

This rule was chosen by the implementing agent and the coordinating session.

## The launch group

A requested end of a running app ends the process group Stim created for the
launch. Stim lists the group's members, then in one step checks that the
recorded app still runs and sends SIGTERM to the group, capturing the identity
of each member at that moment. After up to five seconds it sends SIGKILL, by
pid, only to the app and the captured members whose identity still matches. It
never signals the group once the app may be gone.

When the app is no longer running at a requested end, Stim sends no signal to
its group:

- If the app's pid names another process, the launch group is gone, since a
  pid is not reused while it is the id of a live group. The stop goes on.
- If no process has the app's pid, or its identity cannot be read, and
  processes remain in a group with that id, Stim cannot tell whether they are
  the launch's, for example after a reboot or once the pids wrapped. The stop
  refuses with `STIM_MACOS_OWNER_UNVERIFIED`, listing each remaining pid and the
  `kill` command for them. The person checks them and stops them.

While members remain after the app exited on its own, the run stays open.

Everywhere in this flow a signal follows, in the same synchronous step, a check
that the exact pid signalled, or the leader of the group signalled, is the
recorded running process.

The macOS supervisor this replaces did the same for an app that was still
running when it was stopped. For an app that exited first while a child kept
its output, the run stayed open until that child closed it. A stop then ended
the supervisor, left the child running with its output lost, and succeeded.

Stim Desktop starts a stimd as a plain child in Desktop's own process group
when Desktop's Stim home has none, so a stop of a running Desktop copy ends that
stimd with it. A `stim stop` that such a Desktop copy runs for its own workspace
is itself a member of the group. It refuses, naming its own pid, and says to
run `stim stop` from outside the app.

A hosted session whose stop refuses this way stays in the unknown state and
keeps its slot until the person on the host stops the listed processes and
stops the session again.

This rule was chosen by the coordinator after the third review of #5559, and
replaces the earlier coordinator rule that signalled a group whose leader had
exited. It is not a maintainer decision.

## Each line once

One stimd at a time follows a directory, through an ownership claim
(`macos-app.tail.lock`) whose owner is that stimd; a successor takes it over
only when that stimd is gone or has released it. The one exception is a claim
this same stimd holds: stimd replaces its logs worker only after closing the one
that failed, so such a claim was left by a worker that no longer runs, and the
new worker takes it over. Within one Stim home the stimd claim already keeps a
second stimd out; the tail claim also covers a stimd started in a hosted
session's private home, which can name the same directory.

Before each append to `macos-app.ndjson` the tail records, in
`macos-app.tail.json`, the file's identity, its size before the append, its
expected size after it, and the read position the append completes. After the
append it records that position alone. A stimd that resumes with an append in
flight compares the file:

- exactly the expected size with the same identity means the append landed;
- an unchanged size means the append did not land;
- a file that grew but falls short holds part of the append, so the tail cuts it
  back to its size before the append and appends again.

Only the tail appends to `macos-app.ndjson` or rotates it, so a stimd killed at
any point, restarted or replaced neither repeats nor skips a record in the file.
A `stim logs --follow` that read the partial bytes sees the file shrink, takes it
for a rotation and can replay records it already printed. That is a limit. A tail that
resumes after the end was recorded only removes the raw files.

A failure of stimd's logs worker does not block a macOS drain: the tail's
record on disk is what the next worker resumes from. The worker-loss refusal
covers only the browser output of a workspace with an owned Chrome.

When an output file reaches the log rotation size (8 MiB) the tail copies it and
truncates it. Output the app writes between the copy and the truncation is lost,
and the tail writes a warning that output may have been dropped.

## Provenance

The maintainer asked for the removal of the macOS supervisor in #5382 on
2026-11-12. The design above, its fail-closed rules and its limits were chosen
by the implementing agent and the coordinating session, and the exit record,
launch group, exact append and worker-loss rules by the coordinator and the
review of #5559, not by the maintainer.

Related: #5382, #5386, #5559.

## Code

- `packages/stim-cli/src/commands/macos.ts` and
  `packages/stim-cli/src/device-host/macos.ts`: the launch.
- `packages/stim-cli/src/stimd/logs/macos-tail.ts`: the copy, the end, the exit
  record and the append record.
- `packages/stim-cli/src/macos/output-writers.ts`: the `lsof` check.
- `packages/stim-cli/src/macos/stop.ts`: stop, the launch group and drain.
