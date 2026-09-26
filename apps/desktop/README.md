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
  confirmation. Status issues are grouped by workspace, live workspaces first,
  then those with an error; past three workspaces the rest collapse behind a
  button. Each issue runs its remedy from the workspace, such as
  `stim android --slot fold`, and can copy it; a `stim guide` remedy is copy
  only. With a `stim` that reports only warning text, `stim android` still
  answers an undetected emulator and `stim stop` a stale supervisor record.
  A workspace whose last iOS or Android run failed (not cancelled) is listed
  with **Open logs** and a rerun of `stim ios` or `stim android` with default
  options; one with errors in its logs since the last marker and no failed run
  is listed with **Open logs**. The sidebar count is the number of listed items
  plus finished pull requests.
- Run: **Run on iOS** and **Run on Android** in a workspace's context menu and
  "..." menu, and **Run** on each platform of the inspector's **Builds**
  section (**Rebuild** when that platform's last build failed), run
  `stim ios` or `stim android` in the workspace with no other arguments, so the
  default slot and configuration. The
  menus offer the platforms with a device or a last build, or both when
  neither is recorded. Run is disabled while a build runs in the workspace.
  **Reload app** runs `stim reload` and is disabled unless the dev server and a
  local device are running.
- Workspace inspector: `stim stop`, and `stim worktree remove` after a
  confirmation that names the worktree and its branch. Each running device,
  in the device tile and the inspector's device list, has its own **Stop**
  button, running `stim stop --slot <name>` (`default` for the workspace's
  default device) so the shared server and other slots keep running --
  `--slot` is per slot, not per platform, so it also stops that slot's
  Android device if the slot holds one.
- Idle devices: when the `stim gc --json` preview lists idle devices, the
  sheet offers **Shut down idle** with a duration (30 minutes to 1 day), then
  runs `stim gc --idle <duration> --json` after a confirmation. That shuts the devices
  down like `stim stop` and never deletes them. The preview marks idle and
  unrecognized `stim-*` devices as kept, because `stim gc --delete` never
  touches them.

**All devices**, **Needs attention** and **Machine** stay pinned at the top of
the sidebar; only the list below them scrolls. The sidebar lists projects as a
tree. Each project expands to its workspaces,
and selecting the project row shows all of its workspaces and devices. Projects
with a live workspace start expanded, and the app remembers each project you
expand or collapse. A workspace is named like in the phone app: after its
worktree's branch, else the worktree's folder, else its project for a main
checkout. The second line is where it sits inside its checkout, such as
`apps/mobile`. The view options button next to the logo opens a menu:

- **Status**: All, Live or Idle workspaces.
- **Projects**: which projects the sidebar lists.
- **Group by**: Project (the tree) or None (one list, each row subtitled with
  its project too).
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
clean branch level with its upstream shows nothing. The inspector's workspace
header shows the same as chips, with "↑4 unpushed" and "↓3 behind" in place of
the arrows, and hovering the row indicator or a chip spells it out.

A linked worktree Stim has not registered yet, listed in `unprovisionedWorktrees`
of `stim status --json`, appears in the sidebar under its project and
is marked "no environment", or with its git state when it has one. The project comes from the entry's `repository`,
so the app does not run git in a worktree that may sit in a macOS-protected
folder. It has no action. Selecting it shows its path and
branch and the `stim start`, `stim ios` and `stim android` commands that create
its environment, each with a Copy button.

Each action opens an activity sheet. While the command runs, the sheet shows a
spinner and its latest progress line; only the CLI's progress labels (`stim
guide lifecycle progress`) count as progress. When it finishes, the sheet
confirms it in one line and closes itself. A failure stays open with the CLI's
message and remedy. Cleanups run `stim gc --delete --json` or `stim gc --idle
--json`, and the sheet summarizes the payload's `results`: what was freed and
deleted, then what gc left alone and what failed, each with its reason. It
stays open until closed. The command and the raw output are under **Details**.
Status follows from the status watch. A finished command triggers a one-shot
`stim status --json` only while the watch is not running, or after a
`stim worktree` command, which can change git worktrees the watch does not
observe. The Machine page,
the toolbar and the autopilot share one `stim gc --json` report. It is marked
stale when an action that can change it finishes (a cleanup, a run, start or
stop, a worktree, port, device lease or setting change), and runs again 2
seconds after the last such action unless a run started since. A reload or a
cleanup preview leaves it alone. Each workspace runs one action at a time.

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
fingerprint sources. **Recent builds** under it discloses the platform's last
10 runs from status `builds`, newest first: how each ended (local cache,
remote cache, compiled, failed, cancelled or interrupted), its duration, miss reason, age and
slot. Clicking a run shows its configuration, fingerprint, phase times,
compiler errors and miss reason popover. When the section opens, it runs
`stim <platform> --plan --json` in the workspace for each platform with a last
build or a device, and shows the result on the platform's row: "Next build:
cache hit (local)", "cache hit (remote)" or "cold build, ~5m 40s", or the
refusal with its remedy. A predicted cold build also shows why from the
plan's `missReason`, with the same popover as the last build's. That builds,
boots and installs nothing, but it fingerprints the project, so a workspace
runs one plan at a time, a result
stays for 60 seconds unless that platform's last build changes, closing the
section stops the plan, and nothing is checked while a build runs; the row
shows the running build instead. **Check** runs the plan again, and the row
shows when it was last checked.

When `stim status` reports a device's `app` as `stopped` (the device is up but
the workspace's app process is gone), its tile shows **App not running** with
**Run**, which runs `stim ios` or `stim android` (with `--slot <name>` for a
named slot). Run appears only on a Stim-owned simulator or emulator, which that
command targets; a physical device gets no Run. The inspector's device list
says **App stopped**. Reload app is disabled when every running local device has a stopped app. An `unknown` app state shows nothing.

Each device tile shows the `activity` that `stim status` reports: "Driven by
<tool> · 12m" while agent-device, a Stim device lock, or a test runner drives
it (on the wall, where the workspace header names every driver once as "Driven
by <tools> · 12m", a driven tile only says "Driven"), "Idle 3h" when nothing has used it for 10 minutes or more, and "Activity
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
shared between processes counts more than once. The toolbar shows free space,
without purgeable space and with the same figure as Machine, on the fullest
volume holding the repositories, `$STIM_HOME`, and CoreSimulator, and
what `stim gc --delete` would reclaim; the reclaimable figure needs a Stim
version with `gc --json`.

## Machine

**Machine** starts with **Now**: what uses the Mac's CPU and memory at this
moment, from the `machine` section of the status watch, which refreshes it
every 15 seconds while something runs. Each row is a booted simulator or
emulator with its workspace (or "Not Stim's"), a workspace's Metro, running
build or `stim web` Chrome, stim-server, or a machine-wide process such as
CoreSimulator services, the adb server or a Gradle daemon. Rows show CPU (100%
is one core) and resident memory, busiest first; each process counts in one
row only. A workspace's owned simulator or emulator has **Shut down**, which
runs `stim stop --slot <slot>`, and its Metro has **Stop**, which runs
`stim stop`. Nothing Stim does not own has an action. Two sparklines above the
list follow the Mac's memory in use and the rows' total CPU while the window
is visible.

Below it, the page shows what uses disk space, largest first,
and what Stim can free. It never blocks on a measurement: the device, runtime
and cache sizes come from `stim gc --json`, and the app sizes only folders
outside `$STIM_HOME` with `du`, each path on its own, three at a time. A path
that takes more than three minutes reads **Unknown**. Sizes are kept for 15
minutes, and **Refresh** measures again. Every size cell shows a size, **None**
when nothing is on disk, an ellipsis while it is measured, **Unknown** when it
could not be sized, or a dash before the first measurement, with the reason in
its help tag.

- **Headline**: free space on the fullest volume against the Stim disk budget
  (`budget.minFreeDiskGb`), and one bar split into Stim devices (owned by a
  workspace, parked or orphaned), Stim caches and outputs (shared caches,
  workspace build outputs, logs and orphaned workspace directories),
  `node_modules`, other simulators and AVDs, runtimes and system images, and
  other tools. A category that is not fully measured shows its total as a lower
  bound (≥).
- **Safe to free now**: one list, largest first, built from `stim gc --json`:
  parked, orphaned and stale owned devices, orphaned workspace directories,
  records of deleted folders, logs over the cap, build outputs of idle
  workspaces, merged worktrees (sized by their `node_modules`, since their build
  outputs and logs are rows of their own) and non-empty shared caches. A row
  that a refreshed report no longer lists is never acted on. Each row carries a
  checkbox and the command that frees it. Rows marked **stim gc** are one unit,
  `stim gc --delete`, which also removes merged worktrees and clears idle build
  outputs; while it is checked, those rows are checked and locked. With it
  unchecked, a worktree row runs `stim worktree remove <path>` in its
  repository and a build-outputs row runs `stim gc --delete --cache
workspaces`. A cache row runs `stim gc --delete --cache <name or directory>`
  and starts unchecked. **Free** previews a selection that is one gc run (`stim
gc --json`, with its `--cache` scope) in the activity sheet, whose **Delete**
  runs the same scope with `--delete`. A selection of several commands lists
  them in a confirmation first and then runs them in order.
- **Projects**: workspaces and linked worktrees that `stim worktree warm` has
  not set up (**Not warmed**), grouped by repository and ranked by total. A
  repository with several worktrees expands into them. Each worktree shows its
  `node_modules` (sized with `du`), owned devices (from the inventory), and
  build outputs and logs (from `stim gc --json`). A trash icon marks build
  outputs `stim gc --delete` clears; a lock marks ones it keeps, with the
  reason. Scissors mark logs `stim gc --delete` trims to their newest 8 MiB; a
  lock marks logs over the cap it keeps. The lifecycle reads **Merged into
  main** from `stim gc --json`, **PR #n open** from `gh pr list` in the
  repository when the GitHub CLI is signed in, **Stale Nd** after 7 days without
  recorded use, **Active**, **Checkout** for a source checkout, or **Folder
  gone**. A row's menu reveals the worktree in Finder or runs `stim worktree
remove` in it, with what that frees: its `node_modules`, build outputs and
  logs. Its devices are parked or deleted by the pool rules, so they are not
  counted. In a narrow window the category
  columns fold into one line under the name.
- **Simulators and emulators**: every simulator and AVD from the `inventory`
  of `stim gc --json`, largest first, with its model, runtime or system image,
  last use and owner: **Stim · <workspace>** (with a named slot),
  **Stim · parked**, **Stim · no workspace**, **Another Stim home** for a
  `stim-*` device this home did not create, or **Yours**. Simulator sizes come
  from simctl; AVD sizes from `du -d 1` of the AVD folder (`~/.android/avd`,
  `ANDROID_AVD_HOME` or `ANDROID_USER_HOME/avd`). The app offers no action on a
  device; the largest 12 show until **Show all**. The CLI's inventory notices,
  such as a listing that timed out, show above the list.
- **Runtimes and system images**: iOS simulator runtimes with the size simctl
  reports, and Android system images sized with `du` of the SDK's
  `system-images`, each with the number of devices that use it. Unused ones
  come first and are marked. **Copy** copies the `xcrun simctl runtime delete`
  or `sdkmanager --uninstall` command the CLI reports; Stim never runs it.
- **Other tools**: Xcode DerivedData, Gradle caches and `~/Library/Caches`,
  measured with `du` for information, with **Reveal**. A Stim cache inside one
  of them is subtracted and counted under Stim instead.

With a `stim` that reports no inventory, the device and runtime sections say to
update `stim`, each workspace's simulators read a dash, and the headline shows
those categories as unknown.

## Autopilot

The **Autopilot** section of the App preferences is on by default. It checks
every minute while the app runs, uses the same action slot as the cleanup the
user starts, so the two never overlap, and records every run with its exit
status under **Autopilot activity**.

- **Shut down idle devices** after 30 minutes to 4 hours (1 hour by default)
  runs `stim gc --idle <minutes>m --json` when `stim status` shows a booted device idle
  that long. It waits while a device the CLI counts as idle has a screen the app
  saw change more recently, because `gc --idle` would shut that device down too.
- **Clean up every night** runs at the chosen hour (3:00 by default), or at
  the next check when the Mac slept through it. It runs
  `stim gc --delete --worktrees --older-than <days> --json`, and **Only what is
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
--json` and runs `stim gc --delete --json` at most once an hour. This run has no age
  limit: it clears the build outputs of every workspace not in use and empties
  the parked device pool. It still keeps a merged worktree in use or active
  within the CLI's `gc.worktreeGraceMinutes`, 2 hours by default, so an agent
  that just merged can finish `stim stop` and `stim worktree remove`.
- **Remove worktrees whose pull request was merged or closed** checks every 5
  minutes and when the app becomes active, at most once a minute. It runs
  `gh pr list --state closed --limit 100 --json headRefName` (the 100 newest
  closed pull requests) in each repository
  with a Stim environment. Only when a linked worktree's branch is among those
  pull requests does it run `stim gc --json`, and it runs it again only when
  that set of worktrees changes, a kept one becomes eligible, or 30 minutes
  pass. It then runs `stim worktree remove <path>` on each worktree gc reports
  as removable because its pull request, whose head is or contains HEAD, was
  merged or closed: clean, with no commit that exists only locally except
  those a merged pull request holds, no live Metro, build or device, and past
  `gc.worktreeGraceMinutes`. Right before that it skips a worktree the latest
  `stim status` shows live, building or on another branch; a `stim start` in the seconds
  between that and `stim worktree remove` would still be stopped. A worktree with a finished pull request that gc
  keeps for another reason is listed under **Finished pull requests** in Needs
  attention, as "PR #123 merged, 2 uncommitted or untracked files", with
  **Open PR** and **Show in Finder**; the autopilot never forces a removal.
  Each run is logged, and the **Autopilot removes worktrees of finished pull
  requests** notification, on by default, reads "Removed 3 worktrees for
  merged PRs". Without `gh`, or signed out, nothing is removed by this option;
  the nightly cleanup still removes worktrees git shows as merged.

While free disk is under the budget, the Machine page shows the plan, such as
"Clear the build outputs of 3 idle workspaces and remove 1 merged worktree to
free about 300 MB", with a **Do it** button that runs `stim gc --delete`, and
the sidebar marks Machine. **Do it** in a notification runs only while disk
is still under the budget, and otherwise opens Machine; the app removes its
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

An Android emulator with a hinge, such as one Stim created with
`--device-profile pixel_fold`, shows its posture as a chip: **Folded**,
**Half open** or **Unfolded**, read from the emulator's gRPC POSTURE physical
model. While Take over is on, the **Posture** menu moves the hinge with the
gRPC `setPosture` call. Folded, the emulator streams only the outer display,
so the tile takes that display's shape and touches address its pixels.

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

**Stim > Settings > Phones** serves Stim to the phone app through
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
reports, so they act on that server's pairing state. When that `STIM_HOME` is
not `~/.stim`, the tab names it and warns that phones paired now are stored
there. This happens when Stim Desktop was launched with another `STIM_HOME`, or
adopted a server started with one. Those phones stop working once Stim Desktop
serves `~/.stim` again.

A read-only phone sees workspaces, devices and logs. A phone allowed to control
can also drive simulators and emulators and run reload and stop.

**Pair a Phone** runs `stim-server pair --json`, with `--control` while **Allow
this phone to control devices** is checked (the default), and shows its
single-use code as a QR code with the time left before it expires, plus the
endpoint and token for manual entry. Changing the option generates a new code;
the previous code stays valid until it expires.
The sheet shows the phone once it pairs. The paired phones list comes from
`stim-server devices --json`: each phone's name, a **Read-only** or **Can
control** badge, its short id, the tailnet node it paired from, when it was last
seen, an **Allow control** checkbox, which runs `stim-server devices grant <id>
--control` or `--read`, and **Revoke**, which runs `stim-server devices revoke
<id>` after a confirmation.

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
**Reset** that unsets the layer. A default `stim` picks per machine, such as
`stim-desktop` for `iosSimulatorApp` while Stim Desktop is installed, shows the
reason `stim` reports, for example `default (Stim Desktop installed)`. Edits run
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
  terminal. It adds `STIM_DESKTOP_APP`, set to the app's bundle path, which
  tells `stim` that Stim Desktop is installed without a Launch Services lookup.

At launch the app runs `stim --version` and needs 1.11.0 or later. When
`stim` is missing, too old, or reports no version, a banner explains Stim and
offers **Install stim** or **Update stim**, which runs `npm install --global
stim@latest` in the activity sheet, and **Choose stim executable…**. `npm` is
the one next to the resolved `stim` when there is one, otherwise the first on
the login shell's `PATH`. A newly found `stim` at another path asks for a
restart, because the app resolves `stim` once at launch. While phones are
served, `stim-server --version` gets the same check, installing
`@stim-cli/server@latest`. Once `stim` is recent enough, the banner offers once
to set `iosSimulatorApp` and `androidEmulatorApp` to `stim-desktop` with
`stim settings set … --scope machine`. It skips a key that is already set or
that the installed `stim` does not list. **Not now** hides the offer for good.

## Develop

```bash
cd apps/desktop
swift run
swift test
```

`Sources/StimDesktop/Design/Tokens.swift` is generated from the phone app's
design tokens in `apps/mobile/src/design/tokens.ts`: spacing, radii, opacity,
the text styles with their macOS sizes from `macosText`, and the light and dark
colors. After changing that file, regenerate it with
`node apps/desktop/scripts/generate-tokens.mjs`. Desktop CI runs the same
script with `--check` and fails when the committed file is stale. The color
names match the phone's; `Palette` colors follow the system appearance and the
app's Appearance setting.

## Build the app

```bash
apps/desktop/scripts/bundle.sh
open apps/desktop/build/Stim.app
```

The bundle copies Inter, JetBrains Mono, and the brand artwork, including the animated jar's Lottie files, from `website/`, and embeds `Lottie.framework` from the `lottie-spm` package and `Sparkle.framework` from the `Sparkle` package in `Contents/Frameworks`.

## Updates

Stim Desktop checks for updates with Sparkle 2 against the appcast at `SUFeedURL` in `Support/Info.plist`, `https://github.com/appandflow/stim/releases/download/desktop-latest/appcast.xml`. **Check for Updates…** in the app menu checks now, and Sparkle checks in the background once the user accepts its prompt on the second launch; **Settings > App > Updates** turns the background checks on or off. `scripts/bundle.sh` writes `SPARKLE_PUBLIC_ED_KEY` from its environment into `SUPublicEDKey`. A build without that key, which includes `swift run` and every dev or test copy, never starts the updater: the menu item stays disabled and the toggle is off.

`scripts/release.sh <version>` builds the signed, notarized universal DMG and zip; see [RELEASING.md](./RELEASING.md).

## Layout

- `Sources/StimKit`: models for the CLI's JSON, the login shell environment, the CLI and `stim-server` clients, project grouping, warning remedies, the streaming runner, `stim logs` records and the follow runner, process, disk and gc usage, the status machine section, the Machine report, free plan and worktree lifecycle, and the autopilot schedule, pressure plan and log. Unit-tested.
- `Sources/SimulatorFrames`: live simulator frames through CoreSimulator, and input through the simulator's CoreDevice HID service (`dtuhidd`) or, when a simulator has none, SimulatorKit's legacy HID client. All of them are private Apple interfaces. Expect Xcode releases to break it.
- `Support/SimFold`: the `sim-fold` helper, an iOS Simulator executable that `scripts/bundle.sh` builds into the app's resources. stim-server builds the same sources to fold an iPhone Duo from the phone.
- `Sources/EmulatorFrames`: live emulator frames through the emulator's localhost gRPC `streamScreenshot` call, found through its discovery file, and input through the same endpoint. An emulator without a hardware keyboard (`hw.keyboard=no`) drops key events, so Desktop types on it with `adb shell input`. Emulators Stim booted before it passed `-grpc` show no frames until their next boot.
- stim-server's `stim-frames` helper compiles the non-view files of both modules, listed in `packages/server/helper/desktop-sources.txt`, together with its own `main.swift`. Desktop CI compiles it, so keep those files free of AppKit views, SwiftUI and StimKit. Desktop and the helper both send keys through `SimulatorHID.hardwareKey`.
- `Sources/StimDesktop`: the SwiftUI app. `Design/` holds the generated tokens, the theme layer over them (`.textStyle(_:)`, `Font.stim(_:)` and the dynamic colors), and the component kit that mirrors the phone's: `.buttonStyle(.stim(_:_:))`, `IconButton`, `Pill`, `Banner` and `ListSection`/`ListRow`. A debug build has **Window > Component Gallery**, which shows every token and component in light and dark.
