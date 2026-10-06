---
title: 'Command reference'
sidebar_position: 1
description: 'Every Stim command and option'
---

import StimTabs from '@site/src/components/StimTabs';

:::note[Command examples]

Commands use `stim`. If Stim is not installed globally, replace `stim` with
`npx stim`.

:::

Run `stim <command> --help` for parser help. Run `stim guide` for the full
reference that ships with the installed version. Every refusal code has an
entry in the [troubleshooting reference](./troubleshooting.md).

`start --json`, `ios --json`, `android --json` and `macos --json` report
`agentDevice: { stateDir }`, an absolute path under
`$STIM_HOME/workspaces/<name>/agent-device/`. Each `status --json` environment
reports the same field, shared by its slots, without creating the directory.
Set `AGENT_DEVICE_STATE_DIR` to it when driving a device yourself; see
[agent-device actions](./dev-server-and-logs.md#agent-device-actions).

## Normal workflow

<StimTabs
code={`stim doctor
stim start
stim ios                 # or: stim android, or: stim web
stim logs --errors
stim stop`}
/>

`ios` and `android` require a running dev server for a Debug build. Release
builds embed the JavaScript bundle and skip that requirement.

When [Stim Desktop](./desktop.md) is installed, `worktree warm`, `start`,
`ios`, `android` and `web` print a link that opens the workspace in it, on
stderr, and add it to their `--json` payload as `links.desktop`:

```text
Open in Stim Desktop: stim-desktop://workspace?path=/Users/me/app-feature
```

The agent guide tells agents to share this link with you once, when they
begin work in a workspace.

`reload` is a recovery command that reloads JavaScript in the live app and never
restarts it. Use it when an error screen remains after a fix, not after every
JavaScript edit. It also recovers an Android app whose first bundle failed; an
iOS app in that state never connects to Metro, so reload cannot reach it.

## Named device slots

`ios`, `android`, `device lock`, `device unlock`, `logs`, and `stop` accept
`--slot <name>`. Omitting it selects the default target for a device run;
plain `logs` and `stop` still cover the whole workspace. `status` lists every
slot. Slots can hold multiple simulators of the same model as well as physical
devices. See [multiple devices with slots](./owned-devices.md#multiple-devices-with-slots)
for commands, a copyable agent prompt, and shared-server limitations.

## `doctor`

```text
stim doctor [--platform <ios|android>] [--json] [--fix]
```

Inspects the current app and, in a repository with linked worktrees, the source
checkout's fitness as a seed. It reports missing or stale dependencies,
CocoaPods state, cache conflicts, device capacity, remote session problems, and
a linked native library whose Git metadata enters the fingerprint. On a
checkout without installed dependencies, it also reports fingerprint
differences against a fresh worktree. The checkout is left untouched unless
`--fix` is passed.

`--platform ios` or `--platform android` limits native findings to that
platform while keeping shared project checks. Each run in a React Native or
Expo app is recorded per platform in Stim's state for this project, which also
registers the project for `stim status`, and a run without `--platform` counts
for both, so `stim guide` can tell when doctor is due again. A run in a
directory that is not an app records nothing.

Doctor also prints the running CLI version and the `stim` installation resolved
from `PATH`, and flags a resolved installation that is older than another
available one.

A `budget` line reports the free disk on the volumes that hold the app and
`$STIM_HOME`, and the estimated committed memory, against the
[machine budget](./settings.md#machine-settings). When the machine is over
budget, a finding lists what the next `start`, `ios`, or `android` would reclaim
first. Doctor itself never reclaims. `--json` adds this report as `budget`.

`doctor` also flags when an agent harness sandboxes shell commands and Stim is
not allowed through it, which shows up as unrelated-looking failures against
the simulator service, the adb server, and Stim's own state directory.
For that finding, `--fix` writes the missing allowance into `.claude/settings.local.json` at the
repository root, the per-user file, merging it with whatever is already there
and preserving other settings. It cannot add a Codex allowance because that
sandbox has no per-path allowance to add. This repair runs only when the
report shows that finding, so an unsandboxed session leaves the file alone.
See `stim guide errors sandbox` for the failure signatures and the manual
settings.

Unless `--platform ios` is selected, `--fix` also removes stale ignored,
untracked Android `.cxx` configurations with obsolete compiler launchers,
including those in installed native modules. Stop native builds before this
repair: its cache-lock check cannot detect uncached, release-swap fallback, or
direct Gradle builds. The next build recreates these files; source, custom launcher settings,
and shared ccache entries are preserved. See `stim guide lifecycle options`.

When [`hosting.machines`](./settings.md#machine-settings) names hosting Macs,
doctor reports their separate device-host approval in `deviceHosts`. Only
`--fix` requests approval, retries a definite revoked or lapsed request, and
forgets names removed from the setting. A person on the hosting Mac runs the
printed `stim-server devices grant <id> --device-host` command. Tokens remain
private and pinned to that tailnet node. A changed node refuses access;
unreadable credentials and uncertain replies preserve the pin. Invalid hosting
settings report an error and preserve every saved credential. JSON states
are `approved`, `pending`, `not-asked`, `revoked`, `node-changed`,
`not-on-tailnet`, `tailscale-off`, `unreachable`, `invalid`,
`credentials-unavailable` and `busy`. Hosting approval does not yet change
`ios` or `android` placement.

When the [`offload.machines`](./settings.md#machine-settings) setting names
build machines, doctor reports each one this Mac is not approved on: not on the
tailnet, not asked yet, waiting for approval (with the
`stim-server devices grant <id> --build` command to run there), revoked, or
now a different tailnet node than the one this Mac paired with. `--fix` asks
each named machine without a pairing for build access, asks again one that
revoked or let the request lapse, and forgets the pairing of a machine no
longer named. It never re-pairs with a different node. `--json` lists each named machine
under `buildMachines` with its `state`: `approved`, `pending`, `not-asked`,
`revoked`, `node-changed`, `not-on-tailnet`, `tailscale-off`, `unreachable` or
`invalid`.

Doctor also asks each approved machine for one build offer, the same offer
`stim ios` and `stim android` ask for, and reports every reason that machine
would not take this app's builds now, each as a finding with a fix: it does
not answer, it runs another Stim build (update it to this Mac's build), its
CPU differs; for iOS (unless `--platform android`) its Xcode, simulator SDK or
CocoaPods differ, it has no Bundler for a project whose `Gemfile.lock` pins
CocoaPods (its own CocoaPods version does not matter then), or it has no
iPhone simulator on the runtime `stim ios` builds for here; for Android (with
`--platform android`, or an app with `android/` or Expo) its JDK major differs
or its SDK lacks the NDK, build-tools or compile platform; its worker volume has less than 10 GB free;
or it is busy. Busy and no answer are notes; the
others cost time. In `--json` such a machine also carries `offloadable`,
`reasons`, `problems` (each reason with its finding code), and `capacity`,
its reported load:

```json
{
  "machine": "janics-mac-mini",
  "state": "approved",
  "offloadable": false,
  "reasons": ["Stim build 6bbe9103995f7eb6 there, e7749c9011f4d423 here"],
  "problems": [{ "code": "stim-build", "reason": "Stim build 6bbe9103995f7eb6 there, e7749c9011f4d423 here" }],
  "capacity": {
    "running": 0,
    "max": 1,
    "cpus": 10,
    "loadPerCore": 0.4,
    "builds": 0,
    "maxBuilds": 0,
    "maxLoadPerCore": 2,
    "declined": null,
    "diskFreeBytes": 812000000000,
    "minDiskFreeBytes": 10737418240
  }
}
```

## `ports`

```text
stim ports
stim ports get <label>
stim ports stop [label] [--dry-run]
stim ports release [label]
```

Reserves TCP ports 8900–8999 for web or API servers started by the
project. `get` prints only the number and reuses an existing allocation.
New allocations skip reserved and occupied ports; retry notices go to stderr.
`ports` lists named allocations and Metro, marked managed.

Labels start with a letter and contain up to 64 letters, digits, underscores,
or hyphens. `metro` is reserved for `stim start` and `stim stop`.

The workspace is the nearest `package.json` directory. In a monorepo, a package
that is not a React Native or Expo app, such as a Vite web app in `apps/web`,
uses the one Stim app registered in the same Git worktree instead, and stderr
names it. `web`, `settings`, `logs`, `reload`, `stop` and `status` follow the
same rule; `status` stars the app instead of printing the note. Every `ports` command there then acts on that app's ports, including
`stop` and `release` without a label. `status`, `worktree remove` and `gc`
treat the ports as the app's. A package that already holds ports keeps them
until you release them. With no registered app, or more than one, run `ports`
from the app directory.

`stop` terminates listeners on the selected named ports, including processes
outside the workspace, and prints their PIDs and commands. It sends SIGTERM,
then SIGKILL after two seconds if needed. `--dry-run` previews without killing
or releasing. Failed stops retain the allocation. `release` removes the
reservation without signalling the server. Omit the label to select all named
ports. Neither command touches Metro; `stim stop` leaves named ports alone.

`worktree remove` stops and releases named ports. `gc` reports allocations for
missing workspaces, and `gc --delete` stops and releases them. Unmounted or
unresolved workspace paths remain registered.

See [server examples and limitations](./dev-server-and-logs.md#named-server-ports).

## `start`

```text
stim start [--wait <seconds>] [--remote] [--reset-cache] [--json]
```

Starts the project dev server on the workspace's reserved port. Stim supervises
the process and captures its output. A healthy existing server for the same
project is reused. A Debug `ios` or `android` run starts the dev server the
same way when it is not running, so running `start` first is optional.

- `--wait <seconds>` changes the startup timeout. The default is 60 seconds.
  It waits for the dev server; `--wait` on `ios`, `android`, and `device lock`
  instead bounds the wait for a device another workspace holds.
- `--remote` prepares Metro for a remote device.
- `--reset-cache` restarts only this app's verified owned Metro, preserving its
  port and devices, with Metro's own reset (`resetCache` on a bare server,
  `expo start --clear` on Expo). Every store in the app's Metro config is
  cleared, including this app's shared transform store, so other worktrees of
  the same app rebuild their transforms too; the file map is rebuilt. Other
  apps and native build caches are unchanged. Externally started servers are
  left alone, and a failed startup can be retried with `stim start`.
- `--json` prints one stable result object on stdout.

## `ios`

```text
stim ios [--slot <name>] [--scheme <name>] [--configuration <name>] [--device-type <name>] [--runtime <version>]
         [--simulator-app <xcode|siniulator|stim-desktop>] [--device [udid]] [--wait <seconds> | --no-wait] [--remote <proxy|eas>]
         [--eas-profile <name>] [--no-metro-check] [--no-build-cache] [--plan] [--json]
```

Builds or restores the iOS app. Stim then boots an owned simulator, installs the
app, opens it, and checks launch logs. Native builds run locally by default;
`--eas-profile` downloads an existing EAS development build. A simulator Debug
build can compile on a paired build machine instead: see `offload.mode` in
[machine settings](./settings.md#machine-settings).

- `--configuration <name>` selects an Xcode configuration. The default is Debug.
- `--build-machine <auto|local|name>` overrides `STIM_OFFLOAD_MACHINE` and
  `offload.machine`. A name requires that configured, paired worker and fails
  with `STIM_OFFLOAD_REFUSED` without local fallback. Unlisted or unpaired names refuse at setup before checking the cache, without
  a build record or failed-run stats. A listed paired name with a cache hit
  contacts no worker. Prebuild and pod install still run on this Mac before
  a named offload. A refusal starts no local xcodebuild, Gradle or SwiftPM compile.
  Run `stim doctor --fix` to ask for build access if not paired; a person on
  the worker finds the id with `stim-server devices` and approves it with
  `stim-server devices grant <id> --build`.
  See [machine settings](./settings.md#machine-settings) for supported builds and remedies.
- `--scheme <name>` selects an exact shared Xcode scheme when the automatic
  app selection is not the one you need. Explicit schemes have separate build
  caches and DerivedData. This is a build scheme, not the app's URL scheme.
- `--device-type <name>` creates this workspace's owned simulator as that model,
  overriding `ios.deviceType` for one invocation. A model no installed runtime
  can create refuses with `STIM_BAD_ARG` and prints the ones they do offer.
- `--runtime <version>` creates it on that iOS runtime, overriding `ios.runtime`
  the same way. It takes a version (`26.5`) or a runtime's full name
  (`iOS 26.5`), exactly. When the workspace's simulator already runs another
  installed version, `stim ios` refuses instead of booting it: remove the
  simulator with `stim worktree remove` or `stim gc --delete`, or pass
  `--slot <name>` to create one beside it.
- On a remote run (`--remote` or the `ios.remote` setting), `--runtime` refuses
  with `STIM_BAD_ARG` because the remote backend chooses the iOS version, and so
  does `--device-type` on the proxy backend. `--remote eas` honors
  `--device-type` by starting the EAS Simulator session with
  `eas simulator:start --device <name>`, which needs eas-cli 22.2.0 or later.
  A recorded EAS session still running another model refuses with
  `STIM_REMOTE_DEVICE_MISMATCH`; run `stim stop`, then rerun. The
  `ios.deviceType` and `ios.runtime` settings are ignored on a remote run.
- `--simulator-app <xcode|siniulator|stim-desktop>` overrides the machine `iosSimulatorApp`
  preference for this run. It also opens an already running owned simulator in
  that app without rebooting it. The preference is not saved. Local simulators
  only; cannot be combined with `--device` or a remote target.
- `--device [udid]` builds, installs, and launches on a connected iPhone instead
  of the owned simulator. With no UDID it takes the first connected device it
  can lease. It cannot be combined with `--remote`. Stim never creates, boots,
  or deletes hardware.
- `--wait <seconds>` bounds the wait for a physical-device lease (default 60;
  `0` refuses immediately if busy). Only with `--device`.
- `--no-wait` bypasses leasing, including when another workspace holds the
  device. Installing the same app terminates that workspace's running app.
  Only with `--device`; cannot be combined with `--wait`.
- `--remote proxy` uses a configured Agent Device daemon.
- `--remote eas` uses an EAS remote simulator. It needs eas-cli 21.6.0 or later.
- `--eas-profile <name>` selects a compatible [EAS development build](./eas-builds.md),
  including with `--device`. It needs eas-cli 18.9.0 or later. A miss stops
  and prints an EAS build command; cloud builds require authorization. Cannot
  be combined with `--scheme`, `--configuration`, or `--no-build-cache`.
- `--no-metro-check` skips the Debug dev-server check and does not start the
  dev server.
- `--no-build-cache` ignores cached artifacts and replaces the matching entry.
- `--plan` predicts the next build instead of running it. See
  [Predict the next build](#predict-the-next-build).
- `--json` prints one stable result object on stdout. It includes `buildMachine`
  (the selected `auto`, `local`, or machine name) and `builtOn` (`here` or the
  worker name, absent when no build ran, including cache hits).

A Debug run starts the workspace's dev server as `stim start` would when it is
not running, including after an idle stop. With `--remote`, it starts it as
`stim start --remote` would. The JSON result then carries
`devServer: { "started": true, "reason": "not running" | "stopped (idle)" }`.
The run refuses only when that start fails, with the start's error code.

A non-Debug configuration embeds its JavaScript bundle.

A locally compiled device build is local-tier only. Its cache key ends `-device`, so it cannot
collide with a simulator build, and no build-cache provider or Expo remote cache
is read or written on that path, because every entry they hold is keyed
for the simulator. `--eas-profile <name> --device` uses EAS CLI's artifact cache and
installs the signed app without re-signing it.

A `--device` run installs with `devicectl device install app` and launches with
`devicectl device process launch`. The iPhone can be cabled or paired over
Wi-Fi; an Apple TV, Vision Pro, or simulator is never picked. With no UDID, a
cabled iPhone that is paired and has Developer Mode on is taken first, and a
Wi-Fi one only when there is none. A Wi-Fi run prints one line saying so,
allows each install step 15 minutes and the launch 120 seconds, and fails with
`STIM_DEVICE_WIRELESS_FAILED` when devicectl times out or loses the phone;
connect the cable and run again. A locked phone or another cause devicectl
names keeps its own error and remedy. Every device install is signed, Debug
included, so the app's own `embedded.mobileprovision` must be unexpired and must
name the phone, and the identity it names must be in this machine's keychain
whenever Stim modifies the bundle.

In Debug the phone reaches Metro over the LAN, because it shares no loopback
with the host and USB carries no reverse forward. Stim gates a non-internal IPv4
address as this workspace's Metro, then hands it to the app: an expo-dev-client
app through the deep link (`--payload-url`), a bare app by writing
`<addr>:<port>` into a copy of the bundle's `ip.txt` and re-sealing that copy.
The cache entry is never modified. Set `ios.lanHost` when this Mac has several
interfaces and the phone shares one that is not the first.

Two things a phone needs that a simulator does not, both one-time and both taps
on the phone: trusting the developer certificate under Settings > General > VPN &
Device Management, and allowing the Local Network prompt the first time the app
looks for Metro. Neither can be pre-granted from this Mac. The trust tap has no
API at all and is always the user's; the Local Network prompt can be accepted by
a device tool once it is showing, and Stim's `unverified` remedy prints those
commands when this launch's device log carries iOS's path reason for an
ungranted app. A prior Don't Allow logs the same reason, and the remedy covers
that too. Until it is granted, `launched` comes back `unverified`. Run
`stim guide errors unverified` for the signature and the full recovery.

A `--device` run in a Release configuration builds fresh every time: a cached
Release app carries its builder's JavaScript, and Stim does not swap JavaScript
into cached iOS physical-device builds.

## `android`

```text
stim android [--slot <name>] [--variant <name>] [--system-image <id>] [--device-profile <id>]
             [--device [serial]]
             [--wait <seconds> | --no-wait] [--remote <proxy|eas>]
             [--eas-profile <name>] [--no-metro-check] [--no-build-cache] [--plan] [--json]
```

Builds or restores the Android app. Stim then boots an owned emulator, installs
the app, opens it, and checks launch logs. An emulator debug build can compile
on a paired build machine instead: see `offload.mode` in
[machine settings](./settings.md#machine-settings).

- `--build-machine <auto|local|name>` overrides `STIM_OFFLOAD_MACHINE` and
  `offload.machine`. A name requires that configured, paired worker and fails
  with `STIM_OFFLOAD_REFUSED` without local fallback. Unlisted or unpaired names refuse at setup before checking the cache, without
  a build record or failed-run stats. A listed paired name with a cache hit
  contacts no worker. Prebuild and pod install still run on this Mac before
  a named offload. A refusal starts no local xcodebuild, Gradle or SwiftPM compile.
  Run `stim doctor --fix` to ask for build access if not paired; a person on
  the worker finds the id with `stim-server devices` and approves it with
  `stim-server devices grant <id> --build`.
  See [machine settings](./settings.md#machine-settings) for supported builds and remedies.
- `--variant <name>` selects a Gradle variant. The default is `debug`.
- `--system-image <id>` creates this workspace's owned AVD from that sdkmanager
  package id, overriding `android.systemImage` for one invocation; an id this
  SDK has not installed refuses with `STIM_BAD_ARG` and prints the installed
  ids. When the workspace already owns an AVD made from another image, Stim
  refuses with the same remedy as a profile change, unless that AVD never
  finished a boot: Stim then deletes it through owned-device teardown and
  creates one from the requested image. `android.systemImage` still applies
  only to a new AVD.
- `--device-profile <id>` creates this workspace's owned AVD with that
  avdmanager hardware profile, such as `pixel_tablet` or `pixel_fold`,
  overriding `android.deviceProfile` for one invocation. An id that
  `avdmanager list device -c` does not print refuses with `STIM_BAD_ARG` and
  prints the offered ids. When the workspace already owns an AVD of another
  profile, Stim refuses instead of booting it; use another `--slot` or remove
  the workspace's devices first. `pixel_fold` and `resizable` need a system
  image with foldable support (`SupportPixelFold = on` in its
  `advancedFeatures.ini`, as recent images such as API 34 google_apis have);
  the emulator quits on boot without it. Stim refuses that pair with `STIM_BAD_ARG` before
  creating anything, and the remedy names an installed image that has it:

  ```bash
  stim android --slot fold --device-profile pixel_fold \
    --system-image "system-images;android-36;google_apis;arm64-v8a"
  ```

- `--system-image` and `--device-profile` apply only to the local owned
  emulator. With `--remote` or the `android.remote` setting they refuse with
  `STIM_BAD_ARG`: the remote backend chooses its own device. The
  `android.systemImage` and `android.deviceProfile` settings are ignored on a
  remote run.
- `--device [serial]` installs and launches on a connected physical device.
  With no serial it selects a connected device this workspace can lease. It
  cannot be combined with `--remote`.
- `--wait <seconds>` bounds the physical-device lease wait (default 60;
  `0` refuses immediately if busy). Only with `--device`.
- `--no-wait` bypasses leasing, including another workspace's lease. Installing
  the same app terminates that workspace's running app. Only with `--device`;
  cannot be combined with `--wait`.
- `--remote proxy` uses a configured Agent Device daemon.
- `--remote eas` uses an EAS remote emulator. It needs eas-cli 21.6.0 or later.
- `--eas-profile <name>` selects a compatible [EAS development build](./eas-builds.md),
  including with `--device`. It needs eas-cli 18.9.0 or later. A miss stops
  and prints an EAS build command; cloud builds require authorization. Cannot
  be combined with `--variant` or `--no-build-cache`.
- `--no-metro-check` skips the Debug dev-server check and does not start the
  dev server.
- `--no-build-cache` ignores cached artifacts and replaces the matching entry.
- `--plan` predicts the next build instead of running it. See
  [Predict the next build](#predict-the-next-build).
- `--json` prints one stable result object on stdout. It includes `buildMachine`
  (the selected `auto`, `local`, or machine name) and `builtOn` (`here` or the
  worker name, absent when no build ran, including cache hits).

A Debug variant starts the workspace's dev server when it is not running, as
described for `ios`.

A variant that ends in `Release` embeds its JavaScript bundle and skips Metro.

### Predict the next build

`stim ios --plan` and `stim android --plan` tell you whether the next run will
come from the cache and how long it should take, without building, booting a
device, installing, or starting Metro. A plan takes no workspace lock and
writes no Stim state, so it can run while another build is in progress.

```text
$ stim ios --plan
  plan        ios 1b625d.. -> local cache hit
  expect      ~2.7s (median of 1 hit run)
```

A plan computes the fingerprint and cache key the same way the run does. It
honors `--slot`, `--scheme`, `--configuration`, `--variant`, `--device-type`,
`--runtime`, `--system-image`, `--device-profile`, `--eas-profile` and
`--no-build-cache`. It then
checks the caches in the run's order: the local cache, the `cache.provider`
setting's provider, and the app config's build cache provider. Providers have no
lookup that skips the download, so a remote check downloads the artifact. The
`cache.provider` tier downloads to a temporary directory that the plan removes;
the app config's provider keeps its download wherever it does during a run. On a miss, the plan also reports the
[prebuild decision](./build-caches.md#native-artifact-cache) the run would make. With cache reads on,
it also says why the cache has no app, the way the run would
([cache misses](./build-caches.md#generated-dependency-output-and-cache-misses)):

```text
$ stim ios --plan
  plan        ios 3d4168.. -> cache miss: compiles, regenerates the native dir
  cache       miss: native dependency added: expo-clipboard (before prebuild regenerates ios/)
  expect      unknown: no cold run of this project is recorded yet
```

A plan never runs `expo prebuild`. When the run would and there is an earlier
build to compare with, the reason's `kind` is `prebuild-pending` and it compares
the fingerprint before that prebuild. With
`--eas-profile`, it asks EAS for a matching build and downloads nothing.

`--json` prints
`{ platform, slot?, fingerprint, cacheKey, cacheHit, provider, cacheSkipped, prebuild, outcome, expectedMs, basis, missReason?, refusal? }`.
`missReason` has the shape of `lastBuilds.<platform>.missReason` in
[`stim status --json`](#status).
`cacheHit` is `"local"`, `"remote"` or `false`. `expectedMs` is the median of
this project's recorded runs with that outcome, `basis` counts those runs, and
both are empty (`null` and `0`) until the project has such a run. A run that
would refuse, such as an EAS miss, carries `refusal` and still exits 0.

A plan cannot see everything that happens during a run. Another workspace may
store the key first. A `prebuild` or `pod install` may move the fingerprint,
and the run then checks the new key. A Release hit whose JavaScript swap fails
builds from scratch. An Android plan uses the ABI of the emulator the slot
records, or of the system image a new emulator would use. A plan refuses
`--device`, `--remote`, `--wait`, `--no-wait`, `--no-metro-check` and
`--simulator-app` with `STIM_BAD_ARG`. Without `--eas-profile`, it also refuses
the `ios.remote` and `android.remote` settings and the experimental compiler CAS.

Try it with an agent:

```text
Before building, run `stim ios --plan --json` in this worktree and tell me
whether the next build is a cache hit, how long it should take, and, on a
miss, which native change causes it.
```

## `macos`

```text
stim macos [--build-machine <auto|local|name>] [--remote <machine>] [--json]
```

Builds the explicitly configured Swift Package executable in Debug and launches
an isolated development `.app`. Run from the `Package.swift` directory with
`macos.product` and `macos.infoPlist` configured. It uses fixed SwiftPM commands,
with no Metro or custom build scripts. Workspace logs include compiler output
and runtime stdout/stderr. `status` reports the app and build, and `stop` signals
only their verified owners. Stim Desktop can preview one owned window and open
the verified app for native input on the same Mac using existing permissions.
`--build-machine <auto|local|name>` selects build placement as described in
[machine settings](./settings.md#machine-settings). A name refuses with
`STIM_OFFLOAD_REFUSED` without fallback; `local` compiles here.

`--remote <machine>` takes a hosting Mac name from
[`hosting.machines`](./settings.md#machine-settings) and runs the built app on
that approved Mac over the tailnet. It never falls back to a local launch, and
`stop` or `worktree remove` stop it there. macOS refuses `eas` and `proxy` because
it has neither backend, and refuses `auto` until automatic placement ships.
These reserved names are case-insensitive and trimmed; they refuse with
`STIM_BAD_ARG` before state access or a connection. See the
[native macOS prototype](./macos.md) for metadata, arguments, hosting and current
limitations.

## `web`

```text
stim web [--headed] [--json]
```

Opens the workspace's page in a Stim-owned Chrome, headless unless `--headed`,
and captures its console, uncaught errors and failed requests in `stim logs`.
It never starts a web server: start the dev server first, then run
`stim web`. Expo apps open their Metro URL and start Metro with `stim start`.
Other apps set `web.url`, for example `http://localhost:{port:web}/`, and run
their own dev server on `stim ports get web`. When nothing serves the page,
`launched` is `"unverified"` and the remedy names that step. The payload
reports `launched`, the page URL, the Chrome `pid`, the `profile` directory and
the reserved `cdpEndpoint`. A second run with the same options navigates the
same Chrome again.

`stim stop` closes the browser and keeps its profile; `stim stop --slot web`
closes only the browser. `worktree remove` and
`gc --delete` also delete the profile. See [Web in an owned Chrome](./web.md).

## `reload`

```text
stim reload [ios|android|web] [--json]
```

Requests a JavaScript reload in the live app on this workspace's owned local simulator
or emulator, or reloads its owned Chrome page. It never builds, installs, boots,
or cold-launches. Omit the platform when exactly one owned app or page is live;
name it when more than one is live. A bare reload picks the Chrome page only when
no native launch is recorded. A web reload sends `Page.reload` to the owned page
and reports `strategy: "cdp"`, with `appId` set to the URL the page was on when
Stim sent the reload.

Every native reload goes over the workspace Metro websocket, on both platforms. It never
reopens a development-client URL, because that restarts the app rather than
reloading its JavaScript.

An Android reload first checks `adb reverse` on each live owned emulator launched
against this Metro and re-applies the Metro port's reverse where it is missing.
adb ties a reverse to its transport, so an emulator whose adb connection drops
and reconnects loses it silently, and the app stops reaching Metro and Fast
Refresh. After restoring one, Stim waits up to 8 seconds, sending nothing,
until the app on every emulator it checked is connected again, then sends the
reload once (a bare React Native dev server cannot name its clients, so there
it waits a fixed 2.5 seconds); `reverseRestored` names the serials it
restored. `stim status` reports the same loss as the `android-reverse-missing`
issue, with `stim reload android` as the remedy.

How the message is addressed depends on the dev server, and `strategy` reports
which you got. Where Metro can name its clients, Stim addresses every peer
matching the platform and reports `metro-websocket`. A workspace Metro serves one
app, so those peers are that app on however many devices are attached to the
port; `targets` says how many peers the request addressed. Android peers carry the package
name and iOS peers carry only `role=ios`, which is enough to keep a reload on one
platform but not to single out one iOS app among several.

The bare React Native dev server cannot name its clients at all, because
`@react-native-community/cli-server-api` answers that request out of a `ws`
property removed in ws 3.0. There Stim broadcasts: `metro-broadcast` means every
app on that port was sent a reload request, and that Stim could not confirm the recorded app was
among them. Verify the UI, and fall back to the app's own error screen or dev
menu if nothing changed.

When Metro names its clients and none match the platform, Stim still broadcasts
before giving up, because matching is best-effort and an unmatched peer may be
the app. It reports the miss either way, so verify the UI before acting on the
remedy.

When Metro reports no peer for the app, retry once first: a client reconnects
every 2 seconds, which is also this probe's timeout, so a single miss can be a
reconnect window rather than an app that never connected. If it stays
unreachable on iOS, an error in the first bundle leaves the app without a
packager connection at all, and no retry will make it a peer. The command then
returns instructions to continue in the agent's existing automation session:
press the error screen's Reload button, or open the dev menu and press Reload
when no error screen is showing, and relaunch only when neither is reachable.
Stim does not take over that stateful session.

When Metro itself does not answer within the probe's 2 seconds, nothing is known
about the app, so the command says to retry and check the dev server rather than
sending the agent to the device.

The command refuses release builds, stopped or unowned devices, a missing or
foreign Metro server, and ambiguous selection. `--json` prints one object with
`platform`, `deviceId`, `deviceName`, `appId`, `metroPort`, and `strategy`.
Success, including exit 0 with `--json`, confirms that the request was sent.
The command does not observe completion. Verify the expected UI on the reported
device and inspect `stim logs --errors` before claiming recovery.

## `logs`

```text
stim logs [--slot <name>] [--source <metro|client|device|build|agent|maintenance|all...>]
          [--level <debug|info|warn|error|fatal>] [--since <duration>]
          [--grep <expression>] [--tail <count>] [--errors]
          [--follow] [--json]
```

Queries the workspace log timeline. No matching records is a successful empty
result.

- `--errors` selects errors and fatals from Metro, client, and build logs, plus
  confirmed native app-crash reports and the `stim web` page's failed requests
  and browser errors,
  since the last launch marker. The page's records start again at each page
  load instead, and a launch does not reset them. A completed
  bundle attempt resets only older Metro errors. Metro and client output is
  shared by every slot and names no device, so the newest launch of any slot
  resets it. `--slot <name>` includes that shared output windowed by the
  slot's own launch and the bundles of the platforms it launched, so after
  `stim android` hides an iOS JS error from the unfiltered query,
  `--slot <ios-slot>` still shows it. General device logs require
  an explicit `--source device` or `--source all`.
- `--source device` includes operating-system device logs.
- `--source maintenance` shows report-only maintenance actions and failures
  for this workspace. Add `--errors` to show only maintenance failures from it;
  failures before a later launch marker are hidden.
- `--source agent` shows what agent-device did on this workspace's owned
  simulators and emulators: taps, typing, app opens, screenshots, and failed
  commands. A plain `logs` includes it; `--errors` includes it only when
  selected with `--source agent` or `--source all`.
- `--follow` streams new matching records. It exits with status 0 on Ctrl+C,
  SIGTERM, or when its stdout closes. On Linux it also exits when the process
  that started it exits while its stdout is a pipe. It notices within a few
  seconds, even when no record arrives, except a closed stdout pipe on Linux
  whose starter is still running, which it notices at the next record.
- `--json` writes NDJSON. Zero matches writes zero bytes. With `--errors`, an
  Expo error record also carries a `context` array: the code frame and stack
  lines Expo printed after it.

## `stop`

```text
stim stop [--slot <name>] [--json]
```

Without `--slot`, stops the supervisor and all log collectors, shuts down every
owned local device, ends an owned remote session, and frees the port. Owned
local devices stay assigned for reuse. A dev server left behind by a supervisor
that died is stopped when its recorded process identity still matches. An
external server on the reserved port is left running, the port stays reserved
while that server runs from this project, and a process whose ownership cannot
be verified is not signalled.

`stop` verifies that a device actually shut down instead of trusting the
shutdown command: it waits for a simulator to report `Shutdown` and for an
emulator's process to exit. A device that does not get there is reported as
`failed`, not shut down, with a remedy naming the manual command to run and
`stim gc --delete` as the fallback; `--json` carries the same outcome in
`device.<platform>.status` plus a `remedy` field. `stop` still never deletes
the device.

With `--slot <name>`, stops only that slot's owned devices and collectors and
releases its leases. Metro, the reserved port, and sibling slots keep running.
Use `--slot default` to stop only the workspace's default device -- the one
`ios`/`android` address with no `--slot` and `status` reports with no `[slot]`
label -- while a named slot stays up. `--slot` never ends an owned remote
session, even `--slot default`; use plain `stop` for that. `--slot web` closes
only the owned Chrome from `stim web` and keeps its profile; Metro and every
device keep running, so no device slot can be named `web`. A slot the
workspace has not recorded is refused with `STIM_BAD_ARG` and the list of its
slots, and nothing is stopped. A slot whose first build is still running
counts as recorded, and that build is interrupted.

### Stopping during a build

`ios`, `android`, and `stop` take turns on the workspace's build lock. A
command that has to wait prints what it is waiting for on stderr right away and
every 30 seconds:

```text
  lock        waiting for `stim ios` (pid 41233, running for 12m04s) in this workspace to finish
```

`stop` does not wait out a build that would be left with nothing to deploy to:
a plain `stop`, `stop --slot <name>` for the slot the build targets, or for the
workspace's only device. It sends that run SIGINT after verifying its recorded
process identity and waits up to 60 seconds. The run stops xcodebuild or
Gradle, caches nothing from the interrupted build, and exits 130 with
`STIM_CANCELLED`. If the run does not exit in time, `stop` refuses with
`STIM_STOP_BLOCKED` and names the pid and lock to deal with. `stop --slot
<name>` while a build for another, still-running slot is in progress leaves
that build alone and stops the slot right away. A plain `stop` ends an EAS
session as soon as it sees a build holding the lock, so the session stops
billing even when the build cannot be interrupted.

On a physical iPhone, stopping the log collector closes the running app.
`stop` also releases this workspace's device leases. It never uninstalls the
app or shuts down the phone; hardware has no owned-device registry entry.

## `device lock` and `device unlock`

```text
stim device lock <ios|android> [id] [--slot <name>] [--for <duration>] [--wait <seconds>] [--json]
stim device unlock [ios|android] [--slot <name>] [--json]
```

Leases a connected physical device to this workspace, so another workspace's
`--device` run waits instead of installing over it. `--for` takes a whole
number of seconds or minutes from `10s` to `30m` and defaults to `5m`;
`--wait` bounds how long to wait for a device another workspace holds
(default 60 seconds, `0` refuses at once). Locking a device this workspace
already holds sets a new expiry, which can shorten it.

With no id, `lock` picks from the connected devices the resolver accepts: the
one this workspace already leases when it is connected, otherwise the first
free one in id order. The same rule serves `ios --device` and
`android --device` with no id, so two devices on one machine no longer refuse.

An id can also name this workspace's own Stim-owned simulator (its UDID) or
running emulator (its `emulator-NNNN` serial), in any slot. The lease then
tells agents and `stim status` that the device is being driven, reported as
`driven by stim device lock`. `--slot`, when given, must be the slot the device
is in. A workspace holds one lease per platform and slot, so this refuses with
`STIM_DEVICE_BUSY` while that slot already leases a phone.
With no id, `lock` still picks only physical devices.

`unlock` releases every lease this workspace holds, or only the platform
named. Adding `--slot <name>` restricts release to that slot; releasing nothing
is not an error. A `--device` run takes a lease of
its own for the length of the run, so `lock` is for holding a device across
runs, such as a device-tool session. `stim status` lists every lease on the
machine.

## `settings`

```text
stim settings [--json]
stim settings get <key> [--scope <layer>] [--json]
stim settings set <key> <value> --scope <layer> [--json]
stim settings unset <key> --scope <layer> [--json]
```

Lists every setting with its effective value and the layer it comes from, or
changes one layer. `<layer>` is `machine`, `workspace`, `repo`, or `committed`.
`workspace` is this project's entry in `~/.stim/config.json`, `repo` is this
repository's entry, and `committed` is the app's `.stim.json` (the repository
root's for `worktree.*`). A key accepts only the layers Stim reads it from;
`--scope` can be omitted when there is one. Run it from the app directory, or
from a monorepo web package that resolves to the app (see `ports`).

Strings and choices are passed as-is. Booleans, numbers, arrays, and objects
are JSON:

```bash
stim settings set ios.deviceType "iPhone 17 Pro" --scope workspace
stim settings set worktree.exclude '["node_modules","ios/Pods"]' --scope committed
stim settings set concurrency.maxBuilds 2
stim settings unset ios.deviceType --scope workspace
```

An unknown key, a layer the key is not read from, or a value of the wrong
shape refuses with `STIM_BAD_ARG`, names the expected shape, and writes
nothing. Machine-file writes take the config lock and replace the file
atomically. A committed write keeps the file's other keys and indentation.

`--json` on the list prints one object:

```json
{
  "project": "/path/to/app",
  "files": { "machine": "...", "workspace": "...", "repo": "...", "committed": "..." },
  "settings": [
    {
      "key": "ios.runtime",
      "value": "26.2",
      "origin": "repo",
      "layers": { "repo": "26.2", "committed": "26.0" }
    }
  ],
  "unknown": [{ "key": "bogus", "scope": "committed", "file": "...", "value": true }]
}
```

`origin` is the winning layer, `env` when an environment variable overrides
the file (`env` then names it), `default`, or `null` when unset. A default
that depends on the machine carries `defaultReason`: `iosSimulatorApp` and
`androidEmulatorApp` default to `stim-desktop` with `"defaultReason": "Stim
Desktop installed"` when Stim Desktop is installed. Plain `settings get`
prints the value on stdout and that reason on stderr. `unknown`
lists keys Stim does not read. `android.keystorePassword` is sensitive: it
prints as `********`, and `committed` accepts only an `env:` or `file:`
reference for it. `set` and `unset --json` print the layer written, its file,
and the setting's entry after the write.

## `status`

```text
stim status [--json] [--watch]
```

Shows every Stim environment on the machine. Last builds include `buildMachine`
(the selection) and `builtOn` (`here` or the worker name, absent when no build
ran, including cache hits and refusals after setup). Configuration refusals
create no build record or failed-run stats. Older records may lack
these additive fields. The output includes worktrees,
ports, devices, supervisors, builds, logs, capacity, and free disk space.
Each linked worktree shows its uncommitted changes, commits ahead of and
behind its upstream, and whether its branch is merged, as a
`git: 2 changed, 1 untracked, ahead 3` line. See
[Parallel environments](./worktrees.md#parallel-environments) for the JSON
fields.

Each workspace is marked with its lifecycle phase: `[warming: <step>]` while
`stim worktree warm` runs in it, `[ready]` after a warm until its first run,
or `[idle]`. A live workspace has no marker. In `--json`, each environment
carries `phase` (`warming`, `ready`, `live` or `idle`), `phaseSince` and, while
warming, `warmStep`; see
[Parallel environments](./worktrees.md#parallel-environments).

Each environment also carries `stage`, the conclusion Stim Desktop and the
phone app show beside the git chip: `{ kind, since, platform, closedApps }`.
`kind` is the first of these that applies: `building` while a build runs,
`warming` or `ready` from `phase` when nothing is live, `build-failed` when the
newest run of either platform failed, `running` when the workspace is live or
holds a remote session, else `stopped`. `since` is when that began, `platform`
names the build for `building` and `build-failed`, and `closedApps` lists, for
`running`, the `{ platform, slot }` of each device whose app is closed. A
worktree entry with git facts also carries `gitChip: { parts, ci }`: the
commits ahead and behind, the uncommitted count, the branch it is merged into
(unless its pull request is merged) or a missing upstream, in display order,
and the pull request's checks as `failing`, `pending`, `passing` or `null`.

A workspace that needs attention prints each issue under it with the command
that fixes it:

```text
  ! owned AVD stim-app is not detected by adb; run `stim android`
```

In `--json`, each environment's `issues` array holds
`{ code, severity, message, remedy, workspace, slot? }`, and `warnings` holds
the `error` and `warning` issues as text. Run `remedy` from `workspace`.
`error` is something Stim cannot verify or safely act on, `warning` something
broken now that needs someone to act, and `info` a fact the next normal Stim
command handles by itself; the phone app and Desktop hide `info`. An
`info` issue is a note that blocks nothing: when another app holds an idle
workspace's reserved port, plain `status` prints
`- port 8083 is in use by a dev server in scratchpad/web-phase2/expo-web; stim start will choose a free port`,
and `metro.heldBy` carries that process's `pid` and `cwd`. The same port
taken while the workspace's supervisor runs is a `warning`. An idle workspace's
shut-down emulator is not an issue: Stim warns that adb does not see an owned
emulator only when the workspace holds a lease on it, or launched onto it and
has not stopped it since while its dev server runs or within the last 30
minutes. `stim stop --slot <name>` counts as stopping that slot's device. A
supervisor record whose process is gone is not an issue either; the next
`stim stop` or `stim start` clears it. `stim guide facts status` lists every
issue code.

A workspace with a recorded EAS Simulator session prints a
`remote <platform>: EAS session <id> billable` line with the session's preview
URL. In `--json`, each environment's `remoteDevices` array holds
`platform`, `backend`, `sessionId`, `state`, `startedAt`, and `webPreviewUrl`.
`status` reads Stim's local records and does not query EAS; `stim stop` in that
workspace ends the session.

A physical phone or tablet the workspace leases with `ios --device`,
`android --device`, or `device lock` prints under its workspace as
`ios: Old iPhone (physical, iPhone 12 Pro) connected -- leased until 17:04:53 (9m59s left)`.
In `--json`, each environment's `physicalDevices` array holds `platform`,
`slot`, `id` (the UDID or serial), `name`, `model`, `owned` (always `false`),
`physical` (always `true`), `connection` (`connected`, `disconnected`, or
`unknown`), and `lease` with `holder`, `kind`, `grantedAt`, and `expiresAt`.
Status reads the connection from `xcrun devicectl list devices` or
`adb devices`, only when the workspace holds such a lease. A run lease ends
with its run, so to keep a phone listed after the run, hold it with
`stim device lock`. Stim Desktop and the Stim phone app show each one as a
tile with a Physical badge.

A dev server that its supervisor stopped after
[`metro.idleStopMinutes`](./dev-server-and-logs.md#idle-stop) with no use
prints as `metro: port <port> stopped (idle)`. In `--json` that environment's
`metro` carries `idleStop` with `reason`, `at`, and `idleMinutes`. Any other
known cause prints after `not running`, and `metro.lastStop` carries it; see
[why the dev server stopped](./dev-server-and-logs.md#why-the-dev-server-stopped).

Status prints the recorded managed Metro tunnel's provider and URL, with
`tailnet-only` for Tailscale. In `--json`, `metro.tunnel` carries `{ provider, url }`
when a managed tunnel is recorded on the workspace's reserved port. This reports
the record without probing reachability. See [Metro on your tailnet](./owned-devices.md#metro-on-your-tailnet).

In `--json`, `metro.bundle` reports the dev server's bundle requests, from the
metro log: `{ bundling, platform?, startedAt?, percent?, last? }`. `bundling`
is `true` while an app's request, or Stim's own prefetch before a launch, is in
flight; `percent` is present when Metro reports progress for it. `last` is the
newest finished request: `{ platform, status, durationMs, finishedAt }`.

Once `stim status --watch` has measured them, each environment carries
`disk: { worktreeBytes, nodeModulesBytes, buildBytes, measuredAt }`, and each
owned simulator and emulator carries `disk: { bytes, measuredAt }` for its data
folder. `buildBytes` is Stim's own folder for the workspace, with Xcode derived
data, Gradle outputs and logs. The watcher runs `du` off its refresh path, at
most every 5 minutes per folder while the environment is live and every hour
otherwise, and one-shot `stim status` reads its cached sizes.

An environment carries `agents` when a coding-agent session works in it:
`[{ tool, sessionId, title?, cwd, startedAt?, lastActiveAt?, pid?, openUrl?, webUrl? }]`,
with `tool` either `claude-code` or `codex`. A session works in an environment
when its working directory is the environment's path, a folder inside it, or
its git worktree root. The watcher finds running Claude Code sessions in
`~/.claude/sessions` and Codex threads updated in the last 30 minutes in
`~/.codex`, at most every 15 seconds, and one-shot `stim status` reads what it
found for 2 minutes. These are the tools' own internal files, so Stim reads them
best-effort. `start`, `ios`, `android`, `web`, `reload` and `worktree warm` also
record the `CLAUDE_CODE_SESSION_ID` or `CODEX_THREAD_ID` of the shell that ran
them, which names the session exactly. `title` is the short name the tool keeps
for the session; Stim reads no prompts or conversation. `openUrl` opens the
session in the Claude desktop app or the Codex app when that app is installed,
and is absent for a Claude Code session started in a terminal. `webUrl` is the
session's `https://claude.ai/code/` link while Claude Code Remote Control is
connected, which opens it in a browser or the Claude mobile app; Stim's phone
app opens it from the workspace page.

When the watcher stops finding a session it found on its previous look, it
records the session in each workspace it worked in, and the environment
carries it for 3 days in `endedAgents`, most recently ended first. Each entry
has the fields above except `pid`, as the watcher last found them, including
its `openUrl` and `webUrl`, plus `endedAt`, the last time the watcher found it
running. A Codex thread ends 30 minutes after its last update. A session that
runs again is listed in `agents` only. Stim Desktop and the phone app show a
workspace's running and ended sessions alike, earliest `startedAt` first,
without times.

In `--json`, `machine` lists what uses CPU and memory now: each booted
simulator and emulator with its workspace, each Metro, running build and
`stim web` Chrome, stim-server, and a shared bucket for machine-wide processes
such as CoreSimulator services, the adb server and Gradle daemons. Each owner
carries `cpuPercent`, `memoryMb`, `residentMb` and `processes`, and every
process counts in exactly one owner. `owned` marks what Stim can stop: a
workspace's owned device with `stim stop --slot <name>`, and its Metro with
`stim stop`. `memoryMb` is the physical footprint Activity Monitor shows, read
by a small helper that Stim compiles with the Xcode command line tools on
first use. Without them, and on Linux, `machine.memorySource` is `rss` and
owners' `memoryMb` falls back to resident memory, which counts pages shared
between processes once per process, so a simulator reads many times its
footprint. An environment's `memoryMb` sums its own owners' footprints, builds
included, with `memorySource: "footprint"`. Without a footprint, or when
nothing runs and `machine` is `null`, it is the fixed estimate the memory
budget uses, with `memorySource: "estimate"`. `stim guide facts status`
lists every field.

`--watch` keeps running and prints the status again each time it changes.
With `--json` it prints one complete payload per line: one immediately, then
one per change, never two identical payloads in a row. It reacts to changes in
`$STIM_HOME` state and the EAS session ledger, adb device arrivals and
departures, and simulator state, and recomputes every 30 seconds as a
fallback. A log append updates only the log error count and device activity,
no sooner than 15 seconds after the previous refresh. With `--json`, while
`machine` is not `null`, it rereads the process table every 15 seconds so
`machine` stays current. It exits with status 0
on Ctrl+C, SIGTERM, or when its stdout closes. On Linux it also exits when the
process that started it exits while its stdout is a pipe. It notices within a
few seconds, even when nothing changes, except a closed stdout pipe on Linux
whose starter is still running, which it notices at the next change.
Use it to wait for a device, a build, or a dev server instead of polling `stim status --json`.

While `stim ios` or `stim android` runs, the workspace shows the build's phase
and an estimate of the time left:

```text
  build: ios compile, 1m10s elapsed -- about 3 min left (median of 4 cold runs)
```

In `--json`, each environment carries `build`: `null`, or
`{ platform, slot, state, phase, startedAt, phaseStartedAt, outcome, outcomeKnown, cacheLookupOutcome?, expectedMs, expectedPhaseMs, basis, plannedPhases }`.
`phase` is one of `prepare`, `cache-lookup`, `wait`, `prebuild`, `pods`,
`compile`, `device`, `install` and `launch`. Creating, adopting or booting the
owned simulator or emulator before the cache lookup counts as `prepare`.
`device` starts once the app is ready and covers waiting for the device (its
boot, adoption cleanup, or a physical device's lease and connection check); a
boot that finishes during the build adds no `device` time. `state` is `running` while the run's
`native-run.lock` claim is live, `stale` when that run was killed (the next run
replaces the record), and `unknown` when the claim cannot be read. `outcome` is
`cold` after the local/provider lookups resolve a miss, and `hit` after a cached
artifact is ready to reuse, including a shared-build hit or a recheck after
prebuild or pods. A later recheck can replace the first lookup's outcome.
Before resolution it follows the project's most recent run and `outcomeKnown`
is `false`. `cacheLookupOutcome` is `hit` or `miss` after an actual lookup resolves;
it is absent before resolution and on runs that skip lookup, such as `--eas-profile`.
`expectedMs` and `expectedPhaseMs` are
medians of this project's last successful runs with that outcome, and `basis`
counts the runs behind `expectedMs`. Both are `null` until the project has such
a run. `plannedPhases` lists, in order, the phases at least half of those runs
entered, each as `{ phase, expectedMs }` with its median, so a progress bar can
be drawn before the run reaches them; it is `null` without such runs.

The run estimates twice: when it starts, and once its outcome is known. The
second estimate uses only runs that created, adopted or cold-booted their
device the way this run did, so a new worktree is not estimated from reruns
that reused a booted device. Runs recorded before Stim tagged them also count
for a run that reuses its device until three tagged ones exist. Runs that
finish while this one is running do not change its estimate.

Once the run knows why its cache lookup missed, `build` carries `missReason`,
in the shape of `lastBuilds.<platform>.missReason` below. When prebuild or
pod install will run, the miss is that of the key looked up first and
`build.missProvisional` is `true` until the run looks the key up again after
them, because they can change the fingerprint. A hit then removes `missReason` and
sets `outcome` to `hit`; a miss replaces it with the final reason. Once the native
build tool prints a line Stim reads, `build` also carries `detail` while the
run is in `compile`:
`{ step, unit, done, total, line, updatedAt }`. `step` is the tool's step:
`configure`, `compile`, `link`, `resources`, `script`, `dex`, `package` or
`sign`. For xcodebuild, `unit` is `targets`, `done` counts the targets it
finished and `total` the targets in its dependency graph. A target counts once
xcodebuild touches or signs its product, so an incremental build can end below
`total`. For Gradle,
`unit` is `tasks`, `done` counts the tasks it reported and `total` is `null`.
`line` is the latest compile, link or task line with paths shortened to file
names. These are counts, not a completion percentage: one target can take ten
minutes and a cached one no time at all.

`build.placement` says where the build runs: `"local"`, or, while it is
offloaded to a [build machine](./settings.md#machine-settings), an object with
the machine and its step there. `phase` is `sync`, `deps`, `prebuild`,
`pods`, `build` (xcodebuild or Gradle) or `fetch`; `startedAt` is when the offload
started and `phaseStartedAt` when that step did. Meanwhile `build.phase`
follows it as `prebuild`, `pods` or `compile`.

```json
"placement": {
  "host": "janics-mac-mini",
  "phase": "build",
  "startedAt": "2026-09-28T21:40:02.118Z",
  "phaseStartedAt": "2026-09-28T21:40:09.530Z"
}
```

`build.waitingOn` is present while `build.phase` is `wait`: another workspace
is already building the same artifact, and this run waits for it instead of
building. `waitingOn.path` is that workspace's root, usually the `path` of another entry
in `environments`; the build lock is machine-wide, so it can name a workspace
that is not listed. It is absent when the holder is not known.

Plain `status` adds the machine to the build line:

```text
  build: ios compile on janics-mac-mini (build, 2m10s), 3m05s elapsed
```

Each workspace also shows its last build per platform:

```text
  last build: ios local cache in 12s, android compiled in 7m02s
```

In `--json`, every environment carries `platforms: string[]`, ordered
`ios`, `android`, `macos`, `web`, with `[]` when no platform is detected.
Expo uses an explicit `platforms` list from `app.json` or a literal array in
`app.config.js/ts/cjs/mjs`; otherwise it defaults to iOS and Android, adding web
when `react-native-web` is declared or resolves. Bare apps use `.xcodeproj` or
`.xcworkspace` entries in `ios/` and Gradle project files in `android/`.
`web.url` adds web to any app, even when Expo has an explicit platform list; a
bare app has no other route to web. macOS needs `Package.swift`,
`macos.product` and `macos.infoPlist`. Detection never runs project scripts or
executes app config code.

In `--json`, an environment with a recorded run carries
`lastBuilds: { ios?, android? }`, each
`{ platform, status, cacheHit, cacheSkipped, durationMs, fingerprint, startedAt, finishedAt, errorCode?, missReason?, buildMachine?, builtOn?, offloadedTo?, offloadFallback?, diagnostics? }`.
`status` is `ok` or `failed`, and `cacheHit` is `local`, `remote`, or `false`
when the run compiled or failed before finding an app. `buildMachine` records the
selected `auto`, `local`, or machine name. `builtOn` records `here` or the worker
name when a build ran; it is absent on a cache hit or a refusal before building.
Invalid, unlisted or unpaired selections refuse at setup without a build record.
`offloadedTo` names the
build machine that compiled the app; `offloadFallback` is why a run that
considered offloading built here instead, such as
`janics-mac-mini: busy (load at or above 2/core; load 8.2/core, 2 builds)`. A failed run whose
compiler reported errors carries `diagnostics`: up to five
`{ file, line, column, message }`, with `null` for a position the compiler
did not give. Every failed run carries `cause: { key, file, line }`: its first
diagnostic with a file and a line, keyed `<file>:<line>`, else its `errorCode`
(or `failed`). Failed runs in a row with the same `key` failed the same way.

A run that did not install a cached app (it compiled, or failed before finding
one) carries `missReason`: why the cache had no app for it.

```json
{
  "kind": "changed",
  "summary": "native dependency added: expo-clipboard",
  "changes": [
    { "source": "node_modules/expo-clipboard/ios", "change": "added", "category": "native-dependency" },
    { "source": "expoAutolinkingConfig:ios", "change": "changed", "category": "autolinking" }
  ],
  "changeCount": 2,
  "baseline": { "fingerprint": "5f9c79...", "from": "workspace" },
  "rekeyedBy": []
}
```

`kind` is `changed`, `no-baseline`, `same-sources`, `cache-skipped`, or
`fingerprint-error`. `changes` lists at most 20 of the `changeCount` changed
fingerprint sources. `baseline` is the cached build Stim compared with: this
workspace's last build of the platform, or else the newest build of the same
project in another worktree. `rekeyedBy` names `prebuild` or `pod install`
when those steps moved the cache key. The build prints the same summary on
stderr as `cache miss: <summary>`. To predict the next
build instead, use [`--plan`](#predict-the-next-build).

The same environment also carries `builds: { ios?, android? }`, each
platform's last 10 runs, newest first. Each entry has the fields of
`lastBuilds` plus `{ result, slot, configuration, cacheKey, phases }`.
`result` is `succeeded`, `failed`, `cancelled` (Stim stopped the run after an
interrupt or `stim stop`), or `interrupted`: the run's process ended without
recording a result, such as after a kill or a second interrupt, so the next run in the workspace recorded it without a duration or
cache facts. `configuration` is the iOS configuration or Android variant the run built
(`Debug` or `debug` by default), and
`phases` gives the milliseconds the run spent in each build phase it entered,
such as `pods`, `compile` and `install`. Only runs that record a last build are
listed: a run that stopped before looking up a build, such as one with a bad
flag, is not.

Each booted simulator and detected emulator also shows who is using it:

```text
  ios [duo]: stim-app-duo (iPhone Duo 27.1) booted (owned) -- driven by agent-device for 12m
  android: stim-app (emulator) detected (emulator-5554) (owned) -- idle 3h
```

In `--json`, those devices carry
`activity: { state, driver?, lastActivityAt?, basis }`. `state` is `driven`
when a tool holds the device now, `active` when it had activity in the last 10
minutes, `idle` otherwise, and `unknown` when a claim or driver check could not
be read. Stim counts as drivers a live agent-device session (its recorded
processes must still be alive with their recorded start times, so a stale or
reused pid does not count), an unexpired `stim device lock`, a host process
that names the device (Argent, xcodebuild test runners, idb, Maestro, Appium,
`simctl io|spawn`), and on Android a `uiautomator`, `androidx.test` or Argent
helper process.
`lastActivityAt` is the newest of the device's app log records, the platform's
Metro bundle requests, the workspace's last Stim run, and, while agent-device
drives the device, the agent's last recorded action, rounded down to the
minute; `recent` gives the newest time of each of those kinds of evidence, so a
reader can tell agent actions and reloads from app log records. Stim reads
agent-device state without changing it. `stim guide facts status` lists every
field.

An owned booted simulator or detected emulator also reports whether the
workspace's app is running on it now:

```text
  ios: stim-app (iPhone 18 Pro 27.0) booted (owned) -- idle 3h -- com.example.app not running
```

In `--json`, those devices carry `app: { id, state }`. `id` is the bundle
identifier or package Stim checked, and `state` is `running`, `stopped` (the
app crashed, was killed, or never launched), or `unknown` when the process list
or the app's `Info.plist` could not be read. `app` is absent when the device is
not owned or Stim knows no app id for it. Each of those device records also
carries `appPresence`: `none` when the device runs, its platform's latest run
failed and `builds` carries the platform with no succeeded run, `closed` when it runs and the app is
`stopped`, else `null`. This is the app's current process state, not a record of
the last launch. Stim reads it from one host `ps` for every simulator and the
same `adb shell ps` it reads for activity, so `status --watch` notices an app
that exits within 30 seconds. Run `stim ios` or `stim android` to launch it
again.

Try it with an agent:

```text
Run `stim ios` in this worktree. While it builds, follow
`stim status --watch --json` and tell me each phase change and the time left for
this workspace.
```

## `stats`

```text
stim stats [--json]
```

Shows how many `ios` and `android` runs this project and this machine have
recorded, how many hit the build cache, the mean cold run and hit run, and an
estimate of the time the cache saved. The aggregates are kept in
`$STIM_HOME/stats.json`, and every worktree of a repository counts into the
same project bucket. The same file keeps the last 10 successful runs per
project, platform and cache outcome (and the last 10 that created, adopted or
cold-booted their device), with their phase durations, for the
estimates `stim status` shows; `stats` does not print them. Outside a project only the
machine section prints. There is no reset flag: delete that file to start over.

`--json` prints one line:

```json
{
  "version": 1,
  "project": { "key": "/path/to/app", "ios": {}, "android": null },
  "machine": { "ios": {}, "android": null },
  "offload": {
    "today": { "here": 3, "offloaded": 0, "fellBack": 0 },
    "machines": {},
    "placements": []
  }
}
```

`project` is `null` outside a project, and a platform with no run yet is
`null`. A bucket carries `runs`, `failed`, `hits`, `misses`, `coldRuns`,
`coldRunMs`, `hitRuns`, `hitRunMs`, `timeSavedMs`, `firstRunAt` and
`lastRunAt`, plus `lastColdBuildMs` and `lastPodsMs` once the project has
compiled or installed pods; those two size the progress line a long build
prints (`build       still compiling (1m00s of ~3m10s)`). The saved figure is
an estimate: each cache hit is credited this project's mean cold run at that
moment, minus its own duration, floored at zero.

While a [build machine](./settings.md#machine-settings) is paired, every run
that compiles also records its placement: where it built (`here`,
`offloaded`, or `fell-back` when it tried a machine and built here), the
reason the run printed on its `placement:` line, the build time and this
project's last cold build here to compare it with. `offload.placements` lists
the last 100 from the last 7 days, newest first. `offload.machines` gives each
build machine's offloaded builds, offloaded time, estimated time saved and
fallbacks, for today (this Mac's calendar day) and in total. The plain output
adds a `build placement` section with the same counts and the last 5
placements. `stim guide facts stats` has every field.

The top-level JSON `agentDevice` reports agent-device disk usage: `version: 1`,
`measuredAt`, total known `bytes`, `complete`, `stateDir`, `runnerBuilds`,
`workspaces`, and `hosted`. Unknown byte fields are `null`. Runner entries
include last use, agent-device and Xcode versions, and lease/lock/unreadable
in-use flags. Plain output adds an `agent-device` block when state exists.
`$STIM_HOME/agent-device-usage.json` caches the result for 10 minutes when roots
match. Only `stats` and unscoped `gc` measure it; server and phone stats read
the cache. Stim never trims or deletes the shared runner builds, sessions, logs and other state or the hosted driver dir; a workspace's own agent-device dir goes only with its workspace.

The top-level `swiftpmCache` reports the user-level SwiftPM cache with
`version: 1`, `measuredAt`, `dir`, `present`, `bytes`, and `complete`, or `null`
before a cached measurement exists. The directory is
`~/Library/Caches/org.swift.swiftpm` on macOS, or `org.swift.swiftpm` under
`XDG_CACHE_HOME` (default `~/.cache`) elsewhere. Missing directories have
`present: false`, `bytes: 0`; failed measurements have `bytes: null`,
`complete: false`. Plain output adds a **SwiftPM cache** block after agent-device
only when present. This cache is shared by every SwiftPM build on the machine;
Stim reports it and never deletes it. `$STIM_HOME/swiftpm-cache-usage.json`
caches `du -sk` measurements for 10 minutes, keyed on the resolved directory,
with a 20-second timeout. Only `stats` and unscoped `gc` measure it; server and
phone stats read the cache. `status`, `start`, `ios`, `android` and the budget
gate never measure it.

Try it with an agent:

```text
Run `stim stats --json` and tell me whether any build was offloaded to a build
machine today, and why each of the last few builds stayed on this Mac.
```

## `worktree warm`

```text
stim worktree warm [--refresh]
```

Copies missing ignored entries from the repository's source checkout into the
current linked worktree. It accepts a current subdirectory. The source checkout
must be available in the same Git repository; running warm in the source
checkout refuses.

`--refresh` updates the source checkout before the copy: it checks the upstream, fetches changes when needed,
fast-forwards whatever branch is checked out there, and installs dependencies or
Pods when the new commits moved a lockfile, when nothing is installed, or when
`ios/Pods` does not match `ios/Podfile.lock`. See
[worktree isolation](./worktrees.md#refresh-the-source-checkout-first).

The branch, tracked files, and existing destination entries stay untouched.
Existing directories, including `node_modules`, are skipped whole. Eligible
ignored `.env` and local configuration files are included. The source
checkout's nonempty `.worktreeexclude` replaces its resolved `worktree.exclude`
setting. See [worktree isolation](./worktrees.md) for exclusions.

Wait for warm to finish before any other process writes to the destination.
Concurrent writes are unsafe: files created after the initial existence check
can be overwritten or removed. This includes edits, installs, builds, Metro,
and another warm invocation.

stdout stays empty. stderr reports copied, kept, and failed entries. Failures
exit 1; inspect failed paths before retrying, since partially copied
entries remain and existing directories are skipped. Warm does not install
dependencies or build. It prints the install command when carried
`node_modules` or `Pods` do not match this worktree's lockfiles.

## `worktree remove`

```text
stim worktree remove [target] [--force]
```

Reclaims the target environment, build output, port, and owned device. It then
removes any linked worktree when safe, warmed or not, without requiring a
Stim registry entry. Git-created branches stay. An existing Stim ownership
record permits deleting a branch only when it has no unique commits. On the
source checkout it only reclaims the environment; a bare repository directory
is refused because it is not a worktree. `--force` permits removal
with uncommitted, untracked, or unpushed work or initialized submodules. A
worktree locked with `git worktree lock` is refused until you unlock it.

## `gc`

```text
stim gc [--delete] [--older-than <days>] [--cache <name|all|workspaces|recordings|parked|watchman|gradle-daemons>] [--worktrees] [--idle <duration>] [--json]
```

Reports stale workspace entries, orphaned workspace directories, clean linked
worktrees whose branch is merged or whose pull request was merged or closed,
orphaned owned devices and remote sessions,
stale locks, shared cache sizes, and the memory of the watchman daemon and the
Gradle and Kotlin compile daemons. It does not change anything without
`--delete`. See
[removing finished worktrees in bulk](./worktrees.md#remove-finished-worktrees-in-bulk)
for how gc decides that a branch is merged.

An orphaned device is one this Stim home created that no workspace references.
`gc` shows the size of an orphaned or stale owned device: for a simulator, the
data size `simctl` reports; for an AVD, the size of its directory. Other
devices whose names start with `stim-` appear under "Unrecognized stim-\*
devices" with the command that deletes them; `gc` never deletes them. See
[owned devices](./owned-devices.md).

A workspace directory is orphaned when the project root its `workspace.json`
records is gone from a mounted volume and no registry entry names it. Deleting
a worktree with `git worktree remove` or `rm -rf` leaves one behind. A
directory without a readable `workspace.json` is reported and never deleted.
Nothing deletes a workspace that is in use: a running dev server, a `stim ios`
or `stim android` run, a live build, or a held tunnel or remote lock.

`stim status` caches each folder's size and each worktree's pull request under
`$STIM_HOME/disk-usage` and `$STIM_HOME/pull-requests`. `worktree remove` drops
the entries of the worktree it removes, but not the size entries of its owned
devices' data folders. `gc` lists the entries of a folder or
worktree that is gone from a mounted volume under "Stale status cache entries",
and `--delete` removes them. An entry that records no readable path, or whose
volume is not mounted, is kept and counted under "Skipped".

`--delete` also clears the build outputs (`derived-data/`, `gradle-build/`,
`android-cas/`, `cache-provider/`, `macos/build`, staged `macos/<Product>.app`
and interrupted-build `macos/staging-*` directories) of every workspace that
is not in use. A running, building, unverified or hosted macOS app keeps its
workspace untouched. The workspace keeps its state, logs, devices, ports,
`macos/runtime.lock` and its claim set; the project's own `.build` stays. See
[workspace build outputs](./build-caches.md#workspace-build-outputs).

`gc` reports the size of each workspace's logs. The Metro, client and device
logs rotate at about 8 MiB, but a file written by a Stim version before that cap
can be hundreds of MB. `--delete` trims each of those files that is over 16 MiB
to its newest 8 MiB, whatever `--older-than` says, in every workspace that is not in use and has no device log collector recorded.
Build transcripts and other files under `logs/` are never trimmed.

The Memory section lists long-lived helpers that grow while they run: the
shared watchman daemon with its watched roots, Gradle daemons with their Gradle
version and Gradle home, and Kotlin compile daemons. Each shows its pid,
physical footprint, uptime and whether it is idle, and the section ends with
the memory that can be reclaimed. A plain `--delete` and `--cache all` never
stop them; each kind has its own `--cache` value:

- `stim gc --delete --cache watchman` removes the stale roots (a directory that
  is gone, or a linked worktree git pruned) that no subscription or trigger
  uses. It then shuts watchman down only when no other client is connected and no root has a trigger;
  otherwise it keeps the daemon and names each client, such as the Stim
  workspace whose Metro uses it. Removing roots does not shrink watchman; only a
  restart does, and the next client that needs watchman starts it again.
- `stim gc --delete --cache gradle-daemons` stops each Gradle daemon that its
  own `gradle --status` reports idle, then each Kotlin compile daemon with no
  client connection once no Gradle daemon is busy. Nothing stops while a Stim
  Android build runs. While stim-server runs, it manages the daemons of builds
  offloaded to this Mac, and gc leaves them alone.

Anything gc cannot prove idle is kept, with the reason. With `STIM_HOME` set,
gc skips these machine-global processes. `stim doctor` notes a watchman
footprint over 2 GiB.

Unscoped `gc` also reports agent-device state, including runner builds per
platform and entry, last use and versions, sessions, logs, other state,
workspace directories and stim-server hosted state. JSON `sections.agentDevice`
contains the same payload as `stats.agentDevice`; it is `null` with any
`--cache` scope, including `all`. This state never appears under `caches` and
never changes `actionable`. Stim never trims or deletes the shared runner builds, sessions, logs and other state or the hosted driver dir; a workspace's own agent-device dir goes only with its workspace.
A lease flag means a live owner or runner matched by start time. A lock flag
means a live or unknown lock owner. Unreadable lock owners and unreadable or
unknown leases conservatively mark entries in use; dead lock owners and leases do not. Clear unused state with
agent-device's own tooling or by removing the directories yourself.

Unscoped `gc` reports the shared user-level SwiftPM cache after agent-device.
JSON `sections.swiftpmCache` carries the same payload as `stats.swiftpmCache`.
Any `--cache` scope, including `all`, reports `null` without measuring it.
It never appears in `caches` or changes `actionable`; `--delete` and
`--older-than` leave it untouched. Stim never deletes this cache.

While it works, `gc` prints each slow step on stderr as it starts, such as
`daemons     watchman pid 49040: checking 12 roots`, so a long run shows what it
is waiting on. The report stays on stdout, and `--json` prints only its payload
there.

- `--older-than <days>` also selects devices and workspace build outputs of
  workspaces no Stim command has used for that many days, and unused cache
  entries. It limits the parked simulators and emulators `--delete` clears to
  those parked at least that many days.
- `--cache <name|all|workspaces|recordings|parked>` with `--delete` empties the caches whose name
  or directory carries `<name>` whole, or every cache and the workspace build
  outputs with `all`. `workspaces` clears only the workspace build outputs,
  and skips the workspace directories that plain `--delete` removes whole
  (those of dead projects and orphaned directories). A plain `gc --json` dry run
  carries `scopedEmpty` on each cache, which says whether `--delete --cache`
  without `--older-than` would empty it or leave it alone, and why.
  When several caches share a name, as the Metro transform cache of each
  project does, gc names each one `<name>: <directory>` using its directory's
  last component, so the report and `--cache` tell them apart.
  `parked` erases the parked simulators and emulators and keeps them parked;
  `all` leaves them alone. `watchman` and `gradle-daemons` act on those
  helpers alone (see above), and `--older-than` with them is refused. Other
  devices and project entries are not inspected, so a scoped run empties
  caches and reaps nothing.
- `--worktrees` also selects every clean, idle linked worktree that has a Stim
  workspace, not only the merged ones plain `gc` selects. With `--delete` gc
  runs `stim worktree remove` without `--force` on each of them. Idle means
  unused for `--older-than` days, or 7 days without that option. It cannot be
  combined with `--cache`. See
  [removing finished worktrees in bulk](./worktrees.md#remove-finished-worktrees-in-bulk).
- `--idle <duration>` shuts down owned simulators and emulators whose
  [`status` activity](#status) has been idle for at least `<duration>`, such
  as `30m`, `2h` or `1d`. It acts without `--delete`, never deletes, and
  leaves each device assigned to its workspace, like `stim stop`. It skips a
  device that is driven, whose activity is unknown, or whose workspace has a
  build in progress, and re-checks each device before shutting it down.
  Without `--idle`, `gc` lists idle devices and how long they have been idle.
  Physical and remote devices are out of scope. It cannot be combined with
  `--cache`.
- `--json` prints the report as one object on stdout and every other line on
  stderr. Agents use it to show you what `gc --delete` would remove before they
  ask to run it.

`--json` prints one line. Each key under `sections` is one section of the text
report, in the same order, and is always present. `stim gc --worktrees --json`
prints, for example:

```json
{
  "mode": "dry-run",
  "idle": null,
  "cacheScope": null,
  "olderThan": null,
  "worktreeSweep": { "olderThan": 7, "defaulted": true },
  "actionable": true,
  "failures": null,
  "results": [],
  "sections": {
    "deadProjects": [{ "path": "/path/to/removed-app" }],
    "orphanedWorkspaces": [{ "dir": "~/.stim/workspaces/old--1a2b", "projectRoot": "/path/to/old", "bytes": 52428800 }],
    "linkedWorktrees": [
      {
        "path": "/path/to/feature",
        "idleDays": 12,
        "mergedInto": null,
        "pullRequest": null,
        "pullRequestUnknown": null,
        "willRemove": true,
        "reason": null,
        "detail": "idle 12d",
        "eligibleAt": null
      },
      {
        "path": "/path/to/shipped",
        "idleDays": 0,
        "mergedInto": "origin/main",
        "pullRequest": null,
        "pullRequestUnknown": null,
        "willRemove": true,
        "reason": null,
        "detail": "merged into origin/main",
        "eligibleAt": null
      },
      {
        "path": "/path/to/just-merged",
        "idleDays": 0,
        "mergedInto": "origin/main",
        "pullRequest": null,
        "pullRequestUnknown": null,
        "willRemove": false,
        "reason": "recent-activity",
        "detail": "recent activity: merged into origin/main 12m ago; removable after 2026-09-25T15:48:00.000Z",
        "eligibleAt": "2026-09-25T15:48:00.000Z"
      },
      {
        "path": "/path/to/wip",
        "idleDays": 20,
        "mergedInto": null,
        "pullRequest": {
          "number": 123,
          "state": "merged",
          "url": "https://github.com/acme/app/pull/123",
          "containsHead": true
        },
        "pullRequestUnknown": null,
        "willRemove": false,
        "reason": "dirty",
        "detail": "dirty: 2 uncommitted or untracked files",
        "eligibleAt": null
      }
    ],
    "workspaceLogs": [
      {
        "dir": "~/.stim/workspaces/old-feature--9e8f",
        "projectRoot": "/path/to/old-feature",
        "bytes": 778043392,
        "trimBytes": 761266176,
        "willTrim": true,
        "reason": null,
        "detail": null
      }
    ],
    "workspaceBuildOutputs": [
      {
        "dir": "~/.stim/workspaces/app--3c4d",
        "projectRoot": "/path/to/app",
        "bytes": 1073741824,
        "idleDays": 0,
        "willClear": false,
        "reason": "in-use",
        "detail": "in use: its dev server supervisor (pid 4242) is running"
      }
    ],
    "caches": [],
    "agentDevice": {
      "version": 1,
      "measuredAt": "2026-10-05T17:44:35.000Z",
      "bytes": 8192,
      "complete": true,
      "stateDir": {
        "dir": "/Users/example/.agent-device",
        "present": true,
        "bytes": 8192,
        "sessions": { "dir": "/Users/example/.agent-device/sessions", "bytes": 4096, "count": 1 },
        "logs": { "dir": "/Users/example/.agent-device/logs", "bytes": 4096 },
        "other": { "bytes": 0, "largest": [] }
      },
      "runnerBuilds": {
        "dir": "/Users/example/.agent-device/apple-runner",
        "present": false,
        "bytes": 0,
        "sharedBytes": 0,
        "platforms": []
      },
      "workspaces": [],
      "hosted": null
    },
    "swiftpmCache": {
      "version": 1,
      "measuredAt": "2026-10-05T17:44:35.000Z",
      "dir": "/Users/example/Library/Caches/org.swift.swiftpm",
      "present": true,
      "bytes": 1048576,
      "complete": true
    }
  }
}
```

The example omits the empty sections. `agentDevice` and `swiftpmCache` are
`null` only with a `--cache` scope, including `all`. `memory` lists each helper process as
`{ kind, cacheKind, pid, startedAt, bytes, measure, version, gradleHome, offloadClient, state, reclaimable, reason, detail }`,
where `reclaimable` marks the ones `gc --delete --cache <cacheKind>` would
stop, and `watchmanRoots` lists each root with its `stale` reason and whether
it is `removable`. `reason` is `null` for an entry `--delete`
acts on and otherwise a stable code; `detail` is the text the report prints.
A linked worktree's `eligibleAt` is the time a `recent-activity` worktree
becomes removable, and otherwise `null`. `pullRequest` is the pull request of
the worktree's branch whose head is or contains HEAD, found with `gh`, with
`state` `"open"`, `"merged"` or `"closed"`; `pullRequestUnknown` says why `gh`
could not answer, such as `"gh is not installed"`.
`bytes` is `null` when the size is unknown. `worktreeSweep` is `null` without
`--worktrees`, which still reports merged worktrees. With `--delete`, `mode` is `"delete"`, the sections list what
the run acted on, `results` lists each outcome, and `failures` counts the entries it could not delete. A
nonzero count exits with status 1. Run `stim gc --json` again to see what is
left. `idle` is the `--idle` duration in milliseconds or `null`, and with
`--idle` `failures` also counts devices it could not shut down. A `--cache`
name that no cache carries, or `--cache` together with `--worktrees` or
`--idle`, exits with status 1 and prints
`{ "code": "STIM_BAD_ARG", "message": "...", "remedy": "..." }`.
Each `results` entry is `{ kind, status, label, id, bytes, detail }`. `status`
is `"done"`, `"kept"` or `"failed"`, and `detail` says why an entry was kept or
failed. For example, a deleted simulator reads
`{ "kind": "device", "status": "done", "label": "stim-app (iPhone 17 26.5)", "id": "9C1F...", "bytes": null, "detail": null }`.
`results` is empty on a dry run.
A dry run without `--cache` or `--idle` also carries `inventory`, which is
`null` otherwise. It lists every simulator and AVD on the machine with its
runtime or system image, last use and `owner`: `workspace` (with `project` and
`slot`), `parked`, `orphaned`, `otherStimHome` for a `stim-*` device this Stim
home did not create, or `user`. It also lists the iOS simulator runtimes and
Android system images with how many devices use each (a runtime that
`simctl runtime list` does not show has no size), and the
`xcrun simctl runtime delete` or `sdkmanager --uninstall` command that removes
it. `inventory.notices` says why a listing is missing or partial, such as an
AVD or system image folder Stim cannot read. When macOS privacy protection
blocks the read, for example for AVDs on an external disk, the notice names the
Privacy & Security setting that allows the app running Stim.
The inventory is report only: Stim never runs those commands and never
acts on a device through it.
`stim guide facts gc` lists every section, field and reason code.

Try it with an agent:

```text
Run `stim gc` and show me which owned simulators and emulators are idle and for
how long. Then run `stim gc --idle 2h` to shut down the ones idle that long.
```

```text
Run `stim gc` and show me how much memory watchman and the Gradle and Kotlin
daemons use and what is reclaimable. If watchman has no clients, run
`stim gc --delete --cache watchman`; then run
`stim gc --delete --cache gradle-daemons` to stop the idle daemons.
```

## `guide`

```text
stim guide [topic] [section]
```

Prints version-matched reference text. Topics are agent, facts, metro, ports,
logs, errors, lifecycle, cleanup, and settings. Those topics also cover caches,
remote devices, and release builds. The errors, lifecycle, facts, and cleanup
topics have sections: called bare they print a section index, and a named
section prints on its own. `stim guide errors` lists every refusal code and
`stim guide errors <CODE>` prints one.

The bare index and the agent topic open with a STATUS block when something is
due: doctor for a platform that never ran in this app, ran more than seven
days ago, or ran under another Stim version (outside a React Native or Expo app
there is no doctor line); and a newer Stim release, checked
against the npm registry at most once a day and skipped when
`STIM_NO_UPDATE_CHECK` is set. The block is omitted when nothing is due.

## Structured output and exit codes

Use plain output for an agent workflow. It streams progress and includes all
facts needed for the next step. Use `--json` when a script must parse the result.

Commands exit with code 0 on success. Build, launch, ownership, or input errors
exit with a nonzero code and print an error code, message, and remedy. An empty
`logs` result exits with code 0.

When `start`, `ios`, or `android` reclaimed disk or memory before it started,
its `--json` payload, on success or failure, carries a `reclaimed` array with
one `{ step, targets, failures, freedMb }` entry per step that acted. A machine
still below `budget.hardFloorDiskGb` after reclaiming refuses with
`STIM_LOW_DISK`, naming the largest uses of disk. Run `stim guide errors
STIM_LOW_DISK` for the remedies.
