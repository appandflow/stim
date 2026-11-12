# LLP 0016: stimd runs the managed tunnel

**Type:** Decision
**Status:** Active
**Systems:** Stimd, Metro, Tunnel
**Author:** Janic Duplessis / Claude
**Date:** 2026-11-12
**Related:** LLP 0007

## stimd runs the managed tunnel

The managed tunnel (ngrok, cloudflared or tailscale) that `stim start --remote`
gives a remote device is a child of the home's stimd. `start` asks stimd for it
(`tunnel.ensure`); `stop`, `worktree remove` and reclaim ask stimd to stop it
(`tunnel.stop`). No CLI process spawns or signals a managed tunnel. Reason: a
tunnel the CLI started had no owner between commands, so a killed `start` or a
stimd restart left it unsupervised, and a second implementation of child
supervision sat next to stimd's Metro supervision.

stimd owns three things for the tunnel:

- **The provider order.** `tunnel.ensure` takes the `metro.tunnel` mode, finds the
  providers on the PATH of the command's forwarded environment, and with `auto`
  tries ngrok and then cloudflared, each until one prints a URL. A named
  provider runs alone. A failure names every provider tried, in the order tried.
- **The claim.** The tunnel runs in its own process group under `tunnel.claim`,
  and the claim is what says a tunnel runs. Its details name the port and the
  provider before the provider is spawned. `tunnel.stop`, `stop`, reclaim and
  `worktree remove` stop the tunnel a claim holds by the claim's verified child
  identity, whether or not the workspace records it; while another live process
  still holds the claim (a stimd that is exiting), `tunnel.stop` refuses naming
  that process, so `stop` exits non-zero rather than report the tunnel gone. A stimd restart takes the
  tunnel over by its claim, as it does Metro; one that ended before the tunnel
  printed its URL leaves a claim without a URL, which the successor stops. On
  Windows, where children stop with stimd, a running tunnel holds an in-place
  update (`heldBy: "dev-servers"`).
- **The record.** stimd writes the workspace's managed `metroTunnel` record when
  the tunnel is up and clears it when the tunnel is stopped or found gone, and
  rewrites it when a reused tunnel's record is missing. `status` and the
  remote-device planner read the record, so they can lag a tunnel for the
  moment between its spawn and its URL. Expo's own tunnel replaces the record,
  so starting it first stops the managed tunnel.

A running tunnel is reused only for the same port, a provider the call would
try and, for ngrok, the configured stable URL; any other running tunnel refuses
with `STIM_REMOTE_START_REQUIRED` and `stim stop`, because a Metro's public
origin is fixed when it starts.

## Tunnels an older CLI recorded

A tunnel with a record in workspace state and no claim, which the CLI of an
earlier Stim started, is adopted or stopped by its recorded process identity
(pid and process token), never by name or pid alone. `tunnel.ensure` adopts a
verified one that it may reuse; a record without a token, or one whose identity
cannot be verified, is refused with the reason, and the record stays. When no
claim and no process remains, the CLI clears the dead record and its log file
itself, so `stop` does not start a stimd for it. This path is compatibility row
C29 and ends in 2.1.0: the population is a tunnel an earlier CLI left running
across the upgrade.

## Known limit

A local socket that has not been admitted as an operation can call `tunnel.ensure`
and `tunnel.stop` for any workspace root, as it can `metro.ensure` and
`metro.stop`; `tunnel.stop` with a pid and token still verifies the identity.

## Provenance

The maintainer decided on 2026-11-12 to move the tunnel into stimd, as relayed
by the coordinating session; the words are not on the issue. The rules above
that the maintainer did not state were chosen by the coordinating session and
the implementing agent: that the provider order moves into stimd, that the CLI
keeps no tunnel stop of its own and no compatibility branch beyond adoption by
verified identity (it still clears the record and log of a dead tunnel that has
no claim, compat C29), and that a different running tunnel refuses instead of
being replaced. A review of the first version added the rule that the claim,
not the record, says what runs.

Related: #5421, #5384, #5426.

## Code

- `packages/stim-cli/src/stimd/metro/children.ts`: `ensureTunnel`, `stopManagedTunnel`, adoption.
- `packages/stim-cli/src/daemon/client.ts`: `ensureTunnelThroughStimd`, `stopTunnelThroughStimd`, `workspaceManagedTunnel`.
- `packages/stim-cli/src/engine/tunnel.ts`: the provider processes and `stopTunnel` for a recorded tunnel.
