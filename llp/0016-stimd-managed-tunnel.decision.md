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
(`tunnel.ensure`); `stop`, `worktree remove` and reclaim stop it through stimd
(`tunnel.stop`). No CLI process spawns, signals or records a managed tunnel.
Reason: a tunnel the CLI started had no owner between commands, so a killed
`start` or a stimd restart left it unsupervised, and a second implementation of
child supervision sat next to stimd's Metro supervision.

stimd owns three things for the tunnel and the CLI owns none of them:

- **The provider order.** `tunnel.ensure` takes the `metro.tunnel` mode, finds the
  providers on the PATH of the command's forwarded environment, and with `auto`
  tries ngrok and then cloudflared, each until one prints a URL. A named
  provider runs alone. A failure names every provider tried, in the order tried.
- **The claim.** The tunnel runs in its own process group under `tunnel.claim`.
  A stimd restart takes it over by that claim, as it does Metro. On Windows,
  where children stop with stimd, a running tunnel holds an in-place update
  (`heldBy: "dev-servers"`).
- **The record.** stimd writes the workspace's managed `metroTunnel` record when
  the tunnel is up and clears it when the tunnel is stopped or found gone, so
  `status`, `stop` and the remote-device planner read one record that always
  matches a tunnel stimd supervises or a tunnel an older CLI left.

A running tunnel is reused only for the same port, a provider the call would
try and, for ngrok, the configured stable URL; any other running tunnel refuses
with `STIM_REMOTE_START_REQUIRED` and `stim stop`, because a Metro's public
origin is fixed when it starts.

## Tunnels an older CLI recorded

A tunnel with a record in workspace state and no claim, which the CLI of an
earlier Stim started, is adopted or stopped by its recorded process identity
(pid and process token), never by name or pid alone. `tunnel.ensure` adopts a
verified one that it may reuse; a record without a token, or one whose identity
cannot be verified, is refused with the reason, and the record stays.

## Provenance

The maintainer decided on 2026-11-12 to move the tunnel into stimd, as relayed
by the coordinating session; the words are not on the issue. The rules above
that the maintainer did not state were chosen by the coordinating session and
the implementing agent: that the provider order moves into stimd, that the CLI
keeps no direct tunnel stop and no compatibility branch beyond adoption by
verified identity, and that a different running tunnel refuses instead of being
replaced.

Related: #5421, #5384, #5426.

## Code

- `packages/stim-cli/src/stimd/metro/children.ts`: `ensureTunnel`, `stopManagedTunnel`, adoption.
- `packages/stim-cli/src/daemon/client.ts`: `ensureTunnelThroughStimd`, `stopTunnelThroughStimd`.
- `packages/stim-cli/src/engine/tunnel.ts`: the provider processes and `stopTunnel` for a recorded tunnel.
