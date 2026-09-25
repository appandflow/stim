# Stim Mobile

A read-only Expo app for watching Stim workspaces from a phone. It pairs with
the Stim server on a Mac (`stim-server`, from the `@stim-cli/server` package)
and shows what Stim Desktop shows, without any actions:

- **Home**: one screen for every paired machine; the app keeps a connection
  to each. The **Machines** row has a chip per machine with its connection dot and basic
  usage: live workspaces, memory committed of total, and the lowest free space
  of the volumes that hold Stim's workspaces, Stim home and the simulators. **+**
  pairs another machine. Below, one list of every workspace on every machine,
  building and live ones first, with the machine's name, project, branch, Metro, devices and
  their activity (driven by a tool, or idle), build progress, error and warning
  counts, and remote EAS sessions.
- **Devices**: the Workspaces / Devices toggle under the machine chips switches
  the list to a grid of every running simulator and emulator on every paired
  machine, with its latest frame, model, workspace, branch and machine.
  Tapping a tile opens its workspace. The grid follows the machine and
  project filters. Each tile on screen asks for one frame, unsubscribes when
  it arrives, and asks again 2 seconds later, backing off after errors. Tiles
  off screen, or under another screen, ask for nothing, and the server's
  capture loop runs only briefly. The chosen view is saved on the
  phone.
- **Filters**: the funnel button filters the list by machine, by project, by live
  or idle, and to workspaces with errors or with remote sessions. The filters
  are saved on the phone; a dot on the button shows that some are on. Live only
  is the default.
- **Machine status**: tapping a chip shows that machine's capacity, load average,
  memory pressure, free disk per volume, Stim budgets, running devices and
  device leases, warnings, and its server and `stim` versions.
- **Menu**: the menu button lists **Machines** (rename and forget), **Pair a
  machine**,
  and the app and server versions. Pairing scans the QR code Stim Desktop
  shows under **Pair a phone**, or takes the endpoint and pairing token typed
  in; the token field is masked, with a button that shows it. The device token
  the server issues is kept in the phone's secure storage (Keychain on iOS,
  Keystore on Android) and never shown.
- **Workspace**: a status card with the branch and the app's folder inside
  its checkout, Metro's port and health, memory, and the error count, which
  opens the errors; build progress; warnings, remote sessions, and each
  device: a running device with the latest frame the server sends for it, a
  stopped one as a single row. Under a running simulator or emulator that
  Stim owns, **Agent actions** lists the latest agent-device actions on it
  (taps, typing, app opens, screenshots, failed commands), from
  `logs.subscribe` with `sources: ["agent"]`. The **...** menu opens the logs, copies the
  full path, shows errors, or opens the machine's status.
- **Logs**: the same filters as the Desktop log viewer: the Metro, App, Native,
  Build and Agent sources, a slot, a minimum level, errors only, and a regular
  expression search. The list follows new records until you scroll up, keeps
  the newest 5,000, and a tap on a record shows its whole message and stack.

Paths under the Mac's home folder show as `~/...`; the server reports the home
folder in `hello`. Copy path copies the full path.

The app has no action buttons yet. `useAction(workspace)` in
`src/hooks/mac-connection.tsx` runs the server's `reload` and `stop` actions
and reports which ones the Mac lets this phone run (`available`), the one in
flight (`pending`), and the last failure (`error`). A phone paired without
control gets an empty `available` list.

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
system temporary directory. The mock server grants every phone control and
answers `reload` and `stop` for the fixture workspaces after 0.8 seconds, one
at a time per workspace, without changing the fixtures. Start it with
`npm run mock-server -- --read` to see a read-only pairing, which gets no
actions.

To try the home screen with two Macs, run two mock servers on different ports.
`--workspaces <regex>` keeps only the workspaces whose path matches, and
`--free-gb <n>` sets the free disk `machine.get` reports:

```bash
node mock-server/server.mjs --port 7797 --name "MacBook Pro" --workspaces tlon-apps
node mock-server/server.mjs --port 7798 --name "Mac mini" --workspaces 'Developer/stim|hinges' --free-gb 14
```

## Driving the app

Development builds can start already paired, so a person or an agent driving
the app with agent-device skips the pairing screen:

```bash
cd apps/mobile
npm run dev:pair  # or: npm run dev:pair -- --mock, with npm run mock-server running
stim start
stim ios
```

`npm run dev:pair` runs `stim-server pair --json` against the server running on
this Mac, spends the pairing token the way the app does, and writes the
endpoint and the device token it gets to `.env.local`:

```bash
EXPO_PUBLIC_STIM_DEV_ENDPOINT=ws://127.0.0.1:7787
EXPO_PUBLIC_STIM_DEV_DEVICE_TOKEN=...
```

On launch, a development build stores that Mac, named from the server's
`hello`, and shows it on the home screen. Release builds ignore both variables.
`.env.local` is gitignored; never commit a device token. Metro picks up a
rewritten `.env.local`; reload the app after `dev:pair`.

- `--mock` pairs with `npm run mock-server` instead of `stim-server`. The mock
  server writes its current pairing code to a file in the system temporary
  directory, and issues and prints a new code after each pairing and every 5
  minutes.
- `--control` pairs with control, so the app can run actions. Without it the
  pairing is read-only. The mock server ignores it.
- `--port <n>` targets a server on another port than 7787, such as a
  `stim-server --port <n>` running with a scratch `STIM_HOME`.
- `--endpoint <url>` sets the endpoint the app connects to, such as the
  tailnet endpoint `stim-server` prints. The default, `ws://127.0.0.1:<port>`,
  reaches the Mac from the iOS Simulator but not from an Android emulator.
  The server binds a device token to the machine that paired it, so a token
  from `dev:pair` works only in a simulator or emulator on this Mac.

`dev:pair` prints the id of the device it paired. Revoke it when you are done:

```bash
stim-server devices revoke <id>
```

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
