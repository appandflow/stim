---
title: 'Settings reference'
sidebar_position: 2
description: 'Project, repository, machine, and environment settings'
---

:::note[Command examples]

Commands use `stim`. If it is not installed globally, replace `stim` with
`npx stim`.

:::

Most projects need no settings. Use `stim guide settings` for descriptions that
match the installed version.

## Read and change settings

`stim settings` lists every setting with its effective value and the layer it
comes from. `get`, `set`, and `unset` read or change one layer. The
[command reference](./commands.md#settings) has the full syntax and JSON
output.

```bash
stim settings
stim settings set ios.deviceType "iPhone 17 Pro" --scope workspace
stim settings set optimizations.android.targetAbiOnly false --scope machine
```

A copyable prompt for an agent:

```text
Run `stim settings --json` in this app and tell me which settings are not at
their defaults and which layer sets each one. Then set this workspace's iOS
simulator to an iPhone 17 Pro with
`stim settings set ios.deviceType "iPhone 17 Pro" --scope workspace`.
```

The JSON Schema for every setting ships in the `stim` package as
`dist/settings.schema.json`. Add it to `.stim.json` for editor completion and
validation; Stim ignores the `$schema` key:

```json
{
  "$schema": "https://unpkg.com/stim/dist/settings.schema.json",
  "ios": { "deviceType": "iPhone 17 Pro" }
}
```

The schema's root describes `.stim.json`. `$defs.machine` describes the
machine settings. Each setting carries its dotted key, the layers it can be
written to, and its environment override under `x-stim`.

## Settings layers

Stim reads the first value found in this order:

1. Workspace settings in `~/.stim/config.json`, keyed by the app's absolute path
   (`--scope workspace`).
2. Repository settings in the same machine file, keyed by the git common dir
   (`--scope repo`).
3. Committed `.stim.json` beside the app's `package.json` (`--scope committed`).
4. Machine defaults in `~/.stim/config.json` (`--scope machine`), for the
   top-level `optimizations` settings, `ios.deviceType`, `ios.runtime`,
   `android.systemImage`, `android.deviceProfile` and
   `devices.idleShutdownMinutes` only.
5. The Stim default.

An environment variable that overrides a setting wins over every layer.

Nested objects merge by key. Arrays replace lower-precedence arrays. Unknown
keys produce a warning. Every key below takes one type: a string, an array of
strings, a number, a boolean, or an object such as `android.avdConfig`,
`cache.options`, and the nested `optimizations` settings.
`ios.remote`, `android.remote`, `metro.tunnel`,
`optimizations.android.compilerCache` and `optimizations.android.pch` take only
their listed choices. A value of the wrong type or outside those choices is
refused by name on every command that resolves settings, `stim ios` included,
so a wrong shape never falls back to a default silently. `stim doctor`
reports it as a finding instead of refusing. The exception is
`optimizations.android.casToolchain`: an invalid value warns and falls back to
ccache, or no compiler cache when `compilerCache` is `none`. `doctor` also
reports the invalid setting.

## Committed settings

Each monorepo app reads its own `.stim.json`; it does not inherit an ancestor's
runtime configuration. Single-app repositories still use their root file.
When upgrading, move runtime settings to each relevant app and make profile,
AVD-fragment and committed-provider paths relative to that app directory.
Explicit machine project/repository overrides keep their existing precedence.

`.stim.json` supports these keys:

| Key                           | Purpose                                                                                                    |
| ----------------------------- | ---------------------------------------------------------------------------------------------------------- |
| `ios.deviceType`              | iOS Simulator device type                                                                                  |
| `ios.runtime`                 | iOS Simulator runtime                                                                                      |
| `ios.configuration`           | Xcode configuration, such as `Debug` or `Release`                                                          |
| `ios.remote`                  | Default remote backend, `proxy` or `eas`                                                                   |
| `ios.simslimProfile`          | SimSlim profile for local iOS devices                                                                      |
| `ios.signingIdentity`         | Keychain identity used to re-seal a device build                                                           |
| `ios.signingIdentitySha1`     | SHA-1 of that identity, when two share a name                                                              |
| `ios.lanHost`                 | Address a phone uses to reach this workspace's Metro                                                       |
| `android.systemImage`         | Android SDK system image                                                                                   |
| `android.deviceProfile`       | AVD hardware profile, such as `pixel_tablet` or `pixel_fold`                                               |
| `android.dataPartitionSizeGb` | AVD data partition size                                                                                    |
| `android.avdConfigFile`       | Additional AVD config file                                                                                 |
| `android.avdConfig`           | Validated AVD config values                                                                                |
| `android.variant`             | Gradle build variant                                                                                       |
| `android.keystore`            | Release keystore path                                                                                      |
| `android.keystorePassword`    | Release keystore password source                                                                           |
| `android.remote`              | Default remote backend, `proxy` or `eas`                                                                   |
| `metro.tunnel`                | Remote tunnel mode: `auto`, `off`, `expo`, `cloudflared`, `ngrok`, or `tailscale` (explicit, tailnet-only) |
| `metro.ngrokUrl`              | Existing ngrok URL                                                                                         |
| `metro.publicUrl`             | Existing public Metro URL                                                                                  |
| `metro.port`                  | This workspace's Metro port, reserved instead of one Stim picks                                            |
| `metro.warmupUrl.ios`         | Bundle URL `stim ios` prefetches to warm Metro                                                             |
| `metro.warmupUrl.android`     | Bundle URL `stim android` prefetches to warm Metro                                                         |
| `metro.idleStopMinutes`       | Minutes of no use before the dev server stops; `0` never, default 60                                       |
| `devices.idleShutdownMinutes` | Minutes idle before an owned device shuts down; `0` never, default 0                                       |
| `web.url`                     | Page `stim web` opens; `{port:<label>}` is a named or the Metro port                                       |
| `web.ignoreCertificateErrors` | Accept self-signed dev certificates in the owned Chrome profile                                            |
| `web.viewport`                | Owned Chrome viewport: `desktop` (default) or `phone`                                                      |
| `worktree.exclude`            | Ignored paths skipped by `worktree warm`                                                                   |
| `worktree.defaultBranch`      | Branch `worktree warm --refresh` expects the source checkout on                                            |
| `cache.provider`              | Optional second-tier cache provider module                                                                 |
| `cache.options`               | Options passed to that provider                                                                            |
| `optimizations`               | [Build optimization switches and defaults](./build-optimizations.md)                                       |

`metro.port` and `STIM_METRO_PORT` pin Metro for `stim start`, `stim ios`,
`stim android` and pages using Metro in `stim web`. Changing the pin while
this workspace's dev server runs is refused until `stim stop`; an unverified
supervisor also blocks the change until you stop it with the tool that started
it. You can also unset or restore the pin.
A foreign holder is refused before anything starts or the port is reserved.
This project's own Metro already on the pin is attached to. With
`--no-metro-check`, iOS and Android use the pin, then the recorded port, then
8081, without probing, reserving or writing the registry. An invalid pin
still refuses with `STIM_BAD_ARG`. Release builds skip Metro. A `web.url`
without `{port:metro}` ignores the pin.

`worktree warm` reads repository-wide copy settings from the source checkout's
root `.stim.json`, not individual app files. Keep `worktree.exclude` and
`worktree.defaultBranch` there. `worktree.defaultBranch` is read only by
`worktree warm --refresh`, which warns when the source checkout sits on
another branch; unset, it uses the branch `origin/HEAD` names. A nonempty
`.worktreeexclude` in the source checkout replaces its resolved
`worktree.exclude` setting; an empty or absent file uses the setting.

Do not put secrets in a committed `.stim.json`. Keep secrets in ignored files
and carry those files into a worktree. `stim settings` never prints
`android.keystorePassword` and writes it to `.stim.json` only as an `env:` or
`file:` reference.

`cache.provider` names a module that Stim executes in every worktree of the
app. Review a committed value the way you review a build script, and
keep provider credentials in the environment or in machine settings.
`cache.options` merges by key from the layer that selects the provider,
higher-precedence layers that name no provider, and lower-precedence layers
that name the same provider resolved from the same directory. A machine layer can therefore override one option
of a committed provider, but options written for a different provider, or added
by a lower layer that names no provider, are ignored. Stim reads
the module for `stim ios` and `stim android`; Metro uses it only when the
project's own `metro.config.js` calls `sharedCacheStores()` from
`@stim-cli/metro`.

`metro.warmupUrl.ios` and `metro.warmupUrl.android` replace the bundle URL that
`ios` and `android` prefetch while the native build runs. Unset, Stim uses
Expo's manifest or the bare React Native default. Give an HTTP(S) URL or a path
ending in `.bundle` with the app's full query, including a matching `platform`.
Stim keeps the path and query but always requests this workspace's Metro port.
The setting only changes the prefetch, not the app. Setting
`optimizations.metroWarmup` to `false` turns the prefetch off. Run
`stim guide settings` for the full rules.

```json
{
  "metro": {
    "warmupUrl": { "ios": "/src/main.bundle?platform=ios&dev=true&lazy=true" }
  }
}
```

### Default simulator model and runtime

`ios.deviceType`, `ios.runtime`, `android.systemImage`, and
`android.deviceProfile` can all be set at the machine layer, so one machine
can default every workspace's owned simulator or emulator without touching
each project's `.stim.json`. A workspace, repo, or committed layer still wins
over the machine value, and the `--device-type`, `--runtime`,
`--system-image`, and `--device-profile` flags still win over every layer:

```sh
stim settings set ios.runtime 26.2 --scope machine
stim settings set ios.deviceType "iPhone 17 Pro" --scope machine
stim settings set android.systemImage "system-images;android-36;google_apis;arm64-v8a" --scope machine
```

A model or runtime the machine value names that no installed toolchain offers
refuses with `STIM_BAD_ARG`, the same way an unresolvable per-project or
per-invocation value does, and the message names the machine layer so it is
clear where to fix it.

### Android AVD overrides

New owned AVDs use the Pixel 6 hardware profile (1080 × 2400 pixels at 420 dpi)
unless `android.deviceProfile` names another one, spelled as
`avdmanager list device -c` prints it. Use `pixel_tablet` for a tablet or
`pixel_fold` for a foldable; avdmanager writes the foldable's hinge and posture
keys from the profile. The machine layer can set a default for every workspace:

```sh
stim settings set android.deviceProfile pixel_tablet --scope machine
```

A set profile counts as a request, so a workspace that already owns an AVD of
another profile refuses until that AVD is removed, and each run checks the id
with avdmanager. An id that avdmanager does not offer refuses with
`STIM_BAD_ARG` and lists the offered ids. A parked AVD is adopted only by a workspace that requests the same
profile. Existing AVDs keep their display settings. Parked AVDs created with the
old generic profile are not adopted by new workspaces.

`android.avdConfigFile` reads an Android `config.ini` file. `android.avdConfig`
provides the same safe keys as JSON. Stim applies these values only when it
creates a new owned AVD. It never rewrites an existing AVD or changes generated
identity and storage paths, with one exception: every AVD Stim creates gets
`hw.keyboard=yes` unless these settings set `hw.keyboard`, and a parked AVD
created before that default gets it when a workspace adopts it. A hardware
keyboard lets Stim Desktop and stim-server type through the emulator's gRPC
endpoint; the on-screen keyboard still opens.

The validated keys cover CPU count, RAM, heap size, screen density, graphics,
orientation, network conditions, and common hardware switches. On displayless Linux,
Stim also launches the emulator with `-no-window -noaudio -no-boot-anim`.
With `androidEmulatorApp` resolved to `"stim-desktop"` on macOS, Stim launches it with
`-no-window -gpu host`; see [Machine settings](#machine-settings).
Every owned emulator starts its gRPC endpoint on the console port plus 3000
with token authentication (`-grpc <port> -grpc-use-token`); Stim Desktop reads
emulator frames from it and sends input through it while **Take over** is on.
Run `stim guide settings` for the complete key and value list.

## Machine settings

`~/.stim/config.json` also supports:

```json
{
  "concurrency": { "maxBuilds": 2, "maxDevices": 3 },
  "budget": { "minFreeDiskGb": 20, "hardFloorDiskGb": 5 },
  "iosSimulatorApp": "xcode",
  "androidEmulatorApp": "emulator",
  "tempDir": "/Volumes/SSD/stim-tmp",
  "pool": { "iosParkedMax": 3, "androidParkedMax": 3 },
  "offload": { "machines": ["janics-mac-mini"], "machine": "auto", "mode": "auto" },
  "caches": {
    "buildCache": "/Volumes/Cache/stim/build-cache",
    "metroCache": "/Volumes/Cache/stim/metro-cache"
  }
}
```

`iosSimulatorApp` chooses the macOS app that displays an owned iOS simulator after
Stim boots it. It defaults to `"stim-desktop"` while Stim Desktop is installed
and to `"xcode"` otherwise. `"xcode"` opens the selected Xcode's Device Hub on
Xcode 27 or Simulator on older Xcode. On Xcode 27 (confirmed on 27A266a),
quitting Device Hub by default shuts down every booted simulator on the machine,
including ones it never opened a window for and ones other workspaces or
agents are using; never quit it to free memory or clean up. Set
`"siniulator"` to use an installed
[Siniulator](https://github.com/kmagiera/Siniulator) instead. Set
`"stim-desktop"` to open no simulator window and show the device in Stim
Desktop, which selects the workspace that owns it. This is a
machine-wide preference, not a project setting; Stim still creates, boots, and
owns the simulator. An invalid value refuses before boot. Opening the chosen
app is best effort, so install Siniulator or Stim Desktop before selecting it.

Override it for one launch with `stim ios --simulator-app siniulator`,
`stim ios --simulator-app stim-desktop`, or `stim ios --simulator-app xcode`. The flag also opens an already running owned
simulator without rebooting it and leaves the saved preference unchanged. It
only applies to local simulators.

`androidEmulatorApp` chooses how an owned Android emulator that Stim boots on
macOS is displayed. It defaults to `"stim-desktop"` while Stim Desktop is
installed and to `"emulator"` otherwise. `"emulator"` opens the emulator's own window.
`"stim-desktop"` boots it with `-no-window -gpu host` and opens it in Stim
Desktop, which renders frames and sends input through the emulator's gRPC
endpoint. It applies only when Stim boots the emulator: an emulator that is
already running keeps its current display until it next boots, and physical
devices are unaffected. It has no effect on Linux or Windows. An invalid value
refuses before boot. There is no per-run flag.

Stim finds Stim Desktop by its bundle id, `dev.stim.desktop`, in Launch
Services. A command Stim Desktop runs skips that lookup: Desktop sets
`STIM_DESKTOP_APP` to its app path for every command it starts. A value you
set always wins over that default. `stim settings` shows such a default as
`(default: Stim Desktop installed)`, and `--json` adds
`"defaultReason": "Stim Desktop installed"` to the entry.

`pool.iosParkedMax` bounds the simulators `worktree remove` parks for a later
workspace to adopt. Absent means 3; `0` turns parking and adoption off. When
`STIM_HOME` is set, parking is off unless `STIM_POOL_IOS_PARKED_MAX` is set too.
`pool.androidParkedMax` and `STIM_POOL_ANDROID_PARKED_MAX` apply the same rules
to Android emulators. See [owned devices](/docs/owned-devices) for adoption cleanup.

`hosting.machines` names Macs that may host owned simulator sessions, by
MagicDNS name and optional serve port (default 7443). Name each node and port
once. Set it with
`stim settings set hosting.machines '["janics-mac-mini"]'`, then run
`stim doctor --fix` in an app directory. A person on the hosting Mac approves
the printed id with `stim-server devices grant <id> --device-host`.
Hosting approval is separate from `offload.machines` and grants no read,
control or build access. [`stim macos --host <machine>`](./macos.md#run-it-on-another-mac)
runs a macOS app on an approved machine; `stim ios` and `stim android` do not yet
place sessions on these machines. To view or control a hosted macOS app, a person on
that Mac approves Screen & System Audio Recording and Device Control and Data Access
(Accessibility on macOS 26 and earlier) for Stim Host, the app
`stim-server service install` runs the server under.

Credentials stay private in `$STIM_HOME/device-host-machines.json`. Doctor
reports approval under `deviceHosts` in JSON and never prints the token.
Connections use the pinned node's own tailnet address and MagicDNS TLS name;
a changed node refuses access. Uncertain replies or unreadable credentials
preserve the pin. To approve a replacement node, remove the name, run
`stim doctor --fix` to forget it, then re-add it and run `--fix` again.
Only `--fix` requests access, retries a definite revoked or lapsed request,
or forgets names removed from the setting. A concurrent approval inspection
reports `busy` instead of rotating a pending token.

On a hosting Mac, `hosting.agentDriver` names the tool it starts so a client's
coding agent can drive the macOS apps it hosts for that client. The default,
`none`, starts nothing. `agent-device` starts its daemon only when that
agent-device can lease a single macOS app (its `macos-app` lease backend);
otherwise agent control reports `none` with a notice, and no client is handed
the Mac's desktop. `STIM_AGENT_DEVICE_BIN` in `stim-server`'s environment names
an agent-device binary to use instead of `~/.local/bin/agent-device`.
`stim doctor` on that Mac notes a hosted macOS app that runs while the setting
is `none`.

`offload.machines` lists the Macs on your tailnet that may build for this one,
by MagicDNS name (`janics-mac-mini`), optionally with the port of their
`tailscale serve` route (`janics-mac-mini:7444`; default 7443). Set it with
`stim settings set offload.machines '["janics-mac-mini"]'`, then run
`stim doctor --fix` in any app directory: it asks each named Mac for build access and pins that
Mac's tailnet node. Approve the request on the build machine with
`stim-server devices grant <id> --build`; doctor prints the exact command.
Stim connects to a named Mac only while it is still the pinned node, and never
sends its token to another. Doctor reports each machine's pairing state.

`offload.machine` is a machine setting, defaulting to `auto`. On `ios`,
`android` and `macos`, `--build-machine <auto|local|name>` overrides
`STIM_OFFLOAD_MACHINE`, which overrides the setting. A blank environment value
is unset. Trimmed `auto`/`local` are case-insensitive; names match configured
names case-insensitively with port 7443 when omitted. Reports use the configured
entry:

- `auto` follows `offload.mode`, with the existing local fallback on failure.
- `local` keeps the build on this Mac for this run.
- A tailnet name requires a matching entry in `offload.machines`, already
  paired and approved. It ignores `offload.mode` and this Mac's load and slots.

A named selection never prompts for pairing, uses another machine or falls
back locally. Missing configuration/pairing, denied or pending approval,
unreachability or changed pinned identity, incompatible toolchain/CPU/runtime,
low disk, busy workers, sync/build failures, artifact fetch/store failures and
a checkout changing during the build fail with `STIM_OFFLOAD_REFUSED`. The
message names the worker and the concrete reason. Run `stim doctor --fix` to
ask for build access if not paired. Check `stim settings get offload.machines`;
a person on the worker finds the id with `stim-server devices` and grants build
access with `stim-server devices grant <id> --build`. To change placement,
rerun with `--build-machine auto` or `--build-machine local`.

Device, Release/non-Debug, `--remote`, Android CAS compiler, build-cache-off
and unknown simulator runtime builds refuse a named worker on a cache miss.
Invalid values, unlisted names and unpaired names refuse at setup before the
cache is consulted, without a build record or failed-run stats. A listed paired
name with a cache hit needs no build and contacts no worker. Prebuild and pod
install still run on this Mac before a named offload. `stim status` and its JSON
record `buildMachine` (the selected value) and `builtOn` (`here` or the worker
name, absent when no build ran). Ctrl-C cancels the worker build and starts no
local xcodebuild, Gradle or SwiftPM compile.

Copy this prompt to your agent:

```text
Run stim ios --build-machine janics-mac-mini. If it refuses, report the
STIM_OFFLOAD_REFUSED reason and remedy; do not retry with another placement.
```

With `offload.machine` set to `auto`, `offload.mode` decides where `stim ios` compiles a simulator Debug build and
where `stim android` compiles an emulator debug build, and where `stim macos`
compiles a SwiftPM Debug build:

- `auto` (default) builds here while this Mac has capacity: a free
  `concurrency.maxBuilds` slot (always, with no build limit) and a load per
  core under `offload.maxLoadPerCore`. Otherwise it builds on a machine that
  accepts the build and is expected to be faster: any accepting machine while
  every slot here is busy, or a machine less loaded than this Mac while only
  the load here is high. A build machine too old to report its load is used
  only while every slot here is busy.
- `force` builds on a build machine whenever one accepts the build.
- `off` always builds here.

Load per core is the 5-minute load average divided by the CPU count.
`offload.maxLoadPerCore` (default 2) is the load per core at which a Mac
counts as saturated: this Mac stops preferring itself, and a build machine
declines offloaded builds.

`STIM_OFFLOAD_MODE` overrides it for one command in `auto`. Device, Release and
`--remote` builds, Android builds with the Apple Clang CAS compiler cache, and
iOS/Android runs with the build cache off, always build here.

In `auto`, an offloaded iOS/Android build runs prebuild (and `pod install` for iOS) here, then asks
every paired machine what it can build. Stim picks one whose Stim build and
CPU architecture match this Mac exactly, with at least 10 GB free, that does
not decline, preferring the one that already holds this repository, then the
least loaded. When a machine that offered fails the sync or refuses to start
the build, for example because it got busy meanwhile, Stim tries the next one
in that order:

- For iOS, its Xcode and simulator SDK must match, and it needs an iPhone
  simulator on the target runtime. Its CocoaPods must match too, unless the
  project's `Gemfile.lock` pins CocoaPods: both Macs then run that version
  through Bundler, so the machine needs only Bundler on its stim-server `PATH`
  and installs the pinned gems itself on the first build.
- For macOS, its Xcode and macOS SDK must match. The worker needs network
  access to fetch SwiftPM dependencies the first time and keeps a dependency
  cache per client. The returned app is verified and launched locally; macOS
  artifacts are not cached. See [macOS development](./macos.md).
- For Android, its JDK major version must match (the vendor may differ), and
  its Android SDK must hold the NDK, build-tools and compile platform that the
  project's React Native version names in `gradle/libs.versions.toml`. Gradle
  and the Android Gradle plugin come from the synced project. It builds with
  this Mac's variant, target ABI, Gradle build cache, PCH and compiler cache
  choices, so the APK matches the ABI-narrowed cache key.

Stim sends the files `git ls-files -co --exclude-standard` lists, sending only
those the machine lacks. That includes untracked files that are not ignored,
such as an unignored `.env`. The machine builds with Stim's own code, refuses
unless its fingerprint equals the one here, and sends back the `.app` or APK.
Stim checks the archive's sha256 and fingerprints the checkout again before it
stores and installs the app the usual way; an APK is still compared with the
installed one before Stim skips an install. The build output shows
`placement: <machine>` or `placement: here (<reason>)`. With `auto`, when no machine takes
the build, one line gives each machine's reason, such as
`janics-mac-mini: busy (load at or above 2/core; load 8.2/core, 2 builds) -> building here`,
and a failure after a machine took it prints
`offload failed: <reason> -> building here`; either way it compiles here.
A dropped connection is not a failure by itself: Stim pings the machine every
15 seconds, treats a minute of silence while it waits for the build as a drop,
then reconnects to the same machine for up to 3 minutes and takes the running
build back. The machine keeps a build running for 5 minutes without a
connection before it cancels it. A drop while the app is fetched still builds
here. Ctrl-C cancels the build on the machine; a run killed another way, or
interrupted while it reconnects, leaves it running until those 5 minutes pass. An
offloaded app lands only in this Mac's build cache, not in a remote cache
provider. A project whose `xcodebuild` changes its own fingerprinted inputs
builds on the machine, fails the fingerprint check there; `auto` builds here and a named selection
refuses, so
set `offload.mode` to `off` for it. The `--json` payload and `lastBuilds` carry
`offloadedTo`, or `offloadFallback` with the reason it built here,
`stim status` shows the machine and its step while a build runs there, and
`stim stats` counts offloaded runs apart from cold runs and keeps where each
compiling build ran and why (see [`stats`](./commands.md#stats)). On the
build machine, stim-server's `machine.details` reports the builds it ran for
each client Mac.

On the build machine, `offload.workerRoot` (an absolute path; default
`$STIM_HOME/build-worker`) holds each client's checkouts, dependencies,
DerivedData, compilation cache, ccache and Gradle home, with a separate Stim
home per client and repository and one Gradle home per client. Put it on a
large volume. It runs one offloaded build at a time and boots or installs
nothing. It declines a build while that volume has less than 10 GB free,
while its own Stim builds and the offloaded one fill its
`concurrency.maxBuilds`, or while its load per core is at or above its
`offload.maxLoadPerCore`. While an offloaded build runs, it holds one of the
build machine's `concurrency.maxBuilds` slots, so a local `stim ios` or
`stim android` there waits for the slot and counts the machine as busy. The
slot is freed when the build ends, is cancelled, or its process is gone. Delete
a client's directory there to reclaim its space.

For Android builds, start stim-server on the build machine with `JAVA_HOME`
pointing at a JDK of the same major version as the clients (otherwise it
uses the macOS default JDK, which `java_home` may not find, for example with
Homebrew's `openjdk@17`) and `ANDROID_HOME` at its Android SDK (default
`~/Library/Android/sdk`). After an Android build, the client's Gradle daemon
stays warm for `offload.gradleDaemonIdleMinutes` (default 30; `0` stops it
when each build ends), so the client's next build skips a JVM start of about
15 seconds. A new value applies from the next daemon. The daemon never holds
a build slot. While none of the client's builds runs, stim-server stops it
sooner when a build of the client is cancelled, when the client is revoked, and when
the build machine has less than 2 GB of memory available. Deleting the
client's directory under the worker root stops it too.

To keep stim-server running on the build machine across logins, run
`stim-server service install --serve` there. It installs a per-user LaunchAgent
that starts at login and restarts the server if it exits, and `--serve` adds the
tailnet-only `tailscale serve` route (port 7443, or the next free one). `--path-prepend <dir>` and
`--env KEY=VALUE` pin a PATH entry or a variable, such as a private CocoaPods
install, that stim-server's login-shell environment would otherwise replace.
The service runs under the Stim Host app, which install builds in
`~/Applications` with Xcode Command Line Tools. `stim-server service status`
reports the process, its health, the route, Stim Host's permissions and
whether its Stim build matches the `stim` on PATH. Doctor points to this
command when a named machine does not answer.

Offload needs the same Stim build on both Macs. To move the build machine's
service to another build, run one of these there:

```bash
stim-server service update --release 1.14.0   # an exact release from npm
stim-server service update --from ./packed     # pnpm pack output of a checkout
stim-server service rollback                   # back to the previous server
```

`--release` installs that exact version from the public npm registry, and
the update stops unless npm verifies each package's integrity and registry
signature. `--from` installs the `.tgz` packages in the directory. Either way
the new server is installed beside the running one and must start before the
switch. The update waits up to 30 minutes for offloaded builds and hosted
sessions to finish, restarts the job, and switches back to the previous server
when the new one does not answer within 90 seconds. It never changes pairings,
approvals, Stim Host, the pinned `--env` and `--path-prepend` values or the
serve route.

An installed LaunchAgent does not prove server readiness: check its health in
`stim-server service status` and the reported log when readiness is unavailable.
The server listens before it touches the Stim home. A read-only child process
reads the Stim home, server and recording directories; until it returns,
`/health` answers 503 with `startup.state` `pending`. A read that does not
return within 10 seconds, plus up to one second to stop the child, leaves the
server listening and `degraded`: `/health` and `stim-server service status` name
the reason, and no status followers, watchers, native helpers or recorder start.
The server reads again every 30 seconds and serves as soon as a read returns,
without changing ownership claims or recordings. It does not restore an
inaccessible volume or grant filesystem access; the underlying access problem
still needs to be resolved.

`gc.worktreeGraceMinutes` is how long `stim gc --delete` waits before it
removes a merged or idle linked worktree, counted from the worktree's latest
git or Stim activity, the merge of its branch, or when its pull request was
merged or closed. Absent means 120; `0` removes
a finished worktree at once. `STIM_GC_WORKTREE_GRACE_MINUTES` overrides it. See
[removing finished worktrees in bulk](./worktrees.md#remove-finished-worktrees-in-bulk).

`budget` keeps parallel agents from filling the disk or memory. It is on by
default. Before `stim start`, `stim ios`, or `stim android` builds or boots
anything, Stim checks free disk on the volumes that hold the app and
`$STIM_HOME`, and the estimated memory of live environments:

| Key                           | Default                | Effect                                                                                   |
| ----------------------------- | ---------------------- | ---------------------------------------------------------------------------------------- |
| `budget.minFreeDiskGb`        | 20                     | Below this much free disk, Stim reclaims before it starts.                               |
| `budget.hardFloorDiskGb`      | 5                      | Still below this after reclaiming, the command refuses with `STIM_LOW_DISK`.             |
| `budget.maxCommittedMemoryGb` | 60% of physical memory | Above this estimate, Stim shuts down idle devices and stops idle dev servers first.      |
| `budget.maxLiveWorkspaces`    | unset                  | Above this many workspaces with a booted device or running dev server, the same applies. |

Stim reclaims in order and stops once it is back under budget: it shuts down
idle owned devices in other workspaces, stops idle dev servers in other
workspaces, clears the build outputs of workspaces idle for 10 minutes (least
recently used first), and
trims shared cache entries unused for 14 days. The last two steps run only for
disk. Each step prints a `budget` line on stderr, and `--json` output lists them
under `reclaimed`. The current workspace, a device someone is driving or has
locked, and a workspace with a build in progress are never reclaimed. A memory
or workspace limit never refuses a command. `0` turns a check off. When
`STIM_HOME` is set, the budget is off unless its environment variable is set.
`stim doctor` reports the free disk and committed memory against the budget,
and what the next command would reclaim.

```bash
stim settings set budget.minFreeDiskGb 40
```

Without waiting for a budget, `devices.idleShutdownMinutes` shuts down a
workspace's owned simulators and emulators once they have been idle that long.
It is off by default; see
[idle shutdown](./owned-devices.md#idle-shutdown).

Try it with an agent:

```text
Run `stim doctor` and tell me how much free disk and committed memory this
machine has against its Stim budget, and what the next `stim ios` would
reclaim first.
```

`caches.buildCache` and `caches.metroCache` move the shared build cache and the
Metro transform cache to other absolute paths. `caches` is a machine-file key
only: a `caches` key in `.stim.json` is not read and produces the unknown-key
warning.

`tempDir` moves the large temporary copies Stim makes for iOS app preparation,
release JavaScript and APK swaps, and the `doctor` fingerprint checkout. Unset,
Stim picks a writable directory on the same volume as the files it copies. The
value must be an absolute directory outside Git working trees; a missing
directory is created. `STIM_TMPDIR` overrides it. `stim doctor` reports
cross-volume copy costs and invalid values.

Use a top-level [`optimizations` object](./build-optimizations.md) in this file to
control build optimizations on this machine without changing project files.

## Device recordings

`stim-server` records the screens of owned simulators, emulators and the
Stim-owned Chrome page, so the phone app can scrub back through what an agent
did while you were not watching. It records a device only while an agent or
automation tool drives it, or while the phone app watches it. It keeps the
last 15 minutes of footage per device. Recordings stay on your Mac, under
`$STIM_HOME/workspaces/<id>/recordings/`, and `stim-server` serves them only to
paired devices.

Turn recording off for the whole Mac, a repository, or one workspace:

```bash
stim settings set recording.enabled false --scope machine
```

`recording.enabled` is true by default. The workspace layer wins over the repo
layer, which wins over the machine layer. `STIM_RECORDING=0` overrides every
layer; `stim-server` reads it when it starts. Turning recording off deletes the
existing recordings of every workspace it turns off, and `stim-server` stops
recording them within seconds. See
[Inspect and clean caches](./build-caches.md#device-recordings) for how
recordings are otherwise cleaned up.

## Environment variables

| Variable                              | Purpose                                                                                                     |
| ------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `STIM_HOME`                           | Runtime state root. Default: `~/.stim`                                                                      |
| `STIM_BUILD_CACHE`                    | Native artifact cache root                                                                                  |
| `STIM_METRO_CACHE`                    | Metro transform cache root                                                                                  |
| `STIM_TMPDIR`                         | Directory for large temporary copies; overrides the machine `tempDir`                                       |
| `STIM_MAX_BUILDS`                     | Maximum concurrent native builds                                                                            |
| `STIM_MAX_DEVICES`                    | Maximum booted owned devices                                                                                |
| `STIM_BUDGET_MIN_FREE_DISK_GB`        | Free disk, in GB, below which `start`, `ios`, and `android` reclaim first; overrides `budget.minFreeDiskGb` |
| `STIM_BUDGET_HARD_FLOOR_DISK_GB`      | Free disk, in GB, below which they refuse with `STIM_LOW_DISK`; overrides `budget.hardFloorDiskGb`          |
| `STIM_BUDGET_MAX_COMMITTED_MEMORY_GB` | Estimated memory of live environments, in GB, before idle ones are reclaimed                                |
| `STIM_BUDGET_MAX_LIVE_WORKSPACES`     | Live workspaces before idle ones are reclaimed                                                              |
| `STIM_POOL_ANDROID_PARKED_MAX`        | Maximum parked Android emulators; 0 disables parking and adoption                                           |
| `STIM_POOL_IOS_PARKED_MAX`            | Maximum parked simulators                                                                                   |
| `STIM_GC_WORKTREE_GRACE_MINUTES`      | Minutes `gc --delete` waits after a worktree's last activity or merge; overrides `gc.worktreeGraceMinutes`  |
| `STIM_METRO_PUBLIC_URL`               | Public Metro URL for remote use                                                                             |
| `STIM_METRO_PORT`                     | This workspace's Metro port, reserved instead of one Stim picks; overrides `metro.port`                     |
| `STIM_ANDROID_CAS_TOOLCHAIN`          | Absolute path to the [Android CAS toolchain manifest](./build-optimizations.md#experimental-android-cas)    |
| `STIM_NO_UPDATE_CHECK`                | Set to disable the daily check for a newer Stim release in `stim guide`                                     |
| `STIM_RECORDING`                      | `0` or `false` stops `stim-server` recording device screens; overrides `recording.enabled`                  |

`STIM_HOME`, `STIM_BUILD_CACHE`, and `STIM_METRO_CACHE` must be absolute paths.
A relative value would resolve against each process's working directory, so
the CLI, Metro, and the Expo build-cache provider would use different stores.
Every `stim` command refuses a relative value with `STIM_RELATIVE_PATH`. Metro
and the Expo build-cache provider cannot refuse without breaking the bundler,
so they print a warning and ignore the value, falling back to the config file
or the default.

Proxy remote devices also use `AGENT_DEVICE_DAEMON_BASE_URL` and
`AGENT_DEVICE_DAEMON_AUTH_TOKEN`. Those variables belong to the optional proxy
service, not to Stim.
