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

Stim creates a simulator or emulator for your workspace and reuses it on later runs. It boots and deletes devices that it can verify it owns. A name starting with `stim-` by itself does not prove ownership.

<StimTabs
code={`stim ios
stim android
stim status`}
/>

Use the command for your platform. With Stim Desktop installed, its workspace viewer is the default on macOS. Use `stim settings set iosSimulatorApp xcode` or `stim settings set androidEmulatorApp emulator` to open the platform's own viewer. [Settings](./settings.md)

For a connected phone, use `stim ios --device [udid]` or `stim android --device [serial]`. Stim leases physical devices for the run. Use `stim device lock` to keep one leased across runs. A physical iPhone needs a development profile that lists it. [Provision an iPhone](./commands.md#device-provision)

Stim Desktop and the phone app can view a leased Android phone or control it with permission. A physical iPhone is view-only and must be unlocked, trusted and connected by USB. On the Mac, allow Camera access if asked.

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
and must begin with a letter or digit; prototype-related reserved names and
`web`, which `stim stop --slot web` uses for the owned Chrome, are rejected. A name is scoped to its platform within the workspace.

Slots share one Metro server and compatible native build caches. Native runs
serialize changes to shared build output; the devices can remain running
together afterward. A Debug launch counts a Metro bundle delivery only when it
can tell that its own device requested it. An iOS simulator slot proves its own
launch: on macOS, Stim looks up which simulator app process opened the bundle
request. Android and physical-device requests carry no device identity, nor
does a simulator request whose process lookup failed, so they prove a launch
only while no other slot of the same platform is running (a booted owned
device, a log collector or a device lease; `stim stop --slot <name>` ends all
three).
Otherwise the launch reports `unverified`, and you should inspect the intended
device and its logs before claiming success. `reload` remains platform-wide, and named
slots are not supported for remote sessions. Local runs using an
[EAS development build](./eas-builds.md) can use slots.

### Inspect and stop one slot

<StimTabs
code={`stim logs --slot tablet --errors
stim stop --slot tablet`}
/>

The slot filter selects that target's attributed records plus the shared Metro
and app client output, windowed by that slot's own launch, so another slot's
relaunch does not hide the tablet's JS errors there. `status` lists the named assignments and leases.
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

### Keep simulators running when Device Hub quits

Stim never changes Apple preferences. The commands below are optional, you run
them yourself, and Stim does not check or depend on them.

**Device Hub quit.** Siniulator's setup notes document this private,
machine-wide Xcode preference, and report testing it with Xcode 27.0. Apple does not document
it, and its effect can change between Xcode releases.

```sh
defaults write com.apple.dt.Devices shutdownStartedDevicesOnQuit -bool false
```

It is meant to stop Device Hub from shutting down the simulators it started when
you quit it. Whether it covers simulators Device Hub never displayed, and
whether it holds on every Xcode build, is not confirmed. On one Mac running
macOS 27 with Xcode 27.1 beta the write failed with `Could not write domain`.
On a Mac with Xcode 27.0 the write and readback succeeded, but no Device Hub
quit was tested, so the command may not work everywhere. Keep treating a Device Hub quit as
unsafe, and stop only your own workspaces with `stim stop`.

To undo it, delete the key:

```sh
defaults delete com.apple.dt.Devices shutdownStartedDevicesOnQuit
```

**Xcode Run and Stop for native iOS development.** Xcode may shut down an
unbooted simulator target when you press Stop. This Xcode preference may help;
its effect has not been verified with Stim:

```sh
defaults write com.apple.dt.Xcode DVTiPhoneSimulatorAlwaysLaunchInCoreSimulatorSession -bool true
```

Quit Xcode before you set it, and boot the exact target with Stim before you
press Run in Xcode. It applies to iOS simulators only, not to native macOS
development. To undo it, quit Xcode and delete the key:

```sh
defaults delete com.apple.dt.Xcode DVTiPhoneSimulatorAlwaysLaunchInCoreSimulatorSession
```

Neither preference changes which devices Stim owns or stops. `stim stop` still
shuts down only the owned devices of the workspace you stop.

## Local devices

`stim ios` selects the newest installed runtime that offers a regular numbered
iPhone model (for example "iPhone 18 Pro"), and the newest such model on it, by
default. It falls back to a special model (no generation number, such as
"iPhone Duo") only when no installed runtime offers a numbered one. `stim
android` selects the newest installed system image matching the host
architecture: `arm64-v8a` on ARM64 or `x86_64` on x64. When none is installed,
or `--system-image` names one that is not, it installs that image (or
`system-images;android-36;google_apis;<host ABI>`) with the SDK's own
`sdkmanager --install` first; see
[`android.installImages`](./settings.md#installing-a-missing-android-system-image). Set `.stim.json`
defaults or use `ios --device-type`, `ios --runtime`, `android --system-image`,
and `android --device-profile` for a specific target. These flags choose the
device Stim creates. When the workspace already owns a device of another model
or version, `stim ios` and `stim android` refuse rather than boot it. The one
exception is `--system-image`, which replaces an emulator that never finished
booting. Pass `--slot <name>` to create the requested device beside the current
one. Android AVDs use the
`pixel_6` hardware profile unless `android.deviceProfile` or
`--device-profile` names another one, such as `pixel_tablet` or `pixel_fold`.

`stim stop` shuts down an owned local device but does not delete it. The command
assumes that the caller finished all device automation for that Stim session.
It does not block on other processes attached to the owned device.

An owned iOS simulator is the exception: while macOS memory pressure is normal,
a device slot is free and `daemon.mode` is `on`, `stim stop` leaves it booted for
`pool.bootedGraceMinutes` (15 by default). `stop` still ends Metro, the app and
agent-device sessions, and the simulator stays assigned to the workspace. The
next `stim ios` uses the booted simulator with no boot, and `stim worktree
remove` parks it booted. The stim-daemon shuts it down when the grace period
passes or when memory pressure is not normal. `stop` prints how long it stays
booted; to shut it down now run `STIM_POOL_BOOTED_GRACE_MINUTES=0 stim stop`,
and set `pool.bootedGraceMinutes` to `0` to turn the deferral off. A repeated
`stop` keeps the first expiry. Android emulators, and any simulator stopped with
`--slot`, are shut down at once.

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

To slim every Stim-owned simulator on a Mac without a profile per app, run
`stim settings set ios.simslim on --scope machine`. A project profile still wins,
and `ios.simslim` set to `off` in a project opts that app out. A shut-down
simulator (new, stopped, or parked and adopted) is slimmed as part of its boot:
SimSlim writes its settings while the simulator is shut down and boots it once,
already slim, alongside the app build. An already slim simulator is left alone,
and a rerun on the same boot with an unchanged profile skips SimSlim entirely. A
manual `simslim off` on a running simulator is not noticed until it reboots or
the profile changes. A running simulator is slimmed on the next `stim ios`,
without a boot first, which reboots it, and Stim mutes it again after that
reboot.
Hosted simulators on a named Mac are muted like local ones but never slimmed.
If `simslim` is not installed, `doctor` reports it and `stim ios` boots without
it.

Each boot of an owned iOS simulator writes `ios_boot` records to the workspace's
device log: boot requested (adopted, created, existing or restart), bootstatus
done, SpringBoard started with its pid, viewer opened and SimSlim reboots. When
SpringBoard is missing after boot, Stim also copies the simulator's recent
`SpringBoard-*.ips` crash reports from `~/Library/Logs/DiagnosticReports` into
the workspace logs directory before it restarts the simulator once, because macOS
deletes them after about two days. Read the records with
`stim logs --source device --grep "ios boot"` and `--grep "SpringBoard crash report"`.

A simulator can report Booted and show SpringBoard while process startup is
stalled. Stim checks a bounded process spawn before installation and bounds
local launch calls. When macOS reports elevated memory pressure, diagnostics
recommend freeing memory before retrying. A timeout or existing swap usage
alone does not establish OOM. Stop only workspaces you own and have finished
using; ask before closing other agents' simulators or heavy apps. SimSlim can
reduce future resource use but is not a guaranteed fix for a stalled host.

During a slow local iOS boot, Stim reports the simulator name, elapsed time, last boot
output, current memory pressure, and highest observed pressure roughly every
15 seconds. Recovery advice appears when pressure first reaches warning or
critical, and again only when the level changes. Boot failures retain the highest pressure and the number of
unavailable readings. Unknown readings are not treated as normal, and pressure
does not prove the cause of a timeout. The boot deadline remains ten minutes
and also covers SpringBoard finishing its startup after `simctl bootstatus`
returns, so a slow host spends that time in the boot step, where the last boot
output reads `waiting for SpringBoard`, rather than in the app launch.
Synchronous CLI work can delay observations, progress, and timeout handling.
Diagnostics report observation gaps over 30 seconds; pressure during those gaps
is unobserved, even when surrounding readings are normal.

When `simctl boot` itself exits 22 (EINVAL), Stim checks the simulator's
state. It continues the boot wait when the simulator is Booting or Booted and
boots once more after two seconds when it is Shutdown. If the boot is still
refused, the failure keeps the exit code and does not recommend memory relief
unless the highest observed pressure was warning or critical.

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

### Abnormally large processes

Memory pressure often comes from one process that leaked, not from the
simulators and emulators. `stim doctor`, and the iOS and Android boot messages
under warning or critical pressure, name any process whose physical footprint is
abnormal. Stim reads it from macOS `top`, which counts compressed and swapped
memory (`ps` RSS leaves them out) and can read root-owned daemons. Abnormal means
at least a quarter of physical memory and at least 8 GiB, or 2 GiB for
`fseventsd` and Watchman, which are normally far smaller.

For a process that is safe to restart, Stim prints the command. It never runs
the command itself.

| Process                 | Command                                   | Effect                                         |
| ----------------------- | ----------------------------------------- | ---------------------------------------------- |
| `fseventsd`             | `sudo killall fseventsd`                  | launchd restarts it; file watchers rescan once |
| Watchman                | `stim gc --delete --cache watchman`       | stops it once no workspace uses it             |
| Gradle or Kotlin daemon | `stim gc --delete --cache gradle-daemons` | stops idle daemons; the next build starts one  |

Any other abnormal process is named with its size only; ask before quitting it.
Boot does not wait for the `top` read: the pressure message prints at once and the
named processes follow on a second memory line when `top` finishes.
Doctor skips this check when `STIM_HOME` is set, because processes are
machine-global.
While pressure stays elevated, the automatic maintenance check also records the
processes in `stim status --json` under `maintenance.pressure.memory.culprits`,
and Stim Desktop shows them under **Machines > This Mac > Resource Usage** with
a copy button for each command.

## Idle shutdown

After 15 minutes of inactivity by default, Stim can stop Metro and shut down owned devices. Change `idle.minutes` for a workspace or machine. Set it to `0` to disable idle stop. App logs alone do not keep a workspace active. A build, device control, lease or live share can keep it up.

<StimTabs code="stim settings set idle.minutes 60 --scope machine" />

When a run is waiting on a full device pool, Stim can shut down another eligible device after two idle minutes. Run `stim revive`, `stim ios` or `stim android` to use the workspace again. [Idle stop](./dev-server-and-logs.md#idle-stop)

## Remote devices

Stim supports two optional remote backends:

- `proxy` connects through an Agent Device daemon that already owns a session.
- `eas` creates and owns an EAS simulator session.

A named `--remote-build` refuses physical and `--remote` cache misses with
`STIM_OFFLOAD_REFUSED`. Use `auto` or `local` for those builds; an existing
cache hit with a listed paired name needs no worker. Unlisted or unpaired
names refuse at setup before checking the cache. See [machine settings](./settings.md#machine-settings).

The app builds locally by default; `--eas-profile` can instead download an
[EAS development build](./eas-builds.md). `stim start --remote` creates the
Metro route required by the remote device. Remote EAS sessions can incur cost
independently of the build source. Stim has EAS stop every session it creates
after `remote.easMaxDurationMinutes` (machine setting, default 30), which ends a
session whose workspace was deleted by hand; the next run replaces an expired
session. EAS rejects a value above the account plan's session limit. Stim prepares the app before it creates or
reconnects the session, so a failed build starts no session and the install
follows the connection directly.

An iOS remote build compiles a single simulator architecture. With `proxy`, Stim
reads the host architecture from the daemon's `/health` response (`hostArch`).
It uses `arm64` when the daemon does not report one or does not answer within
3 seconds, and always with `eas`, whose hosts are Apple silicon.

EAS and proxy adapters cannot verify a release or native process launch, so
`launched` stays `"unverified"` and the output says process verification is
unavailable. These adapters collect no device logs or native crash reports.

Workspaces can hold EAS sessions at the same time, but only one session starts
at a time on a machine. A `--remote eas` run that finishes its build while
another workspace is starting a session waits for that start. It prints a
`lock  waiting for EAS remote start (pid …, in <workspace>, running for …)`
line right away and a `still waiting` line every 30 seconds. If one holder
keeps the lock longer than the slowest EAS session start (39 minutes), the run
refuses with `STIM_LOCK_TIMEOUT`, names that process, and installs nothing.

### From Windows or Linux

From a host without Xcode, iOS runs either on a paired Mac with
`stim ios --remote <mac> --remote-build <mac>` (see
[Remote machines](./remote-machines.md#requirements)) or through EAS with
`--remote eas`. `stim doctor --platform ios` on such a host points at both
instead of at CocoaPods and simulators. Install `eas-cli` 21.6.0 or later and `agent-device`, plus `ngrok` or
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

### Metro on your tailnet

For a remote device or an agent-device proxy on the same tailnet, install
Tailscale and sign in on both hosts, then:

```bash
stim settings set metro.tunnel tailscale --scope workspace
stim start --remote
stim status
```

`tailscale` is an explicit `metro.tunnel` choice; `auto` never selects it.
Stim runs a foreground `tailscale serve --https=<metro port>
http://127.0.0.1:<metro port>` process. It never enables Funnel. The printed
URL is `https://<tailnet-name>:<metro port>`, and status reports the recorded
provider and URL. The device must be on the same tailnet, so the `eas` backend
refuses it; the host may not
reach its own tailnet name, so Stim skips the public bundle probe for its
recorded Tailscale tunnel.

`stim stop` and `stim worktree remove` verify and stop only the process Stim
recorded. Ending the foreground process removes its route; a route Stim did
not create is never touched. If the Metro port already has a serve route,
Tailscale refuses and Stim prints Tailscale's error message.
`tailscale serve status --json` lists foreground sessions under the top-level
`Foreground` key; plain `tailscale serve status` does not list them.

<PromptBox title="Expose Metro on your tailnet">
{`Set metro.tunnel to tailscale for this workspace and start Metro for my remote agent-device proxy on the same tailnet. Show me its URL with stim status, then use stim stop when finished.`}
</PromptBox>

## Typing from a viewer

When Stim Desktop controls an owned iOS simulator, or stim-server sends it
input, Stim puts the simulator in hardware-keyboard mode, the setting behind
Simulator.app's Connect Hardware Keyboard. The on-screen keyboard stays hidden
and the keys of the viewer's keyboard type into the focused field. Nothing turns
the mode off when the viewer leaves, so the simulator stays without an on-screen
keyboard until an XCTest run, including agent-device on an iOS simulator, detaches
it and brings the keyboard back. The next input from a viewer after two idle
seconds attaches it again. An Android emulator keeps its on-screen keyboard: its
keyboard is built in to the emulator, so Android's "Use on-screen keyboard"
setting does not apply.

## Control from the phone viewer

A phone granted control can use the compact bottom toolbar for Keyboard,
Home on iOS or Back on Android and web, and both rotation directions. **More** (the ellipsis button)
opens a native menu for Lock, Android Home and Apps, supported foldable postures,
and simulator options. **Device Frame** in the app's Settings shows a simulator's or
emulator's housing when matching artwork is available; an iPhone Duo has its own
**Device Frame** entry in More, usable without a control lease. **Full Screen** in the
title bar hides the title bar and agent actions so the screen grows; the toolbar keeps
**Exit Full Screen**. The bar stays below the screen in portrait and landscape
and fits its common controls within the available width. An iOS simulator turns with
the device, so a portrait-only app shows sideways in a turned frame; on an emulator the
app in front still needs to support the requested orientation. Physical devices rotate
only in hand.

Tapping Control starts control at once, while an agent drives the device or
another person controls it too: everyone's input reaches the device, and a
finger already down keeps the touch pointer until it lifts. A device another
workspace leases offers **Take Over** instead, and so does a device someone else
drives on a stim-server older than shared control. Viewing replay remains read-only.

## Replay device screens

`stim-server` records owned simulators, emulators and the Stim-owned Chrome
page while an agent or automation tool drives them, or while the phone app
watches them. It keeps the last 15 minutes of footage per device, so you can
see what an agent did while you were away.

In Stim Desktop the device viewer shows a replay bar under the screen; in the
phone app the replay controls sit over the bottom of the screen and fade out
until you tap it:

- **Scrub.** Drag to show the frame at that time.
- **Markers.** Tap one to land just before an agent action or an app error.
- **Play.** Play at 1x or 2x, then tap **Live** to return.
- **Step.** In the phone app, jump to the previous or next agent action, and
  see the device's last agent actions under the screen.

Control is off while you look at the past. Time when nothing was recorded, such
as after `stim stop`, shows as a gap, and a stopped device's last footage stays
replayable.

Recordings stay on your machine and are served only to paired phones and Stim
Desktop. Turn them off for the whole machine in the phone's Settings or in Stim
Desktop's Advanced settings, or on the Mac, where a repository or workspace can
also be set on its own:

```bash
stim settings set recording.enabled false --scope machine
```

See [Device recordings](./settings.md#device-recordings) for scopes and
`STIM_RECORDING`, and
[Inspect and clean caches](./build-caches.md#device-recordings) for cleanup.

Try it with an agent:

```text
Run this app with stim ios, then drive it with agent-device for a minute:
open a few screens and fill a form. Tell me when you are done so I can scrub
back through it in the Stim phone app.
```

## Cleanup behavior

| Action                            | What happens                                                                                        |
| --------------------------------- | --------------------------------------------------------------------------------------------------- |
| `stim stop`                       | Stops this workspace and releases leases. It keeps its owned device assignments for later.          |
| `stim worktree remove`            | Reclaims the workspace and parks eligible owned devices for reuse.                                  |
| `stim gc`                         | Previews cleanup and shows disk use.                                                                |
| `stim gc --delete`                | Removes verified stale resources and can delete parked devices. It also runs disk-pressure cleanup. |
| `stim gc --cache parked --delete` | Erases parked device data and keeps the devices in the pool.                                        |

Each platform parks up to three local devices by default. Stim clears the previous app's data before reusing a parked device. Disk pressure can shorten its lifetime. The dormant stage can delete owned devices from an inactive workspace after `idle.dormantDays` (three days by default). Physical devices stay outside Stim's device cleanup. [Disk pressure](./build-caches.md#disk-pressure)

If teardown fails, Stim keeps the ownership record for a retry. For pool settings, reuse rules and recovery, run the version-matched guide.

<StimTabs code="stim guide lifecycle pool" />

## Run iOS on another Mac

After [hosting approval](#paired-mac-hosting-approval), choose the worker and one of its installed runtimes.

<StimTabs
code={`stim ios --remote janics-mac-mini --device-type "iPhone 17 Pro" --runtime "iOS 27.0"
stim status
stim reload ios
stim stop`}
/>

Metro stays on this machine. If a port conflict is reported, run `stim stop` and retry without starting Metro first, or choose a port free on both Macs. Use `--remote-build` separately to place the build. Run `stim stop` before changing hosts. A named host is strict and reports the reason if it cannot take the run.

Open the device in Stim Desktop to view or control it. To drive it with an agent, set `hosting.agentDriver=agent-device` on the host and use agent-device 0.21.30 or later on both machines.

<StimTabs
code={`stim agent-device open <bundleId>
stim agent-device snapshot
stim agent-device click <ref>`}
/>

[Remote machines](./remote-machines.md) · [Agent-device commands](./commands.md#agent-device)

## Paired Mac hosting approval

Add the worker with `stim remote add <machine>` or use the [Desktop wizard](./remote-machines.md#use-the-desktop-wizard). A person at the worker approves `device-host` using the generated setup command. Approve only an expected client, since hosting lets it run native code on that Mac. Build and viewer access have separate grants.

On the worker, run `stim pairings` to list approvals or `stim pairings revoke <id>` to remove one. [Hosted sessions](./remote-machines.md#hosted-parking-and-restart)
