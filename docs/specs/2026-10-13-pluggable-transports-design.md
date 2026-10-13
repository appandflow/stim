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

| Role | Today | Contract capability |
|---|---|---|
| Exposure and TLS | `tailscale serve` on a tailnet-only HTTPS port | `expose`, `setup` |
| Peer identity | `tailscale whois` gives the node a device token is bound to | `identify` |
| Discovery and pinning | `tailscale status --json` lists peer machines; a name that moves to another node is refused | `discover`, `resolve` |
| Bind addresses | The server also listens on the Tailscale addresses; the hosted Metro gateway trusts WireGuard source addresses | `bindAddresses`, `traits.privateNetwork` |

The pairing core does not depend on the transport and does not change: the QR
payload, `hello` with a pairing token and then a device token, the token
registry, and grant and revoke.

## Decisions

- Transports are machine settings, not project settings. stim-server is one
  process per machine and ships inside Stim Desktop, so transports resolve from
  the server's own dependencies. A cache provider, by contrast, resolves from
  the project that names it. `network.transports` is an ordered list, so one
  server can answer a simulator on loopback and a phone on the tailnet.
- Stim adds its own peer identity, so every transport gets a second factor
  beside the device token. At pairing the client sends a public key. Later
  `hello` calls answer a server challenge with that key, and the server proves
  the key the QR code names. A transport identity, such as a Tailscale node,
  remains an extra check where the transport has one.
- Identity comes from the transport that owns the listener, never from request
  headers. `tailscale serve`, ngrok, and cloudflared all proxy from loopback with
  `X-Forwarded-For`, so the header cannot tell them apart.
- ngrok and cloudflared decrypt traffic at their edge. This reverses the
  "Transport alternatives" note of the stim-server design: these backends ship,
  but only when the user turns them on, and Desktop and the docs say that the
  provider can read the traffic. Application-layer encryption may follow.
- Transports without `privateNetwork` cannot carry hosted Metro, whose gateway
  trusts source addresses, until hosted Metro moves onto the authenticated
  WebSocket.
- Metro reach (`metro.tunnel`) moves onto the same plugins, through
  `expose({ purpose: 'metro' })`, after the server side is done.

## Contract

```ts
export const apiVersion = 1;
export const id: string;
export const optionsSchema: JSONSchema; // x-stim annotations, rendered by Desktop
export function createTransport(input: { stimHome: string; env: NodeJS.ProcessEnv; options: Record<string, unknown> }):
  Transport | Promise<Transport>;

interface Transport {
  id: string;
  traits: { privateNetwork: boolean; tls: 'end-to-end' | 'edge' | 'none'; peerIdentity: boolean };
  status(): Promise<TransportStatus>;
  watch?(listener: () => void): () => void;
  expose?(input: { port: number; purpose: 'server' | 'metro' }): Promise<Exposure>;
  setup?(input: { port: number; action: string }): Promise<TransportStatus>;
  identify?(request: IncomingMessage): Promise<TransportIdentity | null>;
  bindAddresses?(): string[];
  discover?(): Promise<TransportPeer[]>;
  resolve?(target: { machine: string; peerId: string }): Promise<Endpoint | string>;
  close?(): void;
}
```

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
2. Add `@stim-cli/transport-local` (loopback, and LAN with a self-signed
   certificate pinned by the QR code), the `v: 2` QR payload, and the key-based
   peer identity.
3. Serve `/health.transports`, `transport.status`, `transport.setup`, and
   `transport.discover`, and move Desktop and the mobile app onto them.
4. Add `@stim-cli/transport-ngrok` and `@stim-cli/transport-cloudflared` for
   pairing and paired connections.
5. Move Metro reach onto the transports, support remote machines over
   transports without discovery, and carry hosted Metro over the WebSocket.
