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
restarted. It does this once per operation, within 30 seconds; with no stimd
admitting it again, the command fails with `STIM_DAEMON_UNAVAILABLE`, a
message that says stimd stopped while the command waited on it, or the
other-build refusal. It never re-runs the whole command on another engine
mid-way, and it does not continue on an attached stimd, which ends with the
command that hosts it.

Only steps that are safe to repeat are repeated, each within the time left of
its own budget:

- `lease.prepare`/`lease.acquire`: the successor finds a lease the dead stimd
  granted by the workspace's holder record and its token and raises it; a lease
  it cannot prove its own refuses as before. A lease whose issuing stimd went
  away is released by its token in the CLI.
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
  starting one when none did. A stimd that decided to exit idle exits only if
  no command was admitted while it checked the engine.

Build, boot and test slot waits already resume, since their queue is claim
files.

Maintainer decision: "another important consteaint of stimd is being resumable", 2026-11-12 (quoted on [#5579](https://github.com/appandflow/stim/issues/5579#issuecomment-6835670519)).

The CLI-side re-admission, the once-per-operation limit, the 30-second bound,
the release by token and the CI hold's replacement were chosen by the
implementing agent for [#5587](https://github.com/appandflow/stim/issues/5587)
and [#5567](https://github.com/appandflow/stim/issues/5567), not by the
maintainer.

## Code

- [Home and socket discovery](../apps/desktop/Sources/StimKit/StimHome.swift), [machine engine paths](../apps/desktop/Sources/StimKit/EngineState.swift), [server lifecycle](../apps/desktop/Sources/StimDesktop/ServerController.swift), and [paired endpoint validation](../apps/desktop/Sources/StimKit/PairingPayload.swift).
- [Re-admission after a stimd restart](../packages/stim-cli/src/daemon/client.ts).
- [stimd socket](../packages/stim-cli/src/stimd/main.ts) and [Desktop bootstrap proof](../packages/server/src/desktop-bootstrap.ts).
