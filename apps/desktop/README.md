# Stim Desktop

A macOS app for supervising Stim workspaces: every worktree on the machine,
grouped by project, with its Metro port, supervisor health, errors, build cache
stats, live frames from its iOS simulators and Android emulators, and its CPU
and resident memory.

It reads Stim state only through `stim status --watch --json`, `stim status --json`, `stim stats --json`,
`stim logs --json`, `stim settings --json`, `stim ios|android --plan --json`, and the `stim gc --json` dry run, and never reads or writes `$STIM_HOME`. Its
actions run the `stim` executable with an argument list, never a shell string,
in the workspace directory:

- Needs attention: preview `stim gc --json`, then run `stim gc --delete` after a
  confirmation; `stim stop` or `stim android` for a status warning. Each row can
  also copy its command.
- Workspace inspector: `stim stop`, and `stim worktree remove` after a
  confirmation that names the worktree and its branch. Each running device,
  in the device tile and the inspector's device list, has its own **Stop**
  button, running `stim stop --slot <name>` (`default` for the workspace's
  default device) so the shared server and other slots keep running --
  `--slot` is per slot, not per platform, so it also stops that slot's
  Android device if the slot holds one.
- Idle devices: when the `stim gc --json` preview lists idle devices, the
  sheet offers **Shut down idle** with a duration (30 minutes to 1 day), then
  runs `stim gc --idle <duration>` after a confirmation. That shuts the devices
  down like `stim stop` and never deletes them. The preview marks idle and
  unrecognized `stim-*` devices as kept, because `stim gc --delete` never
  touches them.

**All devices**, **Needs attention** and **Storage** stay pinned at the top of
the sidebar; only the list below them scrolls. The sidebar lists projects as a
tree. Each project expands to its workspaces,
and selecting the project row shows all of its workspaces and devices. Projects
with a live workspace start expanded, and the app remembers each project you
expand or collapse. The view options button next to the logo opens a menu:

- **Status**: All, Live or Idle workspaces.
- **Projects**: which projects the sidebar lists.
- **Group by**: Project (the tree) or None (one list, each row subtitled with
  its project).
- **Sort by**: Last activity, Name or Memory. Last activity is the newest time
  `stim status --json` records for the workspace: device activity, a driver
  attaching, Metro's supervisor or a remote session starting, or a build
  starting, changing phase or ending. Projects sort by their newest workspace
  or their total memory.
- **Show no-environment worktrees**, **Show git status** and **Show empty
  projects** (projects the other options leave with no rows).

The app remembers every choice. The button turns purple with a dot while any
option differs from its default, and the menu then ends with **Reset**. When
the options hide every row, the list says so and offers **Show all** or
**Reset**. Arrow
keys move through the menu, Return picks, and Right and Left open and close a
submenu.

Each workspace row shows its worktree's git state from `stim status --json`: a
dot with the number of uncommitted files, arrows for commits ahead of and
behind the upstream, and **merged** when `gc` would call the branch merged. A
clean branch level with its upstream shows nothing. The workspace header shows
the same as chips, and hovering the row indicator spells it out.

A linked worktree Stim has not registered yet, listed in `unprovisionedWorktrees`
of `stim status --json`, appears in the sidebar under its project and
is marked "no environment", or with its git state when it has one. The project comes from the entry's `repository`,
so the app does not run git in a worktree that may sit in a macOS-protected
folder. It has no action. Selecting it shows its path and
branch and the `stim start`, `stim ios` and `stim android` commands that create
its environment, each with a Copy button.

Output streams into an activity sheet with the exit status, and status refreshes
when the command finishes. Each workspace runs one action at a time.

Status stays current through one long-running `stim status --watch --json`,
which prints a payload each time the state changes, and the toolbar shows
`live` while it runs. If it exits, the app restarts it after a delay that
doubles from 1 to 30 seconds. A `stim` without `--watch` makes the app run
`stim status --json` every 10 seconds instead.

A running build's progress bar carries its cache outcome: "Cache hit" or "Cold
build" once the run has reached install or prebuild, pods or compile, and
"Likely cache hit" or "Likely cold" before that, when `stim status` reports the
outcome of the project's previous run. Its tooltip names how many runs the time
estimate comes from. The workspace inspector's **Builds** section shows each
platform's last build from `lastBuilds` (local cache, remote cache, compiled,
or failed, with its duration and age). A compiled build shows why it missed
the cache from `missReason`; clicking it opens a popover with the changed
fingerprint sources. When the section opens, it runs
`stim <platform> --plan --json` in the workspace for each platform with a last
build or a device, and shows the result on the platform's row: "Next build:
cache hit (local)", "cache hit (remote)" or "cold build, ~5m 40s", or the
refusal with its remedy. That builds, boots and installs nothing, but it
fingerprints the project, so a workspace runs one plan at a time, a result
stays for 60 seconds unless that platform's last build changes, closing the
section stops the plan, and nothing is checked while a build runs; the row
shows the running build instead. The refresh button checks again.

Each device tile shows the `activity` that `stim status` reports: "Driven by
<tool> · 12m" while agent-device, a Stim device lock, or a test runner drives
it, "Idle 3h" when nothing has used it for 10 minutes or more, and "Activity
unknown" when Stim could not read a claim. The app adds one signal the CLI
cannot see: a simulator's screen damage or an emulator's new frame. A screen
that changed in the last 10 minutes clears the idle badge, and an older change
counts toward the idle time. The app sees screen changes only while the tile's
frames are streaming.

Resource usage is measured with `ps` every 3 seconds while the app is active
and its window is on screen: each workspace's
supervisor and Metro process trees plus the `launchd_sim` tree of each of its
simulators (matched by UDID) and the qemu process of each emulator (matched by
AVD name or console port). Memory is the sum of resident sizes, so memory
shared between processes counts more than once. The toolbar shows free space
on the volumes holding the repositories, `$STIM_HOME`, and CoreSimulator, and
what `stim gc --delete` would reclaim; the reclaimable figure needs a Stim
version with `gc --json`.

## Storage

**Storage** at the top of the sidebar shows what uses disk space. It never
blocks on a measurement: sizes load in the background at low priority, are kept
for 15 minutes, and **Refresh** measures again.

- **Workspaces**: each workspace's build outputs, from `stim gc --json`, and its
  `node_modules` and owned simulators and emulators, which the app sizes with
  `du` (`~/Library/Developer/CoreSimulator/Devices/<UDID>` and
  `~/.android/avd/<name>.avd`, or `ANDROID_AVD_HOME`). A trash icon marks build
  outputs `stim gc --delete` clears; a lock marks ones it keeps, with the reason.
  The lifecycle column reads **Merged into main** from `stim gc --json`, **PR #n
  open** from `gh pr list` in the repository when the GitHub CLI is on the login
  shell's `PATH` and signed in, **Stale Nd** after 7 days without recorded use,
  or **Active**. Without `gh` the column still shows merged and stale.
  **Remove merged worktrees** runs `stim worktree remove <path>` for each
  worktree gc reports as merged, after a confirmation. A row's menu reveals the
  worktree in Finder or runs `stim worktree remove` in it.
- **Stim caches and devices**: build outputs of idle workspaces, each shared
  cache, and parked, orphaned or stale owned devices, from `stim gc --json`.
  Each row previews a scoped dry run (`stim gc --json --cache workspaces`,
  `stim gc --json --cache <name>`, or `stim gc --json`) in the activity sheet,
  whose **Delete** runs the same scope with `--delete`.
- **Outside Stim**: simulators Stim does not own, Xcode DerivedData, Gradle
  caches and `~/Library/Caches`, measured with `du` and shown for information
  with **Reveal in Finder**. A Stim cache inside one of them is subtracted and
  listed under Stim instead.
- **Reclaim everything safe** previews `stim gc --json` and runs `stim gc
--delete` after a confirmation.

## Autopilot

The **Autopilot** section of the App preferences is on by default. It checks
every minute while the app runs, uses the same action slot as the cleanup the
user starts, so the two never overlap, and records every run with its exit
status under **Autopilot activity**.

- **Shut down idle devices** after 30 minutes to 4 hours (1 hour by default)
  runs `stim gc --idle <minutes>m` when `stim status` shows a booted device idle
  that long. It waits while a device the CLI counts as idle has a screen the app
  saw change more recently, because `gc --idle` would shut that device down too.
- **Clean up every night** runs at the chosen hour (3:00 by default), or at
  the next check when the Mac slept through it. It runs
  `stim gc --delete --worktrees --older-than <days>`, and **Only what is
  unused for** sets the days, 7 by default. The run removes merged worktrees
  and clean, pushed worktrees idle that long, clears the build outputs of
  workspaces no Stim command has used that long, trims shared cache entries
  unused that long, and deletes owned devices of workspaces unused that long
  and devices parked that long. A workspace used since keeps its build
  outputs, and recently parked devices stay in the pool. The first launch, turning the option on and changing the
  hour only record the time, so none of them starts a cleanup.
- **Reclaim space when free disk is under the Stim budget** compares the free
  space on the volumes Stim writes to, without purgeable space, with
  `budget.minFreeDiskGb` and `budget.hardFloorDiskGb` from `stim settings --json`.
  0 turns the check off, as in the CLI. Under it, the app previews `stim gc
--json` and runs `stim gc --delete` at most once an hour. This run has no age
  limit: it clears the build outputs of every workspace not in use and empties
  the parked device pool.

While free disk is under the budget, the Storage view shows the plan, such as
"Clear the build outputs of 3 idle workspaces and remove 1 merged worktree to
free about 300 MB", with a **Do it** button that runs `stim gc --delete`, and
the sidebar marks Storage. **Do it** in a notification runs only while disk
is still under the budget, and otherwise opens Storage; the app removes its
delivered pressure notifications once free disk is back above the budget. With
autopilot reclaiming, the app posts a
notification after each run. Without it, the app posts the plan once per
episode with a **Do it** button. The **Free disk falls under the Stim budget**
notification is on by default and needs the bundled app.

## Logs

A workspace's detail view has a **Logs** tab next to its device, and the error
count on the device wall and in the inspector opens it with **Errors only** on.
The tab runs `stim logs --json --follow --tail 5000` in the workspace and adds
the filters you pick: the Metro, App (`client`), Native (`device`), Build and
Agent (`agent`, what agent-device did on the workspace's devices) sources, a
slot, a minimum level, a regular expression search (`--grep`), and `--errors`.
With every source selected no `--source` is passed, so **Errors only** keeps
the CLI's default scope, which leaves general device logs and agent actions
out. The Agent source needs a `stim` that has it; an older one refuses
`--source agent` once any chip is off.
Changing a filter or the workspace restarts the command; leaving the tab or
quitting the app terminates it.

The list keeps the newest 50,000 records and drops the oldest past that. It
follows new records until you scroll up, and **Jump to latest** resumes. Each
row shows a record's first line; select one to read its whole message and
stack. Command-C or **Copy** copies the selected records, or every loaded
record when none is selected. **Reveal log folder** opens the workspace's log
directory from `stim status`.

Under the device on the **Device** tab, **Agent actions** lists the latest
agent-device actions on that simulator or emulator, newest first: taps, typing,
app opens, screenshots, and failed commands in red. It runs `stim logs --json
--follow --tail 200 --source agent --slot <slot>` in the workspace and keeps
the records whose `deviceId` is the device's UDID or serial. It shows nothing
until the focused device has an action, and switching devices or tabs
terminates the command.

## Build progress

While `stim ios` or `stim android` runs in a workspace, its header on the wall
and the tile of the device it targets show a progress bar with the build phase,
the elapsed time against the median of that project's comparable runs, and
"about N min left". With no finished run to compare against, the bar is
indeterminate. The figures come from the `build` field of `stim status --json`,
which needs a Stim version that reports it.

## Take over a device

Device frames are view-only until you turn on **Take over** above a booted iOS
simulator or a running owned Android emulator in a workspace's detail view.
While it is on, the app sends that device your clicks and drags as touches,
trackpad scrolls as one-finger drags, and your keys. Turn it off before an agent
drives the device again. Command-key shortcuts stay with the app's menus, and a
mouse wheel without precise deltas does not scroll.

A simulator with more than one display, such as the iPhone Duo, shows every
display side by side, and touches go to the display you click. Only the
display the posture lights shows content; the other stays black. While Take
over is on, **Fold / Unfold** sweeps the simulated hinge to the other posture.
It runs the bundled `sim-fold` helper inside the simulator with `xcrun simctl
spawn`. The helper calls SpringBoard's private display tool service, so the
button appears only in the bundled app, and an iOS release can break it.

Android input goes through the emulator's gRPC `sendMouse` and `sendKey` calls.
Printable ASCII is sent as text; other keys, such as Delete, Return, Tab and the
arrows, are sent as key presses. Control shortcuts are not sent, and an
emulator without a gRPC endpoint cannot be taken over.

## Remote sessions

A workspace with a recorded EAS Simulator session from `stim ios --remote eas`
or `stim android --remote eas` shows a tile with a blue ring. The tile loads the
session's `webPreviewUrl` from `stim status --json` in a web view and marks the
session as billable. Its **Stop** button, in the tile and the inspector's device
list, runs `stim stop` in the workspace after a confirmation, which ends the
session -- a remote session has no per-slot teardown, so its Stop always
targets the whole workspace, unlike a local device's `stim stop --slot <name>`.
A session with no recorded preview URL shows a message instead of the page.

## Phones

**Stim > Settings > Phones** serves Stim to the read-only phone app through
`stim-server` from `@stim-cli/server`. With **Serve to phones** on, the app
checks `http://127.0.0.1:7787/health` at launch. When a server answers, the app
uses it and never starts a second one. Otherwise it runs `stim-server --port
7787` and stops it with SIGTERM when the app quits, or when you turn the
preference off, followed by SIGKILL if it has not exited after 3 seconds. A
killed server leaves its `stim status --watch` child running until that child's
next write fails. A server the app did not start keeps running after the app
quits. `stim-server` is found on the login shell's `PATH`, or at the path you
choose in the same tab. While a server runs, the tab re-checks it every 5
seconds, and the pairing and device commands use the `STIM_HOME` its health
reports, so they act on that server's pairing state.

**Pair a Phone** runs `stim-server pair --json` and shows its single-use code as
a QR code with the time left before it expires, plus the endpoint and token for
manual entry. The sheet shows the phone once it pairs. The paired phones list
comes from `stim-server devices --json`: each phone's name, the tailnet node it
paired from, when it was last seen, and **Revoke**, which runs `stim-server
devices revoke <id>` after a confirmation.

When the server reports that Tailscale is not running, the tab shows the
steps: `tailscale up`, restart the server (a button when the app started it),
then run the `tailscale serve` command the tab shows next. The server reports the
Tailscale state it started with, so the steps stay until it restarts. Until then, the pairing
endpoint is `ws://127.0.0.1:7787` and works only on this Mac, for example from
an iOS Simulator.

While Tailscale runs, the tab shows the route the server's health reports from
`tailscale serve status`, re-read every 5 seconds. A tailnet-only route shows the
endpoint phones connect to, such as `wss://<mac>.<tailnet>.ts.net:7443`.
Without a route, the tab shows the command that serves the server on a
dedicated tailnet-only port, `tailscale serve --bg --https=7443
http://127.0.0.1:7787`, or the next free port when 7443 is taken. When a route
to the server is on a port with Funnel on, the tab says the server is public
and pairing fails with the same explanation; it never suggests a Funnel port.

## Settings

**Stim > Settings** (Command-comma) edits Stim settings and the app's own
preferences.

The **Machine**, **Repository**, **Workspace** and **.stim.json** tabs are
generated from `settings.schema.json`, which the `stim` package ships beside
`dist/cli.mjs`; the app reads the one next to the resolved `stim` executable,
or `packages/stim-cli/dist` under `swift run`. Choices are pickers, booleans
toggles, numbers steppers, paths file pickers, string lists token fields, and
objects JSON fields. Values come from `stim settings --json` run in the chosen
workspace: each row shows the effective value and its layer, the lower layer a
value there overrides, an environment override when one is set, and a
**Reset** that unsets the layer. Edits run
`stim settings set|unset <key> --scope <layer> --json`, and a refusal shows
under the field. `android.keystorePassword` is never shown. Keys Stim does not
read are listed read-only.

The **App** tab holds preferences kept in `UserDefaults`, never in Stim's
config: appearance (Auto, Light, Dark), the sidebar's Status option, opening to all
devices or the last project, device tile size, a live frame rate cap, pausing
frames while the window is hidden, the editor and terminal the workspace
inspector opens, notifications, a menu bar extra with the live workspace count
and quick open, launch at login, the autopilot (see Autopilot), and a `stim` executable override that applies
at the next launch. Notifications and launch at login need the bundled app.

## Requirements

- macOS 14 or later and Xcode 27, selected with `xcode-select` or `DEVELOPER_DIR`. Stim Desktop falls back to `/Applications/Xcode.app` when the selected developer directory has no simulator support.
- `stim` on the login shell's `PATH`, `STIM_BIN` set to its path, or the override in Settings. The cleanup
  preview needs a `stim` with `gc --json`. At launch the app reads the
  environment of `zsh -lic` once and runs every `stim` command with it, so
  commands see the same `PATH` and variables such as `ANDROID_HOME` as a
  terminal.

## Develop

```bash
cd apps/desktop
swift run
swift test
```

## Build the app

```bash
apps/desktop/scripts/bundle.sh
open apps/desktop/build/Stim.app
```

The bundle copies Inter, JetBrains Mono, and the brand artwork from `website/`.

## Layout

- `Sources/StimKit`: models for the CLI's JSON, the login shell environment, the CLI and `stim-server` clients, project grouping, warning remedies, the streaming runner, `stim logs` records and the follow runner, process, disk and gc usage, the Storage report and worktree lifecycle, and the autopilot schedule, pressure plan and log. Unit-tested.
- `Sources/SimulatorFrames`: live simulator frames through CoreSimulator and input through SimulatorKit, both private Apple frameworks. Expect Xcode releases to break it.
- `Support/SimFold`: the `sim-fold` helper, an iOS Simulator executable that `scripts/bundle.sh` builds into the app's resources.
- `Sources/EmulatorFrames`: live emulator frames through the emulator's localhost gRPC `streamScreenshot` call, found through its discovery file, and input through the same endpoint. Emulators Stim booted before it passed `-grpc` show no frames until their next boot.
- stim-server's `stim-frames` helper compiles the non-view files of both modules, listed in `packages/server/helper/desktop-sources.txt`, together with its own `main.swift`. Desktop CI compiles it, so keep those files free of AppKit views, SwiftUI and StimKit.
- `Sources/StimDesktop`: the SwiftUI app and its brand theme.
