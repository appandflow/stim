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

## Normal workflow

<StimTabs
code={`stim doctor
stim start
stim ios                 # or: stim android
stim logs --errors
stim stop`}
/>

`ios` and `android` require a running dev server for a Debug build. Release
builds embed the JavaScript bundle and skip that requirement.

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
`--eas-profile` downloads an existing EAS development build.

- `--configuration <name>` selects an Xcode configuration. The default is Debug.
- `--scheme <name>` selects an exact shared Xcode scheme when the automatic
  app selection is not the one you need. Explicit schemes have separate build
  caches and DerivedData. This is a build scheme, not the app's URL scheme.
- `--device-type <name>` creates this workspace's owned simulator as that model,
  overriding `ios.deviceType` for one invocation. A model no installed runtime
  can create refuses with `STIM_BAD_ARG` and prints the ones they do offer.
- `--runtime <version>` creates it on that iOS runtime, overriding `ios.runtime`
  the same way. It takes a version (`26.5`) or a runtime's full name
  (`iOS 26.5`), exactly.
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
- `--json` prints one stable result object on stdout.

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
the app, opens it, and checks launch logs.

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
- `--json` prints one stable result object on stdout.

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
the `android.remote` setting and the experimental compiler CAS.

Try it with an agent:

```text
Before building, run `stim ios --plan --json` in this worktree and tell me
whether the next build is a cache hit, how long it should take, and, on a
miss, which native change causes it.
```

## `reload`

```text
stim reload [ios|android] [--json]
```

Requests a JavaScript reload in the live app on this workspace's owned local simulator
or emulator. It never builds, installs, boots, or cold-launches. Omit the
platform when exactly one owned app is live; name it when both iOS and Android
are live.

Every reload goes over the workspace Metro websocket, on both platforms. It never
reopens a development-client URL, because that restarts the app rather than
reloading its JavaScript.

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
stim logs [--slot <name>] [--source <metro|client|device|build|agent|all...>]
          [--level <debug|info|warn|error|fatal>] [--since <duration>]
          [--grep <expression>] [--tail <count>] [--errors]
          [--follow] [--json]
```

Queries the workspace log timeline. No matching records is a successful empty
result.

- `--errors` selects errors and fatals from Metro, client, and build logs, plus
  confirmed native app-crash reports, since the last launch marker. A completed
  bundle attempt resets only older Metro errors. General device logs require
  an explicit `--source device` or `--source all`.
- `--source device` includes operating-system device logs.
- `--source agent` shows what agent-device did on this workspace's owned
  simulators and emulators: taps, typing, app opens, screenshots, and failed
  commands. A plain `logs` includes it; `--errors` includes it only when
  selected with `--source agent` or `--source all`.
- `--follow` streams new matching records.
- `--json` writes NDJSON. Zero matches writes zero bytes.

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
session, even `--slot default`; use plain `stop` for that.

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
`--scope` can be omitted when there is one. Run it from the app directory.

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

Shows every Stim environment on the machine. The output includes worktrees,
ports, devices, supervisors, builds, logs, capacity, and free disk space.
Each linked worktree shows its uncommitted changes, commits ahead of and
behind its upstream, and whether its branch is merged, as a
`git: 2 changed, 1 untracked, ahead 3` line. See
[Parallel environments](./worktrees.md#parallel-environments) for the JSON
fields.

A workspace that needs attention prints each issue under it with the command
that fixes it:

```text
  ! owned AVD stim-app is not detected by adb; run `stim android`
```

In `--json`, each environment's `issues` array holds
`{ code, severity, message, remedy, workspace, slot? }`, and `warnings` holds
the same issues as text. Run `remedy` from `workspace`. An idle workspace's
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

A dev server that its supervisor stopped after
[`metro.idleStopMinutes`](./dev-server-and-logs.md#idle-stop) with no use
prints as `metro: port <port> stopped (idle)`. In `--json` that environment's
`metro` carries `idleStop` with `reason`, `at`, and `idleMinutes`.

`--watch` keeps running and prints the status again each time it changes.
With `--json` it prints one complete payload per line: one immediately, then
one per change, never two identical payloads in a row. It reacts to changes in
`$STIM_HOME` state and the EAS session ledger, adb device arrivals and
departures, and simulator state, and recomputes every 30 seconds as a
fallback. It exits with status 0 on Ctrl+C, SIGTERM, or when its stdout
closes. Use it to wait for a device, a build, or a dev server instead of
polling `stim status --json`.

While `stim ios` or `stim android` runs, the workspace shows the build's phase
and an estimate of the time left:

```text
  build: ios compile, 1m10s elapsed -- about 3 min left (median of 4 cold runs)
```

In `--json`, each environment carries `build`: `null`, or
`{ platform, slot, state, phase, startedAt, phaseStartedAt, outcome, expectedMs, expectedPhaseMs, basis }`.
`phase` is one of `prepare`, `cache-lookup`, `wait`, `prebuild`, `pods`,
`compile`, `install` and `launch`. `state` is `running` while the run's
`native-run.lock` claim is live, `stale` when that run was killed (the next run
replaces the record), and `unknown` when the claim cannot be read. `outcome` is
`cold` once the run reaches prebuild, pods or compile, and `hit` once it
reaches install without them; before that it follows the project's most recent
run. `expectedMs` and `expectedPhaseMs` are medians of this project's last
successful runs with that outcome, and `basis` counts them. Both are `null`
until the project has such a run. Stim does not report a completion
percentage.

Each workspace also shows its last build per platform:

```text
  last build: ios local cache in 12s, android compiled in 7m02s
```

In `--json`, an environment with a recorded run carries
`lastBuilds: { ios?, android? }`, each
`{ platform, status, cacheHit, cacheSkipped, durationMs, fingerprint, startedAt, finishedAt, errorCode?, missReason? }`.
`status` is `ok` or `failed`, and `cacheHit` is `local`, `remote`, or `false`
when the run compiled or failed before finding an app.

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
that names the device (xcodebuild test runners, idb, Maestro, Appium,
`simctl io|spawn`), and on Android a `uiautomator` or `androidx.test` process.
`lastActivityAt` is the newest of the device's app log records, the platform's
Metro bundle requests, and the workspace's last Stim run. Stim reads
agent-device state without changing it. `stim guide facts status` lists every
field.

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
project, platform and cache outcome, with their phase durations, for the
estimates `stim status` shows; `stats` does not print them. Outside a project only the
machine section prints. There is no reset flag: delete that file to start over.

`--json` prints one line:

```json
{
  "version": 1,
  "project": { "key": "/path/to/app", "ios": {}, "android": null },
  "machine": { "ios": {}, "android": null }
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
stim gc [--delete] [--older-than <days>] [--cache <name|all|workspaces>] [--worktrees] [--idle <duration>] [--json]
```

Reports stale workspace entries, orphaned workspace directories, clean linked
worktrees whose branch is merged or whose pull request was merged or closed,
orphaned owned devices and remote sessions,
stale locks, and shared cache sizes. It does not change anything without
`--delete`. See
[removing finished worktrees in bulk](./worktrees.md#remove-finished-worktrees-in-bulk)
for how gc decides that a branch is merged.

An orphaned device is one Stim created that no workspace references. Other
devices whose names start with `stim-` appear under "Unrecognized stim-\*
devices" with the command that deletes them; `gc` never deletes them. See
[owned devices](./owned-devices.md).

A workspace directory is orphaned when the project root its `workspace.json`
records is gone from a mounted volume and no registry entry names it. Deleting
a worktree with `git worktree remove` or `rm -rf` leaves one behind. A
directory without a readable `workspace.json` is reported and never deleted.
Nothing deletes a workspace that is in use: a running dev server, a `stim ios`
or `stim android` run, a live build, or a held tunnel or remote lock.

`--delete` also clears the build outputs (`derived-data/`, `gradle-build/`,
`android-cas/` and `cache-provider/`) of every workspace that is not in use. The
workspace keeps its state, logs, devices and ports. See
[workspace build outputs](./build-caches.md#workspace-build-outputs).

- `--older-than <days>` also selects devices and workspace build outputs of
  workspaces no Stim command has used for that many days, and unused cache
  entries. It limits the parked simulators and emulators `--delete` clears to
  those parked at least that many days.
- `--cache <name|all|workspaces>` with `--delete` empties the caches whose name
  or directory carries `<name>` whole, or every cache and the workspace build
  outputs with `all`. `workspaces` clears only the workspace build outputs.
  Devices and project entries are not inspected, so a scoped run empties caches
  and reaps nothing.
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
    "caches": []
  }
}
```

The example omits the empty sections. `reason` is `null` for an entry `--delete`
acts on and otherwise a stable code; `detail` is the text the report prints.
A linked worktree's `eligibleAt` is the time a `recent-activity` worktree
becomes removable, and otherwise `null`. `pullRequest` is the pull request of
the worktree's branch whose head is or contains HEAD, found with `gh`, with
`state` `"open"`, `"merged"` or `"closed"`; `pullRequestUnknown` says why `gh`
could not answer, such as `"gh is not installed"`.
`bytes` is `null` when the size is unknown. `worktreeSweep` is `null` without
`--worktrees`, which still reports merged worktrees. With `--delete`, `mode` is `"delete"`, the sections list what
the run acted on, and `failures` counts the entries it could not delete. A
nonzero count exits with status 1. Run `stim gc --json` again to see what is
left. `idle` is the `--idle` duration in milliseconds or `null`, and with
`--idle` `failures` also counts devices it could not shut down. A `--cache`
name that no cache carries, or `--cache` together with `--worktrees` or
`--idle`, exits with status 1 and prints
`{ "code": "STIM_BAD_ARG", "message": "...", "remedy": "..." }`.
`stim guide facts gc` lists every section, field and reason code.

Try it with an agent:

```text
Run `stim gc` and show me which owned simulators and emulators are idle and for
how long. Then run `stim gc --idle 2h` to shut down the ones idle that long.
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
