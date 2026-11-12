# LLP 0016: macOS app output without a supervisor

**Type:** Decision
**Status:** Active
**Systems:** macOS, Logs, Claims
**Author:** Janic Duplessis / Claude
**Date:** 2026-11-12
**Related:** LLP 0007

## The op launches the app and stimd copies its output

`stim macos`, and a hosted macOS session's worker, start the app through
`spawnOwned`: detached, in its own process group, with stdout and stderr going
to two files in the workspace's logs directory (`macos-app-<hash>.out` and
`.err`) and `NSUnbufferedIO=YES` in its environment. The app holds the macOS
runtime claim itself. No Stim process is the app's parent and none waits on it,
so the app's exit code is not known: the run ends with `Exited <product>.` at
info level, never with a code, and a crash does not show in `stim logs --errors`
unless the app wrote something at warn level or above (stderr) first.

stimd's logs worker copies both files into `macos-app.ndjson` in the same
directory, stdout at info and stderr at warn. It finds the apps to follow from
workspace state and from hosted macOS sessions, when a command asks and every
two seconds, so a stimd that starts later picks up an app that runs or one
whose output it has not finished copying.

Reason: a per-workspace Node supervisor cost a process per app, a registration
handshake per launch, and gave the app the supervisor's environment instead of
the command's.

## Every writer gone

stimd treats an app's run as ended, writes `Exited <product>.`, records the end
in `macos-app.tail.json` and removes the two output files only when all of these
hold:

- the app's recorded identity is gone or names another process;
- no process remains in the app's process group;
- `lsof -t` lists no process other than stimd holding either output file open;
- everything up to the end of both files is copied.

`stim stop`, the next `stim macos`, a hosted session's stop and its app
replacement, and workspace removal each ask stimd to drain the app's output and
proceed only once that end is recorded. When it is not recorded within five
seconds, they fail and say why: the app still runs, its group remains, a pid
still holds the output open (named), or `lsof` could not answer. Stim sends no
signal to a process it found only through `lsof`; the person stops it.

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
- A helper that keeps a process in the app's group but closed its output still
  blocks the end, through the group rule.

## Each line once

One stimd at a time follows a directory, through an ownership claim
(`macos-app.tail.lock`) whose owner is that stimd; a successor takes it over
only when that stimd is gone or has released it. Before each append to
`macos-app.ndjson` the tail records, in `macos-app.tail.json`, the file's
identity and size and the read position the append completes; after the append
it records that position alone. A stimd that resumes from a record with an
append in flight compares the file: grown with the same identity means the
append landed. Only the tail appends to `macos-app.ndjson` or rotates it, so the
comparison is exact, and a stimd killed at any point, restarted or replaced
neither repeats nor skips a line.

When an output file reaches the log rotation size (8 MiB) the tail copies it and
truncates it. Output the app writes between the copy and the truncation is lost,
and the tail writes a warning that output may have been dropped.

## Provenance

The maintainer asked for the removal of the macOS supervisor in #5382 on
2026-11-12. The design above, its fail-closed rules and its limits were chosen
by the implementing agent and the coordinating session, not by the maintainer.

Related: #5382, #5386.

## Code

- `packages/stim-cli/src/commands/macos.ts` and
  `packages/stim-cli/src/device-host/macos.ts`: the launch.
- `packages/stim-cli/src/stimd/logs/macos-tail.ts`: the copy, the end and the
  append record.
- `packages/stim-cli/src/macos/output-writers.ts`: the `lsof` check.
- `packages/stim-cli/src/macos/stop.ts`: stop and drain.
