# @stim-cli/transport-tailscale

The Tailscale transport for stim-server. It serves stim-server on a tailnet-only `tailscale serve` HTTPS route, never
on Funnel, identifies each peer with `tailscale whois`, and listens on the machine's Tailscale addresses while Tailscale
runs. It implements the [`@stim-cli/transport`](../transport/README.md) contract.

stim-server depends on it and needs no configuration. It loads the transport only once this machine uses the tailnet:
`route.setup` (which calls `expose` to add the serve route), a tailnet `stim pair`, `stim setup`'s route step, a
`stim service install --serve` route, a Funnel share, a build or device-host approval while the `tailscale` command is
installed, a request `tailscale serve` forwarded, or `stim serve --tailnet`. The first of these writes
`$STIM_HOME/server/tailnet.json`, and every later start loads the transport. Until then `/health` and the server name
read `tailscale status` and `tailscale serve status` on demand, kept for 30 seconds.
