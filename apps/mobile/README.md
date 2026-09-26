# Stim Mobile

An Expo app for watching Stim workspaces from a phone. It pairs with
the Stim server on a Mac (`stim-server`, from the `@stim-cli/server` package)
and shows what Stim Desktop shows. A phone the Mac grants control can also
reload and stop a workspace:

- **Home**: one screen for every paired machine; the app keeps a connection
  to each. The **Machines** row has a chip per machine with its connection dot and basic
  usage: live workspaces, the machine's memory used of total (as Activity
  Monitor's "Memory Used" counts it, colored by memory pressure), and the lowest
  free space of the volumes that hold Stim's workspaces, Stim home and the
  simulators. **+**
  pairs another machine. Below, one list of every workspace on every machine,
  building and live ones first, with the machine's name, project, branch and its
  git state (a dot with the count of uncommitted files, arrows for commits ahead
  of and behind the upstream, and **merged** once gc would call the branch
  merged), Metro, devices and
  their activity (driven by a tool, or idle), build progress, error and warning
  counts, and remote EAS sessions.
- **Devices**: the Workspaces / Devices toggle under the machine chips switches
  the list to a grid of every running simulator and emulator on every paired
  machine, with its latest frame, model, workspace, branch and machine.
  Phones sit two to a row; a device whose frame is wider than tall, such as a
  landscape iPad or an unfolded iPhone Duo, takes a whole row.
  Tapping a tile opens its workspace. The grid follows the machine and
  project filters. Each tile on screen asks for one frame, scaled to fit 640
  pixels, unsubscribes when
  it arrives, and asks again 2 seconds later, backing off after errors. Tiles
  off screen, or under another screen, ask for nothing, and the server's
  capture loop runs only briefly. The chosen view is saved on the
  phone.
- **Filters**: the funnel button filters the list by machine, by project, by live
  or idle, and to workspaces with errors or with remote sessions. The filters
  are saved on the phone; a dot on the button shows that some are on. Live only
  is the default.
- **Machine status**: tapping a chip shows that machine's capacity, with Stim's
  share of memory (what live workspaces commit), charts of CPU, memory used and
  startup-volume free space over the last hour, load average, memory used and
  pressure, free disk per volume, Stim budgets, running devices and
  device leases, **Needs attention**, and its server and `stim` versions.
  Needs attention groups status issues by workspace, live workspaces first,
  then those with an error, shows three workspaces until you expand it, and
  shows each issue's remedy with **Copy**, which copies it as
  `cd '<workspace>' && <remedy>`. No remedy maps to Reload or Stop, so none
  offers an action button.
- **Menu**: the menu button, or a swipe from the left edge of home, slides
  home right and shows the menu behind it: **Workspaces** and **Devices**
  (the same switch as home's toggle), **Machines** (rename and forget),
  **Pair a machine**, and **Recent workspaces**, the workspaces most recently
  live or opened on this phone. The button at the bottom shows the number of
  paired machines and opens **About**, with the app and server versions. A tap
  on home, a swipe left, or Android's back button closes it. Pairing scans the QR code Stim Desktop
  shows under **Pair a phone**, or takes the endpoint and pairing token typed
  in; the token field is masked, with a button that shows it. The device token
  the server issues is kept in the phone's secure storage (Keychain on iOS,
  Keystore on Android) and never shown.
- **Workspace**: a status card with the branch and the app's folder inside
  its checkout, Metro's port and health, the git state as chips, memory, and the error count, which
  opens the errors; build progress with its cache outcome ("Cache hit" or
  "Cold build", "Likely ..." before the run reaches a phase that decides it);
  each platform's last build (local cache, remote cache, compiled, or failed,
  with its duration and age), with why a compiled build missed the cache,
  which opens a sheet listing the changed fingerprint sources, and what the next build would find and how long it
  should take ("Next build: cache hit (local)" or "cold build, ~5:40"), from the server's read-only `build.plan`, with
  why a predicted cold build would miss the cache, which opens the same sheet. The
  screen asks for each platform with a last build or a device when it opens, one plan at a time, reuses a result for
  60 seconds unless that platform's last build changes, ignores a reply that arrives after it closes, and asks nothing
  while a build runs. The refresh icon asks again;
  warnings, remote sessions, and each
  device: a running device with the latest frame the server sends for it,
  fitted to the screen's width, and **Folded** or **Unfolded** for an iPhone
  Duo or an Android foldable emulator, a stopped one as a single row. Tapping
  the frame opens the [device view](#device-view). Under a running simulator or
  emulator that Stim owns, **Agent actions** lists the latest agent-device actions on it
  (taps, typing, app opens, screenshots, failed commands), from
  `logs.subscribe` with `sources: ["agent"]`. The **...** menu opens the logs, copies the
  full path, shows errors, or opens the machine's status. With control, it
  also runs **Reload** and **Stop** (see [Actions](#actions)).
- **Logs**: the same filters as the Desktop log viewer: the Metro, App, Native,
  Build and Agent sources, a slot, a minimum level, errors only, and a regular
  expression search. The list follows new records until you scroll up, keeps
  the newest 5,000, and a tap on a record shows its whole message and stack.

Paths under the Mac's home folder show as `~/...`; the server reports the home
folder in `hello`. Copy path copies the full path.

The design and protocol are in
[docs/specs/2026-09-25-stim-server-design.md](../../docs/specs/2026-09-25-stim-server-design.md).
The phone reaches the Mac over Tailscale with `wss://`; plain `ws://` is
accepted only for a loopback endpoint, which is what the simulator uses with
the mock server.

## Device view

Tapping a running device's frame on the workspace screen opens it full
screen. It renders `DeviceScreen` (see Device video): H.264 video at up to
60 frames a second when the server offers it, JPEG frames at up to 30
otherwise, scaled to the screen's pixels (at most 1600 on the longer edge)
and fitted to the device's shape. It is view-only until you turn on **Control**, which appears only when
the Mac granted this phone control.

With **Control** on, the server starts a control session (`control.begin`)
and holds a `stim device lock` lease on the device, so agents see it as
driven. Touches on the frame go to the device as a touch that follows your
finger: a tap, a drag or swipe, or a long press. The toolbar has **Keyboard**,
which opens the phone's keyboard and types what you type (printable ASCII;
Return and Delete included), **Home**, **Lock**, and on Android **Back** and
**Apps**. The session ends when you turn Control off, leave the view, lose the
connection, or after 5 minutes without input; the banner says why.

When status reports the device driven by something else, such as
agent-device, a `stim device lock`, or another phone, a banner names it and
Control is refused with the server's reason. **Take over** asks for
confirmation, then starts control anyway; the Mac records the takeover in its
action log.

## Actions

`hello` tells the app which actions the Mac lets this phone run. With control,
the workspace **...** menu shows **Reload** and **Stop**:

- **Reload** runs `stim reload` at once. When the workspace has both a running
  owned iOS simulator and a running owned Android emulator, it asks which app
  to reload, because `stim reload` without a platform refuses to choose.
- **Stop** asks for confirmation, then runs `stim stop`.

A toast shows the action while it runs, then its result or the server's error
message. The workspace updates through the status stream.

A read-only pairing shows one **Reload and Stop** entry instead, which
explains the grant: on the Mac, `stim-server devices grant <id> --control`,
with the id `stim-server devices` lists. A connection learns its actions only
from `hello`, so its **Reconnect** button opens a new connection to pick up the
grant. When control is taken away while connected, the server refuses the
action and the toast shows why. A server that predates actions shows neither
entry.

## Device video

`DeviceScreen` (`src/components/device-screen.tsx`) shows the stream
`useDeviceStream` (`src/hooks/device-stream.ts`) opens, which subscribes with
`video: ["h264"]`. When the server offers video, each binary
message goes straight to `StimVideoView`, a native view from the local Expo
module in `modules/stim-video`. On iOS it decodes with
`AVSampleBufferDisplayLayer`, and on Android with `MediaCodec` onto a
`SurfaceView`. The view stays black until the first keyframe. A decoder that
lost its state, for example after the app was in the background, or one
that fell more than three frames behind on Android, drops frames until a
keyframe it asks the server for with `frames.keyframe`. A server without
video sends JPEG `frame` events, which the same component shows as images.
The screen is fitted to the component's bounds at the device's aspect ratio,
and children render over the fitted screen, so touch overlays share its
coordinates. Development builds show H.264 fps, bitrate and latency (arrival
time minus the Mac's capture time) in the corner. The grid tiles keep
requesting JPEG frames.

`modules/stim-video` is native code: pull it, then rebuild the app with
`stim ios` or `stim android`. Fast Refresh does not load it.

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
`status.json`), because the capture machine had none. Two workspaces carry
`lastBuilds` added the same way; the compiled Android one also carries a `missReason`
in the shape of a real miss. `build.plan` answers from
`mock-server/fixtures/plans.json`, a local hit for iOS and a cold build that
generates the native dir for Android, captured from `stim ios|android --plan
--json`, with a `missReason` added to the Android one by hand.

Device tokens the mock server issues survive its restarts in a file in the
system temporary directory. The mock server grants every phone control and
answers `reload` and `stop` for the fixture workspaces after 0.8 seconds, one
at a time per workspace, without changing the fixtures. The `chat-perf-demo`
workspace runs an iOS simulator and an Android emulator, so reload there asks
for a platform, and the mock server refuses a reload without one, like
`stim reload`. Start it with
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

## Variants

`app.config.ts` builds one of two variants, chosen by `APP_VARIANT`:

- `production`, the default: **Stim**, bundle id and Android package
  `com.appandflow.stim`, scheme `stim`.
- `development`: **Stim Dev**, `com.appandflow.stim.dev`, schemes `stim` and
  `stim-dev`, and an orange icon with a **DEV** band. It installs next to the
  TestFlight app instead of replacing it.

`stim ios`, `stim android` and the EAS `production` profile build
`production`; the EAS `development` profile builds `development`. Set the
variable for any other command that reads the config, such as
`APP_VARIANT=development npx expo prebuild`.

The development icons in `assets/images/icon-dev.png` and
`assets/images/icon-ios-dev.png` are generated from the production icons.
After changing an icon, regenerate them and commit the result:

```bash
node scripts/dev-icons.mjs
```

## Building the dev app for your own phone

A Release build of the Stim Dev variant runs on an iPhone without Metro and
without TestFlight. `xcodebuild` signs it with the App&Flow team (`R7E8P23K3N`)
through an App Store Connect API key, so Xcode does not need to be signed in
to an Apple ID. Unlock the phone, connect it by cable or on the same network,
and find its UDID with `xcrun devicectl list devices`. Then, from
`apps/mobile`:

```bash
APP_VARIANT=development npx expo prebuild -p ios --clean
APP_VARIANT=development xcodebuild -workspace ios/StimDev.xcworkspace -scheme StimDev \
  -configuration Release -destination id=<UDID> -derivedDataPath ios/build \
  -allowProvisioningUpdates -allowProvisioningDeviceRegistration \
  -authenticationKeyPath ~/.appstoreconnect/private_keys/AuthKey_<KEY_ID>.p8 \
  -authenticationKeyID <KEY_ID> -authenticationKeyIssuerID <ISSUER_ID> \
  DEVELOPMENT_TEAM=R7E8P23K3N build
xcrun devicectl device install app --device <UDID> \
  ios/build/Build/Products/Release-iphoneos/StimDev.app
rm -rf ios
```

`xcodebuild` reads `app.config.ts` again during the build, so it needs
`APP_VARIANT` too. Remove `ios/` at the end: Stim records the prebuild it ran
for this workspace and does not notice a hand-made one, so the next `stim ios`
would build and cache the Stim Dev project as the production app.

The key's role must reach Certificates, Identifiers & Profiles: Admin, or
App Manager with that access. With it, Xcode creates the
development certificate, registers the bundle id, and adds the phone named by
`-destination` to the team's devices, then refreshes the team provisioning
profile. `-destination generic/platform=iOS` also signs, but registers no
device, so the app installs only on phones the team already has.

A Release build ignores `.env.local`; pair it with the QR code or the
endpoint and token, as with the TestFlight app. It gets updates published
to channel `development` (see [Updates](#updates)). `npm run dev:pair` is for
development builds on this Mac's simulators and emulators.

## Updates

Release builds run `expo-updates` against EAS Update. The production variant
reads channel `production`: TestFlight builds from the EAS `production`
profile, `preview` builds, and local Release builds. A Release build of the
Stim Dev variant, such as the phone build above, reads channel
`development`. The channel is `updates.requestHeaders` in `app.config.ts`, so
a local `xcodebuild` gets it too; `eas.json` sets the same `channel` on the
`production` and `development` profiles. Debug builds, including the EAS
`development` development client, load JS from Metro and fetch no updates on
launch.

`runtimeVersion` uses the `fingerprint` policy: the runtime is a hash of the
native project inputs. A JS-only change keeps the runtime, so an update
reaches the builds already installed. A change to native code, a native
dependency, `eas.json`, an asset the config names, or the native parts of
`app.config.ts` gives a new runtime, which needs a new build; installed
builds ignore updates for another runtime. `xcodebuild` computes the
fingerprint from `app.config.ts` during the build, which is why the phone
build passes `APP_VARIANT` to it. The two variants have different bundle ids,
so they never share a runtime.

The app checks for an update on every launch without waiting for it: it
starts the update it already has, downloads a newer one in the background,
and runs it on the next launch. This is the `expo-updates` default. A
monitor that opens to glance at a build should open at once, even on a slow
or captive network, and one launch on the previous JS changes nothing on the
Mac.

**About** shows the running update's id, or `embedded` when the app runs the
JS it was built with. Debug builds show `embedded` too.

Publish an update by hand from `apps/mobile`:

```bash
eas update --channel production --environment production --platform ios --message "<what changed>"
APP_VARIANT=development eas update --channel development --environment development --platform ios --message "<what changed>"
```

`eas update` computes the runtime from the checked-out project, so run it on
the commit the builds were made from, plus JS changes only.

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

- `development`: a development client of the Stim Dev variant (see
  [Variants](#variants)), distributed internally.
- `preview`: a release build of the production variant, distributed
  internally. It replaces the TestFlight app on a phone and gets updates from
  channel `production`.
- `production`: an App Store build on update channel `production`. EAS owns the build number
  (`appVersionSource: "remote"`) and increments it on every build. The
  marketing version is `version` in `app.config.ts`.

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

   This prints the `owner` and `extra.eas.projectId` to set in
   `app.config.ts`; commit that change. If the project already exists on expo.dev, link it with
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

`.github/workflows/mobile-release.yml` releases from `main`. It runs in the
`release` environment and signs in to Expo with the `EXPO_TOKEN` secret.

- **Actions**, **Mobile release**, **Run workflow**, with a `mode`:
  - `auto`, the default: computes the iOS fingerprint of the checked-out
    project (`npx expo-updates fingerprint:generate --platform ios`) and
    compares it with the runtime of the latest finished `production` build.
    The same runtime publishes an update; a different one, or no build with a
    runtime, builds and submits.
  - `update`: publishes an update to channel `production` with the commit
    subject as the message. Use it only when you know the change is
    JS-only; an update for a runtime no build has reaches no one.
  - `build`: builds with the `production` profile and submits to
    TestFlight (`eas build --auto-submit`).
- A `mobile-v<version>` tag on `main` always builds and submits. The version
  must equal `version` in `app.config.ts`, so raise it first.

`eas build` records as the build's runtime the fingerprint computed on the
machine that starts it, so a build from this workflow and the fingerprint
`auto` compares are both computed on the Linux runner. A build started by hand
on a Mac records the Mac's fingerprint; if a platform difference ever made
the two disagree, `auto` would build for a JS-only change. `auto` compares
with the newest production build from any branch, so start production builds
only from `main`.

`--auto-submit` and `eas submit` read the App Store Connect API key from EAS
credentials, not from GitHub. Store it once, from `apps/mobile`:

```bash
eas credentials --platform ios
```

Choose the `production` profile, then **App Store Connect: Manage your API
Key**, **Set up your project to use an API Key for EAS Submit**, and use an
existing key: give the path to its `.p8` file, its key ID and issuer ID.
EAS keeps the key on expo.dev for the Expo account; the `.p8` stays out of
the repository.

To release by hand instead:

```bash
eas build --platform ios --profile production --auto-submit
eas update --channel production --environment production --platform ios --message "<what changed>"
```

The build appears in TestFlight after Apple finishes processing it, usually
within 30 minutes. Add testers under the app's **TestFlight** tab. Raise
`version` in `app.config.ts` for a new marketing version; build numbers need no
change.
