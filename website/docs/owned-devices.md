---
title: 'Devices and cleanup'
sidebar_position: 3
description: 'Owned devices, physical-device leases, and cleanup'
---

import StimTabs from '@site/src/components/StimTabs';
import PromptBox from '@site/src/components/PromptBox';

Commands use `stim`. If it is not installed globally, replace `stim` with
`npx stim-cli`.

Stim creates and records its local simulators and emulators. Their names start
with `stim-`. It never creates, boots, or deletes a simulator or emulator that
another tool made.

`stim android --device [serial]` and `stim ios --device [udid]` install, launch,
and read available logs on connected physical devices. Stim leases the device
for the run, then releases the lease. Use `stim device lock` to hold it across
runs. Hardware never enters the owned-device registry and is never booted,
shut down, or deleted by Stim.

Each workspace keeps its owned-device assignments for later runs.

## Multiple devices with slots

Use `--slot <name>` to keep multiple targets in one workspace: phone and tablet
simulators, several devices of the same model, Android emulators, and connected
hardware. There is no fixed number of slots; available host resources and any
configured device caps still apply. Omitting the flag uses `default`, including
assignments created before slots were supported.

<PromptBox title="Test a change on multiple devices">
{`Use Stim to test this change on an iPhone simulator, an iPad simulator, and my connected iPhone in this workspace. Use slots named phone, tablet, and hardware. Reuse those slots on later runs. Check the UI and errors on each target, report what you verified, and leave the devices running for me.`}
</PromptBox>

The agent should select installed simulator models and identify the connected
phone before running. A physical iPhone needs a signed development build that
covers its UDID. If several phones are connected, name the one you want.

### Run and reuse targets

For example, with the named iPad model installed:

<StimTabs
code={`stim start
stim ios --slot phone
stim ios --slot tablet --device-type "iPad Pro 13-inch (M5)"
stim ios --slot hardware --device
stim status`}
/>

Repeat the same slot and device selectors to reuse an assignment. Choose an
installed model reported by `xcrun simctl list devicetypes`;
replace the iPad model above when needed. Use `--device <udid>` when selecting
among connected iPhones. Android supports the same pattern with
`stim android --slot phone` or `stim android --slot hardware --device <serial>`.
Slot names are case-sensitive, 1–64 letters, digits, underscores or hyphens,
and must begin with a letter or digit; prototype-related reserved names are
rejected. A name is scoped to its platform within the workspace.

Slots share one Metro server and compatible native build caches. Native runs
serialize changes to shared build output; the devices can remain running
together afterward. A shared Metro request cannot prove which slot fetched a
bundle, so Debug launches may report `unverified`. Inspect the intended device
and its logs before claiming success. `reload` remains platform-wide, and named
slots are not supported for remote sessions. Local runs using an
[EAS development build](./eas-builds.md) can use slots.

### Inspect and stop one slot

<StimTabs
code={`stim logs --slot tablet --errors
stim logs --source metro --errors
stim stop --slot tablet`}
/>

The slot filter selects that target's attributed records. Shared Metro logs
need a workspace-wide query. `status` lists the named assignments and leases.
`stop --slot tablet` stops that slot's owned devices and collectors and releases
its leases, while keeping Metro and sibling slots running. The assignment stays
available for another run. Plain `stim stop` handles every slot in the workspace.

Physical-device leases are separate per slot, but two slots cannot hold the
same physical device at once. `device lock --slot hardware` can retain a lease
across runs; use the platform and device selector shown in the
[command reference](./commands.md#device-lock-and-device-unlock).

All slots participate in workspace removal and garbage collection. Parked
models share each platform's pool limit: an infrequently reused iPad can be
evicted as the oldest parked simulator when that pool fills. Upgrades preserve
existing ownership state; do not erase it. Use a slot-aware CLI consistently
while named assignments exist, because older versions cannot manage them.

## Local devices

`stim ios` selects the newest suitable iPhone model and installed runtime by
default. `stim android` selects the newest installed system image matching the
host architecture: `arm64-v8a` on ARM64 or `x86_64` on x64. Set `.stim.json`
defaults or use `ios --device-type`, `ios --runtime`, and
`android --system-image` for a specific target.

`stim stop` shuts down an owned local device but does not delete it. The command
assumes that the caller finished all device automation for that Stim session.
It does not block on other processes attached to the owned device.

## Memory pressure and SimSlim

SimSlim is recommended as an optional way to reduce background services and
memory use when running several iOS workspaces. Review the profile against
your app's needs: disabled services can affect tests. Current SimSlim 0.8
requires iOS 18.5 or newer. Run `stim guide lifecycle simslim` for installation
and profile setup; `doctor` recommends it without applying it automatically.

A simulator can report Booted and show SpringBoard while process startup is
stalled. Stim checks a bounded process spawn before installation and bounds
local launch calls. When macOS reports elevated memory pressure, diagnostics
recommend freeing memory before retrying. A timeout or existing swap usage
alone does not establish OOM. Stop only workspaces you own and have finished
using; ask before closing other agents' simulators or heavy apps. SimSlim can
reduce future resource use but is not a guaranteed fix for a stalled host.

## Remote devices

Stim supports two optional remote backends:

- `proxy` connects through an Agent Device daemon that already owns a session.
- `eas` creates and owns an EAS simulator session.

The app builds locally by default; `--eas-profile` can instead download an
[EAS development build](./eas-builds.md). `stim start --remote` creates the
Metro route required by the remote device. Remote EAS sessions can incur cost
independently of the build source.

## Cleanup behavior

- `stim stop` releases the live environment and device leases. It ends an owned
  remote session. On a physical iPhone, stopping the log collector also closes
  the app; it does not shut down the phone or uninstall anything.
- `stim worktree remove` releases leases, parks eligible owned iOS simulators and
  Android emulators for another workspace. Each platform keeps up to three
  parked devices by default and deletes the oldest when full. Disabling
  parking makes removal delete the device; see [settings](/docs/settings).
- `stim gc` reports stale and orphaned resources.
- `stim gc --delete` removes verified resources from the report, including
  parked simulators, emulators, and expired device lease files.

If deletion fails, Stim keeps the ownership record and exits with an error. A
later cleanup can then retry without losing track of the resource.

Runtime state lives under `$STIM_HOME`, which defaults to `~/.stim`. Each
workspace stores state and logs in a directory derived from its absolute path.

Android adoption requires the same system image, disk size and AVD creation
settings. It keeps the AVD name and installed APK, clears the adopting app's
data, and uninstalls other third-party apps before launch. Installation is
skipped only when the installed APK matches the requested file by SHA-256.
App data remains on disk while parked; system apps, shared storage, accounts
and device settings persist across reuse. Set `pool.androidParkedMax` to `0`
when a fresh device is required. AVDs created before Stim recorded their
creation configuration are deleted when removed.
