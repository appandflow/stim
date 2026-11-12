# LLP 0017: stimd keeps device log streams across a gap

**Type:** Decision
**Status:** Active
**Systems:** Stimd, Claims, Devices
**Author:** Janic Duplessis / Claude
**Date:** 2026-11-12
**Related:** LLP 0007, LLP 0013

## A stream survives a stimd crash, a planned update and a logs worker failure

Simulator and emulator log streams run as children of stimd and are written by
one logs worker thread. Three events end a stream's capture without anyone
asking: stimd dies, stimd is replaced by a newer build, the worker thread fails.
In each case stimd restarts the stream under the same stream id, writes what it
knows about the gap into the workspace's device log, and backfills the lines the
platform still holds. Reason: a stream that ended silently left the workspace
with no device lines and no record of why until `stim ios|android` ran again.

- **A crashed owner.** At boot, a stream record that was never handed over is
  resumed only when its claim proves the owner gone: the claim is resolved,
  names the stream, and every holder's owner identity reads gone or recycled
  (`streamOwnerGone`). The orphaned child of the dead stimd is stopped by the
  existing claim recovery, through its verified identity, before the new child
  starts. An owner that is running or unverifiable, no claim, or an unresolved
  claim means no resume and no reap; stimd logs `device_log_stream_unverified`
  with the claim's remedy and leaves the record. No time or pid decides.
- **Owned and booted.** A crashed stream is resumed only when the workspace's
  slot still records the device as owned and this Stim home's ledger lists it
  (`resolveOwnedIosSim`, `resolveOwnedAvdSerialAsync`), and it is booted and the
  same serial runs it. Otherwise the stream is not restarted; the interrupted
  record says why. Stim never touches a simulator or emulator it does not own.
- **A planned update** resumes as before and then backfills. No interrupted
  record is written: the stop and start records mark the gap and the backfill
  fills it.
- **A logs worker failure.** Each stream that can be resumed is marked handed
  over with the failure as its reason, so its cleanup keeps the record. After
  the streams have stopped, stimd restarts them once, in the environment each
  was started with (kept in memory, never on disk). A second failure during that
  recovery restarts nothing more; the records stay for the next stimd start.
- **Physical device consoles are not resumed**, because restarting
  `devicectl --console` launches the app. They get the interrupted record only,
  and the record is marked (`interruptedAt`) so later boots do not repeat it.
  Their claim and orphaned child are left as they were.

## The interrupted record

`collector_interrupted`, level `warn`, source `device`, with `interruptedFrom`
(the newest record this stream wrote, or the stream's start), `interruptedUntil`
and the reason. `warn` shows in `stim logs` and is not counted by `--errors`,
which keeps only `error` and `fatal` (plus native crashes and web errors): the
app did not fail, capture did. If a backfill fails, its own
`collector_backfill_failed` warn record says so.

## Backfill and duplicates

The resumed stream backfills with the existing `backfillDeviceLog`, from one
millisecond after the newest device line (a record with no `event`) that the
stream wrote to the workspace's device log, or from the stream's `startedAt` when
it wrote none. Lines already written have a timestamp at or before that point,
and the worker drops backfilled lines older than it, so nothing is written
twice. The worker's deduplication window against the live stream is unchanged.

Limits:

- A line with the same millisecond as the last written one, and written after
  it, is not recovered. Android timestamps include a clock offset measured again
  at resume, so a line within the offset's jitter of the boundary can repeat or
  be missed.
- iOS: `log show` returns what the simulator's log store kept at `info` level and
  above, the level the live stream uses; `debug` lines in the gap are lost. The
  query has a 15 s limit and its output is read whole.
- Android: `logcat -d --pid` returns what the ring buffer still holds for the
  app's current pid. A restarted app's earlier pid and evicted lines are lost.
- A quiet app's last line can be old, and the query then covers a long range.
- Windows keeps a declared child unrecovered (LLP 0007), so a crashed stream
  there is not resumed.

## Owned web streams and the worker

The worker also holds the DevTools observer of each owned Chrome. When it fails,
the roots that may have lost output (those with a request in flight and those
whose web record names a Chrome) are marked unverified, and only those. A root
stops being unverified when a later `ownedSync` or `ownedObserveWeb` for it
completes on the new worker. A refused drain for another reason still stands: a
web record whose Chrome has no observer refuses on its own. Until then
`ownedDrain` for that root refuses with the stop remedy, and `ownedRunning()`
holds idle exit.

The remedy for a state that cannot be verified is to stop this stimd: it is
safe, and the next command starts a new one.

A web stream whose writer failed is reported once and dropped. stimd logs
`web_observer_failed`; the next drain of that workspace returns the failure once
(the output was lost, and removal can then proceed), and a new Chrome launch is
no longer refused. The stream is not re-attached for the same Chrome until
something asks for it. This replaces the earlier rule that a failed writer kept
its observer until stimd restarted (#5386).

## Provenance

The maintainer decided on 2026-11-12 to fix the device log regressions in stimd,
as relayed by the coordinating session: "Bring back helper for both and fix 3 to
6 in stimd" (items 3, 5 and 6 of the regression audit). The words are not on the
issue. The rules above (the claim proof, the owned and booted check, `warn` and
the record's shape, backfill from the last written line, per-root unverified
state, report-once for a failed web writer) were chosen by the coordinating
session and the implementing lane.

Related: #5572, #5462, #5465, #5386.

## Code

- `packages/stim-cli/src/stimd/logs/streams.ts`: `resumeIn`, the worker failure recovery, `ownedDrain`.
- `packages/stim-cli/src/stimd/logs/claim.ts`: `streamOwnerGone`.
- `packages/stim-cli/src/stimd/logs/interruption.ts`: the record, the last-written scan, the device check.
- `packages/stim-cli/src/stimd/logs/owned.ts`: report-once for a failed web writer.
