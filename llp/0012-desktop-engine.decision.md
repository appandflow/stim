# LLP 0012: Stim Desktop and the matching-home engine

**Type:** Decision
**Status:** Active
**Systems:** Desktop, Engine, Server
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

## Code

- [Home and socket discovery](../apps/desktop/Sources/StimKit/StimHome.swift), [machine engine paths](../apps/desktop/Sources/StimKit/EngineState.swift), [server lifecycle](../apps/desktop/Sources/StimDesktop/ServerController.swift), and [paired endpoint validation](../apps/desktop/Sources/StimKit/PairingPayload.swift).
- [stimd socket](../packages/stim-cli/src/stimd/main.ts) and [Desktop bootstrap proof](../packages/server/src/desktop-bootstrap.ts).
