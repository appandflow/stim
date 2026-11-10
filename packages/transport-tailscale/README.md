# @stim-cli/transport-tailscale

The Tailscale transport for stim-server. It serves stim-server on a tailnet-only `tailscale serve` HTTPS route, never
on Funnel, identifies each peer with `tailscale whois`, and listens on the machine's Tailscale addresses while Tailscale
runs. It implements the [`@stim-cli/transport`](../transport/README.md) contract.

stim-server depends on it and needs no configuration. It loads the transport only once this machine uses the tailnet.
These write `$STIM_HOME/server/tailnet.json`, after which every start loads it: `route.setup` (which calls `expose` to
add the serve route), a tailnet `stim pair`, `stim setup`'s route step, a `stim service install --serve` route,
`stim serve --tailnet`, and a start that finds any paired device or build or device-host client. These load it for the
running server only: a build or device-host approval while the `tailscale` command is installed, a request that
`tailscale serve` forwarded, a Funnel share, and a service started with a recorded serve route. Until then `/health` and
the server name read `tailscale status` and `tailscale serve status` on demand, kept for 30 seconds, the
longest the loaded transport's monitor waits between reads.
