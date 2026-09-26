---
title: 'Devices and cleanup'
sidebar_position: 3
description: 'Owned devices, physical-device leases, and cleanup'
---

import StimTabs from '@site/src/components/StimTabs';
import PromptBox from '@site/src/components/PromptBox';

:::note[Command examples]

Commands use `stim`. If it is not installed globally, replace `stim` with
`npx stim`.

:::

Stim creates and records its local simulators and emulators. Their names start
with `stim-`. It never creates, boots, or deletes a simulator or emulator that
another tool made.

A `stim-` name alone does not make a device Stim's. Stim lists every device it
creates in `~/.stim/created-devices.json`. For devices created before that
ledger, it also accepts an iOS name in its exact `stim-<label> (<model> <runtime>)`
format, or an AVD whose `config.ini` holds the data partition size Stim writes.
`stim gc --delete` removes only those devices when no workspace references them.
It lists any other `stim-*` device with the command that deletes it, and leaves
it for you to run.

`stim android --device [serial]` and `stim ios --device [udid]` install, launch,
and read available logs on connected physical devices. An iPhone can be cabled
or paired over Wi-Fi; with no UDID, Stim picks a cabled iPhone first. Stim leases the device
for the run, then releases the lease. Use `stim device lock` to hold it across
runs. Hardware never enters the owned-device registry and is never booted,
shut down, or deleted by Stim.

Each workspace keeps its owned-device assignments for later runs.
After boot, Stim opens its owned iOS simulator in Device Hub on Xcode 27, or
Simulator on older Xcode. Stim passes the workspace's simulator ID to Device Hub
so it can open that device's window.
Opening the window is best effort; a window failure does not undo a successful boot.
On Xcode 27 (confirmed on 27A266a), quitting Device Hub by default shuts down
every booted simulator on the machine, including ones it never opened a
window for and ones other workspaces or agents are using. Never quit Device
Hub to free memory or clean up; use `stim stop` on workspaces you own
instead. [Siniulator's setup notes](https://github.com/kmagiera/Siniulator#working-with-device-hub)
describe a macOS preference that stops this; it is undocumented whether that
preference also covers simulators Device Hub never displayed.
To display owned simulators in Siniulator, set `"iosSimulatorApp": "siniulator"`
at the top level of `~/.stim/config.json` after installing it. For one launch,
use `stim ios --simulator-app siniulator` (or `--simulator-app xcode` to use
Apple's viewer). This also opens an already running owned simulator without
rebooting it or saving the override. Siniulator
shuts down a simulator when its window closes by default. In Siniulator Settings,
enable **Leave simulator running after window is closed** to keep Stim's device
running.

To show owned simulators in Stim Desktop instead of a simulator window, set
`"iosSimulatorApp": "stim-desktop"`, or pass `--simulator-app stim-desktop` for
one launch. Stim Desktop selects the workspace that owns the simulator and
focuses that device. It only displays the simulator; it never boots or shuts
it down.

Owned Android emulators open their own window by default. To boot them without
a window on macOS and show them in Stim Desktop instead, set
`"androidEmulatorApp": "stim-desktop"`:

```sh
stim settings set androidEmulatorApp stim-desktop
```

Stim then starts newly booted owned emulators with `-no-window -gpu host`, which
keeps GPU acceleration, and opens `stim-desktop://open?serial=<serial>` in the
background so Stim Desktop focuses that emulator. An emulator that is already
running keeps its current display until it next boots, and physical devices are
unaffected. Stim's maintainer runs with `"iosSimulatorApp": "stim-desktop"`;
setting both shows every owned device in Stim Desktop.

An iPhone Duo simulator shows both of its screens side by side, and the
unlit one stays black. While **Take over** is on, its tile has a **Fold /
Unfold** button that sweeps the simulated hinge to the other posture. The
button needs the bundled app, and because it uses private iOS interfaces, a
new iOS runtime can break it.

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
`stim android --slot phone`, `stim android --slot fold --device-profile pixel_fold`
or `stim android --slot hardware --device <serial>`.
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
`stop --slot default` stops only the workspace's default device the same way,
leaving named slots and Metro up.

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

`stim ios` selects the newest installed runtime that offers a regular numbered
iPhone model (for example "iPhone 18 Pro"), and the newest such model on it, by
default. It falls back to a special model (no generation number, such as
"iPhone Duo") only when no installed runtime offers a numbered one. `stim
android` selects the newest installed system image matching the host
architecture: `arm64-v8a` on ARM64 or `x86_64` on x64. Set `.stim.json`
defaults or use `ios --device-type`, `ios --runtime`, `android --system-image`,
and `android --device-profile` for a specific target. Android AVDs use the
`pixel_6` hardware profile unless `android.deviceProfile` or
`--device-profile` names another one, such as `pixel_tablet` or `pixel_fold`.

`stim stop` shuts down an owned local device but does not delete it. The command
assumes that the caller finished all device automation for that Stim session.
It does not block on other processes attached to the owned device.

Android creation records an owned reservation before running native tools.
Other workspaces can update Stim config during creation, while GC and teardown
keep that reservation. An interruption leaves an incomplete record; retry
`stim android` to reconcile it through owned-device cleanup. If a per-AVD claim
under `~/.stim/avd-locks` is live or unresolved, cleanup refuses. Wait for live
work to finish. Before removing an unresolved claim, verify that neither Stim
nor its native child is still using the AVD, and remove only the named claim.
Keep the AVD data and follow `stim guide errors STIM_CLAIM_REFUSED`.

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

During a slow local iOS boot, Stim reports the simulator name, elapsed time, last boot
output, current memory pressure, and highest observed pressure roughly every
15 seconds. Boot failures retain the highest pressure and the number of
unavailable readings. Unknown readings are not treated as normal, and pressure
does not prove the cause of a timeout. The boot deadline remains ten minutes,
but synchronous CLI work can delay observations, progress, and timeout handling.
Diagnostics report observation gaps over 30 seconds; pressure during those gaps
is unobserved, even when surrounding readings are normal.

An agent should stop unused slots in workspaces it owns, reduce concurrent
builds, and retry after pressure falls. Ask before closing another agent's
simulator or a user's app. Repeated reboots under unchanged pressure can repeat
the stall.

Local Android emulator boots also print a memory phase line when macOS reports
warning or critical pressure. If boot times out under that pressure, Stim
extends the wait once by up to 240 seconds while the process it started is
still alive. It waits on the same emulator and never launches a duplicate.
New-device preparation waits 120 seconds initially; the later boot check uses
240 seconds. Normal or unavailable pressure, an exited process, or unavailable
process liveness does not trigger the extra wait. adb probes are bounded.

Timeout remedies include observed pressure and the running Stim-owned device
count when available. Device count alone does not prove memory pressure or
trigger the extra wait. Specific emulator log errors keep their own remedies.
Stop an unneeded device with `stim stop` only in a workspace you own, then rerun
`stim android` with the same build options. Read
`stim guide errors STIM_NO_DEVICE` for recovery details.

## Remote devices

Stim supports two optional remote backends:

- `proxy` connects through an Agent Device daemon that already owns a session.
- `eas` creates and owns an EAS simulator session.

The app builds locally by default; `--eas-profile` can instead download an
[EAS development build](./eas-builds.md). `stim start --remote` creates the
Metro route required by the remote device. Remote EAS sessions can incur cost
independently of the build source. Stim prepares the app before it creates or
reconnects the session, so a failed build starts no session and the install
follows the connection directly.

Workspaces can hold EAS sessions at the same time, but only one session starts
at a time on a machine. A `--remote eas` run that finishes its build while
another workspace is starting a session waits for that start. It prints a
`lock  waiting for EAS remote start (pid …, in <workspace>, running for …)`
line right away and a `still waiting` line every 30 seconds. If one holder
keeps the lock longer than the slowest EAS session start (39 minutes), the run
refuses with `STIM_LOCK_TIMEOUT`, names that process, and installs nothing.

### From Windows or Linux

`--remote eas` is the supported way to run iOS from a host without Xcode.
`stim doctor --platform ios` on such a host points at it instead of at
CocoaPods and simulators. Install `eas-cli` 21.6.0 or later and `agent-device`, plus `ngrok` or
`cloudflared` for the Metro tunnel, then:

```bash
stim start --remote
stim ios --remote eas --eas-profile ios-simulator
stim logs --errors
stim stop
```

The profile is the simulator profile from [EAS builds](./eas-builds.md#choose-a-profile):
the EAS Simulator runs simulator binaries, so it must set `ios.simulator: true`.
The build must already exist on EAS; a miss prints the `eas build` command and
never starts one. `stim status` lists the running session with its browser
preview URL, and Stim Desktop shows that page as a device tile. `stim stop`
ends the session and the tunnel.

An install or launch failure leaves the session running and billed. The remedy
names the session: rerun the command to reuse it, or run `stim stop` to end it.

## Cleanup behavior

- `stim stop` releases the live environment and device leases. It ends an owned
  remote session. On a physical iPhone, stopping the log collector also closes
  the app; it does not shut down the phone or uninstall anything.
- `stim worktree remove` releases leases, parks eligible owned iOS simulators and
  Android emulators for another workspace. Each platform keeps up to three
  parked devices by default and deletes the oldest when full. Disabling
  parking makes removal delete the device; see [settings](/docs/settings).
- `stim gc` reports stale and orphaned resources. `stim gc --json` prints the
  same report as one JSON object.
- `stim gc --delete` removes verified resources from the report, including
  parked simulators, emulators, and expired device lease files. With
  `--older-than <days>`, it removes only the devices parked at least that long.

Before shutting down, parking or deleting an owned simulator or emulator, Stim
attempts to close local `agent-device` sessions on that exact iOS UDID or live
Android serial. An Android session must also name the owned AVD, because the
next emulator on a console port reuses the serial. `stim stop` (including
`stop --slot`) closes a session only when agent-device's claim on the device
names that session and was taken inside the workspace being stopped. Stim
rechecks ownership and asks agent-device to reject a close if the session now
targets another device. Sessions from another workspace or claim, sessions on
other devices, and physical devices stay open. The integration is optional: a
missing binary skips cleanup; failures print a warning and device teardown
continues. Agent-device calls have
a combined 15-second budget per device and require local socket transport and
support for `--session-lock reject`. Remote daemons are never used.

If deletion fails, Stim keeps the ownership record and exits with an error. A
later cleanup can then retry without losing track of the resource.

Parked-device adoption and deletion share a process-identity claim. The next
attempt recovers a proven dead or different owner, while a live owner keeps
the device protected. An opaque deletion marker also protects the device from
older Stim versions. If Stim dies during a device-tool call, its native child
may still be running: inspect both before following the claim's removal remedy.
Older inline `deletionClaim` fields require manual inspection and removal of
only that field; keep the device and pool record. Run `stim guide lifecycle pool`
for the recovery steps.

Runtime state lives under `$STIM_HOME`, which defaults to `~/.stim`. Each
workspace stores state and logs in a directory derived from its absolute path.

Parking erases a simulator with `simctl erase` and wipes an emulator's user
data and snapshots, so a parked device takes a few megabytes instead of
gigabytes. The adopting workspace pays a first boot, about 15 seconds for a
simulator and 20 for an emulator, and installs its app again. Stim erases a
simulator only after it reports `Shutdown`: it waits up to 15 seconds,
retries the shutdown once, and waits up to 15 seconds more. A simulator that
stays booted is deleted instead, and `stim worktree remove` prints `could not
park <name>: ... -- deleted it instead`.

Android adoption requires the same system image, disk size and AVD creation
settings. It keeps the AVD name. For an emulator parked with its data by an
older Stim, adoption clears the adopting app's data and uninstalls other
third-party apps before launch. Installation is skipped only when the
installed APK matches the requested file by SHA-256. AVDs created before Stim
recorded their creation configuration are deleted when removed.
