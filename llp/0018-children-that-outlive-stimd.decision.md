# LLP 0018: Children that must outlive stimd have their own parent

**Type:** Decision
**Status:** Active
**Systems:** Stimd, Metro, Claims
**Author:** Janic Duplessis / Claude
**Date:** 2026-11-12
**Related:** LLP 0007, LLP 0016, LLP 0017

## Which children stimd may own

stimd restarts: it crashes, updates in place, switches engine and idle-exits. A
process learns a child's exit status only by waiting on it as its parent, and a
pipe it reads ends when it does. So a child belongs to stimd only when a stimd
restart can drop it unnoticed: a pass, a measure, a fingerprint check, a probe.
A child whose exit code and complete output matter, and that must keep running
across a stimd restart, gets a small per-workspace helper process as its parent,
not stimd. Today that is the macOS app (`macos-run`, LLP 0017) and the dev
server (`metro-run`, below); the physical iPhone console is planned in another
issue. stimd stays
the coordinator of such a child: it starts and stops it, holds its claim, and
finds a running helper again by that claim and the helper's verified process
identity, never by name. Each helper costs one Node process while its child runs.
A new design that adds a long-lived child to stimd says which side of this rule
the child is on.

## Maintainer decisions

Maintainer decision: "i think supervisors might still be needed to allow stimd restarting? I think we need to keep this in mind for future designs", 2026-11-12.

Maintainer decision: "Bring back helper for both and fix 3 to 6 in stimd", 2026-11-12. "Both" is the dev server and the physical iPhone console; items 3 to 6 of the regression audit are stimd log fixes another issue covers.

Maintainer decision: "if we're regressing on func i don't mind keeping the extra processes if it makes things simpler and more robust", 2026-11-12 (LLP 0017).

The maintainer said these to the coordinating session, which relayed them; #5571
quotes them (https://github.com/appandflow/stim/issues/5571#issuecomment-6834430648). The general rule above and the design below were written by the
implementing agent from those words and accepted by the coordinating session;
nothing else in them is the maintainer's.

## The dev server's helper

Why: a dev server that stimd adopted lost its exit code ("exit code unknown"
after every stimd restart). Output written between a crashed stimd's last read
and adoption was never recorded, and the tail stopped at the leader's exit
although group members still wrote (audit A1, A3).

**Process tree.** stimd starts `metro-run` (`dist/metro-run.mjs`,
`src/stimd/metro/run.ts`), which starts the dev server with piped stdout and
stderr in the dev server's own process group. The helper's child per mode:

- Expo: `node_modules/.bin/expo start` (on Windows, Stim's node running the bin).
- `metro.command`: the command's program.
- Bare React Native: `node <build>/injected/metro-host.cjs`. It is a separate
  process, so a Metro crash cannot take the record with it.
- Re.Pack: the Rock or React Native CLI bin.

stimd builds the fixed invocation (invariant 3) in `expoServerLaunch`,
`commandServerLaunch`, `repackServerLaunch` and `hostLaunch`. It passes the argv
after `--` and the env as the helper's own env, which the helper hands on
unchanged, so no env reaches disk. The managed tunnel stays a stimd child
(LLP 0016). It should follow later: its exit code matters less than Metro's, but
it shares the Windows hold.

**Detaching.** On POSIX the helper starts `detached: true` (its own group and
session) with stdio `ignore`, `metro-run.log`, `metro-run.log`, `ipc`, and stimd
`unref`s it. The helper's own stdout and stderr, which hold only its crash
output, go to `metro-run.log`, which stimd truncates at each helper start, so
the file holds one helper run. When stimd finds a helper gone with no exit file,
it copies the last 50 lines (at most 4 KB) of that file into the error record in
`metro.ndjson`, which keeps the history the next helper start truncates. A group signal to the dev server therefore never reaches the
helper.

**Claim and liveness.** stimd holds `metro.claim` as before. Its details also
record `helper: {pid, processToken, protocol: 1}`, so a later protocol change
can tell the helpers apart. The dev server is the claim child, so `retake()`,
`stopMetroTree` and a rolled-back build work as before. stimd judges the dev
server running while the helper's identity reads `same`. The helper exits only
after its child's group is gone and the exit is on disk. A helper whose identity
reads `unknown` is not settled; a stop then refuses with `STIM_CLAIM_UNAVAILABLE`
and the claim's remove command. The helper holds no claim of its own.

**Pending child.** From the helper's spawn until it reports, the claim child
is pending (`{"record":null}`, never recovered, LLP 0007). The window lasts one
Node start and one spawn. In these cases the claim is released:

- the helper reports `failed`, meaning it could not open its output files or
  start the dev server, or it stopped a dev server whose identity it could not
  read;
- the helper ended after writing an exit file with its own pid.

A helper killed before it reports (for example during its module load) or still
silent after 20 s leaves the claim pending, and `start` and `stop` refuse with
`STIM_CLAIM_UNAVAILABLE`. The refusal
names the helper pid and the claim path, and its remedy reads: "Stop the helper
with `kill <pid>`" when it still runs, then "Check whether a dev server still
listens on port <port> with `lsof -nP -iTCP:<port> -sTCP:LISTEN` (on Windows
`netstat -ano | findstr :<port>`) and stop it, then run `rm -f <claim> <child>`". Once a person removes the claim, the next
`start` proceeds. After a stimd restart the same claim reads as unresolved;
`start` then refuses with `STIM_CLAIM_REFUSED` and `stop` with the claim
description, each with the same port check.

**Protocol.**

- Startup over IPC, like `macos-run`: the helper sends `registered` with the dev
  server's `{pid, processToken}` (or `failed`). stimd sets that as claim child,
  writes `helper` into the details and sends `metro-run-accept`, and the helper
  disconnects. If the channel closes before the accept, the helper stops its
  child.
- Output: the helper truncates `metro.stdout.log` and `metro.stderr.log` when it
  starts and appends raw chunks to them; `start` quotes the stderr tail. It turns
  lines into `metro.ndjson` records with `outputRecord(mode)`, Re.Pack's parser
  included. It also writes the Expo tunnel URL, once, into workspace state while
  the recorded supervisor token is its dev server's, and tries again every
  250 ms, at most 40 times, when stimd has not yet recorded the dev server, until
  the dev server exits. That
  is its only state write.
- Rotation: every writer appends each record in one `write` on an `O_APPEND`
  descriptor, so lines never interleave. Only the helper rotates `metro.ndjson`
  (at `LOG_ROTATE_BYTES`, by renaming it under `metro.ndjson.lock`), and, for a
  dev server without a helper, stimd's C30 tail writer. Every other writer opens
  the file for each record and never rotates: stimd's writer for a helper's
  workspace, the one-record writers of idle stop, idle device shutdown and
  `stop`'s vanished line, and the injected Metro writers (`appendFileSync`). `gc`
  trims the log only while no dev server runs. No one rotates the raw files;
  the helper empties them per dev server, as stimd did.
- Output limit: the dev server's stdout and stderr are pipes, because the
  helper records lines and the exit together. On macOS a process that writes a
  burst larger than the pipe buffer (64 KB) and then calls `process.exit()` loses
  what is still buffered inside that process, since its pipe writes are
  asynchronous. Everything the dev server wrote before it exited is recorded.
- Exit: at the leader's `exit` the helper keeps the code or signal and reads on
  until the group is gone and both pipes close. While the group lives, that is
  the dev server still running, and a stop ends it. Once the group is gone, the
  helper waits at most 1 s more for the pipes, then stops reading. A descendant outside the group that
  still holds a pipe then gets EPIPE on its next write. The helper writes
  `metro-run.exit.json` (`{pid, processToken, code, signal, exitedAt, helperPid}`,
  atomically) and exits.
- Settling the exit: stimd settles that file when the helper exits (it is the
  helper's parent), on every tick, at boot and before `start`. For a workspace
  whose claim no longer holds the dev server, it finds the file by scanning the
  registered projects' workspace directories. A file matching the recorded
  `supervisor` gets the one `supervisor_stopped` line and stop record. Any other
  file gets a `dev_server_exit_unclaimed` warn line with the code. Either way
  stimd deletes it. A matching exit file counts as an ended helper even before
  the helper process is gone. An ensure or a stop settles an ended helper first, so a
  start right after a crash records the crash rather than a stop. A stop that finds
  the dev server's leader already exited, with its helper still draining, waits for
  the helper to end (at most 5 s) and settles the exit the helper recorded, not a
  stop, and when a stop request is recorded too, the `requested` record keeps
  the code or signal; otherwise an
  adopted helper's exit waits for the tick, which took 42 to 45 s in the
  real-tool check. `status` (`metroLastStop`) reads a matching file before it
  calls a supervisor vanished, so it shows the code during that wait. stimd
  stays the only writer of `supervisor_stopped` and of the stop cause.
- Readiness and heartbeat are unchanged: the heartbeat carries the dev server's
  pid, and stimd probes the port.
- Group stop: one function, `stopProcessGroup` (`stimd/metro/group-stop.ts`), serves the helper's `close()` and stimd's
  fallback, so they cannot diverge. While the leader reads `same` it records each group member's identity and sends
  SIGTERM to the group. The group then gets 5 s to drain, since members outlive the leader by a moment; a leader that
  already exited is waited for the same way and nothing is signalled. A member still alive after that is killed by its
  own pid after its own identity reads `same` in the same synchronous step, never by a group signal. A leader reading
  `unknown` or `different`, a member whose identity cannot be read, a leader that exited before its members were
  recorded while members remain, and a group that does not empty are refusals naming the failed check and the pids
  left; the claim stays. A pgid is not reused while any member lives (Linux keeps the struct pid of a group in use;
  XNU skips the pids of existing groups), so a live group of a gone leader is the dev server's own. Not guaranteed: a
  member forked after the last listing that exits between its listing and its kill can have its pid reused.
- Stop: stimd checks the helper's identity and sends SIGTERM to that pid in one
  synchronous function. The helper stops its group (identity check, SIGTERM,
  up to 5 s, identity check, SIGKILL, up to 5 s), records the exit and ends. If
  the helper has not ended within 13 s, stimd stops the group by the claim child, then sends SIGKILL to a helper
  that still runs, again after an identity check. An unproven end is the
  `STIM_CLAIM_UNAVAILABLE` refusal. `metro.stop` answers only after the helper is
  gone, so `reclaim`, which stops through it, removes no directory the helper
  still writes.

**Events.**

- stimd crash, in-place update or engine switch: the helper keeps recording. The
  successor retakes the claim (owner gone, child live) and takes the helper from
  the details. There is no tail and no offset handover. An exit while no stimd
  runs waits in the exit file. The helper runs from its build's engine
  directory, which the claim's `engineDir` keeps retained.
- Idle exit: stimd does not idle-exit while it supervises a dev server, since
  idle stop, the C6 restart, hosted links and watch roots run in its tick.
- Helper crash: the dev server likely dies of EPIPE on its next write. stimd
  finds the helper gone with no exit file, stops the group by the claim child,
  and logs at error that the helper ended without recording the exit. The next
  ensure starts a new dev server. Output after the crash is lost. On Windows,
  which has no process groups, one function stops the dev server's tree for every
  stop path: it reads the leader's identity (`unknown` refuses with
  `STIM_CLAIM_UNAVAILABLE` and keeps the claim; `gone` or `different` means it
  already ended), runs `taskkill.exe` from `%SystemRoot%\System32` on that pid
  with no await in between, and confirms by the leader's exit, not taskkill's
  status. A still running leader after 5 s is the refusal, and its message names the failed
  check, taskkill's status included. Where the leader exited and a group member
  still lives (POSIX), the claim reads live while the group does and the remedy
  names the group: `pgrep -g <pid>`, `kill -TERM -<pid>`, then the claim removal.
- Machine reboot: the claim's owner and child are gone and no exit file exists,
  so the stop reads as "gone and recorded no cause".

**Windows.** The helper is used there too, but not detached, and stimd still
stops dev servers at its exit and holds an update with `heldBy:
"dev-servers"`. Whether a detached helper and its dev server outlive stimd on
Windows is not checked. Planned (#5571): a `ci-full` run of a test where stimd
exits and the successor stops the helper's dev server; then drop Metro from
`metroRootsEndingWithStimd` and the hold. Two Stim builds on one home (audit A6)
are unchanged.

**Contracts.** The `status --json` `supervisor` object keeps its shape and
meaning: `supervisor.pid` is the dev server's pid. The heartbeat, `metro.stop`,
`resolveProjectMetro`, `reclaim`, `machine-usage.ts` and Desktop
(`Resources.swift`) use it. The helper's memory, one Node process, therefore
falls outside the workspace's measured process tree. The stdout of `start` and
`stop` and `launched` do not change. One error answer does: `metro.stop` for a
workspace whose Metro claim is unresolved answers `STIM_CLAIM_REFUSED`, with the
claim description and the port check and remove command as remedy, where it
answered `not-owned` and `stim stop` then signalled the recorded dev server
itself. Stim cannot tell whether that dev server still runs under an unresolved
claim, so it refuses (LLP 0007); `stim stop` prints that message and remedy.

**Migration, compat C30 until 2.1.0.** A claim without `helper` holds a dev
server that a pre-helper stimd started. It is adopted as before (file tail, exit
code unknown) and restarted at its workspace's next idle point. A rollback to a
pre-helper build adopts a helper's claim the old way and tails the raw files the
helper still writes, at a known cost: every line lands in `metro.ndjson` twice,
the exit settles as unknown, and the exit file stays until a helper-aware stimd
finds it matching nothing.

Not determined: Windows behaviour; whether a `NODE_OPTIONS` meant for the
project, which the helper inherits as 1.40's supervisor did, matters.

## Code

- `packages/stim-cli/src/stimd/metro/run.ts`: the dev server's helper.
- `packages/stim-cli/src/stimd/metro/children.ts`: spawn, adoption, stop and settle of dev servers.
- `packages/stim-cli/src/macos/run.ts`: the helper this rule already applies to.
