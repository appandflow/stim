---
title: 'Devices and cleanup'
sidebar_position: 3
description: 'Owned devices, physical-device leases, and cleanup'
---

Commands use `stim`. If it is not installed globally, replace `stim` with
`npx stim`.

Stim creates and records its local simulators and emulators. Their names start
with `stim-`. It never creates, boots, or deletes a simulator or emulator that
another tool made.

`stim android --device [serial]` and `stim ios --device [udid]` install, launch,
and read available logs on connected physical devices. Stim leases the device
for the run, then releases the lease. Use `stim device lock` to hold it across
runs. Hardware never enters the owned-device registry and is never booted,
shut down, or deleted by Stim.

Each workspace keeps its owned-device assignment for later runs.

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

The app still builds on the local machine. `stim start --remote` creates the
Metro route required by the remote device. Remote EAS sessions can incur cost.

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
