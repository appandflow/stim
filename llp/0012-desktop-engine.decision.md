# LLP 0012: Stim Desktop and the matching-home engine

**Type:** Decision
**Status:** Active
**Systems:** Desktop, Engine, Server, Stimd
**Author:** Codex
**Date:** 2026-11-12
**Related:** LLP 0008, LLP 0009, LLP 0010

## Use the engine that owns the home

The macOS app lives in `apps/desktop`, a Swift package outside the pnpm
workspace; see its README. It reads state and runs Stim operations through the
matching-home stim-server, the net thread inside that home's stimd. Desktop
reads `run/stimd.json` and `run/desktop.key` to connect, and accesses workspace
and operation state only through the server. It reads the separate machine
engine pointer and manages its bootstrap runtime when needed. That store is
independent of `STIM_HOME`, even though the default paths share `~/.stim`.
Desktop never falls back to an external Stim CLI. It proves the key in `run/desktop.key`
(0600, written by stimd when it starts) with `desktop.authenticate` for its
Desktop-only methods; a local connection without that proof keeps the local
read and control capabilities only. A separately installed CLI is optional for
coding agents and terminal use. External bootstrap tools run through
`ProcessStream`.
It connects through stimd's CLI socket, whose path `run/stimd.json` names
(normally `$STIM_HOME/run/stimd.sock`; when that path exceeds macOS's 103-byte
limit, `/tmp/stim-sockets-<uid>/<sha256-of-normalized-socket-path>.sock`). The
first frame is `{"kind":"desktop"}`; `net.ensure` starts the net thread and
answers `{port, listening: true}` or why it cannot start, and `net.connect`
hands the rest of that connection to the net thread, where it speaks the
WebSocket protocol as a local client. The socket's directory is mode 0700 and
owned by stimd's user; the socket serves only that user without pairing or
Noise. stim-server binds no Unix socket of its own.

A bundled server and an adopted process on a fixed port could hold a different view of the same home. The matching-home connection has one state and operation owner and follows engine updates without a second Node runtime bundled in Desktop. [Desktop engine migration](https://github.com/appandflow/stim/pull/5365), [Single resident engine](https://github.com/appandflow/stim/pull/5380).

## A paired server owns its own work

Desktop can also pair as a client with another machine's
stim-server, as the phone app does: it spends a `stim pair` token in
protocol 2's Noise handshake, requires the payload's server-key fingerprint, and
keeps its per-pairing client private key and pinned server key in the macOS
Keychain, never under `$STIM_HOME`. The pinned key is the trust boundary;
Desktop accepts Tailscale endpoints and supported private IP literals, and `stim pair` refuses a Funnel route. A remote server grants it only the capabilities recorded for its key:
`read`, plus `control` for a `--control` pairing. `desktop.*`, `route.setup`,
`machines.update.*` and `device-host.sessions*` stay Unix-socket-only. Desktop
treats every remote message as untrusted input, never turns a remote path into a
local file or process, and never stores another machine's workspace data on
disk.

Viewing another server and asking a remote worker to run a local workspace have different owners. An address locates the paired server and its pinned key authenticates it. The private LAN parser brings Desktop in line with phone pairing while keeping the same key proof. [Pairing with owning servers](https://github.com/appandflow/stim/pull/4489), [Desktop LAN pairing](https://github.com/appandflow/stim/pull/5015).

## A command does not continue across a stimd restart

A command's admission (`op.begin` and its token) lives only in the memory of
the stimd that gave it, and so do its device lease ticket, its Metro ticket and
its readiness wait. A command waits automatically before that admission: while
a stimd starts, and while a stimd of another build hands the home over to one
of this build. Once a stimd has admitted it, a command whose stimd goes away (a
crash, a kill, a service restart) fails at its next step that uses the
admission with `STIM_DAEMON_UNAVAILABLE`, a message that says stimd stopped
while the command was running, and the remedy to run the command again; a step
under way settles as soon as the admission's connection ends. Those steps are the
device lease (`lease.prepare`/`lease.acquire`), Metro
(`metro.prepare`/`metro.wait`), the managed tunnel (`tunnel.ensure`), the
device log stream (`logs.start`) and launch verification (`readiness.wait`).
A command queued at a build, boot or test slot keeps its place, since that
queue is claim files, and fails at its next such step. The CLI does not admit
the command again and repeats no step. A command that already held an
admission, its own or one it took for a single request such as the managed
tunnel's, starts no stimd for the rest of its run: wherever it would start one,
including to observe its owned browser, it fails with the same error instead.
`stim start` does not report a dev server as started, or as already running,
once its admission is lost. A lease the lost stimd granted while its reply
was under way is released by the CLI. The device lease does not fall back to a
local lease, and a launch whose readiness wait or final coverage read finds
its admission lost fails instead of ending `unverified`, since a lost stimd is
not missing evidence (invariant 11).

A rerun costs little: the build is cached, the next stimd adopts a running Metro
by its claim (one still starting is waited for, not restarted) and resumes the
device log streams. A lease whose issuing stimd went away is released by its
token in the CLI, also when the operation is cancelled.

An engine switch waits while admitted commands pin stimd, so it does not cut
one. A stimd that decided to exit idle exits only if no command was admitted
while it checked the engine. A `stim ci` hold of a persistent stimd that is
ending when it asks waits for it to go and pins the stimd that replaces it,
starting one when none did; a stimd of another build, or one an attached
command hosts, is refused at once. A stimd that stops while the hold holds it
is not replaced: the hold prints one stderr line, and the job's next command
admits itself.

Maintainer decision: "And yes i think the resumeability thing was maybe a bad idea? If we can avoid by having clear errors if we interrup commants or have stuff wait automatically it would be better", 2026-11-20 (quoted on [#6025](https://github.com/appandflow/stim/issues/6025#issuecomment-7031965051)).
It replaces the CLI re-admission that followed from the decision of
2026-11-12 on [#5579](https://github.com/appandflow/stim/issues/5579#issuecomment-6835670519).

Chosen by the implementing lane, not the maintainer: the exit code stays 1, the
CLI waits up to 1 s for the admission's connection to close before it reads a
failed step as a lost stimd, and the CI hold's 30 s wait for an ending stimd
before it pins.

## A service stimd serves the service port

The stimd that holds a home a service unit serves listens on the unit's port.
Where the unit follows the engine, the job ends up the owner (LLP 0009, Service
and engine updates): a holder that accepts the job's ask below exits once no
command runs, and the job's restart then takes the home back.
Any starter can win the home after a handover: the successor, the unit's own
restart, or a stimd a command started, which has no service options and, with
a saved share, runs a share-only net thread on a random loopback port. So the
unit's process (`--service` without `--carried`), when it finds a stimd holding
the home, asks `net.ensure` with `service: true` and the values of its bare
`--env` names, which the holder may not have. When the holder runs a
share-only net thread, stimd replaces it with one on the service's options and
those values (the values reach only that thread, never a successor's
arguments; the new thread restores the saved shares), unless work pins stimd,
in which case it refuses and the unit's next restart asks again. An ask that
waits on the stop gets the service's thread. A service's ask that starts the
thread or the move holds the service's ownership from that moment, so Stim
Desktop cannot replace the thread while it starts; a thread that does not
listen on the service port releases it, and a move that fails puts the
share-only thread back on its previous options so saved web shares keep
serving until the next ask retries. stimd handles every `net.ensure` one at a time, in arrival order, against the thread as it is when the ask's turn comes, so one rollback configuration and one ownership reservation exist. A move's rollback restores the share-only options the thread ran on, never a proposal that did not start. A matching service ask joins a thread that is still starting. A service ask for port 0 matches any port, on the loopback setting alone. A thread start has no deadline of its own: an ask waits for it as it did before the queue, and the start is bounded by its own steps. The boot start of `stim serve` or of saved shares is the first turn of that queue. A service ask that finds a running thread that is not share-only and whose loopback setting or port differs from the service's is refused without taking ownership. Once the service's thread runs,
Stim Desktop no longer moves it. A net thread that serves clients on other
options (Desktop's or `stim serve`'s) is not replaced: the asker exits 1
naming both ports, and `stim service status` names the holder's port. Which of
the two owns the home then is the open decision of
[#5095](https://github.com/appandflow/stim/issues/5095).

stimd records its net thread's port as `netPort` in `run/stimd.json` (null
while none listens). Once stimd closes its net thread for good, no ask starts
another.

Maintainer direction: "can u check the update process to make sure this doesnt happen? Can we make sure stimd always uses same port so this wont hjappen", relayed on [#5811](https://github.com/appandflow/stim/issues/5811).

Chosen by the implementing agent, not the maintainer: replacing only a
share-only thread, refusing while pinned rather than deferring, and leaving a
unit that names one engine build to `stim service install` (status reports
it), serving every `net.ensure` one at a time in arrival order, matching a service ask for port 0 on the
loopback setting alone, and refusing a service ask whose options do not match a
running non-share thread.

## The gc report answers from its cache

Desktop's cleanup report is a gc dry run that takes minutes on a machine with
many checkouts, so stim-server never makes Desktop wait for one.
`desktop.reports.get {report: "gc"}` answers at once with the last good
report and `measuredAt`, the time its sweep started. While no report exists it
answers `pending: true` with no value, never zeros. At most one sweep runs. A
read starts one when the report is missing or older than 15 minutes, or after
`desktop.reports.invalidate` asked for fresh; an invalidation starts a sweep at
once only for a subscriber, and one that arrives during a sweep never aborts
it but makes one more sweep follow. `refreshing` is set while a sweep runs, and
`error` carries the last failed sweep's reason while none does; a failure keeps
the last good report, and the next sweep waits 5 minutes unless fresh is asked
for. The sweep runs on stimd's report thread, beside the passes thread, not
in the net thread: stim-server asks stimd for it over the CLI socket
(`gc.report`), as `stim gc --dry-run --refresh` does, so one sweep at a time
serves every reader, and an ask after an invalidation gets a sweep that
started after it. The sweep has a 15 minute budget instead of the API's 60
seconds; one past it fails its readers at once, and no sweep starts until its
thread job has settled, and stimd saves its result to `$STIM_HOME/gc/report-cache.json`, the
one writer of that file (read by core), so a restarted stimd answers from it
and stim-server takes a newer sweep another reader caused from it. The file
holds when the sweep and each of its parts started. Only without a stimd, as
in tests, does stim-server read the report in its own thread, and then it
writes nothing.
Phone machine details read the same entry. Desktop reads without invalidating
on its polls, every 15 seconds while a sweep runs or no report exists (backing
off to 5 minutes after failures) and every 5 minutes otherwise, and asks for
fresh only from its Refresh button and after an action that changes storage.
Nothing deletes from this report: a gc pass and `deleteGarbageItem` read their
candidates again before they act.

Maintainer decision: "also could stim mostly return its cached values, unless maybe deskt ask for fresh", 2026-11-27, quoted on [#6606](https://github.com/appandflow/stim/issues/6606).

Maintainer decision: "how reliable is stimd cache tho? If it is we might want to return cached values always?", 2026-11-27, quoted on [#6606](https://github.com/appandflow/stim/issues/6606).

Chosen by the implementing agent, not the maintainer: the 15 minute staleness
bound (about three of the slowest sweeps seen), the 15 minute sweep budget, the
5 minute retry after a failed sweep, and Desktop's poll intervals.

## Code

- [Home and socket discovery](../apps/desktop/Sources/StimKit/StimHome.swift), [machine engine paths](../apps/desktop/Sources/StimKit/EngineState.swift), [server lifecycle](../apps/desktop/Sources/StimDesktop/ServerController.swift), and [paired endpoint validation](../apps/desktop/Sources/StimKit/PairingPayload.swift).
- [Failing a command whose stimd went away](../packages/stim-cli/src/daemon/client.ts).
- [stimd socket](../packages/stim-cli/src/stimd/main.ts) and [Desktop bootstrap proof](../packages/server/src/desktop-bootstrap.ts).
- [The cached gc report](../packages/server/src/desktop-reports.ts), [stimd's sweeps](../packages/stim-cli/src/stimd/gc-report.ts) and [Desktop's polls](../apps/desktop/Sources/StimStores/GcReportStore.swift).
