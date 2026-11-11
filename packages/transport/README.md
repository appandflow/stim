# @stim-cli/transport

The contract between stim-server and the transports that carry phones and other machines to it. A transport
package declares `stimPlugin.kinds.transport: 1` in package.json and exports `id` and `createTransport()`, and stim-server loads it with `loadTransport()`:

```ts
import { loadTransport } from '@stim-cli/transport';

const loaded = await loadTransport({
  reference: '@stim-cli/transport-tailscale',
  manifest: () =>
    import('@stim-cli/transport-tailscale/package.json', { with: { type: 'json' } }).then(
      ({ default: manifest }) => manifest,
    ),
  load: () => import('@stim-cli/transport-tailscale'),
  input: { env: process.env, options: {} },
});
if ('unavailable' in loaded) console.error(loaded.unavailable);
```

`loadTransport()` never throws. A missing package, a different manifest kind integer, a failing `createTransport()` or a
load that takes longer than 10 seconds comes back as `unavailable` with the reason.

A transport implements the capabilities it has. Every argument and result is structured-clone-safe data, so a
transport can run in a worker thread, and the transport kit (`runContract('transport', ...)` from `stim/plugin`) loads it that way:

- `bindAddresses()`: the addresses stim-server listens on, besides loopback, for the clients it carries.
- `watch(listener)`: calls `listener({ addresses })` with the new addresses when they or the transport's state may have
  changed, and returns a function that stops it.
- `identify({ address, headers })`: the machine a connection comes from, given the request headers as a plain object.
  stim-server binds a device token to it at pairing and refuses the token from any other machine.
- `expose({ port })` and `unexpose({ port })`: make a local port reachable from outside this machine and stop doing so.
  `expose` answers the port it serves on and whether the port is `routed`, `funneled`, `missing` or `unknown`. The kit
  calls them only when its caller passes `expose: { port }`, because on a real transport they change the machine's
  routes; pass it for a fixture, or for options that point the transport at a test environment.
- `resolve({ name })`: the endpoint to dial a machine of this transport, or `{ unresolved }` with the reason.
- `close()`: stops any background work.

The design and the capabilities still to come are in
[docs/specs/2026-10-13-pluggable-transports-design.md](../../docs/specs/2026-10-13-pluggable-transports-design.md).
