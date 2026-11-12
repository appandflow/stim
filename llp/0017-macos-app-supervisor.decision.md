# LLP 0017: The macOS app keeps its supervisor

**Type:** Decision
**Status:** Active
**Systems:** Desktop, Hosted devices, Claims
**Author:** Janic Duplessis / Claude
**Date:** 2026-11-12
**Related:** LLP 0007, LLP 0010

## The macOS app keeps its supervisor

`stim macos` and a hosted macOS session's worker start the app through
`macos-run`, a per-workspace supervisor process. It launches the app with piped
stdout and stderr, copies each line into the workspace's `macos.ndjson`, holds
the runtime claim with the app as its child, and records the app's exit code.
This is the one long-lived child that stays outside stimd; the others (Metro,
the tunnel, the owned Chrome of `stim web`) moved into it. Do not replace the
supervisor with a file that stimd tails unless the condition at the end of this
document holds.

Reason: the supervisor provides four things a stimd-tailed file cannot.

- **The exit code.** Only a parent that waits on the app learns whether it
  crashed, failed or was quit. Without one, every end Stim did not request looks
  the same, and a person quitting the app reads as an error.
- **An end of output proven by the pipe closing.** The supervisor's pipes close
  when every holder of them is gone. A file has no such signal, so completeness
  needs polling for holders with `lsof`.
- **A stop that a process the app left behind cannot block.** The supervisor is
  the claim holder and ends with its own signal. With the app as the holder, a
  stop after the app died refuses while a process it left in its group remains,
  where the supervisor's stop succeeds.
- **A hosted session that cannot get stuck holding a slot.** When a stop
  refuses because of a leftover process, the hosted session stays `unknown` and
  keeps its capacity slot until a person on the host kills the listed pids.

The cost is one extra Node process per running macOS app.

## Maintainer decision

Maintainer decision: "if we're regressing on func i don't mind keeping the extra processes if it makes things simpler and more robust" (2026-11-12)

The maintainer said this to the coordinating session on 2026-11-12, after five
reviews of PR #5559; the session relayed it. It is not on a GitHub thread. PR
#5559 was closed with the words quoted in its closing comment, and issue #5382,
which asked for the removal, was closed as not planned.

## What was tried

PR #5559 removed the supervisor. The app was started through `spawnOwned`, which
writes its output to files; stimd tailed them into `macos-app.ndjson`. A run
ended only when `lsof` showed no holder of the files besides stimd and no process
remained in the app's group. The exit status, which the supervisor gives, was
replaced by a lookup of a crash report under `~/Library/Logs/DiagnosticReports`
and by a marker file for ends Stim requested. Reviews found that every
regression above remained, and that the tail needed its own recovery logic for an
interrupted append. The branch `feat/5382-macos-stimd-owned` holds that work for
reference.

## Reopening

Reopen the removal only with a way to keep both of these: the app's exit code,
and a stop that a process left behind cannot leave stuck. Two leads were not
tried: stimd launching the app as its own child, which would give stimd the exit
code, and the system log's termination reason.

## Code

The supervisor starts in `commands/macos.ts` and `device-host/macos.ts`. Both
carry an `@ref` to this section.

Related: #5382, #5559.
