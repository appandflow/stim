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
| Peer identity         | `tailscale whois` gives the node a device token is bound to; replaced by Stim's own keys (see Authentication)  | `identify`, for display only             |
| Discovery and pinning | `tailscale status --json` lists peer machines; a name that moves to another node is refused                    | `discover`, `resolve`                    |
| Bind addresses        | The server also listens on the Tailscale addresses; the hosted Metro gateway trusts WireGuard source addresses | `bindAddresses`, `traits.privateNetwork` |

Pairing and access stay transport neutral: the QR code, approval, grant and
revoke work the same on every transport. Authentication itself changes; see
"Authentication".

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

Every client (the phone app, the CLI's machine-to-machine connections and Stim
Desktop) runs the same handshake right after the WebSocket opens, before any
RPC. Device tokens and the `hello` auth variants of protocol 1 go away.

### Keys

- The server has one long-term X25519 key, generated on first start in
  `$STIM_HOME/server/identity.key` (mode 0600). Losing or replacing it makes
  every client refuse the server until it pairs again, which is what pinning
  means.
- Each client has one long-term X25519 key:
  - CLI: `$STIM_HOME/client-identity.key` (0600).
  - Desktop: the Keychain.
  - iOS phone: the Keychain, as `kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly`.
  - Android phone: app storage, encrypted with an AES key held in the Android
    Keystore. The Keystore cannot hand raw X25519 bytes to libsodium, so it
    wraps the key instead.
- A device record stores the client's public key and its capabilities instead
  of a token hash. A machine credential stores the server's public key instead
  of a tailnet node.

### Secrets and derived values

A pairing token or setup ticket is a 32-byte random secret, shown or carried
out of band. The server never uses the secret itself, or a plain hash of it, as
a name. From the secret `t`, both sides derive:

- `psk = SHA-256("stim noise psk v1" || t)`, the Noise PSK;
- `lookup = SHA-256("stim noise lookup v1" || t)[0..16]`, sent in the cleartext
  prefix of the first WebSocket message to name the secret;
- `journal = SHA-256("stim setup journal v1" || t)`, the setup journal's file
  name and URL path.

The server stores `psk` and `lookup` in its private secret store, never in the setup journal, and deletes both when the secret is spent or expires. Knowing `lookup` or `journal`, which appear in
cleartext, logs and URLs, does not reveal `psk`.

### Handshake

The handshake is Noise (noiseprotocol.org, revision 34) with X25519,
ChaCha20-Poly1305 and SHA-256, carried as the first three WebSocket messages.
Noise handshake messages are limited to 1024 bytes; the prefix is at most 18
bytes.

The first WebSocket message is a cleartext prefix followed by Noise message 1.
The prefix is a protocol version byte, then a mode byte, then, in first-contact
mode only, the 16-byte `lookup`. The prefix sits outside the Noise message because in a PSK pattern
Noise encrypts even message 1's payload, so the server must know the pattern
before it can parse it. The prologue is `"stim noise v1"` followed by the
prefix, so the handshake authenticates the prefix and a changed prefix fails
it.

- **First contact, mode 1, `XXpsk2_25519_ChaChaPoly_SHA256`.** The prefix
  carries `lookup`. The server finds the matching secret and uses its
  `psk`, which it mixes into message 2. A man in the middle without the secret
  cannot complete message 2, and the client's static key in message 3 is
  already protected by the PSK.
  - After the handshake the client pins the server's static key.
  - The phone also checks that key against the fingerprint in the QR code.
  - The server records the client's static key with the capabilities stored
    with the secret on the server, never with capabilities the client names.
  - A pairing token is spent on success.
  - If no valid secret matches, the server closes with `unknown-secret` and
    keeps nothing.
- **Returning client, mode 0, `XX_25519_ChaChaPoly_SHA256`.** The prefix has
  nothing after the mode byte, so no key fingerprint is visible to someone
  watching the connection. The server learns the client's static key in
  message 3 and accepts it only if a record has it. The client accepts only the
  server key it pinned.

Capabilities always come from the authenticated key's server-side record. A
record created from a pairing token issued by `stim-server pair --local` also
carries `local`, which only the server's own user can create. Methods that are
Desktop-only today (`device-host.sessions`, `route.setup`,
`machines.update.*`) require a `local` record arriving on the loopback-only
listener (see "Contract"). A phone's `control` capability is never enough.

### Transport messages

- After the handshake, the two cipher keys from `Split()` encrypt one
  ChaCha20-Poly1305 message per WebSocket message, one key per direction.
- The nonce is Noise's: 32 zero bits, then a 64-bit little-endian counter per
  direction. The counter is implicit, so a dropped, repeated or reordered
  message fails to decrypt and closes the connection.
- The first plaintext byte is the message type, `0x01` for text and `0x02` for
  binary. It is inside the AEAD, so it is authenticated, and receivers dispatch
  on it, not on the WebSocket frame type, which is always binary.
- There is no rekey. A direction that reaches 2^64 - 1 messages closes the
  connection.
- Size limits are per direction, count the plaintext without its type byte, and are unchanged from protocol 1: the server accepts messages up to 64 KiB from clients and sends up to 16 MiB. Video
  frames exceed Noise's 65535-byte transport message limit, which is why Stim
  uses `Split()`'s keys with this framing instead of Noise transport messages.

### Access

- **Pairing a phone.** Desktop shows a QR code with a single-use pairing token
  (5 minutes) and the server key's fingerprint.
- **Pairing Desktop.** Desktop runs `stim-server pair --local --control` and
  spends that token over loopback, as it does today with a device token.
- **Approving a machine.** The requesting machine generates the setup ticket:
  Stim Desktop's Add Machine flow, or `stim doctor --fix` on a machine without
  Desktop, which prints the ticket and the command to run on the worker. A
  person runs `stim-server setup` on the worker with the ticket in
  `STIM_SETUP_TICKET`.
  - Setup stores `psk` and `lookup` in the server's private secret store, and writes the journal, named by `journal`, with only its progress and the capabilities it approves. One ticket can approve build, device-host or both.
  - The ticket stays valid as a PSK until the journal expires (at most 2
    hours) or setup finishes, and is spent once each approved capability has
    a record.
  - A request that arrives before setup runs gets `unknown-secret` and is
    retried.
  - A request without a valid secret cannot be made, so a request can no
    longer come from merely claiming to be a peer.
- **Revoking.** Revoking deletes the record and closes its live sessions, so
  the key no longer authenticates.
- **Network identity is never authentication:**
  - `/setup/<journal>` is served to whoever names the journal, since the
    journal holds no secret.
  - The agent route authenticates by its session token alone.
  - Peer `/health` returns only the version.

### Versions and release order

Existing device records, client credentials and pairings are not carried over.
After the upgrade, phones pair again, Desktop pairs again on its own, and
remote machines are approved again with a new setup ticket.

The phone app ships through App Store review, so it cannot ship together with
stim-server, which ships through npm and inside Desktop. The order is:

1. The phone app ships speaking both protocols.
   - The protocol follows the pairing record: a pairing made with protocol 2
     only ever uses protocol 2.
   - A failure before the handshake completes never drops or rewrites a
     pairing.
   - Protocol 1 is only used for an existing protocol 1 pairing, over `wss://`.
2. stim-server, the CLI and Desktop ship protocol 2 only. An old client gets
   `protocol-unsupported` with an "update, then pair again" remedy.
3. A later phone release drops protocol 1.

The version byte in message 1 leaves room for later protocol versions.

The CLI's machine-to-machine rules in the repository guide (pinning a tailnet
node, sending a token only to that node, `stim-server setup --client <node>`)
change with the implementation; those pull requests rewrite them.

### Implementation

- **Node (stim-server, the CLI).** One TypeScript implementation of the two
  patterns and the transport framing, on `node:crypto` with no new dependency.
- **Phone.** A C++ Nitro module on libsodium owns the whole session:
  - It wraps the `react-native-nitro-websockets` socket and installs itself as
    the socket's message handler.
  - It runs the handshake, reading the client key from secure storage itself.
  - It encrypts and decrypts every message, and passes only plaintext RPC
    messages to JavaScript, which sends through it.
  - For each video subscription it returns a `VideoStream` hybrid object.
    JavaScript passes it to the video view as a prop:
    `<StimVideoView stream={stream} />`. The view, a Nitro view in Swift and
    Kotlin, becomes that stream's consumer, so frames go from the socket to the
    decoder without a lookup by stream id. Replacing or removing the prop
    detaches the consumer.
  - The existing VideoToolbox and MediaCodec decoding moves into the Nitro
    view, which replaces the Expo `StimVideo` view and its `streamId` registry.
  - A `VideoStream` that JavaScript feeds exists only in development builds,
    for the mock server and tests.
  - Before writing the view, verify that a Nitro view prop can carry a hybrid
    object with `react-native-nitro-modules` 0.37.1, React Native 0.88 and Expo
    SDK 58.
  - Neither the long-term key nor the session keys enter the JavaScript heap,
    and video frames never reach the JavaScript thread.
  - Why native: ChaCha20-Poly1305 in JavaScript without a JIT ran at about
    3.7 MB/s on an M4 Pro. A phone is slower, video runs at up to 1 MB/s, and
    the work would share the thread the app runs on. The phone's own number is
    measured before release.
- **Stim Desktop.** CryptoKit.
- **Tests.**
  - Both patterns are checked against published Noise test vectors (cacophony,
    snow and flynn/noise for `XX`; flynn/noise for `XXpsk2`). Stim adds
    `XXpsk2` vectors of its own, generated with an independent implementation
    (Python `noiseprotocol`) that also reproduces the published ones.
  - The framing gets its own committed vectors.
  - Every implementation runs all of these, plus an interop test against a
    real stim-server.
- **LAN.** The phone uses plain `ws://` on a LAN, protected by Noise, so it
  needs no TLS certificate or pinning. The pairing checks in the app accept
  `ws://` to private addresses for protocol 2 pairings only.

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
  identify?(peer: { address: string; request: IncomingMessage }): Promise<TransportIdentity | null>; // display only
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
sets. From phase 2, `identify` only labels a connection for display, and each
listener belongs to a single transport. stim-server also keeps a loopback-only
listener for Desktop and the CLI on this machine. No transport exposes it or
forwards to it, so a connection that arrives there comes from this machine.

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
- The QR payload moves to `v: 2`: first with the server key fingerprint (phase
  2), then with an `endpoints` list, each entry naming its transport. The mobile app tries the endpoints in order
  and stops relying on the `.ts.net` suffix to decide whether to trust a host.
  Error and onboarding copy becomes per transport.

## Credentials

A machine credential stores the transport, the address to reach the worker,
and the worker's pinned server key: `{ transport, address, serverKey }`. It no
longer stores a tailnet node, and records from protocol 1 are not read (see
"Versions and release order"). Machine names in settings accept an optional
`<transport>:` prefix; no prefix means `tailscale`.

## Phases

1. Add `@stim-cli/transport` and move Tailscale into
   `@stim-cli/transport-tailscale`, with the server reaching it only through the
   contract. No behavior change; the existing server, setup, registry, and
   hosted relay tests are the check.
2. Stim's authentication and encryption, in release order:
   - the TypeScript Noise library;
   - the phone app speaking both protocols, with its native session module and
     Nitro video view, and reading the server key fingerprint from the QR
     payload;
   - stim-server, the CLI and Desktop on protocol 2 only, with the server key
     fingerprint in the QR payload.

   Then `@stim-cli/transport-local` (loopback and LAN) and the `endpoints`
   list in the QR payload.

3. Serve `/health.transports`, `transport.status`, `transport.setup`, and
   `transport.discover`, and move Desktop and the mobile app onto them.
4. Add `@stim-cli/transport-ngrok` and `@stim-cli/transport-cloudflared` for
   pairing and paired connections.
5. Move Metro reach onto the transports, support remote machines over
   transports without discovery, and carry hosted Metro over the WebSocket.
