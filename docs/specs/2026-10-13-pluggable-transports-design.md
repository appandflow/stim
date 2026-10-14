# Pluggable transports

Date: 2026-10-13. Status: accepted.

## Summary

stim-server reaches phones and other machines only through Tailscale. This
design splits that into a transport contract, `@stim-cli/transport`, and one
package per backend: `@stim-cli/transport-tailscale`, `@stim-cli/transport-local`,
`@stim-cli/transport-ngrok`, and `@stim-cli/transport-cloudflared`. It follows
the cache provider contract in `@stim-cli/cache`: a versioned module, a bag of
optional capabilities, a loader that never throws, and a contract test kit.

`stim` and `@stim-cli/server` depend on every first-party transport for now,
and Stim Desktop bundles them. They may become optional installs later.

## What Tailscale does today

Stim uses Tailscale for four separate things. The contract keeps them
separate, because the other backends provide only some of them.

| Role                  | Today                                                                                                          | Contract capability                      |
| --------------------- | -------------------------------------------------------------------------------------------------------------- | ---------------------------------------- |
| Exposure and TLS      | `tailscale serve` on a tailnet-only HTTPS port                                                                 | `expose`, `setup`                        |
| Peer identity         | `tailscale whois` gives the node a device token is bound to                                                    | `identify`                               |
| Discovery and pinning | `tailscale status --json` lists peer machines; a name that moves to another node is refused                    | `discover`, `resolve`                    |
| Bind addresses        | The server also listens on the Tailscale addresses; the hosted Metro gateway trusts WireGuard source addresses | `bindAddresses`, `traits.privateNetwork` |

The pairing core does not depend on the transport and does not change: the QR
payload, `hello` with a pairing token and then a device token, the token
registry, and grant and revoke.

## Decisions

- Transports are machine settings, not project settings. stim-server is one
  process per machine and ships inside Stim Desktop, so transports resolve from
  the server's own dependencies. A cache provider, by contrast, resolves from
  the project that names it. `network.transports` is an ordered list, so one
  server can answer a simulator on loopback and a phone on the tailnet.
- Stim authenticates and encrypts every client connection itself, on every
  transport, Tailscale included. See "Authentication". A transport carries
  bytes; it never decides who a client is. The network address, `tailscale
whois` and `X-Forwarded-For` are shown to people and never authenticate
  anyone. The forwarded address still keys rate limits for serve-proxied
  connections, since they all arrive from 127.0.0.1; that limits load, it
  grants nothing. This reverses "Stim writes no cryptography" in the
  stim-server design.
- ngrok and cloudflared decrypt TLS at their edge. Stim's own encryption means
  the edge sees only ciphertext, so these backends can ship. The user still
  turns them on explicitly. This reverses the "Transport alternatives" note of
  the stim-server design.
- Transports without `privateNetwork` cannot carry hosted Metro, whose gateway
  trusts source addresses, until hosted Metro moves onto the authenticated
  WebSocket.
- Metro reach (`metro.tunnel`) moves onto the same plugins, through
  `expose({ purpose: 'metro' })`, after the server side is done.

## Authentication

Every client, the phone app, the CLI's machine-to-machine connections and Stim
Desktop, opens the same handshake right after the WebSocket opens and before
any RPC. Device tokens and the `hello` auth variants of protocol 1 go away, and
the protocol version is bumped.

### Keys

- The server has one long-term X25519 key, generated on first start in
  `$STIM_HOME/server/identity.key` (mode 0600). Losing or replacing it makes
  every client refuse the server until it pairs again, which is what pinning
  means.
- Each client has one long-term X25519 key: in the phone's secure storage, in
  `$STIM_HOME/client-identity.key` (0600) for the CLI, and in the Keychain for
  Desktop.
- A device record stores the client's public key instead of a token hash. A
  client credential stores the server's public key instead of a tailnet node.

### Handshake

The handshake is Noise (noiseprotocol.org, revision 34) with
X25519, ChaCha20-Poly1305 and SHA-256, carried as the first three WebSocket
messages. It has two modes, named by a cleartext identifier in the payload of
message 1 so the server knows which keys to use:

- **First contact, `XXpsk2`.** The PSK is SHA-256 of the out-of-band secret:
  the QR code's pairing token for a phone, the setup ticket for a machine. The
  server already stores exactly that hash for both, and message 1 names the
  hash's first 8 bytes so the server can find it. The server mixes the PSK into
  message 2, so a man in the middle without the secret cannot complete
  message 2, and the client's static key in message 3 is already protected by
  the PSK. After the handshake the client pins the server's static key, the
  server records the client's static key in a device record with the
  requested capabilities, and the pairing token is spent, single use as today.
  The phone also checks the server's static key against the fingerprint in the
  QR code. Trade-off: while a token or ticket is unspent, its stored hash is
  enough to pair, so a leaked `pairing.json` or setup journal is usable until
  the token expires (5 minutes for pairing tokens).
- **Returning client, `XX`.** Message 1 names the fingerprint of the client's
  static key. The server accepts only a static key it has a record for, and the
  client accepts only the server key it pinned.

The prologue binds the protocol name and version, so a handshake cannot be
replayed into another protocol. Capabilities come from the authenticated
key's record. Loopback-only methods such as `device-host.sessions` check that
record's capabilities, not the absence of a forwarded header.

### Transport messages

After the handshake, every WebSocket message, text or binary, is one
ChaCha20-Poly1305 message under the cipher states that Noise's `Split()`
returns, with the 64-bit counter as the nonce. Video frames exceed Noise's
65535-byte transport message limit, so Stim uses `Split()`'s keys with its own
framing instead of Noise transport messages: one AEAD message per WebSocket
message, up to the existing 16 MiB message limit. A message that fails to
decrypt, or arrives out of order, closes the connection. A connection rekeys
after 2^32 messages.

### Access

- Pairing a phone spends the single-use pairing token as the PSK.
- A build or device-host request must carry a worker-issued setup ticket as
  its PSK. Without one, there is no request. Stim Desktop's Add Machine flow
  and `stim-server setup` already produce tickets, and `stim doctor --fix`
  takes one through `STIM_ACCESS_TICKET`. A request can no longer be made by
  merely claiming to be a peer.
- Approval, `grant` and `revoke` work as now. Revoking deletes the record, so
  the key no longer authenticates.

### No migration

Existing device records, client credentials and pairings are not carried over.
After the upgrade, phones pair again, Desktop pairs again on its own, and
remote machines are approved again with a new setup ticket.

The phone app ships through App Store review, so it cannot ship together with
stim-server, which ships through npm and inside Desktop. The order is:

1. The phone app ships speaking both protocols. It uses the new one with a
   server that offers it, and keeps its old pairing for an old server.
2. stim-server, the CLI and Desktop ship the new protocol only. An old client
   gets `protocol-unsupported` with an "update, then pair again" remedy.
3. A later phone release drops the old protocol.

The CLI's machine-to-machine rules in the repository guide (pinning a tailnet
node, sending a token only to that node, `stim-server setup --client <node>`)
change with the implementation; those pull requests rewrite them.

### Implementation

- **Node (stim-server, the CLI).** One TypeScript implementation of the two
  patterns and the transport framing. `node:crypto` provides X25519,
  ChaCha20-Poly1305, SHA-256 and HKDF, so no dependency is added.
- **Phone.** A C++ Nitro module on libsodium owns the whole session:
  - It wraps the `react-native-nitro-websockets` socket and installs itself as
    the socket's message handler.
  - It runs the handshake, using the client key it reads from the Keychain or
    Keystore itself.
  - It encrypts and decrypts every message.
  - It hands video frames straight to the native decoder and passes only
    plaintext RPC messages to JavaScript, which sends through it.
  - Neither the long-term key nor the session keys enter the JavaScript heap,
    and video frames never reach the JavaScript thread.
  - Measured on an M4 Pro, ChaCha20-Poly1305 in JavaScript without a JIT ran at
    about 3.7 MB/s, which is too slow for video of up to 8 Mbit/s on a phone.
- **Stim Desktop.** CryptoKit.
- **Tests.** Every implementation is checked against the Noise test vectors for
  `XXpsk2_25519_ChaChaPoly_SHA256` and `XX_25519_ChaChaPoly_SHA256`, and
  against a real stim-server in an interop test.
- **LAN.** The phone uses plain `ws://` on a LAN, protected by Noise, so it
  needs no TLS certificate or pinning. The pairing checks in the app accept
  `ws://` to private addresses once the handshake is in place.

## Contract

```ts
export const apiVersion = 1;
export const id: string;
export const optionsSchema: JSONSchema; // phase 3: x-stim annotations, rendered by Desktop
export function createTransport(input: {
  env: NodeJS.ProcessEnv;
  options: Record<string, unknown>;
}): Transport | Promise<Transport>;

interface Transport {
  id: string;
  traits: { privateNetwork: boolean; tls: 'end-to-end' | 'edge' | 'none'; peerIdentity: boolean };
  bindAddresses?(): string[];
  watch?(listener: () => void): () => void;
  identify?(peer: { address: string; request: IncomingMessage }): Promise<TransportIdentity | null>;
  close?(): void;
  // Later phases:
  status?(): Promise<TransportStatus>;
  setup?(input: { port: number; action: string }): Promise<TransportStatus>;
  expose?(input: { port: number; purpose: 'server' | 'metro' }): Promise<Exposure>;
  discover?(): Promise<TransportPeer[]>;
  resolve?(target: { machine: string; peerId: string }): Promise<Endpoint | string>;
}
```

Phase 1 ships the members above the comment. The others are added as optional
members while `apiVersion` stays 1, the way `@stim-cli/cache` added `files`.
In phase 1, `address` is still the `X-Forwarded-For` peer that `tailscale serve`
sets, and stim-server binds an identity to the transport that returned it. Phase 2
gives each listener a single transport, so only the transport that owns the
connection is asked.

`TransportStatus` is a list of checks, each with a state (`waiting`,
`working`, `ok`, `problem`), a title, an optional detail, and an optional
remedy (a command to copy, a URL to open, or a `setup` action). Desktop already
models pairing steps this way, so it renders any transport's checks without
transport-specific code.

## Apps

Stim Desktop is a Swift app and cannot load plugins, so the server serializes
what the apps need:

- `/health` gains `transports`, one entry per configured transport with its
  state, endpoint, and traits. The `tailscale` and `route` fields stay while
  older Desktop builds are in use.
- `transport.status`, `transport.setup`, and `transport.discover` replace
  Desktop's own `tailscale status --json` reads and the `route.setup` call.
- Each transport's `optionsSchema` joins `settings.schema.json` under
  `network.options.<id>`, so the existing settings editor renders it. Cache
  providers get the same optional `optionsSchema`.
- Desktop shows the generic checks list by default. The Tailscale screens keep
  their custom content (app links, app or CLI install, Funnel warning) as an
  override keyed on the transport id.
- The QR payload moves to `v: 2` with an `endpoints` list, each entry naming its
  transport, plus the server key. The mobile app tries the endpoints in order
  and stops relying on the `.ts.net` suffix to decide whether to trust a host.
  Error and onboarding copy becomes per transport.

## Credentials

Machine credentials store `nodeId` and `dnsName`. They become
`{ transport, peerId, address }`, and records without a transport are read as
`tailscale`. Machine names in settings accept an optional `<transport>:`
prefix; no prefix means `tailscale`.

## Phases

1. Add `@stim-cli/transport` and move Tailscale into
   `@stim-cli/transport-tailscale`, with the server reaching it only through the
   contract. No behavior change; the existing server, setup, registry, and
   hosted relay tests are the check.
2. Stim's authentication and encryption: the Noise handshake and encrypted
   messages in stim-server and the CLI, then the phone app, then Desktop,
   with setup tickets required for access requests. Then
   `@stim-cli/transport-local` (loopback and LAN) and the `v: 2` QR payload
   with the server key.
3. Serve `/health.transports`, `transport.status`, `transport.setup`, and
   `transport.discover`, and move Desktop and the mobile app onto them.
4. Add `@stim-cli/transport-ngrok` and `@stim-cli/transport-cloudflared` for
   pairing and paired connections.
5. Move Metro reach onto the transports, support remote machines over
   transports without discovery, and carry hosted Metro over the WebSocket.
