# @stim-cli/transport-local

The local network transport for stim-server. It listens on the private IPv4 addresses the machine setting
`server.lanAddresses` names, each an address or a network interface name such as `en0`, so machines and phones on the
same network reach stim-server without Tailscale. It implements the [`@stim-cli/transport`](../transport/README.md)
contract.

- **Off by default.** With `server.lanAddresses` empty, stim-server listens on no local network address. Wildcard
  (`0.0.0.0`), loopback, public and IPv6 addresses are refused.
- **Plain WebSocket, no TLS.** Every connection runs stim-server's protocol 2 Noise handshake before any request, which
  authenticates both sides by their keys and encrypts the connection. A network address never identifies a client.
- **Live.** The setting and the interfaces are read again every 5 seconds, so a changed setting or a new DHCP lease
  applies without a restart.

stim-server depends on it and loads it at start.
