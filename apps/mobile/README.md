# Stim Mobile

A read-only Expo app for watching Stim workspaces from a phone. It pairs with
the Stim server on a Mac (`stim-server`, from the `@stim-cli/server` package)
and shows what Stim Desktop shows, without any actions:

- **Macs**: the paired Macs, with rename and forget. Pairing scans the QR code
  Stim Desktop shows under **Pair a phone**, or takes the endpoint and pairing
  token typed in. The device token the server issues is kept in the phone's
  secure storage (Keychain on iOS, Keystore on Android).
- **Workspaces**: every workspace on the Mac grouped by project, live ones
  first, with Metro, supervisor health, running devices and their activity
  (driven by a tool, or idle), build progress, error and warning counts, and
  remote EAS sessions. **Show idle** lists the workspaces with nothing running.
- **Workspace**: the branch and path, warnings, remote sessions, and each
  device with the latest frame the server sends for it.
- **Logs**: the same filters as the Desktop log viewer: the Metro, App, Native
  and Build sources, a slot, a minimum level, errors only, and a regular
  expression search. The list follows new records until you scroll up, keeps
  the newest 5,000, and a tap on a record shows its whole message and stack.

The design and protocol are in
[docs/specs/2026-09-25-stim-server-design.md](../../docs/specs/2026-09-25-stim-server-design.md).
The phone reaches the Mac over Tailscale with `wss://`; plain `ws://` is
accepted only for a loopback endpoint, which is what the simulator uses with
the mock server.

## Protocol types

`src/protocol/types.ts` holds the protocol messages and the `stim status --json`
and `stim logs --json` payload types the app reads. They are written from the
spec until the server and the shared types in `@stim-cli/core` exist; the app
then imports them from there and this file goes away.

## Develop

The app lives outside the pnpm workspace and uses npm. It needs Node.js 22.

```bash
cd apps/mobile
npm install
stim start
stim ios          # or: stim android
npm run mock-server
```

`npm run mock-server` serves a Stim server on `ws://127.0.0.1:7787` that
replays payloads captured from a real Mac in `mock-server/fixtures/`: a
`stim status --json` payload taken while `stim ios` was installing, records
from `stim logs --json`, and one simulator screenshot as the frame of every
iOS device. It prints a pairing code; in the app, choose
**Enter the endpoint and token instead** and type the endpoint and token. The
status timestamps are moved forward to the time the server starts, so build
and activity durations read as they did at capture. The workspace that ran
the build carries a remote EAS session added by hand (listed under `edits` in
`status.json`), because the capture machine had none.

Device tokens the mock server issues survive its restarts in a file in the
system temporary directory.

## Checks

```bash
npm run format:check
npm run lint
npm run typecheck
npm test
```

`.github/workflows/mobile.yml` runs them for changes under `apps/mobile`.
