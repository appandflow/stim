# @stim-cli/transport

The contract between stim-server and the transports that carry phones and other machines to it. A transport
package exports `apiVersion`, `id` and `createTransport()`, and stim-server loads it with `loadTransport()`:

```ts
import { loadTransport } from '@stim-cli/transport';

const loaded = await loadTransport({
  reference: '@stim-cli/transport-tailscale',
  load: () => import('@stim-cli/transport-tailscale'),
  input: { env: process.env, options: {} },
});
if ('unavailable' in loaded) console.error(loaded.unavailable);
```

`loadTransport()` never throws. A missing package, a different `apiVersion`, a failing `createTransport()` or a
load that takes longer than 10 seconds comes back as `unavailable` with the reason.

A transport declares its `traits` and implements the capabilities it has:

- `bindAddresses()`: the addresses stim-server listens on, besides loopback, for the clients it carries.
- `watch(listener)`: called when those addresses or the transport's state may have changed.
- `identify({ address, request })`: the machine a connection comes from. stim-server binds a device token to it at
  pairing and refuses the token from any other machine.
- `close()`: stops any background work.

The design and the capabilities still to come are in
[docs/specs/2026-10-13-pluggable-transports-design.md](../../docs/specs/2026-10-13-pluggable-transports-design.md).
