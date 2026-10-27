---
title: 'Settings reference'
sidebar_position: 2
description: 'Project, repository, machine, and environment settings'
---

import StimTabs from '@site/src/components/StimTabs';
import ArchiveSettings from './_generated/settings-archive.md';
import BudgetSettings from './_generated/settings-budget.md';
import EnvSettings from './_generated/settings-env.md';
import MachineSettings from './_generated/settings-machine.md';
import MaintenanceSettings from './_generated/settings-maintenance.md';
import ProjectSettings from './_generated/settings-project.md';

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
   settings whose Layers column below includes `machine`.
5. The Stim default.

An environment variable that overrides a setting wins over every layer.

Nested objects merge by key. Arrays replace lower-precedence arrays. Unknown
keys produce a warning. Every key below takes one type: a string, an array of
strings, a number, a boolean, or an object such as `android.avdConfig`,
`cache.options`, and the nested `optimizations` settings.
`ios.remote`, `android.remote`, `macos.remote`, `metro.tunnel`,
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

These settings can be set for a project. The Layers column lists where each
one can live; `committed` means `.stim.json`. The
[build optimizations](./build-optimizations.md) page explains the
`optimizations` switches.

<ProjectSettings />

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
`ios` and `android` prefetch while the native build runs. Unset, Stim uses the
app's most recent bundle request on that platform from the workspace's metro
log (skipped when its entry file no longer exists), then Expo's manifest or the bare React Native default. Give an HTTP(S) URL or a path
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
clear where to fix it. An Android system image is the exception while
`android.installImages` is `auto`: see below.

### Installing a missing Android system image

When no installed system image matches the request, `stim android` installs one
before it creates the owned emulator: the image `--system-image` or
`android.systemImage` names, else `system-images;android-36;google_apis;<host ABI>`.
It runs the SDK's own `cmdline-tools/latest/bin/sdkmanager --install` and prints
an `image` line while it downloads (about 2 GB).

- A slot whose owned emulator already finished a boot keeps that emulator and
  installs nothing.
- It installs only images for this machine's ABI.
- It never accepts an SDK license. With unaccepted licenses it refuses and names
  the `sdkmanager --licenses` command to run.
- It needs 8 GB free on the SDK volume and the SDK command-line tools.
- One install runs per SDK root and Stim home; a second run waits for it.
- `stim doctor` notes a missing image, and `stim doctor --fix --platform android`
  installs it right away.
- `stim gc` marks the images Stim installed with `stimInstalled`, next to the
  `sdkmanager --uninstall` command that removes them.

Set `android.installImages` to `never` to refuse with the install command
instead, for example on a metered connection or a Mac short on disk. For a
hosted run the host's machine value decides:

```sh
stim settings set android.installImages never --scope machine
```

### SimSlim for every owned simulator

`ios.simslim` takes `on` or `off`, default `off`, and can be set at any layer.
Set it on the machine layer to slim every Stim-owned iOS simulator on that Mac
with SimSlim's default service categories, without adding a profile to each
app:

```sh
stim settings set ios.simslim on --scope machine
```

A project `ios.simslimProfile` still applies in place of the defaults, whatever
`ios.simslim` says. A workspace, repo, or committed `ios.simslim` of `off` opts
that app out and restores stock services on its simulator. SimSlim's defaults
disable push, StoreKit, iCloud, Safari sync, Mail, Calendar and Contacts
services among others, so move an app that needs them to a profile that keeps
those categories or to `off`. Install SimSlim once per Mac with
`brew install mobai-app/tap/simslim`; without it `doctor` reports the gap and
`stim ios` boots normally with a one-line note.

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
  "remote": { "machines": ["janics-mac-mini"], "build": "auto" },
  "caches": {
    "buildCache": "/Volumes/Cache/stim/build-cache",
    "metroCache": "/Volumes/Cache/stim/metro-cache"
  }
}
```

These settings live only in the machine file. The budget, archive and
maintenance settings are listed in their own sections below.

<MachineSettings />

`concurrency.maxDevices` limits booted or booting owned devices. At the cap,
new devices wait in FIFO order across the Stim home for 600 seconds by default.
Use `--wait <seconds>` to change the bound, or `--no-wait` / `--wait 0` to
refuse immediately. A workspace's own live device bypasses the queue. Waiting
prints holder names and elapsed time, followed by the queue position, head
workspace name and `$STIM_HOME/device-waits` path. Workspaces that share a
project name show the directory that tells them apart, as in
`mobile (qa-b-p2)`. Timeout names the same head and path. `stim stop` cancels a queued run and releases its ticket without
booting its device. Status adds `build.waitingFor`, and
stats records `capacityWaits` and positive placement `deviceSlotWaitMs`.
`0` or an unset cap means unlimited devices.

`concurrency.maxIosDevices`, `concurrency.maxAndroidDevices` and
`concurrency.maxMacosApps` cap one platform each: booted owned iOS simulators,
booted owned Android emulators and hosted macOS apps on a worker. They default
to `0`, no per-platform limit, and they only tighten. A run must fit its
platform's cap and `concurrency.maxDevices`: `maxDevices` counts simulators and
emulators together, local and hosted, and counts hosted macOS apps as a pool of
their own, so a macOS app is bounded by both `maxMacosApps` and `maxDevices`
and never adds to the simulator and emulator total. With the new settings unset,
nothing changes for an existing `maxDevices`. Local admission queues and
reclaims for a platform cap the way it does for `maxDevices`, and a run held
back only by its own platform's cap does not hold up a run on the other
platform; reclaim for a full platform cap shuts down only devices of that
platform. A stim-server worker applies all three caps when it offers and
reserves a hosted session, counting its own local simulators and emulators.
Local `stim macos` runs are not counted, so `maxMacosApps` limits hosted macOS
apps only. A refusal names the full limit with its count and cap, such as
`1 Stim iOS simulator(s) are already booted and concurrency.maxIosDevices is 1`.

```bash
stim settings set concurrency.maxIosDevices 2 --scope machine
```

With a cap set, queue reclaim uses the waiting workspace's effective setting:
`devices.reclaimIdleMinutes` defaults to 10. The queue head shuts down the
longest-idle eligible owned device in another workspace of this Stim home,
one at a time, at most once every 15 seconds, rechecking capacity before
another. `0` disables it. The same idle checks as
[supervisor idle shutdown](./owned-devices.md#idle-shutdown) protect drivers,
locks, builds, viewers and recent activity. Reclaim never deletes and excludes
the waiting workspace, physical, hosted, remote, parked and other homes'
devices. Failed locks or shutdowns are reported once per device and skipped
for the rest of the wait. The supervisor's own
idle shutdown defaults to 30 minutes. Positive `reclaimed` counts
are included in wait stats.

Any workspace of this Stim home with a device idle for
`devices.reclaimIdleMinutes` is eligible, even with no supervisor and even
when its own `devices.idleShutdownMinutes` is `0`. Stim Desktop's simulator
view and manual input in Simulator.app do not count as activity. Opt out
machine-wide with the command below; the waiter's effective setting decides.

```bash
stim settings set devices.reclaimIdleMinutes 0 --scope machine
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
`"stim-desktop"` to open no simulator window and show a launch card in Stim
Desktop. Clicking **Show** opens the workspace that owns the device. This is a
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
`"stim-desktop"` boots it with `-no-window -gpu host` and shows a launch card in
Stim Desktop. Clicking **Show** opens the emulator view. Desktop renders frames
and sends input through the emulator's gRPC endpoint. It applies only when Stim
boots the emulator: an emulator that is
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
to Android emulators. The hosting Mac also uses these bounds for hosted devices
on stop, separately from its local pool and across all clients per platform.
Hosted adoption is limited to the same client, clears app data and removes other
apps. Parked hosted devices persist across a clean server restart; the oldest
excess devices, unusable adoption candidates and a revoked client's devices are
retired. See [hosted parking](./remote-machines.md#hosted-parking-and-restart)
and [owned devices](/docs/owned-devices) for adoption cleanup.

`remote.buildPoolDisabled` and `remote.devicePoolDisabled` list members excluded
from this requester's automatic build and simulator/emulator placement. Both default
to `[]`; use `local` or exact `remote.machines` entries, including case and port.
Names are not trimmed; unmatched entries exclude nothing. The settings preserve
pairing, running work and explicit placement, and refuse disabling or removing the
last configured, approved member of either pool. A remote that Tailscale reports as
running an OS other than macOS never counts for the device pool. Excluding local
prevents local fallback. See [automatic machine pools](./remote-machines.md#automatic-machine-pools).

`remote.easMaxDurationMinutes` (default 30) is the number of minutes after which EAS
stops each EAS Simulator session Stim creates, for `--remote eas` and
`remote.easFallback`. It bounds the cost of a session that nobody ended, such as one
whose workspace was deleted by hand. `stim stop` and `stim gc --delete` still end a
session sooner, and a later run replaces an expired one. EAS rejects a value above
the account plan's session limit. A run reuses a live session without checking how
much of the cap is left.

`remote.machines` names the remote machines this machine may build on and host owned
simulator sessions on, by MagicDNS name and optional serve port (default 7443),
or, for a machine on the local network without Tailscale, as `local:` and its
private IPv4 address or host name with an optional stim-server port (default
7787); that machine lists where it listens in `server.lanAddresses`, which is
empty by default. See [Local network, without Tailscale](./remote-machines.md#local-network-without-tailscale).
Name each node and port once. Set it with
`stim settings set remote.machines '["janics-mac-mini"]'`, then run
`stim doctor --fix` in an app directory. Build and device-host approvals are
separate, and a remote machine is used only for what it approved; a listed machine that
never granted one is not used for it, and doctor reports it. Doctor makes a setup
ticket and prints the `stim-server setup` command a person runs on the remote
machine to approve this one; one ticket covers builds and hosting. Hosting approval grants no
read, control or build access. [`stim macos --remote <placement>`](./macos.md#run-it-on-another-mac)
or `macos.remote` runs a macOS app on an approved machine. [iOS placement](./owned-devices.md#run-ios-on-another-mac) uses
`stim ios|android --remote <placement>` or `ios.remote` / `android.remote` and the same approval. `auto` places on an approved Mac when this machine is full or busy; `remote` and `remote-only` try the approved Macs first. To view or control a hosted macOS app, a person on
that Mac approves Screen & System Audio Recording and Device Control and Data Access
(Accessibility on macOS 26 and earlier) for Stim Host, the app
`stim-server service install` runs the server under.

Credentials stay private in `$STIM_HOME/device-host-machines.json`. Doctor
reports approval under `deviceHosts` in JSON. The first connection after
approval pins the remote machine's stim-server key, and every later connection
must prove that key; a different key reports `key-changed` and refuses access.
Uncertain replies or unreadable credentials preserve the pin. To approve a
replaced machine, remove the name, run `stim doctor --fix` to forget it, then
re-add it and run `--fix` again. Only `--fix` makes a setup ticket, asks again
after a revoked or `lapsed` request, or forgets names removed from the setting.
A pending request reports its ticket's `expiresAt`. A concurrent approval
inspection reports `busy` instead of replacing a pending ticket.

On a remote Mac that hosts, `hosting.agentDriver` names the tool it starts so a client's
coding agent can drive the macOS apps, iOS simulators and Android emulators it hosts for that client. The default,
`none`, starts nothing. For macOS, `agent-device` starts its shared daemon only when it
can lease a single app (its `macos-app` lease backend);
otherwise agent control reports `none` with a notice, and no client is handed
the Mac's desktop. `STIM_AGENT_DEVICE_BIN` in `stim-server`'s environment names
an agent-device binary to use instead of `~/.local/bin/agent-device`. Hosted iOS uses one daemon per session, pinned to its simulator UDID by the daemon policy. Hosted Android uses one daemon per session pinned to the emulator serial. Both machines need agent-device 0.21.30 or later. `doctor` counts installed hosted iOS, Android and macOS apps with no driver. Argent and other automation tools work with the devices Stim runs on the same Mac, but are not hosted drivers: Argent changes every booted simulator on its Mac and cannot be confined to one session's device, so a remote client gets agent-device or nothing. See [hosted iOS](./owned-devices.md#run-ios-on-another-mac) and [hosted Android](./remote-machines.md).

For a setup walkthrough covering build and hosting approvals, see [Remote machines](./remote-machines.md).

For builds, the same `remote.machines` list names the machines on your tailnet
that may build for this one, optionally with the port of their
`tailscale serve` route (`janics-mac-mini:7444`; default 7443).
`stim doctor --fix` in any app directory makes a setup ticket for each named
machine and prints the `stim-server setup` command a person runs there to
approve this one. The next doctor run pins that machine's stim-server key, and
Stim connects only to a server that proves it holds that key. Doctor reports each remote machine's build pairing state under `remoteMachines`.

The order of `remote.machines` is the priority order for every workload. A
build, simulator, emulator or macOS app goes to the first listed machine that has
approval, a free slot and a 5-minute load per core under that machine's own
`server.maxLoadPerCore`; a machine at its caps, over that limit, unreachable or
without approval is skipped and the next one in order is tried. Load does not
rank the machines that qualify, so the first one fills before the next is used.
`stim status` shows this Mac's load per core against its own
`server.maxLoadPerCore`, as `capacity.load` in `--json`.
Put the fastest machine first and set the order with
`stim settings set remote.machines '["fast-mini","slow-mini"]'`;
`stim doctor` prints it as `placement order`, and its JSON gives each machine a
`priority`. Desktop's Remote Macs list shows the order and moves a machine up or down.

`remote.build` is a machine setting, defaulting to `auto`. On `ios`,
`android` and `macos`, `--remote-build <local|auto|remote|remote-only|name>` overrides
`STIM_REMOTE_BUILD`, which overrides the setting. A blank environment value
is unset, and `stim doctor` flags an invalid value in the machine config or in
`STIM_REMOTE_BUILD`. Trimmed placement words are case-insensitive; names match configured
names case-insensitively with port 7443 when omitted. Reports use the configured
entry:

- `local` keeps the build on this machine for this run.
- `auto` builds here while this machine has capacity and otherwise on the first accepting remote machine in order, within enabled pool members, with local fallback only while local is enabled.
- `remote` builds on the first remote machine in order that accepts the build, and here only when none does.
- `remote-only` is `remote` without the local build: it refuses with `STIM_OFFLOAD_REFUSED` when no remote machine accepts the build, or the build cannot leave this machine.
- A tailnet name requires a matching entry in `remote.machines`, already
  paired and approved. It ignores this machine's load and slots.

`remote.buildMode` and `STIM_REMOTE_BUILD_MODE` were removed and are no longer read.
`stim doctor` and `stim settings` report any left in a config file or the environment.
Use `remote.build` instead: `auto` stays `auto`, `force` becomes `remote` and `off`
becomes `local`. `stim settings unset remote.buildMode` removes the leftover key from
every layer that has it, and `--scope` removes it from one.

A named selection never prompts for pairing, uses another machine or falls
back locally. Missing configuration/pairing, denied or pending approval,
unreachability or a changed server key, incompatible toolchain/CPU/runtime,
low disk, busy workers, sync/build failures, artifact fetch/store failures and
a checkout changing during the build fail with `STIM_OFFLOAD_REFUSED`. The
message names the worker and the concrete reason. Run `stim doctor --fix` to
ask for build access if not paired. Check `stim settings get remote.machines`;
a person on the worker approves this machine by running the `stim-server setup`
command doctor printed. To change placement,
rerun with `--remote-build auto`, `remote` or `local`.

Device, Release/non-Debug, `--remote`, Android CAS compiler, build-cache-off
and unknown simulator runtime builds refuse a named worker on a cache miss.
Invalid values, unlisted names and unpaired names refuse at setup before the
cache is consulted, without a build record or failed-run stats. A listed paired
name with a cache hit needs no build and contacts no worker. Prebuild and pod
install still run on this machine before a named offload; for `stim ios` the worker's toolchain is checked first. `stim status` and its JSON
record `buildMachine` (the selected value) and `builtOn` (`here` or the worker
name, absent when no build ran). Ctrl-C cancels the worker build and starts no
local xcodebuild, Gradle or SwiftPM compile.

Copy this prompt to your agent:

```text
Run stim ios --remote-build janics-mac-mini. If it refuses, report the
STIM_OFFLOAD_REFUSED reason and remedy; do not retry with another placement.
```

A build that leaves this machine goes to the first machine in `remote.machines`
order that accepts it: a free slot (`concurrency.maxBuilds`), at least 10 GB free,
a matching toolchain and a load per core under its own `server.maxLoadPerCore`.
A machine that already holds the exact completed artifact goes ahead of the
order. Where `stim ios` compiles a simulator Debug build, `stim android` an
emulator debug build and `stim macos` a SwiftPM Debug build depends on the
selection:

- `auto` (default) builds here while this machine has capacity: a free
  `concurrency.maxBuilds` slot (always, with no build limit) and a load per
  core under `server.maxLoadPerCore`. Otherwise it builds on the first
  accepting remote machine in order. A remote machine too old to report its
  load is used only while every slot here is busy.
- `remote` builds on the first accepting remote machine in order, whatever the
  load here, and builds here when none accepts.
- `remote-only` does the same and refuses when none accepts.

Load per core is the 5-minute load average divided by the CPU count.
`server.maxLoadPerCore` (default 2) is also the busy threshold for automatic
iOS, Android and macOS placement. It is the load per core at which a machine
counts as saturated: each machine applies its own value, a remote machine
declines offloaded builds past it, and automatic placement skips it.

Device, Release and
`--remote eas|proxy` builds, Android builds with the Apple Clang CAS compiler cache, and
iOS/Android runs with the build cache off, always build here. Hosted iOS Debug
builds can use a separate `--remote-build`, targeting the hosting Mac's
architecture and runtime.

In `auto`, an offloaded iOS/Android build runs prebuild (and `pod install` for iOS) here, then asks
every paired machine what it can build. Stim picks one whose Stim build
compatibility version matches and, for iOS and macOS, whose CPU architecture matches the target simulator, with at least 10 GB free, that does
not decline, taking the first in `remote.machines` order. When a machine that offered fails the sync or refuses to start
the build, for example because it got busy meanwhile, Stim tries the next one
in that order:

- For iOS, its Xcode and simulator SDK must match, and it needs an iPhone
  simulator on the target runtime. A missing or different global CocoaPods keeps `auto`, `remote` and
  `remote-only` placement from choosing the machine for a project that does not pin it, unless the
  machine already holds the exact artifact. The placement line says why and
  `stim doctor` shows the install command. A named `--remote-build` still sends the build;
  a `pod install` that fails there reports "pod install failed" with the fix on that
  machine. When the project's `Gemfile.lock`, in `ios/` or the project root, pins CocoaPods, both machines run that version
  through Bundler, so the machine needs Bundler on its stim-server `PATH`
  and installs the pinned gems itself on the first build. This machine's side of
  the comparison runs `pod --version` in the directory `pod install` runs in. The comparison uses
  `.ruby-version` when installed, otherwise rvm's or rbenv's default Ruby, and only when neither exists the login shell's `GEM_HOME`, `GEM_PATH` and Ruby-related `PATH` entries (unless the caller already sets `GEM_HOME`), and the same UTF-8 locale defaults as `pod install`, which runs in the same environment, including the Bundler run.
- For macOS, its Xcode and macOS SDK must match, unless `--remote-build` and `--remote` name the same Mac, which builds and runs the app and then needs only the same Stim build compatibility version (see [macOS development](./macos.md#run-it-on-another-mac)). The worker needs network
  access to fetch SwiftPM dependencies the first time and keeps a dependency
  cache per client. The returned app is verified and launched locally. Completed
  caching requires `macos.artifactInputs` and a locally verified compile; remote
  output is not published under an unverified client key. See [macOS development](./macos.md).
- For Android, its CPU architecture may differ, so an x86_64 Linux or Windows machine
  running stim-server can build for an Apple silicon Mac. Its JDK major version must match (the vendor may differ), and
  its Android SDK must hold the NDK, build-tools and compile platform that the
  project's React Native version names in `gradle/libs.versions.toml`, or have
  its licenses accepted so Gradle downloads what is missing on the first build
  (unless the project sets `android.builder.sdkDownload=false`). Gradle
  and the Android Gradle plugin come from the synced project. It builds with
  this machine's variant, target ABI, Gradle build cache, PCH and compiler cache
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
offloaded app lands only in this machine's build cache, not in a remote cache
provider. A project whose `xcodebuild` changes its own fingerprinted inputs
builds on the machine, fails the fingerprint check there; `auto` builds here and a named selection
refuses, so
set `remote.build` to `local` for it. The `--json` payload and `lastBuilds` carry
`offloadedTo`, or `offloadFallback` with the reason it built here,
`stim status` shows the machine and its step while a build runs there, and
`stim stats` counts offloaded runs apart from cold runs and keeps where each
compiling build ran and why (see [`stats`](./commands.md#stats)). On the
remote machine, stim-server's `machine.details` reports the builds it ran for
each client machine.

On the remote machine, `server.workerRoot` (an absolute path; default
`$STIM_HOME/build-worker`) holds each client's checkouts, dependencies,
DerivedData, compilation cache, ccache and Gradle home, with a separate Stim
home per client and repository and one Gradle home per client. On a Windows
machine, the checkouts and Gradle homes themselves live in short directories
under `C:\sw` instead (see [Windows worker](./remote-machines.md#windows-worker)). Put it on a
large volume. It runs one offloaded build at a time and boots or installs
nothing. It declines a build while that volume has less than 10 GB free,
while its own Stim builds and the offloaded one fill its
`concurrency.maxBuilds`, or while its load per core is at or above its
`server.maxLoadPerCore`. While an offloaded build runs, it holds one of the
remote machine's `concurrency.maxBuilds` slots, so a local `stim ios` or
`stim android` there waits for the slot and counts the machine as busy. The
slot is freed when the build ends, is cancelled, or its process is gone. Delete
a client's directory there to reclaim its space.

For Android builds, the remote machine builds on an installed JDK of the same
major version as the client (found in the system JVM directories, Homebrew,
Android Studio and SDKMAN) even when its default JDK is another one; a machine
with none gets the install command as the fix. Start stim-server with
`JAVA_HOME` at such a JDK only to choose it for every build, and with
`ANDROID_HOME` at its Android SDK (default
`~/Library/Android/sdk`, or `~/Android/Sdk` on Linux). After an Android build, the client's Gradle daemon
stays warm for `server.gradleDaemonIdleMinutes` (default 30; `0` stops it
when each build ends), so the client's next build skips a JVM start of about
15 seconds. A new value applies from the next daemon. The daemon never holds
a build slot. While none of the client's builds runs, stim-server stops it
sooner when a build of the client is cancelled, when the client is revoked, and when
the remote machine has less than 2 GB of memory available. Deleting the
client's directory under the worker root stops it too.

To keep stim-server running on a remote machine across logins, run
`stim-server service install --serve` there. It installs a per-user LaunchAgent
that starts at login on macOS, a systemd user service on Linux (with
`sudo loginctl enable-linger $USER` so it starts at boot), or a scheduled task
on Windows that starts at logon, and restarts the server if it exits. `--serve` adds the
tailnet-only `tailscale serve` route (port 7443, or the next free one). `--path-prepend <dir>` and
`--env KEY=VALUE` pin a PATH entry or a variable, such as a private CocoaPods
install, that stim-server's toolchain discovery does not find.
The service runs under the Stim Host app, which install builds in
`~/Applications` with Xcode Command Line Tools. `stim-server service status`
reports the process, its health, the route, Stim Host's permissions and
whether its Stim build matches the `stim` on PATH. Doctor points to this
command when a named machine does not answer.

Offload needs Stim releases with the same build compatibility version on both
machines. It changes only in a release that changes what a worker builds, how it
builds, or the build messages, so two machines on different Stim builds usually
offload to each other. A stim-server too old to report its compatibility version
needs the same Stim build as this machine. To move the remote machine's
service to another build, run one of these there:

```bash
stim-server service update --release 1.14.0   # an exact release from npm
stim-server service update --from ./packed     # pnpm pack output of a checkout
stim-server service rollback                   # back to the previous server
```

`--release` installs that exact version from the public npm registry, and
the update stops unless npm verifies each package's integrity and registry
signature. `--from` installs the `.tgz` packages in the directory, checks the
registry signature of every dependency they bring from npm, and does not look up
Stim's own packages on the registry, so an unpublished version installs. Either way
the new server is installed beside the running one and must start before the
switch. The update waits up to 30 minutes for offloaded builds and hosted
sessions to finish, restarts the job, and switches back to the previous server
when the new job exits or does not answer within 90 seconds. It never changes pairings,
approvals, Stim Host, the pinned `--env` and `--path-prepend` values or the
serve route.

A client machine this machine approved for builds or device hosting can request
the same update over its tailnet connection, so the remote machine keeps up
without ssh. It can always ask for an npm release. It can send its own packed
build only while `server.acceptClientBuilds` is true on the remote machine; it
is false by default:

```bash
stim settings set server.acceptClientBuilds true   # on the remote machine
```

Replacing a loaded service waits up to 45 seconds for its existing listeners to
release the port. Uninstall does not wait for the port. If stopping the old job
or starting the new one fails, install restores the previous plist and attempts
to restart a previously loaded LaunchAgent; if it cannot, it prints the
launchctl bootout/bootstrap remedy. A running LaunchAgent does not prove server readiness: check its health in
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
`$STIM_HOME`, and the estimated memory of active environments:

<BudgetSettings />

Stim reclaims in order and stops once it is back under budget: it shuts down
idle owned devices in other workspaces, stops idle dev servers in other
workspaces, clears the build outputs of workspaces idle for 10 minutes (least
recently used first), and
trims shared cache entries unused for 14 days. The last two steps run only for
disk. Each step prints a `budget` line on stderr, and `--json` output lists them
under `reclaimed`. A cache trim that removed nothing is not repeated for 5
minutes while the same caches exist and free disk has not fallen by more than
1 GB; the skipped run prints one `budget` line saying so. `stim gc` and
automatic maintenance never skip. The current workspace, a device someone is driving or has
locked, and a workspace with a build in progress are never reclaimed. A memory
or workspace limit never refuses a command. `0` turns a check off. When
`STIM_HOME` is set, the budget is off unless its environment variable is set.
`stim doctor` reports the free disk and committed memory against the budget,
and what the next command would reclaim.

```bash
stim settings set budget.minFreeDiskGb 40
```

Without waiting for a budget, `devices.idleShutdownMinutes` shuts down a
workspace's owned simulators and emulators once they have been idle that long,
through the workspace's dev server supervisor or, with no supervisor, through
automatic maintenance every `maintenance.idleCheckMinutes` (5).
It is on by default at 30 minutes; see
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
last 15 minutes of footage per device. Recordings stay on your machine, under
`$STIM_HOME/workspaces/<id>/recordings/`, and `stim-server` serves them only to
paired devices.

Turn recording off for the whole machine, a repository, or one workspace:

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

## Hidden workspaces

Mark a workspace hidden so the Stim apps can list it under Hidden. Run this from
the workspace:

```bash
stim settings set workspace.hidden true
```

`workspace.hidden` is false by default and lives only in the workspace layer, so
it takes no `--scope`. `stim status --json` reports `hidden: true` on that
environment. The next `start`, `ios`, `android`, `web`, `macos`, `reload`, `logs`
or `worktree warm` in the workspace clears it, so a workspace in use is never
hidden. `stim settings unset workspace.hidden` shows it again, and
`worktree remove` drops it with the workspace.

## Environment variables

These variables override a setting and win over every layer:

<EnvSettings />

A boolean override such as `STIM_RECORDING` takes `true`, `false`, `1` or `0`.
`STIM_ANDROID_CAS_TOOLCHAIN` is described under
[experimental Android CAS](./build-optimizations.md#experimental-android-cas).

Stim also reads these variables, which have no setting:

| Variable                | Purpose                                                                                                                                                                          |
| ----------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `STIM_HOME`             | Runtime state root. Default: `~/.stim`                                                                                                                                           |
| `STIM_METRO_PUBLIC_URL` | Public Metro URL for remote use                                                                                                                                                  |
| `STIM_NO_UPDATE_CHECK`  | Set to disable the daily check for a newer Stim release in `stim guide`                                                                                                          |
| `STIM_RUN_ID`           | Id for this `stim` invocation (letters, digits, `.`, `_`, `-`, at most 64); stamped as `runId` on every log record it writes and sent to stim-server. Default: generated per run |
| `STIM_TRACE`            | Path of a Chrome trace file the command writes its timeline to; see [Timing traces](#timing-traces). Default: unset, nothing written                                             |

Processes a command starts, such as the Metro supervisor and the collectors, inherit its `STIM_RUN_ID`, so their records carry the id of the command that started them.

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

## Archive retention

`archive.enabled` accepts machine, workspace, repo, and committed layers.
The other archive settings are machine settings. Environment overrides win.
With `STIM_HOME`, archiving defaults off unless `STIM_ARCHIVE_ENABLED` is set.
Sizes use binary GB and MB; 0 means keep none.

<ArchiveSettings />

Retention runs on every worktree removal, archived or not, once an archive
exists. It deletes records past their age or count limit first, then expires
recordings, agent actions and logs by age from removal; trims logs by oldest
rotated generation, then build logs, then oldest other files; and removes the
largest kind of the oldest archive while total caps are exceeded. Artifact
expiry keeps records. Turning `recording.enabled` off at machine scope deletes
archived recordings on the next retention pass.

The same `archive.enabled`, `archive.maxAgeDays` and `archive.maxTotalGb` govern
the uncommitted changes gc archives before it removes a dirty finished worktree
([remove finished worktrees in bulk](./worktrees.md#remove-finished-worktrees-in-bulk)).
Those archives have their own `archive.maxTotalGb` budget, so all archives
together can take twice that, and `archive.enabled false` keeps such worktrees
instead.

<StimTabs code="stim settings set archive.enabled false --scope repo" />

See [archived workspaces](./worktrees.md#archived-workspaces) for privacy and deletion.

## Automatic maintenance

`maintenance.mode` is `on` by default: a pass removes what `stim gc --delete`
would remove under the caps and floors below and logs every action. `report`
measures, plans and logs and deletes nothing, and `off` disables passes.
`STIM_HOME` and `CI` make the mode `off` unless `STIM_MAINTENANCE` is set.
All of these settings have machine scope except `maintenance.keep`, a project
setting that pins a workspace: automatic passes never clear its build outputs,
delete its owned devices or remove its worktree. `maintenance.idleStopHours`
takes machine and project layers; see
[idle workspace stop](./dev-server-and-logs.md#idle-workspace-stop). On a hosting Mac, stim-server reads its
machine value to stop a hosted session whose client has been gone that long. GB and MB below mean GiB and MiB.

<MaintenanceSettings />

Size scans defer above `maintenance.maxLoadPerCore`; pressure checks continue.
On macOS the memory signal is the sysctl pressure level, with no signal when
sysctl fails. `os.freemem()` and `maintenance.minAvailableMemoryGb` apply only
on other platforms.
Caps act toward `maintenance.capTargetPercent` of the limit. The Swift
compilation cache can only be emptied whole, so a pass empties it only below
`budget.hardFloorDiskGb` or at disk pressure level 3, and never while an iOS
build holds its claim on it or that claim is unresolved.
`maintenance.urgentFreeDiskGb`, `maintenance.criticalFreeDiskGb` and
`maintenance.pressureProtectMinutes` set the
[disk pressure levels](./build-caches.md#disk-pressure-levels). `caches.ccacheMaxGb` is
passed to ccache, which evicts by itself. `maintenance.sweepHours` (24) sets how
often the age sweep runs. `maintenance.olderThanDays` (7; 0 turns these off) is how long
something stays unused before that sweep removes it: workspace build outputs,
shared cache entries, parked simulators and emulators, and clean, pushed linked
worktrees (only with `maintenance.removeIdleWorktrees`, off by default); `maintenance.deviceIdleDays` sets how long a workspace stays idle
before that sweep deletes its owned simulators and emulators (0 turns it off);
`maintenance.gradleVersionIdleDays` (7) sets how long a Gradle version no project pins stays unmodified before level 3 stops the idle Gradle and Kotlin daemons that keep it and deletes it (0 turns that off);
`maintenance.removeFinishedWorktrees` controls the worktree
check. Memory pressure is recorded; below disk pressure level 3 a pass stops a dev server only after `maintenance.idleStopHours` without real activity (removing a finished worktree tears down that workspace's own, as `gc --delete` does). Debug check logs are off by default.
See [automatic maintenance](./build-caches.md#automatic-maintenance) for reports.

## Debug logs

`debug.logs` is a machine setting, off by default, with the environment
override `STIM_DEBUG` (`1` or `0` for one command). While it is on, the CLI
writes debug records to `$STIM_HOME/logs/debug/cli.ndjson`: each run's start and
end, every child process with its program name, duration and exit status, and
every request to another machine with its duration and result code. stim-server
writes `server.ndjson` there and logs every request with its timings to its
service log. Records never carry arguments,
environment values, tokens or tickets, nothing is sent anywhere, and the file
rotates at about 8 MiB with one previous generation kept.

<StimTabs code="stim settings set debug.logs true --scope machine" />

Try this with your agent:

```text
Turn on debug.logs, rerun the command that stalled, then read
~/.stim/logs/debug/cli.ndjson and tell me which child process or remote request
took the time.
```

## Timing traces

`STIM_TRACE=<path>` writes a timeline of one command to `<path>` as Chrome trace
events. Open the file in [Perfetto](https://ui.perfetto.dev) or `chrome://tracing`
to see where `worktree warm`, `start`, `ios`, `android` or `stop` spent its time:
one span per child process, one per build phase (the phases `stats.json` and the
build ledger record), and spans for the fingerprint and the wait for Metro.
Unset, Stim writes nothing. There is no setting for it, and the trace goes only
to that file, never to stdout or stderr, so `--json` output is unchanged.

<StimTabs code="STIM_TRACE=/tmp/ios.json stim ios" />

The command you start truncates the file; the processes it starts, such as the
Metro supervisor, append to it, so use a new path for each command. The file is a
JSON array with one event per line and no closing bracket, which Perfetto and
`chrome://tracing` accept. Argument values of flags that look like secrets,
credentials in URLs and common token shapes are replaced with `[redacted]`, as
are the credentials of `curl -u` and `security import -P`. Other programs'
short flags such as `-p` and `-u` are kept, because they usually mean a path, a
port or a user. A trace still holds full paths and arguments, so treat it like a
log.

Try this with your agent:

```text
Run stim ios with STIM_TRACE=/tmp/ios.json, then read the file and tell me which
build phase and which child process took the most time.
```
