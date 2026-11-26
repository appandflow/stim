---
title: 'Devices and cleanup'
sidebar_position: 3
description: 'Owned devices, phones, slots, and what Stim deletes'
---

import StimTabs from '@site/src/components/StimTabs';
import PromptBox from '@site/src/components/PromptBox';

:::note[Command examples]

Commands use `stim`. If it is not installed globally, replace `stim` with
`npx stim`.

:::

Each workspace gets its own simulator or emulator, which Stim creates, reuses
and cleans up. Stim boots and deletes only devices it can verify it created. A
device named `stim-...` that Stim did not record is not touched.

<StimTabs
code={`stim ios
stim android
stim status`}
/>

With Stim Desktop installed, devices open in its viewer. To use the platform's
own window instead, set `iosSimulatorApp` to `xcode` or `androidEmulatorApp` to
`emulator`.

## Several devices in one workspace

A slot is a named device in the same workspace. Slots share one Metro server
and the build cache.

<PromptBox title="Test a change on multiple devices">
{`Use Stim to test this change on an iPhone simulator, an iPad simulator, and my connected iPhone in this workspace. Use slots named phone, tablet, and hardware. Reuse those slots on later runs. Check the UI and errors on each target, report what you verified, and leave the devices running for me.`}
</PromptBox>

The agent runs something like:

<StimTabs
code={`stim ios --slot phone
stim ios --slot tablet --device-type "iPad Pro 13-inch (M5)"
stim ios --slot hardware --device
stim logs --slot tablet --errors
stim stop --slot tablet`}
/>

`stop --slot <name>` stops one device and keeps Metro and the other slots.
Plain `stim stop` stops all of them. With more than one device of a platform
running, Stim cannot always prove which device loaded the bundle, so the launch
can report `unverified`.

## Choose the device

By default `stim ios` creates the newest numbered iPhone on the newest
installed runtime, and `stim android` the newest installed system image for
your CPU, with the `pixel_6` profile. When no system image is installed, Stim
installs one with `sdkmanager`. Pick a model with `--device-type` and
`--runtime` (iOS) or `--system-image` and `--device-profile` (Android), or set
them in `.stim.json`. A workspace that already owns a different model refuses
instead of replacing it; use a new `--slot` for the second model.

## Physical phones

Run on a connected phone with `stim ios --device [udid]` or
`stim android --device [serial]`. Stim leases the phone for the run so two
workspaces never install on it at once. `stim device lock ios|android` holds
the lease for a set time, 5 minutes by default and 30 at most.

A physical iPhone needs a development signing profile that lists it. The first
time, `stim device provision ios` registers the phone with your Apple team; it
is the only command that changes your developer account, and it asks first:

<PromptBox title="Set up my iPhone for signing" response={`Provisioning would register this iPhone with team ABCDE12345 and refresh the development profile. Confirm?`}>
{`My iPhone is connected but stim ios --device fails on signing. Run stim device provision ios without --yes, show me what it would change, and wait for me to confirm.`}
</PromptBox>

Stim Desktop and the phone app can watch a leased
Android phone and control it with permission. A physical iPhone is view only,
and must be unlocked, trusted and connected by USB.

Stim never deletes or erases a physical device.

## Stop and idle shutdown

`stim stop` shuts down the workspace's devices and never deletes them. The
device stays assigned, so the next run only pays a boot. An owned iOS simulator
stays booted for `pool.bootedGraceMinutes` (15 by default) while memory allows,
so a quick restart skips the boot. Set it to `0` to shut down at once.

After `idle.minutes` (15 by default) with no activity, Stim stops Metro and
shuts down the workspace's devices. App logs alone do not count as activity.
Set it to `0` to turn idle stop off:

<StimTabs code="stim settings set idle.minutes 60 --scope machine" />

Run `stim revive`, `stim ios` or `stim android` to use the workspace again.

## Memory

A booted iOS simulator uses roughly 1 to 2 GB of RAM and an Android emulator 2
to 3 GB. Stim slims every iOS simulator it owns: it turns off background system
services such as push, StoreKit, Spotlight, Siri and iCloud, which cuts each
simulator's memory several times over. Slimming needs iOS 18.5 or newer.

If your app needs one of those features, keep it with an `ios.simslimProfile`,
or set `ios.simslim` to `off` for the project. When the app asks for a service
slimming turned off, Stim logs a warning that names the category to keep.

<PromptBox title="Fix a feature slimming turned off">
{`A system feature such as push, StoreKit or Contacts does not work in my app on the Stim simulator. Check stim logs for a warning that slimming turned it off, and if one names the feature, add its category to the except list of an ios.simslimProfile.`}
</PromptBox>

Under memory pressure, `stim doctor` and slow boots name any process with an
abnormal footprint, such as a leaked `fseventsd`, Watchman or Gradle daemon,
and print the command to restart it. Stim never runs that command itself. Stim
Desktop lists them under **Machines > This Mac > Resource Usage**.

## Replay

`stim-server` records owned devices and the owned Chrome page while an agent
drives them or the phone app watches them. It keeps the last 15 minutes per
device. Scrub back in Stim Desktop or the phone app to see what an agent did.
Recordings stay on your machine and go only to Stim Desktop and paired phones.
Turn them off with:

<StimTabs code="stim settings set recording.enabled false --scope machine" />

When Stim Desktop or a viewer types into an owned iOS simulator, Stim turns on
its hardware keyboard, so the on-screen keyboard stays hidden until an XCTest
run, such as agent-device, brings it back.

## What Stim deletes

| Action                        | What happens                                                                                                                 |
| ----------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `stim stop`                   | Shuts down the workspace's devices and releases its leases. Deletes nothing.                                                 |
| `stim worktree remove`        | Reclaims the workspace and parks its owned devices for reuse, unless disk pressure is critical.                              |
| `stim gc --dry-run`           | Shows what `stim gc` would delete. Deletes nothing.                                                                          |
| `stim gc`                     | Deletes stale owned devices, devices of workspaces idle for `idle.dormantDays` (1 day), unused simulator runtimes, and more. |
| `stim gc --pressure critical` | Also makes every idle workspace dormant, which deletes its owned devices.                                                    |

Each platform parks up to three devices by default (`pool.iosParkedMax`,
`pool.androidParkedMax`), and Stim clears the previous app's data before
reusing one. `stim gc` deletes a simulator runtime only when no simulator on
the machine uses it and simctl marks it deletable. It keeps the only installed
runtime, the newest one when none is used, and any runtime a project pins with
`ios.runtime`. Stim never touches simulators you created or physical devices.

## Devices on other machines

- **Another Mac.** `stim ios --remote <mac>` runs on an approved Mac with Metro
  kept here. A person at that Mac approves the `device-host` grant, which lets
  your machine run native code there, so approve only clients you expect. See
  [Remote machines](./remote-machines.md).
- **EAS Simulator.** `stim ios --remote eas --eas-profile <profile>` runs a
  downloaded EAS build on an EAS cloud simulator. Sessions are billed by EAS.
  Stim ends each session it creates after `remote.easMaxDurationMinutes` (30 by
  default), and `stim stop` ends it sooner. A failed install leaves the session
  running and billed until you rerun or stop. It needs `eas-cli` 21.6.0 or
  later, logged in with `eas login` or `EXPO_TOKEN`. This also works from
  Windows or Linux with `agent-device` and `ngrok` or `cloudflared` for the
  Metro tunnel. See [EAS development builds](./eas-builds.md).
- **An Agent Device daemon.** `stim ios --remote proxy` (or `android`) runs on
  a device an existing Agent Device daemon serves, with its URL and token.
- EAS and proxy devices cannot prove a Release or native launch, so it stays
  unverified, and they collect no device logs or crash reports.
- **Your tailnet.** Set `metro.tunnel` to `tailscale` and run
  `stim start --remote` to serve Metro to a device on the same tailnet. Stim
  never enables Funnel.

## Agent detail

The agent reads the version-matched rules with `stim guide lifecycle pool`,
`stim guide lifecycle lease`, `stim guide lifecycle simslim` and
`stim guide cleanup gc`.
