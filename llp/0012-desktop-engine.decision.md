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
the stimd that gave it. When that stimd goes away under the command, whether or
not it is waiting on stimd at that moment (a crash, a kill, an in-place update,
an engine switch), the CLI admits the command again with the stimd that
replaces it, the way it was first admitted, starting one where the command
would have started one. It then repeats the step it was waiting on and
continues, printing one stderr line that stimd restarted. A command that was
not waiting is admitted again at its next stimd step that takes the command's
own admission (a lease, a log stream or a readiness check), with the same line;
a Metro or tunnel request takes a request-scoped admission of its own and
prints none. It does this once per operation, and the whole resume (every wait
in it) takes at most 30 seconds. A cancelled operation stops resuming at once
and is not admitted again. With no stimd admitting it again, or when the stimd
that replaced the first one also goes away under the repeated step, the command
fails with `STIM_DAEMON_UNAVAILABLE`, a message that says stimd stopped while
the command was running, or with the other-build refusal. A command that was
not waiting meets a refusal at its step: the CLI's device lease falls back to a
local lease, the log stream reports the refusal with its remedy, and the
readiness check marks coverage failed. When a stimd of another build ended the
connection, the resume reports that refusal and starts no stimd of this build.
It never re-runs the whole command on another engine mid-way, and it does not
continue on an attached stimd, which ends with the command that hosts it.

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
serving until the next ask retries. stimd handles every `net.ensure` one at a time, in arrival order, against the thread as it is when the ask's turn comes, so one rollback configuration and one ownership reservation exist. A move's rollback restores the share-only options the thread ran on, never a proposal that did not start. A matching service ask joins a thread that is still starting. A service ask for port 0 matches any port, on the loopback setting alone. A thread start has a 30-second deadline, after which the ask is answered as not listening and the thread is stopped. A service ask that finds a running thread that is not share-only and whose loopback setting or port differs from the service's is refused without taking ownership. Once the service's thread runs,
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
it), serving every `net.ensure` one at a time in arrival order, the 30-second
start deadline of a net thread, matching a service ask for port 0 on the
loopback setting alone, and refusing a service ask whose options do not match a
running non-share thread.

## Code

- [Home and socket discovery](../apps/desktop/Sources/StimKit/StimHome.swift), [machine engine paths](../apps/desktop/Sources/StimKit/EngineState.swift), [server lifecycle](../apps/desktop/Sources/StimDesktop/ServerController.swift), and [paired endpoint validation](../apps/desktop/Sources/StimKit/PairingPayload.swift).
- [Re-admission after a stimd restart](../packages/stim-cli/src/daemon/client.ts).
- [stimd socket](../packages/stim-cli/src/stimd/main.ts) and [Desktop bootstrap proof](../packages/server/src/desktop-bootstrap.ts).
