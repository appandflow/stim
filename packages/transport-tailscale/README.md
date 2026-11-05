# @stim-cli/transport-tailscale

The Tailscale transport for stim-server. It serves stim-server on a tailnet-only `tailscale serve` HTTPS route, never
on Funnel, identifies each peer with `tailscale whois`, and listens on the machine's Tailscale addresses while Tailscale
runs. It implements the [`@stim-cli/transport`](../transport/README.md) contract.

stim-server depends on it and loads it at start; it needs no configuration.
