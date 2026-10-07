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

The Stim phone viewer's control toolbar offers **Shake** and **Slow animations**
for owned iOS simulators when the paired server supports them. Slow animations
shows the confirmed simulator state. These options require control access and
are hidden on older servers or devices that do not support them. They use
Stim's viewer and never open Device Hub.

A `stim-` name alone does not make a device Stim's. Stim lists every device it
creates in `~/.stim/created-devices.json`, or in `$STIM_HOME/created-devices.json`
when `STIM_HOME` points somewhere else. For devices created before that ledger,
it also accepts a device its config records in the device pool or in a
workspace as owned. `stim gc --delete` removes only those devices when no
workspace references them. It lists any other `stim-*` device, including one
another `STIM_HOME` created, with the command that deletes it (`rm -rf <dir>`
for AVD data with no registration), and leaves it for you to run.

When a simulator in the ledger is deleted outside Stim, for example from Xcode,
`stim gc` reports its UDID as a stale ledger entry and `stim gc --delete` removes
it from the ledger. Stim does this only when `simctl` lists every simulator,
unavailable ones included, and that UDID is not among them.

The Android ledger records AVD names, and another `STIM_HOME` can create an AVD
with the same name later. `stim gc` reports an AVD name as stale when
`emulator -list-avds` answered, the AVD home exists, and no AVD root has a
registration or data directory for that name. It does not report a name that an
unfinished `stim android` setup has reserved. `stim gc --delete` checks again
before it forgets the name. After you delete a Stim AVD by hand, run `stim gc
--delete` so a later AVD with that name is not treated as this home's.

`stim android --device [serial]` and `stim ios --device [udid]` install, launch,
and read available logs on connected physical devices. An iPhone can be cabled
or paired over Wi-Fi; with no UDID, Stim picks a cabled iPhone first. Stim leases the device
for the run, then releases the lease. Use `stim device lock` to hold it across
runs. Hardware never enters the owned-device registry and is never booted,
shut down, or deleted by Stim.

While a workspace holds the lease, `stim status` lists the device under that
workspace with its name, model, whether the Mac reaches it, and when the lease
ends, and Stim Desktop and the Stim phone app show it as a tile with a
Physical badge. To keep a phone on screen while you work, lock it:

```bash
stim device lock ios --for 30m
stim status
```

Or ask an agent:

```text
Lease my connected iPhone to this workspace with stim device lock for 30 minutes, then run stim status and tell me whether it shows as connected.
```

A leased iPhone cabled over USB also streams its screen to the phone app
through `stim-server`, view only: Stim sends a physical iPhone no taps, text
or buttons. Over Wi-Fi it shows no screen. The iPhone must be unlocked and
trust the Mac. macOS
counts the iPhone's screen as a camera, so the first stream asks for Camera
access for Stim, the app that runs `stim-server`.

While a workspace holds an Android phone's lease, the phone app and Stim Desktop
also show the phone's screen live through `stim-server`. **Control** in Stim
Desktop, or a phone paired with control, can tap, swipe, type and press Home,
Back, Apps and Lock on it. Stim Desktop also shows a cabled iPhone's screen,
view only. The stream runs over
adb with the [scrcpy](https://github.com/Genymobile/scrcpy) server, which
`stim-server` pushes to `/data/local/tmp` and deletes when the stream stops. It
installs nothing, changes no setting, and cannot rotate the phone. Control ends
when the workspace releases the lease or it expires. Some Android 15 and 16
phones send no picture until their screen changes. With the screen off, you see
what the phone's display shows, such as an always-on display, and watching never
wakes it.

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

When [Stim Desktop](./desktop.md) is installed, it is the default viewer for
both platforms: `iosSimulatorApp` and `androidEmulatorApp` default to
`"stim-desktop"`. Stim looks the app up by its bundle id
(`dev.stim.desktop`) in Launch Services. Without Stim Desktop the defaults
stay `"xcode"` and `"emulator"`, and a value you set always wins.
`stim settings get iosSimulatorApp` prints the effective value and, on stderr,
`(default: Stim Desktop installed)` when the default comes from the app.

For owned simulators, Stim Desktop selects the workspace that owns the
simulator and focuses that device, and no simulator window opens. If the app is
showing another page, it keeps that page and shows a card with a **Show**
button instead. It only displays the simulator; it never boots or shuts it
down. Pass
`--simulator-app stim-desktop` to use it for one launch.

When Stim Desktop is not running, Stim starts it without the command's
`STIM_HOME`. Stim Desktop then reads the same Stim home, and serves the same
paired phones, as when you open it yourself. It shows only devices from that
home, so a simulator booted under another `STIM_HOME` does not appear in it.

For owned Android emulators, Stim starts newly booted emulators on macOS with
`-no-window -gpu host`, which keeps GPU acceleration, and opens
`stim-desktop://open?serial=<serial>` in the background so Stim Desktop
focuses that emulator, or offers it in a card when the app is on another page. An emulator that is already running keeps its current display
until it next boots, and physical devices are unaffected.

To keep the simulator and emulator windows with Stim Desktop installed:

```sh
stim settings set iosSimulatorApp xcode
stim settings set androidEmulatorApp emulator
```

An iPhone Duo simulator shows its active screen, with the frame fitted to
that screen. Both screens appear side by side until the active screen is
known. While **Control** is on, its tile has a **Fold / Unfold** button that sweeps the simulated hinge to the other posture. The
button needs the bundled app, and because it uses private iOS interfaces, a
new iOS runtime can break it. **Rotate left** and **Rotate right** work in
folded, half-open and unfolded postures. Apps keep their supported
orientations, and the Duo home screen stays portrait.
When the Desktop viewer is open and the installed devicectl supports hinge
observation, its preset selection follows changes made by other controllers.
Arbitrary angles leave all presets unselected. Older tools retain the posture
Desktop last requested. **Hinge angle** opens a slider from 0 to 180 degrees
while **Control** is on; release it to apply the selected angle. Selecting the
current preset does nothing.
When its observed angle is below 180 degrees, the Desktop viewer projects the
active inner display around its hinge. Taps and drags follow the projected
screen. The cover and fully open display stay flat; without angle observation,
the inner display also stays flat.

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

## Local devices

`stim ios` selects the newest installed runtime that offers a regular numbered
iPhone model (for example "iPhone 18 Pro"), and the newest such model on it, by
default. It falls back to a special model (no generation number, such as
"iPhone Duo") only when no installed runtime offers a numbered one. `stim
android` selects the newest installed system image matching the host
architecture: `arm64-v8a` on ARM64 or `x86_64` on x64. Set `.stim.json`
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
15 seconds. Recovery advice appears when pressure first reaches warning or
critical, and again only when the level changes. Boot failures retain the highest pressure and the number of
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

## Idle shutdown

A stalled agent can leave its simulator or emulator booted for hours. Set
`devices.idleShutdownMinutes` to have the workspace's dev server supervisor
shut its owned devices down after that many idle minutes. It is on by default
at 30 minutes. Set it for the machine or for one project; `0` turns it off:

```bash
stim settings set devices.idleShutdownMinutes 60 --scope machine
```

A device counts as idle when it is booted, no tool drives it, no `stim device
lock` or agent-device session holds it, no build runs in the workspace, and it
has shown no activity (app logs, device logs, bundle requests, Stim commands, agent actions)
for that long. A phone app viewing the device through `stim-server` keeps it
up. Stim Desktop's own simulator view does not.

The device is shut down, never deleted, through the same path as `stim stop`.
Physical devices are never touched. `stim status` shows
`shut down after 30m idle` on the device, and the next `stim ios` or
`stim android` boots it again.

The supervisor checks once a minute and reads the setting when it starts, so
restart the dev server with `stim stop` and `stim start` after changing it.
The supervisor path does not check after `stim stop` or for release runs,
which have no supervisor. When `metro.idleStopMinutes` is shorter, the dev
server's idle stop shuts down the devices idle that long first.

Queue reclaim is a separate, faster path. With `concurrency.maxDevices` set,
this changes the default behavior for everyone: the waiting run uses its own
effective `devices.reclaimIdleMinutes`, default 10, to shut down the
longest-idle eligible owned device across this Stim home's other workspaces.
Only the FIFO head reclaims, one device at a time, then checks the queue and
capacity before another. `0` disables reclaim; the supervisor's own idle
shutdown still defaults to 30 minutes.

The same idle check applies: no driver, Stim or agent-device lock, build,
device lock or viewer, and no Stim command, app log, device log, Metro bundle
or agent action within the interval. Reclaim rechecks idleness under the
target workspace's native-run lock and re-resolves ownership through
centralized teardown. It shuts down, never deletes, and excludes the waiting
workspace, physical, hosted, remote, parked and other homes' devices. Lock or
teardown failures are logged and skipped while the run keeps waiting. It
works even when the target has no supervisor.

The waiting run prints the reclaimed device, workspace and idle minutes on
stderr. The reclaimed workspace's status and `device_idle_shutdown` log say
`reclaimed for a waiting run`; wait stats include a positive `reclaimed` count.

```bash
stim settings set devices.reclaimIdleMinutes 0 --scope machine
```

Agent prompt:

```text
Change Stim's idle device shutdown for this project to 60 minutes with
`stim settings set devices.idleShutdownMinutes 60 --scope workspace`, restart
the dev server with `stim stop` and `stim start`, and confirm with
`stim settings get devices.idleShutdownMinutes`.
```

## Remote devices

Stim supports two optional remote backends:

- `proxy` connects through an Agent Device daemon that already owns a session.
- `eas` creates and owns an EAS simulator session.

A named `--build-machine` refuses physical and `--remote` cache misses with
`STIM_OFFLOAD_REFUSED`. Use `auto` or `local` for those builds; an existing
cache hit with a listed paired name needs no worker. Unlisted or unpaired
names refuse at setup before checking the cache. See [machine settings](./settings.md#machine-settings).

The app builds locally by default; `--eas-profile` can instead download an
[EAS development build](./eas-builds.md). `stim start --remote` creates the
Metro route required by the remote device. Remote EAS sessions can incur cost
independently of the build source. Stim prepares the app before it creates or
reconnects the session, so a failed build starts no session and the install
follows the connection directly.

An iOS remote build compiles a single simulator architecture. With `proxy`, Stim
reads the host architecture from the daemon's `/health` response (`hostArch`).
It uses `arm64` when the daemon does not report one or does not answer within
3 seconds, and always with `eas`, whose hosts are Apple silicon.

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

## Control from the phone viewer

A phone granted control can use the compact bottom toolbar for Keyboard,
Home on iOS or Back on Android and web, and both rotation directions. **More** (the ellipsis button)
opens a native menu for Lock, Android Home and Apps, supported foldable postures,
and simulator options. **Device frame** appears in More when matching artwork is
available and remains usable without a control lease. The bar stays below the screen in portrait and landscape
and fits its common controls within the available width. The app in front still needs
to support the requested orientation. Physical devices rotate only in hand.

Tapping Control explicitly takes over from the displayed driver immediately.
If the server reports a driver conflict after that tap, the Take over action
also starts control immediately. The server keeps its exclusive control lease
and records the takeover. Viewing replay remains read-only.

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

Recordings stay on your Mac and are served only to paired phones and Stim
Desktop. Turn them off for the whole Mac in the phone's Settings or in Stim
Desktop's Phones settings, or on the Mac, where a repository or workspace can
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
- `stim gc --cache parked` lists only the parked devices, with the app each
  one holds and its size. With `--delete` it erases each verified parked
  simulator (`simctl erase`) and wipes each parked emulator's user data and
  snapshots, and keeps them parked for the next workspace.

Before shutting down, parking or deleting an owned simulator or emulator, Stim
attempts to close local `agent-device` sessions on that exact iOS UDID or live
Android serial. An Android session must also name the owned AVD, because the
next emulator on a console port reuses the serial. For an emulator that is
already shut down, Stim closes the sessions that name its AVD on any serial
that no connected device now holds. `stim stop` (including
`stop --slot`) closes a session only when agent-device's claim on the device
names that session and was taken inside the workspace being stopped. A session
claimed from the workspace's git root, such as the worktree root when the app
lives in a subdirectory, is closed too, but only after `stop` has shut its
device down and Stim has checked that the device is still stopped and that no
other device holds its serial. Stim
rechecks ownership and asks agent-device to reject a close if the session now
targets another device. Sessions from another workspace or claim, including
sibling directories under the git root, sessions on other devices, and physical
devices stay open. The integration is optional: a
missing binary skips cleanup; failures print a warning and device teardown
continues. Agent-device calls have
a combined 15-second budget per device and pass (the pass `stop` makes after
shutdown has its own), and require local socket transport and
support for `--session-lock reject`. Remote daemons are never used.

An owned emulator counts as stopped only when no emulator process launched for
its AVD is left. Stim asks it to quit with `adb emu kill`. A hung emulator that
ignores that for 60 seconds, or that adb cannot reach, gets SIGTERM and then
SIGKILL, but only after Stim verifies that the process runs that AVD and is the
same process it saw before shutdown. Windows has no such check, so Stim signals
nothing there. If the emulator still runs, `stop`, `worktree remove` and
`gc` report `teardown failed` and keep the device record instead of reporting it
stopped or parked.

If deletion fails, Stim keeps the ownership record and exits with an error. A
later cleanup can then retry without losing track of the resource.

Parked-device adoption and deletion share a process-identity claim. The next
attempt recovers a proven dead or different owner, while a live owner keeps
the device protected. An opaque deletion marker also protects the device from
older Stim versions. When that marker outlives its owner, adoption treats the
device as erased and drops its recorded app, cache key and scheme approvals.
An erase by `gc --cache parked --delete` that fails after the erase command
started keeps the device parked without them for the same reason.
If Stim dies during a device-tool call, its native child
may still be running: inspect both before following the claim's removal remedy.
Older inline `deletionClaim` fields require manual inspection and removal of
only that field; keep the device and pool record. Run `stim guide lifecycle pool`
for the recovery steps.

Runtime state lives under `$STIM_HOME`, which defaults to `~/.stim`. Each
workspace stores state and logs in a directory derived from its absolute path.

Parking keeps the device as it is: the app stays installed and the pool
record names it. A parked device can therefore hold gigabytes until
`stim gc --cache parked --delete` erases it. Stim parks a simulator only after
it reports `Shutdown`: it waits up to 15 seconds, retries the shutdown once,
and waits up to 15 seconds more. A simulator that stays booted is deleted
instead, and `stim worktree remove` prints `could not park <name>: ... --
deleted it instead`.

Adoption gives the new workspace a clean app state without reinstalling. It
resets privacy grants and the keychain, uninstalls every other user app, and
clears the workspace app's data: on iOS it empties the app's data container
and resets its preferences, and on Android it runs `pm clear`. It does this on
every adoption, whichever workspace parked the device. The reset preferences
of an iOS expo-dev-client app hold only the two that hide the Expo dev menu and
its Tools button, so the menu stays off when an agent or a crash relaunches
the app. Stim then compares the installed app with the requested build byte
for byte and skips the install when they match, so a new worktree running the
same build as the parked device boots it warm and launches without copying the
app. App-group
containers, photos, the pasteboard and Simulator settings are not cleared.

Android adoption requires the same system image, disk size and AVD creation
settings. It keeps the AVD name. An emulator's `/data` partition is fixed, so
before installing, adoption checks its free space. When there is less than
twice the APK size plus 512 MB, Stim trims app caches, and if that is not
enough it wipes the emulator's user data, boots it again and says so in the
output. An install that fails with `INSTALL_FAILED_INSUFFICIENT_STORAGE` gets
the same cleanup and retries. Simulators use the Mac's disk, so iOS has no such
check. AVDs created before Stim recorded their creation configuration are
deleted when removed.

## Run iOS on another Mac

If Stim is not installed globally, replace `stim` with `npx stim`.
Use the [hosting approval setup](#paired-mac-hosting-approval), then name the Mac:

<StimTabs code={`stim ios --remote janics-mac-mini --device-type "iPhone 17 Pro" --runtime "iOS 27.0"
stim status
stim reload ios
stim stop`} />

Set `ios.remote` to that name for a workspace default. `eas` and `proxy` keep
those backend meanings. No flag or setting runs here. `auto` refuses with
`STIM_BAD_ARG` until automatic placement ships; Android on a paired Mac is not
available yet. `--device` and `--simulator-app` cannot target a hosting Mac.
The host boots headless; this Mac's viewer setting is ignored.

`--slot`, `--scheme`, `--configuration` and `--eas-profile` work as usual.
Model and runtime selectors use the host's installed choices. The build targets
its simulator architecture. `--build-machine` independently selects a compatible
Debug build worker. A named host never falls back: `STIM_HOSTING_REFUSED` names
unreachable, declined or uncertain placement and its reason.

Metro stays on this Mac. Its supervisor runs a private tailnet gateway to the
host's loopback bridge; no `stim start --remote` is needed. `metro.tunnel` and
`metro.publicUrl` are ignored, and non-Debug runs skip Metro. Hosted Debug runs
require a running supervisor with private gateway support before reserving a
simulator; `--no-metro-check` refuses with `STIM_BAD_ARG`. If Metro is missing or
uses an older supervisor, run `stim stop; stim start`, then retry. Fast Refresh and
`stim reload ios` use this workspace's Metro. `launched` stays `unverified`
until bundle evidence, or positive native process evidence for a release run.

Reruns reattach to the recorded session and upload a new app attempt. A stopped
or missing session is replaced. An unreachable or unknown session refuses
replacement. Switching between this Mac and a hosting Mac, or to a different
hosting Mac, requires `stim stop` first for that slot.
`status --json` adds `ios.host` with `machine`, `session`, `selected`, the device's
`name` and `runtime`, `agent`, and the probed `state`. A shutdown local simulator
is replaced in status without a warning. A booted or unknown local simulator
stays visible alongside `ios.host` with a warning; plain status shows both. The
default slot appears only in `ios`, never in `slots[]`. The host UDID and private gateway never appear
in local device fields. Stop and worktree removal wait for the host, delete only
its owned simulator without parking, then clear placement. `stop --json` reports
each hosted slot under `outcomes.device["ios:host:<slot>"]`, alongside local
outcomes; one failure does not hide siblings that stopped. An unreachable host
keeps the placement and fails cleanup; rerun `stim stop` when it answers. Missing
or unapproved local credentials require `stim doctor` to restore access first.
Unreadable machine or session state stays recorded: status warns, and stop names
the workspace-state key to inspect. Only that slot's iOS run refuses; restore
its recorded machine and session from the host, then run `stim stop` for that
slot. Reload reports the failure and remedy in JSON when no other app can
reload, and logs remain readable. A hello refusal after this Mac loses hosting
access clears its placement during stop or worktree removal; other refusals
retain it.
A host server restart stops its sessions.

Reruns upload only missing manifest and file digests from a session-scoped store;
the host verifies bytes before reuse. When an offloaded iOS simulator build ran
on the hosting Mac's pinned node, the host takes files that match the client's
manifest from that build. A refused or timed-out handoff falls back to upload, retrying a still-busy host for at most one minute.

`stim logs` and `stim logs --errors` pull native device records through bounded
host queries. Concurrent followers share a collection, throttled per session,
without blocking app delivery, viewing or control. Stop limits each log drain to
30 seconds with progress on stderr and stops if neither cursor nor collection
checkpoint advances. The host captures a bounded final tail before deletion,
also on revocation or server close, and stop copies it back afterwards. If that
collection drops a backlog interval and eventually succeeds, a device warning
record names the interval.
A damaged collection checkpoint is ignored and rebuilt; collected records remain
readable. The client waits up to 180 seconds for stop. The final collection and
worker termination paths fit within that wait; an in-flight handoff copy and
closing Metro or view transports are outside those worker bounds. Collected
records remain in the session home; app blobs and materialized bundles are removed.
Native queries read persisted entries, overlap by five seconds and de-duplicate;
info-level or later-persisted entries may be unavailable. JavaScript logs reach Metro.
An older host prints an update note, uses uploads and shows previously copied logs.

Stim Desktop and the phone app show the simulator with an **on &lt;machine&gt;**
label. Turn on **Serve to phones** in Desktop and pair the phone with the client
Mac. Both view and control it through that Mac's local stim-server relay;
neither connects directly to the hosting Mac. Named slots work independently.
Touch and text work in Desktop. Local Simulator.app, rotation, hardware buttons
and simulator options are hidden there. The phone also sends supported buttons,
rotation and the postures reported by the host. Hosted viewing has no replay,
Duo frame rendering or physical-device target. A stopped session shows a rerun
command; an unavailable host reports the connection failure.

`devices.idleShutdownMinutes` does not stop hosted
simulators in this phase; their recorded sessions prevent Metro idle stop.

For agent control, set `hosting.agentDriver` to `agent-device` on the hosting Mac.
Both Macs need agent-device **0.21.20 or later**, with the daemon policy and remote-config contract.
The host starts one loopback daemon per installed session, under an ownership claim
whose child is that daemon. Its policy allows exactly the session's simulator UDID and
refuses shutdown. Stop, close, revocation, reinstall and graceful server close stop
the daemon and invalidate its grant. A server crash can leave detached daemon
processes and claims; restart alone does not prove they stopped. An unexpected exit restarts only that session; rerun
`stim ios` to refresh the rotated grant.
An unresolved proxy or daemon retains its claim and blocks reinstall and native
teardown. Clear a named claim only after proving its owner and child are gone.

`ios.host.agent` reports `driver`, `remoteConfig` and `command`. Plain status prints
`agent: <command>`. Each slot has its own 0600 config under the workspace's Stim
state directory; tokens never appear in placement or status. Use that file:

```bash
agent-device open <bundleId> --remote-config <file>
agent-device snapshot --remote-config <file>
agent-device click <ref> --remote-config <file>
agent-device screenshot --remote-config <file>
```

The command shape is `agent-device <command> --remote-config <file>`. `open`
automatically allocates an `ios-instance` lease through the `proxy` provider in
this session's tenant. The config contains `daemonBaseUrl`, `daemonAuthToken`,
`tenant`, `sessionIsolation`, `runId`, `clientId`, `deviceKey`, `leaseBackend`,
`leaseProvider` and `platform`, with no preallocated `leaseId`. `close` releases
the lease. `stim stop` closes the matching connection and removes that slot's
config once the host confirms stop or revocation. An unreachable host keeps the
config and placement for retry.
The host stops the session daemon and identity-checked agent-device runners
targeting its exact simulator UDID before deleting the simulator, even without `close`.

Allowed commands are `devices`, `open`, `close`, `snapshot`, `diff`, `wait`, `find`, `get`,
`is`, `click`, `fill`, `press`, `type`, `focus`, `scroll`, `screenshot`,
`longpress`, `swipe`, `back`, `home`, `orientation`, `appstate`, `alert` and `batch`.
They inspect and interact with the simulator and its installed apps. `devices`
lists only the session's simulator, filtered by the daemon policy. Its device
claims are session-local and record `/` as the workspace; a host-side agent-device
using the same simulator is not visible to the hosted daemon. Client device
selectors are stripped and requests are pinned to iOS and that UDID; an explicitly
named foreign UDID is refused. Selecting another device, boot/shutdown/erase,
installs, uninstall, uploads, `push`, `record`, `logs`, `network`, `perf`, `trace`,
`clipboard` and `settings` are refused. Stim installs the app; agents cannot
enumerate other host devices or write host files. Ambient client fields (`cwd`,
`stateDir`, `config` and `remoteConfig`) are stripped, including within batch steps.
Host paths and launch inputs (`--out`, baseline, launchConsole, developerDir,
installSource and similar fields) are refused, including within batch steps.
Runtime hints are dropped and only reporting/artifact metadata is forwarded. Screenshots accept agent-device's generated remote temp artifact,
which the client downloads, rather than arbitrary host destinations.

If the setting is `none`, the daemon cannot enforce the policy, or the host
lacks the `hosted-ios-agent` hello feature, agent access stays
`{ driver: 'none', setting: 'hosting.agentDriver' }`. Update the host and check
its agent-device installation and setting. This never grants another device.
Client hello carries only name and version, not features, so the host cannot gate
daemon startup or grant issuance on client support. The client checks the host's
`hosted-ios-agent` feature before using a grant.

Copy this prompt into your coding agent:

```text
Run this workspace's iOS app on janics-mac-mini with stim ios --remote janics-mac-mini.
Use the host's offered simulator architecture, keep Metro here, report launch evidence
and status. Read ios.host.agent from stim status --json, open the app with
agent-device open <bundleId> --remote-config <file>, then snapshot and click through
that config. Run stim stop when finished. If the host refuses, report its reason.
```

## Paired Mac hosting approval

Device-host approval is separate from build offloading and phone control. On the
client Mac, set `hosting.machines` to the expected tailnet names, then run
`stim doctor --fix` in an app directory to request approval. Doctor stores a
separate private, node-pinned credential and reports its state under
`deviceHosts` in JSON. iOS and macOS can run on a named approved Mac.
See [machine settings](/docs/settings#machine-settings).
Stim Desktop can show and approve an expected `device-host` request from
another Mac on your tailnet. The server command is
`stim-server devices grant <id> --device-host`; inspect `stim-server devices`
first, or deny a request with `stim-server devices revoke <id>`.
Hosting approval permits that client's native app code to run in its own
hosted simulators, emulators or macOS app sessions. Approve only an expected client.

Before reserving, an approved client can query the
[hosted availability offer protocol](https://github.com/appandflow/stim/blob/main/packages/server/README.md#hosted-availability-offers)
for an installed iOS or Android SDK choice or the macOS host version, host
architecture, current hosted
reservation capacity, memory pressure, load and free disk on the Stim home
volume. An unavailable or unknown choice carries a decline reason. This query
creates no device or session. Offers are advisory snapshots; reserve still
admits atomically and rechecks native conditions. Ordinary local device
producers do not participate in hosted capacity, and Android AVD storage can
be on a different volume. Named iOS placement uses these offers before building or reserving.

An approved client can reserve, boot, reconnect to and stop its own iOS simulator
through the [hosted session protocol](https://github.com/appandflow/stim/blob/main/packages/server/README.md#hosted-ios-session-protocol).
It can also transfer a digest-verified simulator `.app` bundle and install and
launch it through the [app delivery protocol](https://github.com/appandflow/stim/blob/main/packages/server/README.md#hosted-ios-app-delivery).
The worker checks the expected bundle identity, simulator platform, executable
architecture and minimum OS. Bundle links must stay inside the app. Uploads
resume at recorded byte offsets; replaying a completed app attempt returns its
result without launching twice. Stop and revocation cancel installation before
deleting that exact owned simulator.
Replaying an attempt resolves the same session after a lost reply. Unknown
creation or deletion outcomes retain the reservation until exact reconciliation;
explicit stop and approval revocation delete only that session's exact
ledger-owned simulator. At start, stim-server retires leftover stopped iOS and
Android devices while retaining session homes and records.
Hosted reservations are atomic with each other; ordinary local device producers
do not participate, so this is not a machine-wide hard capacity guarantee.

The worker also accepts an Android reservation with optional installed
`systemImage` and `deviceProfile` selectors. It gives that opaque session a
unique owned AVD and a journal-reserved console port, verifies the exact running
AVD and ABI, and reconnects to that same record. Explicit stop and revocation
delete only that exact ledger-owned AVD and retain its session home and record. Ports are coordinated
among hosted sessions; ordinary local producers can still race a reservation.
Android Metro and screen/input routing remain follow-ups in #2266;
Android sessions refuse the iOS Metro, view and input routes. The
protocol details are in the
[hosted Android session protocol](https://github.com/appandflow/stim/blob/main/packages/server/README.md#hosted-android-session-protocol).

Android app delivery uses the same resumable transfer methods with a single
`App.apk` file and the expected package identity. The worker checks byte digests,
minimum SDK, native ABI and its exact ledger-owned running AVD before install
and launch. An installed app attempt replays without launching twice. An install
or signature conflict refuses without uninstalling an existing app. See the
[Android app delivery protocol](https://github.com/appandflow/stim/blob/main/packages/server/README.md#hosted-android-app-delivery).

The host also accepts `platform: "macos"` without selectors. It reserves one
of 64 app slots and accepts a prebuilt release `.app` with a digest-verified
`Contents/Info.plist` and executable under `Contents/MacOS/`. The worker checks
bundle identity, architecture and minimum macOS version, refuses Apple bundle
identities, URL registrations and update feeds, then stamps
`<bundleId>.hosted<appSlot>` and ad hoc signs the app. The owned macOS supervisor
runs it with a private home and temporary directory; this is not an OS sandbox.
Stop and revocation stop only the recorded processes and remove the last hosted
identity's preferences domain and plist, the private app home and delivered bytes,
keeping logs and receipts. Unresolved sessions retain their app slots.
Until a driver runs, the host reports `agent: { driver: 'none' }` for installed macOS apps, and `stim doctor` on the host names `hosting.agentDriver`.
macOS hosting supports viewing and control of the running app on the host. Metro
is refused; see [macOS placement](./macos.md#run-it-on-another-mac).
See the [macOS session protocol](https://github.com/appandflow/stim/blob/main/packages/server/README.md#hosted-macos-app-sessions).

Development launches remain `unverified` until a Metro bridge proves a bundle
request. Release launches report success only after positive native process
evidence; absent evidence remains `unverified`.

The [private Metro protocol](https://github.com/appandflow/stim/blob/main/packages/server/README.md#private-hosted-metro)
routes the hosted iOS app through worker loopback to its client's verified Metro
over the tailnet. The client gateway accepts only the pinned worker and a
session secret. Reconnect keeps the worker port while its session owner lives;
stop and revocation close the streams. No public tunnel or Funnel is needed.
Expo development clients need the forwarded-origin manifest contract described
in that protocol; older client/CLI versions are not covered by this slice.

Automatic placement and Android Metro and viewing remain in [#2266](https://github.com/appandflow/stim/issues/2266).
This protocol slice does not change where `stim ios` or `stim android` runs.
Hosting approval grants no access to unrelated
workspaces, phone control or build offloading.

The [hosted view and input protocol](https://github.com/appandflow/stim/blob/main/packages/server/README.md#hosted-ios-and-macos-view-and-input)
streams and controls only the approved client's ready, owned iOS simulator or
running macOS app. macOS frames show only the hosted app's window. Viewing is
refused before launch and after exit. On the host, grant Screen & System Audio Recording and
Device Control and Data Access (Accessibility on macOS 26 and earlier) once to the
app that runs stim-server: Stim Host for a server run by
`stim-server service install`, or Stim Desktop. The worker derives
the exact simulator or app identity from its private records and keeps the
capture helper under the session's ownership claim. Reconnect preserves the
native session; subscribe and begin control again. Installation, stop and
revocation close capture and input before native work. An uncertain journal
retains native ownership while ending known capture. Surviving or unresolved
posture input blocks native replacement and teardown after a server crash.
Automatic CLI placement remains under #2266.
