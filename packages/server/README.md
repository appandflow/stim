# Stim server implementation

This private workspace package implements the server bundled into `stim`.
Users install `stim` and run `stim serve`, `stim pair`, `stim pairings`,
`stim service` and `stim setup`.

User guidance lives in the website docs:

- [Remote machines and worker setup](../../website/docs/remote-machines.md)
- [Phone pairing, access and notifications](../../website/docs/phone-app.md)
- [Web shares](../../website/docs/share.md)
- [Device ownership and recordings](../../website/docs/owned-devices.md)
- [Commands](../../website/docs/commands.md) and [settings](../../website/docs/settings.md)

For development, build this package with `pnpm --filter @stim-cli/server build`.
The workspace build remains available to repository consumers; npm releases
bundle these sources into `stim` and do not publish this package.

Wire contracts live in [core/protocol.ts](../core/protocol.ts), with
[protocol.ts](./src/protocol.ts) defining the server schema. State readers live
in [core/state](../core/state). Follow the repository's [agent guide](../../AGENTS.md)
for authentication, ownership and validation requirements.
