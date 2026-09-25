# Stim server and read-only mobile app

Date: 2026-09-25. Status: proposed. Issue: #1110.

## Summary

A new package, `@stim-cli/server`, runs a long-lived process on the Mac that
serves Stim state to paired clients: workspaces, devices, device activity,
build progress, logs, and device frames. A read-only mobile app (Expo) pairs
with it by scanning a QR code in Stim Desktop and connects over Tailscale, which
already encrypts the traffic and identifies both devices; Stim adds no
cryptography of its own. The QR code carries a single-use pairing token that
the phone exchanges for a revocable device token. Stim Desktop can start the
server, or it runs alone as `stim-server`.

The server reads state with the same code and locks as the CLI, through state
types and readers moved into `@stim-cli/core`. It never changes Stim state.

## Motivation

Supervising agents means watching workspaces, devices, and logs while away from
the Mac. Stim Desktop shows all of this, but only on the Mac it runs on, and it
gets it by spawning `stim` processes and reading simulator framebuffers
locally. A phone can do neither.

## Decisions already made

- The server is a separate package, not new CLI commands. The `stim` command
  surface does not grow.
- Types and utilities for reading config and state are shared, so the server
  and the CLI cannot disagree about files, paths, locks, or payload shapes.
- The mobile app is read-only for now: no actions, no device input.
- Pairing is by QR code, and must work across networks, not only on the same
  Wi-Fi.
- The mobile app is Expo / React Native in `apps/mobile`, built and tested with
  Stim itself, and distributed through TestFlight with EAS under the App&Flow
  Apple team and Expo account.

## Scope

In: the package layout and what moves into core, the read path, the protocol,
pairing and transport security, frame delivery, the Desktop changes, the mobile
app's first version, and the rollout.

Out (non-goals):

- Actions from the phone (stop, gc, worktree remove, reload) and device input.
  The protocol reserves room for capabilities, but v1 grants none.
- Public internet access without Tailscale. The design keeps it possible (see
  "Transport"), but v1 ships LAN and Tailscale only.
- A hosted relay service.
- Replacing Stim Desktop's local data path. Desktop keeps its local IOSurface
  frames and may keep spawning the CLI; moving it onto the server is optional
  and comes later.

## Architecture

```text
 Mac
 +--------------------------------------------------------------+
 | @stim-cli/core   state types, paths, lock-aware readers,      |
 |                  settings registry, ledgers, log record types |
 +--------------------------------------------------------------+
        ^ reads                 ^ reads
 +-------------+        +-------------------------------+      +------------------+
 | stim (CLI)  |        | @stim-cli/server (stim-server)|<---->| mobile app (Expo)|
 | all writes  |<-spawn-| read-only; wss over Tailscale |      | read-only        |
 +-------------+        | frames: screenshots (v1),     |      +------------------+
                        |   stim-frames helper (v2)     |
                        +-------------------------------+
                               ^ starts / pairs
                        +-------------------------------+
                        | Stim Desktop                  |
                        +-------------------------------+
```

### Packages

- `@stim-cli/core` gains a `state` entry point: the `$STIM_HOME` path layout,
  config and workspace state types, lock-aware read helpers built on the
  existing `withDirLock` claim protocol, the settings registry (#1079), the
  created-device and EAS session ledgers, NDJSON log record types and readers,
  and the status payload types. The CLI switches to these imports; its
  behavior does not change. This is a refactor with no new behavior, reviewed
  and tested like one.
- `@stim-cli/server` depends on `@stim-cli/core` and on `stim`, so it always
  runs the exact CLI version it was released with. Bin: `stim-server`.
- The cache packages keep depending only on core; nothing they import changes.

All six packages are versioned in lockstep. RELEASE.md's package list,
`scripts/release-prep.mjs`, the release QA matrix mapping, and the Release
workflow gain the new package, so the first release that includes it uses the
full lane.

### Read path

The server only reads. The single file it writes is its own pairing state
(below), under `$STIM_HOME/server/`, with the same locked atomic writes as
every other Stim state file.

- Status: phase 1 runs `stim status --watch --json` as a child process and
  forwards each payload. This reuses the change detection from #1080 and the
  fast status from #1081 with no refactor. Phase 2 moves the status
  computation into core piece by piece, until the server computes it in
  process. The payload shape does not change between phases.
- Logs: `stim logs --json --follow` per subscribed workspace, with the same
  filters the Desktop log viewer uses (#1076). A query without `--follow` serves
  history.
- Stats: `stim stats --json` on demand.
- Settings: the effective settings from `stim settings --json` (#1079), read-only,
  with sensitive values masked by the CLI as today.

Child processes run with the login-shell environment captured once at start,
as Desktop does (#1066).

### Protocol

JSON messages over a WebSocket (`wss://` over Tailscale, see below).
One request/response shape and one event shape:

```json
{ "id": 7, "method": "logs.subscribe", "params": { "workspace": "...", "sources": ["metro"], "level": "warn" } }
{ "id": 7, "result": { "subscription": "s3" } }
{ "event": "logs", "subscription": "s3", "records": [ ... ] }
```

Methods in v1: `hello` (versions and capabilities), `status.subscribe`,
`logs.query`, `logs.subscribe`, `stats.get`, `settings.get`, `frames.subscribe`,
`unsubscribe`. Events: `status` (a full payload, as `status --watch` prints it),
`logs`, `frame`, `error`. A client that reconnects resubscribes; the server
keeps no per-client history.

The message types live in core and are exported as JSON Schema at build time,
like the settings schema. Swift models for Desktop and TypeScript types for the
mobile app are generated from it, so the three cannot drift.

`hello` reports the capabilities the client holds. v1 grants only `read`. A
later `control` capability, granted per paired device, would cover actions and
input; it is out of scope here.

### Pairing and transport security

Tailscale provides the transport security: WireGuard encrypts traffic end to
end between the phone and the Mac, on the same Wi-Fi or across networks, and
ties each node to a tailnet identity. Stim writes no cryptography and adds no
encryption layer.

- The server listens only on loopback and on the Mac's Tailscale address, never
  on every interface. `tailscale serve` fronts it with a valid HTTPS
  certificate for the Mac's `*.ts.net` name, so clients use standard `wss://`
  with no certificate pinning. Port 7787 by default, configurable in the
  server's own settings.
- Desktop shows a QR code on request:

  ```json
  {
    "v": 1,
    "name": "Janic's MacBook Pro",
    "endpoint": "wss://janics-mbp.tail1234.ts.net",
    "pairingToken": "<random, single use, expires in 5 minutes>"
  }
  ```

- The phone connects to `endpoint` through its own Tailscale app and spends
  the pairing token. The server returns a random device token, stored in the
  phone's secure storage; the server keeps only its hash. Every later
  connection presents the device token.
- Before accepting a connection, the server asks `tailscale whois` for the
  peer's node and user, and records them at pairing. A device token presented
  from a different tailnet node is refused, so a leaked token alone is not
  enough.
- Paired devices are listed in `$STIM_HOME/server/devices.json` (name, token
  hash, tailnet node and user, paired at, last seen, capabilities) and can be
  revoked from Desktop or with `stim-server devices`.
- Connections that fail authentication are rate-limited and closed after a
  short timeout.

Requirements this creates: Tailscale on the Mac and on the phone, in the same
tailnet or with the Mac's node shared to the phone's user. Without Tailscale
the app cannot connect in v1.

### Transport alternatives (not in v1)

- Same Wi-Fi without Tailscale: TLS with a self-signed certificate whose
  fingerprint the QR code carries, pinned by the app. Adds certificate pinning
  to the mobile app; deferred until someone needs it.
- Anywhere without Tailscale on the phone: Tailscale Funnel exposes the server
  publicly with TLS terminated on the Mac, not at a relay, so the same device
  tokens and `wss://` apply; `tailscale whois` identity would then be missing,
  so Funnel access needs its own opt-in and time limit. A Cloudflare quick
  tunnel would need an application-layer encryption channel, because
  Cloudflare terminates TLS at its edge; avoid it.

### Frames

- v1: screenshots. iOS via `xcrun simctl io <udid> screenshot` and Android via
  the emulator gRPC `getScreenshot` (#1064), at a low frame rate (about 1 to 5
  per second, adaptive), JPEG-encoded and sent as `frame` events. This needs no
  native code, so it works on a headless Mac with only `stim-server`.
- v2: a native helper, `stim-frames`, shipped inside Stim.app. It encodes
  simulator IOSurface frames with VideoToolbox (H.264) and streams them over
  WebRTC, with DTLS fingerprints exchanged over the authenticated WebSocket. The
  server discovers the helper and falls back to screenshots without it.
- Only devices `stim status` lists as owned are served.

## Stim Desktop

- Starts `stim-server` on launch when enabled in App preferences, or connects
  to one that is already running. It never starts a second one.
- A "Pair a phone" sheet shows the QR code, and a list of paired devices with
  last seen and revoke.
- Desktop's own data path stays as it is in this phase.

## Mobile app (v1, read-only)

An Expo app, built and run with Stim itself:

- Pairing: scan the QR code, name the Mac, list and forget paired Macs.
- Workspaces grouped by project, with Metro, supervisor, device activity (#1092),
  build progress (#1069), errors, and remote EAS sessions (#1068).
- Device view: the latest frames of each owned device.
- Logs: the same filters as the Desktop log viewer, following new lines.
- Push notifications (build finished, new errors) are out of scope for v1; they
  need an outbound notification path and are a later design.

## Invariants

- One implementation of state reading and locking: the server uses core's
  readers; it never parses `$STIM_HOME` files with its own code.
- The server changes no Stim state. Its only writes are its own files under
  `$STIM_HOME/server/`, locked and atomic.
- Runtime state stays under `$STIM_HOME` (AGENTS.md "Project").
- Tests redirect `STIM_HOME` (invariant 5) and never bind real interfaces other
  than loopback.

## Rollout

Each step is its own issue and pull request:

1. Move state types and read helpers into `@stim-cli/core` (no behavior change).
2. `@stim-cli/server` skeleton: pairing registry and device tokens, the
   `tailscale whois` check, `tailscale serve` setup, `hello`, `status.subscribe`
   backed by `stim status --watch --json`, loopback integration tests.
3. `logs.*`, `stats.get`, `settings.get`.
4. v1 frames (screenshots).
5. Desktop: start or connect to the server, pairing sheet, device list.
6. The mobile app, v1.
7. Release: the sixth package in the release tooling; full-lane release.
8. Later: v2 frames with `stim-frames` and WebRTC; status computed in process;
   the transport alternatives above; the `control` capability.

## Open questions

- Whether the server configures `tailscale serve` itself or documents the
  one-time command, and how it behaves when Tailscale is not running.
- Whether the phase-2 status move belongs in core or a separate
  `@stim-cli/status` package.
