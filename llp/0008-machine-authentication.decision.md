# LLP 0008: Machine authentication and pairing

**Type:** Decision
**Status:** Active
**Systems:** Server, Transport, Desktop
**Author:** Codex
**Date:** 2026-11-12
**Related:** LLP 0009, LLP 0010, LLP 0012

## Authenticate the key

Every network machine-RPC connection to stim-server, including loopback TCP,
runs protocol 2's Noise handshake (`@stim-cli/core/noise-session`) before any RPC,
as [the authentication design](../docs/specs/2026-10-13-pluggable-transports-design.md#authentication)
specifies. The separate HTTP `/health` endpoint reports service readiness.
Capabilities come only from approved records for the proved client key. The
network address, `tailscale whois` and `X-Forwarded-For` label records and key
rate limits.

The same identity and grant must survive a transport change. Binding authority to a tailnet address would make the private LAN transport depend on Tailscale and would conflate a network observation with proof of the client key. [Protocol 2](https://github.com/appandflow/stim/pull/3741), [Private LAN transport](https://github.com/appandflow/stim/pull/4458).

## Pairing and setup secrets

Pairing tokens and setup tickets
are 32 random bytes; the server keeps only their derived `psk` and `lookup` in
`server/secrets.json` and never writes them to setup journals, which are named
by the derived `journal`.

The derived records let the server find a pending handshake and verify it without storing the value a person can spend to pair or approve access. [Protocol 2](https://github.com/appandflow/stim/pull/3741).

## Desktop proves local authority

Clients of this machine's own user use the Unix
socket, never a TCP connection. A Stim Desktop paired with another machine's
server is an ordinary paired device there. The Desktop-only methods work only
on a connection through stimd's CLI socket that proved the key stimd writes to
`run/desktop.key` (0600) when it starts; the key never crosses the socket and
never appears in arguments, environment or output.

The OS-owned socket establishes the local user. The separate bootstrap proof reserves privileged Desktop actions for the matching-home client, even when another local process can open that socket. [Single engine per home](https://github.com/appandflow/stim/pull/5380).

## Code

- [Network admission](../packages/server/src/server.ts), [Desktop proof](../packages/server/src/desktop-bootstrap.ts), and [device and machine records](../packages/server/src/registry.ts).
