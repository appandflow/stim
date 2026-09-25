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
and `stim logs --json` payload types the app reads. It is a copy of the types
`@stim-cli/server` exports, not an import, because this npm app cannot consume
the pnpm workspace packages cleanly:

- `@stim-cli/server` is not published yet, and the app is not a workspace
  member, so there is no package to install.
- A TypeScript path into `packages/server/src/protocol.ts` makes the app's `tsc`
  compile `@stim-cli/core/state` from source, which imports Node built-ins and
  `unique-pid`, neither of which the app installs. Metro would also have to
  bundle `PROTOCOL_VERSION` from outside the project root.
- The built `dist/protocol.d.mts` would make the app's checks depend on a
  pnpm install and build of the workspace.

`packages/server/__tests__/mobile-protocol.test.ts` keeps the copy honest: the
root `pnpm run typecheck` fails when the app would send params the server
refuses, misses a server method, or misreads a result or event the server
sends. The root CI runs when this file changes. The app's `LogRecord` is
narrower than the server's on purpose: the server forwards whatever
`stim logs --json` prints.

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

## Ship to TestFlight

The app ships to TestFlight with EAS, under the App&Flow Expo account
(`appandflow`) and the App&Flow Apple Developer team. `eas.json` has three
build profiles:

- `development`: a development client, distributed internally.
- `preview`: a release build, distributed internally.
- `production`: an App Store build. EAS owns the build number
  (`appVersionSource: "remote"`) and increments it on every build. The
  marketing version is `version` in `app.json`.

`development` and `preview` builds install only on devices registered with
`eas device:create`.

The app declares `ITSAppUsesNonExemptEncryption` as `false`: it uses only the
TLS that iOS provides, so App Store Connect does not ask the export compliance
question for each build.

### One-time setup

Run these from `apps/mobile` with the EAS CLI (`npm install --global eas-cli`,
or prefix each command with `npx`).

1. Log in to Expo with an account that belongs to the `appandflow`
   organization:

   ```bash
   eas login
   eas whoami
   ```

2. Create the EAS project under the App&Flow owner and link it:

   ```bash
   eas init --account appandflow
   ```

   This writes `owner` and `extra.eas.projectId` to `app.json`; commit that
   change. If the project already exists on expo.dev, link it with
   `eas init --id <project-id>` instead.

3. Create the App Store Connect app record, if it does not exist yet. In
   [App Store Connect](https://appstoreconnect.apple.com), under the App&Flow
   team, open **Apps**, choose **+**, then **New App**: platform iOS, name
   `Stim`, bundle ID `com.appandflow.stim`, and any SKU. If the list does not
   offer the bundle ID, run step 4 first, which registers it, or register it
   under **Certificates, Identifiers & Profiles**. `eas submit` can create the record only when it signs in with an
   Apple ID; an App Store Connect API key cannot create apps.

   Copy the app's **Apple ID** (a number, under **App Information**) into
   `eas.json`:

   ```json
   "submit": { "production": { "ios": { "ascAppId": "<Apple ID>" } } }
   ```

4. Set up signing and submission credentials:

   ```bash
   eas credentials --platform ios
   ```

   Choose the `production` profile, sign in with an Apple ID on the App&Flow
   team, and let EAS create or reuse the distribution certificate and the App
   Store provisioning profile. In the same menu, under **App Store Connect:
   Manage your API Key**, add an API key so `eas submit` runs without Apple ID
   prompts. To create the key yourself: App Store Connect, **Users and
   Access**, **Integrations**, **App Store Connect API**, a key with the **App
   Manager** role; keep the downloaded `.p8` file out of the repository.

### Each release

```bash
eas build --platform ios --profile production
eas submit --platform ios --latest
```

The build appears in TestFlight after Apple finishes processing it, usually
within 30 minutes. Add testers under the app's **TestFlight** tab. Raise
`version` in `app.json` for a new marketing version; build numbers need no
change.
