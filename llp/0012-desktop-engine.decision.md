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

## A command continues across a stimd restart

A command's admission (`op.begin` and its token) lives only in the memory of
the stimd that gave it. When that stimd goes away while the command waits on it
(a crash, a kill, an in-place update, an engine switch), the CLI admits the
command again with the stimd that replaces it, the way it was first admitted,
starting one where the command would have started one. It then repeats the
step it was waiting on and continues, printing one stderr line that stimd
restarted. It does this once per operation, and the whole resume (every wait in
it) takes at most 30 seconds. A cancelled operation stops resuming at once and
is not admitted again. With no stimd admitting it again, or when the stimd that
replaced the first one also goes away under the repeated step, the command
fails with `STIM_DAEMON_UNAVAILABLE`, a message that says stimd stopped while
the command waited on it, or with the other-build refusal. When a stimd of
another build ended the connection, the resume reports that refusal and starts
no stimd of this build. It never re-runs the whole command on another engine
mid-way, and it does not continue on an attached stimd, which ends with the
command that hosts it.

Only steps that are safe to repeat are repeated, each within the time left of
its own budget:

- `lease.prepare`/`lease.acquire`: the successor finds a lease the dead stimd
  granted by the workspace's holder record and its token and raises it; a lease
  it cannot prove its own refuses as before. A lease whose issuing stimd went
  away is released by its token in the CLI, also when the operation is
  cancelled.
- `metro.prepare`/`metro.wait`: the successor adopts a running Metro by its
  claim, so ensuring it again reuses it (on Windows Metro ends with stimd and
  starts again).
- `tunnel.ensure`: the tunnel claim names the tunnel the successor reuses.
- `logs.start`: a start answers the stream that already runs for the slot.
- `readiness.wait`: asked again with coverage reset to pending, so the
  successor proves it again, and again while the successor has not yet resumed
  the stream.
- A CI hold of a persistent stimd that is ending when it asks, or that stops
  while it holds, waits for it to go and pins the stimd that replaces it,
  starting one when none did; a stimd of another build, or one an attached
  command hosts, is refused at once, and a failed replacement is printed on
  stderr. A stimd that decided to exit idle exits only if
  no command was admitted while it checked the engine.

Build, boot and test slot waits already resume, since their queue is claim
files.

Maintainer decision: "another important consteaint of stimd is being resumable", 2026-11-12 (quoted on [#5579](https://github.com/appandflow/stim/issues/5579#issuecomment-6835670519)).

The CLI-side re-admission, the once-per-operation limit, the 30-second bound,
the release by token and the CI hold's replacement were chosen by the
implementing agent for [#5587](https://github.com/appandflow/stim/issues/5587)
and [#5567](https://github.com/appandflow/stim/issues/5567), not by the
maintainer.

## A service stimd serves the service port

The stimd that holds a home a service unit serves listens on the unit's port.
Any starter can win the home after a handover: the successor, the unit's own
restart, or a stimd a command started, which has no service options and, with
a saved share, runs a share-only net thread on a random loopback port. So the
unit's process (`--service` without `--carried`), when it finds a stimd holding
the home, asks `net.ensure` with `service: true`. stimd then restarts a net
thread that runs share-only or on another port or listener scope with the
service's options, and Stim Desktop no longer moves it. The move compares with
the thread that runs, and an ask that waits on the stop gets the service's
thread. The ask carries each of the unit's `--env` names with its value from the
unit's environment, which the stimd that holds the home may not have. While
work pins stimd, or a workspace action runs in the net thread (a Desktop or
phone build, start or stop), or the net thread runs or admits an offloaded job
(its artifact delivery and a client engine install included) or holds a hosted session the next server
cannot resume (a macOS session, or one installing), or runs a runtime
install or another device-host probe, it refuses instead, and the
asker exits 1, so the unit's restart asks again; otherwise the net thread stops
admitting both in the same step that finds none, stimd checks its own pinned
work once more, and the move follows (or the net thread admits again). Once stimd closes its net
thread for good, no ask starts another.
The asker also exits 1, naming both ports, when the answer is another port.
stimd records its net thread's port as `netPort` in `run/stimd.json` (null
while none listens), and `stim service status` names a holder on another port.

Maintainer direction: "can u check the update process to make sure this doesnt happen? Can we make sure stimd always uses same port so this wont hjappen", relayed on [#5811](https://github.com/appandflow/stim/issues/5811).

Chosen by the implementing agent, not the maintainer: moving the thread on the
service's ask rather than deciding which starter may take the home, refusing
while pinned rather than deferring the move, and leaving a unit that names one
engine build to `stim service install` (status reports it).

## Code

- [Home and socket discovery](../apps/desktop/Sources/StimKit/StimHome.swift), [machine engine paths](../apps/desktop/Sources/StimKit/EngineState.swift), [server lifecycle](../apps/desktop/Sources/StimDesktop/ServerController.swift), and [paired endpoint validation](../apps/desktop/Sources/StimKit/PairingPayload.swift).
- [Re-admission after a stimd restart](../packages/stim-cli/src/daemon/client.ts).
- [stimd socket](../packages/stim-cli/src/stimd/main.ts) and [Desktop bootstrap proof](../packages/server/src/desktop-bootstrap.ts).
