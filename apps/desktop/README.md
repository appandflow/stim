# Stim Desktop

A macOS app for supervising Stim workspaces: every worktree on the machine,
grouped by project, with its Metro port, supervisor health, errors, build cache
stats, live frames from its iOS simulators and Android emulators, and its CPU
and memory (the physical footprint `stim status` measures, or resident memory
from an older `stim`).

It reads Stim state only through `stim status --watch --json`, `stim status --json`, `stim stats --json`,
`stim logs --json`, `stim settings --json`, `stim ios|android --plan --json`, `stim doctor --json`, and the `stim gc --json` dry run, and never reads or writes `$STIM_HOME`.
Device replay and a leased physical device's screen, which only stim-server serves, come from the stim-server the
Phones tab runs or found, over loopback; see [Replay](#replay) and [Physical devices](#physical-devices). Its
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
  "..." menu, and **Run** on each platform of the inspector's **Build**
  section (**Rebuild** when that platform's last build failed), run
  `stim ios` or `stim android` in the workspace with no other arguments, so the
  default slot and configuration. The
  menus offer the platforms with a device or a last build, or both when
  neither is recorded. Run is disabled while a build runs in the workspace.
  **Reload app** runs `stim reload` and is disabled unless the dev server and a
  local device are running.
- Workspace page: the "..." menu beside the stage line runs `stim stop`, and `stim worktree remove` after a
  confirmation that names the worktree and its branch. Each running device's
  viewer has its own **Stop** button, running `stim stop --slot <name>` (`default` for the workspace's
  default device) so the shared server and other slots keep running --
  `--slot` is per slot, not per platform, so it also stops that slot's
  Android device if the slot holds one.
- Idle devices: when the `stim gc --json` preview lists idle devices, the
  sheet offers **Shut down idle** with a duration (30 minutes to 1 day), then
  runs `stim gc --idle <duration> --json` after a confirmation. That shuts the devices
  down like `stim stop` and never deletes them. The preview marks idle and
  unrecognized `stim-*` devices as kept, because `stim gc --delete` never
  touches them.

**All devices**, **Needs attention** and **Machines** stay pinned at the top of
the sidebar; only the list below them scrolls. The sidebar lists projects as a
tree. Each project expands to its workspaces,
and selecting the project row shows all of its workspaces and devices. Projects
with a live, warming or ready workspace start expanded, and the app remembers each project you
expand or collapse. A workspace is named like in the phone app: after its
worktree's branch, else the worktree's folder, else its project for a main
checkout. The second line is where it sits inside its checkout, such as
`apps/mobile`. The view options button next to the logo opens a menu:

- **Status**: All, Live or Idle workspaces. Live also shows a workspace with a
  running build, and one that `stim worktree warm` is preparing ("Warming...",
  with an activity indicator) or has prepared before its first run ("Ready").
- **Projects**: which projects the sidebar lists.
- **Group by**: Project (the tree) or None (one list, each row subtitled with
  its project too).
- **Sort by**: Name (the default), Last activity or Memory. Name orders rows by project, then
  workspace title, so rows stay in place while agents work. Last activity is the newest time
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

When **All devices** or a project has nothing running, or a workspace that is
not warming has no device, the page shows three example prompts for a coding agent, picked at
random from the phone app's list each time the page appears, with a **Copy**
button that reads **Copied** once the prompt is on the clipboard.

Each workspace row shows its worktree's git state from `stim status --json`: a
dot with the number of uncommitted files, arrows for commits ahead of and
behind the upstream, and **merged** when `gc` would call the branch merged. A
clean branch level with its upstream shows nothing. Hovering the row indicator
spells it out.

## Workspace page

A workspace's page starts with one line. The **stage line** says where the
workspace is, with a subtitle: **Running** ("up 42m", turning red with "3
errors" or "iOS app closed"), **Building** ("iOS · started 1m ago"), **Build
failed** (the platform and when), **Warming** (the warm step and how long),
**Ready** ("warmed 48m ago") or **Stopped** (when Metro last stopped). While a
build runs, the line adds its phase ("Compiling"), a short bar and the elapsed
time over the estimate ("1:42 / ~2:40"), so a build can be followed with the
inspector hidden. Next comes the **git chip**, which starts with the branch's pull request
from `worktree.pullRequest` as "PR #N" coloured by its state (open green,
draft grey, merged purple, closed red) with one CI mark: a check when every
check passes, a cross when one fails, a dot while some are pending. Without a
pull request it starts with a branch icon. Commits ahead and behind,
uncommitted files, "merged into main" (left out when the pull request itself
is merged) or "no upstream" follow only when there are some.
Clicking it opens a popover with the branch, its upstream, the pull request's
title, checks and review, and **Open on GitHub**. The "..." menu at the end of
the line holds the workspace actions.

The inspector, toggled from the toolbar, holds the workspace's details, in
this order:

- **Build**: one card per platform. While a build runs, its card shows the
  phase or the build tool's step with its counts ("Compiling 45 of 180
  targets"), the elapsed time over the estimate, a bar with a segment per
  phase sized by the reference run, the phase checklist, why the cache missed
  and the last lines of build output (`stim logs --source build`). Otherwise
  it shows the last build with its compiler errors and miss reason, the next
  build from `stim <platform> --plan --json`, **Check** and **Run**. Each card
  lists its recent builds.
- **Resources**: CPU (100% is one core) and memory with charts over the last
  10 minutes the app sampled while on screen, every process that counts
  toward the workspace (simulators and emulators, Chrome, Metro, builds) and
  the disk breakdown. CPU and memory sum the workspace's owners in the status
  `machine` section, or the app's own process sample when that section has
  none for the workspace; disk is the worktree plus Stim's build folder from
  `disk`.
- **Metro & logs**: Metro's port with a health dot, the error count since the
  last marker, the bundle line from `metro.bundle` ("Bundling · 62%",
  "Bundled in 1.8s · 12s ago", "Bundle failed") and **Show logs**.
- **Agents**: the coding-agent sessions associated with the workspace, from
  `agents` and `endedAgents`, earliest started first and without times, so the
  list stays put as processes start and stop.
- **Build cache · project**: the project's hit rate and time saved per
  platform.
- **Warnings**: the workspace's `warnings` from `stim status --json`, when
  there are some.

Below the line, the devices take the rest of the page: every device of the
workspace at once, in the order above, each with its live frame. The frames
share one height, the tallest at which every tile fits the canvas in one row
or a few, wrapping when the window is narrow and scrolling past a floor of 260
points. A tile is a preview: the device's name and state, its activity, its
CPU, memory and disk (from the machine owner matched by slot and kind, and the
device's `disk`) and its screen, which takes no input. A device whose build is
running shows "Waiting for the iOS build" over its frame with the phase, a
thin bar and the elapsed time over the estimate. One whose app process is gone
shows **App not running**, and one whose platform never built here and last
failed shows **No app installed** over its frame instead. A workspace that is
warming with no device yet shows a warming placeholder.

Clicking a tile opens the **device viewer**, a sheet as large as the main
window allows, with a minimum of 560 by 480 points. One toolbar names the
device, its model and its workspace, with the driver or idle badge, **App not
running**, **Physical** and the lease, and the device's CPU and memory when
they fit. On its right are **Run** when the app is not running, **Take over**
(see [Take over a device](#take-over-a-device)), and **Stop** (a simulator,
emulator or remote session; a web page has Open in browser, Reload and Close;
a physical device has none), then the agent actions toggle and Close. The
device sits on a plain canvas, as large as it fits, with its buttons in a
column beside it, and the replay bar (see [Replay](#replay)) runs across the
bottom.

On the right, 360 points wide, the **agent actions** list what agents did on
the device (`stim logs --source agent`), oldest first, with filter chips (All,
Failed and the two most used commands) and a divider for a pause of more than
5 minutes. The action on screen is highlighted and kept in view: the newest
while live, and while replaying the last one at or before the frame shown, or
the one just stepped or clicked to. An action the replay recorded shows a play
icon. Clicking an action shows its level, command, device and whether the
replay recorded it until another action comes on screen, and a recorded one
plays from 1.5 seconds before it; an action the replay did not record only
shows its details. While the list has
the keyboard, Up and Down move through the actions the same way and Space
plays and pauses. **Open in logs** closes the viewer and shows the device's
agent actions in the logs, at the selected action or the one on screen. The toolbar button hides
the list, and the app remembers it; a sheet too narrow for the list and a
420-point canvas hides it too. Physical and remote devices have no list.

Escape releases a device that is taken over, and otherwise closes the viewer;
closing it releases the device too. While the viewer is open, the device's
tile stops streaming and says "Open in the viewer". Tiles on the All devices
wall are previews too; clicking one opens its workspace.

The logs are hidden by default. The toolbar's logs button, which carries the
error count while they are hidden, or **Show logs** in the inspector opens
them in a drawer below the devices, resized by dragging its top edge; the app
remembers both. **Open logs** from Needs attention, a notification or a
workspace menu opens the drawer too.

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
Closing the sheet leaves the command running. The sidebar footer's Operations
item (in the toolbar while the sidebar is hidden) shows a spinner and a count
while commands run and a red dot when a finished one failed and was not
opened. Its popover lists the running commands and the last 20 finished ones of
the session, and each row reopens its sheet.
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
"Likely cache hit" or "Likely cold" before that and while it waits for its
device, when `stim status` may report the outcome of the project's previous
run. Its tooltip names how many runs the time
estimate comes from. The workspace inspector's **Build** section shows each
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
the workspace's app process is gone), its tile shows **App not running**, and
its viewer adds **Run**, which runs `stim ios` or `stim android` (with `--slot <name>` for a
named slot). Run appears only on a Stim-owned simulator or emulator, which that
command targets; a physical device gets no Run. Reload app is disabled when every running local device has a stopped app. An `unknown` app state shows nothing.

A workspace lists its devices like the phone app: running ones first, then
iOS, Android, Web, physical and remote devices, then by slot name. The order
never depends on activity or drivers, so a device keeps its place while an
agent attaches or detaches.

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

## Machines

**Machines** shows this Mac's **Now** and where its builds ran, then one
section per build machine (see [Build machines](#build-machines)), then
**Disk on this Mac**. **Now** is what uses the Mac's CPU and memory at this
moment, from the `machine` section of the status watch, which refreshes it
every 15 seconds while something runs. Each row is a booted simulator or
emulator with its workspace (or "Not Stim's"), a workspace's Metro, running
build or `stim web` Chrome, stim-server, or a machine-wide process such as
CoreSimulator services, the adb server or a Gradle daemon. Rows show CPU (100%
is one core) and memory, largest memory first so rows stay in place
as CPU changes; each process counts in one row only. A workspace's owned simulator or emulator has **Shut down**, which
runs `stim stop --slot <slot>`, and its Metro has **Stop**, which runs
`stim stop`. Nothing Stim does not own has an action. Two sparklines above the
list follow the Mac's memory in use and the rows' total CPU, sampled every 3
seconds while the window is visible, so the CPU line steps with the 15-second
refresh. When workspaces are live but `machine` is missing, the band says live
usage is unavailable instead of listing nothing.

Under **Disk on this Mac**, the page shows what uses disk space, largest first,
and what Stim can free. It never blocks on a measurement: the device, runtime
and cache sizes come from `stim gc --json`, and the app sizes only folders
outside `$STIM_HOME` with `du`, each path on its own, three at a time. A path
that takes more than three minutes reads **Unknown**. Sizes are kept for 15
minutes, and **Refresh** measures again. Every size cell shows a size, **None**
when nothing is on disk, an ellipsis while it is measured, **Unknown** when it
could not be sized, or a dash before the first measurement, with the reason in
its help tag.

The processes under **Now**, **Safe to free now**, **Projects**,
**Simulators and emulators** and **Runtimes and system images** each have a
header with a disclosure chevron and a count. A collapsed section shows only
its header. An expanded one shows its first 10 rows in their usual order, then
**Show all** or **Show fewer**. For **Projects** the 10 are repositories; an
expanded repository lists all of its worktrees. An expanded **Safe to free
now** always lists every row, so none of the rows **Free** acts on are hidden.
Free still previews or confirms its commands first, collapsed or not. The app
remembers each section's choices in its own preferences.

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
  device. The CLI's inventory notices,
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

A workspace's page shows its logs beside the devices, or on a **Logs** tab when
the page is narrow. The Logs card and the error count on the device wall open
them, with **Errors only** on when there are errors.
The tab runs `stim logs --json --follow --tail 5000` in the workspace and adds
the filters you pick: the Metro, App (`client`), Native (`device`), Build and
Agent (`agent`, what agent-device did on the workspace's devices) sources, a
slot, a minimum level, a regular expression search (`--grep`), and `--errors`.
With every source selected no `--source` is passed, so **Errors only** keeps
the CLI's default scope, which leaves general device logs and agent actions
out. The Agent source needs a `stim` that has it; an older one refuses
`--source agent` once any chip is off.
Changing a filter or the workspace restarts the command; hiding the logs or
quitting the app terminates it.

The list keeps the newest 50,000 records and drops the oldest past that. It
follows new records until you scroll up, and **Jump to latest** resumes. Each
row shows a record's first line; select one to read its whole message and
stack. Command-C or **Copy** copies the selected records, or every loaded
record when none is selected. **Reveal log folder** opens the workspace's log
directory from `stim status`.

The viewer's agent actions are the agent-device actions on that simulator or
emulator: taps, typing, app opens, screenshots, and failed commands in red. On
the Web device they are the clicks, typing and scrolls an attached tool such as
Playwright sent to the page. The viewer runs
`stim logs --json --follow --tail 200 --source agent --slot <slot>` in the
workspace and keeps the records whose `deviceId` is the device's UDID or
serial, or the page's DevTools target, up to 200; closing the viewer
terminates the command. An action sits on the replay where it started, at the
record's `startedAt` when agent-device reported one, like its marker.
**Open in logs** switches the Logs tab to the Agent source of the device's
slot, clears the level, search and **Errors only** filters, and scrolls to and
selects that action's record.

## Build progress

While `stim ios` or `stim android` runs in a workspace, its header on the wall
shows a progress bar with the build phase, the elapsed time against the median
of that project's comparable runs, and "about N min left". On the workspace
page, the header line shows the phase, a short bar and the elapsed time over
that estimate, the device it targets shows the same over its screen, and the
inspector's **Build** section shows the phase checklist. With no finished run
to compare against, the bars are indeterminate. The figures come from the `build` field of `stim status --json`,
which needs a Stim version that reports it.

## Take over a device

Device frames are view-only until you turn on **Take over** (the hand button)
in the device viewer of a booted iOS simulator or a running owned Android
emulator. Only the device open in the viewer can be taken over, and closing the
viewer releases it.
While it is on, the app sends that device your clicks and drags as touches,
trackpad scrolls as one-finger drags, and your keys. Turn it off before an agent
drives the device again. Command-key shortcuts stay with the app's menus, and a
mouse wheel without precise deltas does not scroll.

A column beside the screen of a running simulator or emulator has its
hardware buttons and rotation: **Home** and **Lock** on a simulator, sent
through the simulator's HID service; **Home**, **Back**, **Apps** and **Lock**
on an emulator, sent with gRPC `sendKey` (Lock, and every button on an emulator
without a hardware keyboard, with `adb shell input keyevent`); then **Rotate
left** and **Rotate right**. The hardware buttons press only while the device
is taken over; rotation works at any time.

A simulator with more than one display, such as the iPhone Duo, shows every
display side by side, and touches go to the display you click. Only the
display the posture lights shows content; the other stays black. **Folded**,
**Half open** and **Unfolded** in the column move the simulated hinge to 0,
120 or 180 degrees, as the posture buttons in Xcode's Device Hub do. They sweep
the angle through the simulator's vendor-defined HID service
(`com.apple.coredevice.feature.remote.hid.vendordefined`), which iOS needs to
swap panels; the path is adapted from
[Siniulator](https://github.com/kmagiera/Siniulator) under its MIT licence.
The lit panel cannot tell Half open from Unfolded, so the selected button and
the posture chip show the open posture Stim Desktop last set. On a
CoreSimulator without that service the column shows **Fold / Unfold** instead,
which runs the bundled `sim-fold` helper inside the simulator with `xcrun
simctl spawn` to toggle SpringBoard's private display tool service; it appears
only in the bundled app, and an iOS release can break it.

An Android emulator with a hinge, such as one Stim created with
`--device-profile pixel_fold`, shows its posture as a chip: **Folded**,
**Half open** or **Unfolded**, read from the emulator's gRPC POSTURE physical
model. The **Posture** menu in the button column moves the hinge with the
gRPC `setPosture` call. Folded, the emulator streams only the outer display,
so the viewer takes that display's shape and touches address its pixels.

Android input goes through the emulator's gRPC `sendMouse` and `sendKey` calls.
Printable ASCII is sent as text; other keys, such as Delete, Return, Tab and the
arrows, are sent as key presses. Control shortcuts are not sent, and an
emulator without a gRPC endpoint cannot be taken over.

## Web

A workspace where `stim web` runs shows its Stim-owned Chrome as a **Web** tile
on the wall and on the workspace page, labelled with the page's URL,
the in-app route (`web.page.route`) when one moved it after the load.
Desktop reads the page's frames itself, over the loopback DevTools endpoint
`stim status --json` reports, and connects only when Chrome reports the pid
status names. **Take over** sends clicks, drags, hover, trackpad scrolls and
keys to the page; Command shortcuts stay with the Mac. The viewer's buttons open
the URL in your default browser (never the Stim profile), run `stim reload web`,
and **Close** runs `stim stop --slot web`, which keeps Metro, the devices and the
profile. A failed page load shows a "Page failed to load" pill and a Needs
attention item that reruns `stim web`, and a tool attached to the DevTools
endpoint, such as Playwright MCP, shows as the driver.

## Replay

While a stim-server runs on port 7787 (**Serve to phones**, see [Phones](#phones)),
each simulator, emulator and web page's device viewer offers a replay bar
once the server has recorded it,
like the phone app's device viewer. Stim Desktop connects to that server at
`ws://127.0.0.1:7787`. The first time, it runs `stim-server pair --json --control` for a
token, spends it as a device named "Stim Desktop", and keeps the
device token in a file only you can read under `~/Library/Application
Support/Stim Desktop/stim-server/`, one per Stim home. A Stim Dev build (see
[Build the app](#build-the-app)) pairs as "Stim Dev" and keeps its token under
`~/Library/Application Support/Stim Dev/stim-server/`, so revoking one app's
pairing leaves the other's. A source build or `swift run` from before Stim Dev
paired as "Stim Desktop"; Stim Dev does not reuse that pairing, which stays in
`stim-server devices` until you revoke it. The server issued it to
a loopback connection, so it refuses the token from any other node. When the
server no longer knows the token, the app pairs once more, so revoking it with
`stim-server devices revoke` lasts only until the next connection; turn off
**Serve to phones** to stop it. A read-only pairing from an earlier version gets
control through `stim-server devices grant <id> --control` once, then the app
reconnects. The Phones list leaves both apps' devices out.

The app polls `replay.range` every 10 seconds while the viewer shows. The bar has
**Live**, play and pause, a 1x or 2x speed, and a track of the recorded spans
with each unrecorded gap at a fixed width. Agent actions, errors and crashes
are markers; hovering one shows its time, command and log line, and clicking
near one lands 1.5 seconds before it. The buttons on each side of play step to the previous or
next agent action, landing the same way; errors are skipped, and next with no
later action goes live while the device runs. They are disabled while live and
when no action lies that way. Hovering the track also shows a still
frame above the time: the keyframe that starts the recorded segment of about
5 seconds there, from `replay.keyframe`, so the preview can be up to about 5
seconds early. The app decodes it on its own queue, apart from playback, keeps
the last 200 segments' frames, and also fetches the two segments on each side
of the one hovered; hovering never seeks. The frame's box appears once the
first keyframe arrives, sized to it, so a server without `replay.keyframe`
shows the time alone. A keyframe that fails to decode is not asked for again. Dragging shows the frame under the
pointer. The first seek opens a `frames.subscribe` with `video: ["h264"]` and
`at`, which also works for a device that is not running; later seeks send
`frames.seek`. The app decodes the H.264 itself. A server that answers without
H.264 cannot replay, and the bar says so. **Live** closes the subscription and
shows the device's own live screen again. Take over is disabled while
replaying, and a seek releases it. After a lost connection the replay resumes,
paused at the frame shown.

The bar shows **Recording** while the server records the device, and **Replay
off** when `stim status --json` reports `recording.enabled` false for the
workspace. Physical and remote devices have no replay. **Record device screens
for replay** in **Stim > Settings > Phones** runs `stim settings set
recording.enabled true|false --scope machine`; turning it off asks first,
because it deletes the recordings.

## Remote sessions

A workspace with a recorded EAS Simulator session from `stim ios --remote eas`
or `stim android --remote eas` shows a tile with a blue ring. The tile loads the
session's `webPreviewUrl` from `stim status --json` in a web view and marks the
session as billable. Its **Stop** button, in the viewer, runs `stim stop` in the workspace after a confirmation, which ends the
session -- a remote session has no per-slot teardown, so its Stop always
targets the whole workspace, unlike a local device's `stim stop --slot <name>`.
A session with no recorded preview URL shows a message instead of the page.

## Physical devices

A physical iPhone, iPad or Android phone the workspace leases with
`stim ios --device`, `stim android --device` or `stim device lock` shows as its
own tile, from the environment's `physicalDevices` in `stim status --json`, next
to any simulator or emulator in the same slot. The tile names the device and
its model, carries a **Physical** pill and "Leased · 42m left", and counts
as running while the Mac reaches the device. It has no Stop and no rotate
buttons. A lease alone puts the workspace under Live.

The tile streams the device's screen from the local stim-server (see
[Replay](#replay) for the connection) with `frames.subscribe`, `physical:
true` and `video: ["h264"]`, as the phone app does, and decodes the H.264
itself. An iPhone streams only over a USB cable and is view only. An Android
phone streams over adb, and **Take over** in the viewer sends clicks and drags as touches,
trackpad scrolls as one-finger drags, and typed ASCII, Return, Tab and Delete
as text, through a `control.begin` session with `physical: true`. While taken
over, the viewer shows Home, Back, Apps and Lock buttons. The server accepts
control only from the workspace that holds the lease, and never takes or
renews a lease itself.

Instead of a screen, the tile says:

- **Turn on Serve to phones** while no stim-server runs, or why the server is
  unreachable.
- **Update stim-server** with the install command when the server's hello
  lacks `physical-ios` or `physical-android` for the device.
- **Disconnected** when `stim status` reads the device as disconnected.
- **The workspace's lease on this device ended**, with the `--device` command
  that leases it again, once the lease's end time passes, before `stim status`
  drops the tile.

A delayed stream shows the server's reason, such as a locked iPhone. When the
server ends control (no input for 5 minutes, the device gone, the lease
ended), Take over turns off and the tile says why.

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
choose in the same tab. A test copy can move the port from 7787 with
`defaults write <bundle id> stimServerPort -int <port>`, so it never adopts
the Mac's own server. While a server runs, the tab re-checks it every 5
seconds and the app every 10 seconds while it is active, otherwise every 60
seconds. When a server the app did not start misses two checks in a row, the app starts its
own while **Serve to phones** is on. The pairing and device commands use the
`STIM_HOME` its health reports, so they act on that server's pairing state. When that `STIM_HOME` is
not `~/.stim`, the tab names it and warns that phones paired now are stored
there. This happens when Stim Desktop was launched with another `STIM_HOME`, or
adopted a server started with one. Those phones stop working once Stim Desktop
serves `~/.stim` again.

A read-only phone sees workspaces, devices and logs. A phone allowed to control
can also drive simulators and emulators and run reload and stop.
An iPhone that turns on notifications gets push notifications from the server
while **Serve to phones** is on, even when the app on the phone is closed; see
[Push notifications](../../packages/server/README.md#push-notifications).

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
<id>` after a confirmation. Macs that build here are listed apart, under
**Macs that build here**, without the checkbox: a Mac waiting for approval shows
**Waiting for you** with the time its request lapses, **Review...** and **Deny**; an
approved one shows **Can build** and **Revoke**. See
[Build machines](#build-machines).

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

## Build machines

Another Mac on the tailnet can build for this one once a person on it approves
this Mac (see [Build access](../../packages/server/README.md#build-access)).

On the Mac that wants to build elsewhere, **Stim > Settings > Build Machines**
lists the entries of the `offload.machines` machine setting, each with its
state from the `buildMachines` field of `stim doctor --json --platform ios`:
**Approved**, **Waiting for approval** (with the request id), **Not asked**,
**Revoked** (revoked, denied, or the request lapsed), **Different Mac** (the
name now belongs to another tailnet node than the one this Mac asked, so Stim
does not connect to it), **Not on the tailnet**, **Tailscale is off**,
**Unreachable** or **Not a tailnet name**. Doctor runs in the first workspace
`stim status` lists, like the doctor checks under Needs attention; with no
workspace listed, the tab says so. While a machine waits for approval the tab
checks again every 15 seconds. Below, **Macs on your tailnet** lists the other
online macOS peers from `tailscale status --json` whose `tailscale serve` route
on port 7443 answers `GET /health` as stim-server. **Use for Builds** adds a Mac
to the setting with `stim settings set offload.machines <list> --scope machine`
and asks it with `stim doctor --json --platform ios --fix`, which also asks
again any listed Mac that has not approved this one. **Ask** and **Ask Again**
run the same `--fix`. **Remove** takes a Mac out of the setting after a
confirmation, unsetting it when the list is empty; removing a **Different Mac**
also runs `--fix`, which forgets the old node so the Mac can be asked again.

On the Mac that builds, the app checks `stim-server devices --json` every 10
seconds while a server runs. Each new build request adds "<Mac> wants to build
on this Mac" to **Notifications** (category **A Mac asks to build here**,
Alert by default) and shows it as a card or a macOS notification. Its
**Review** opens a dialog with the Mac's name, its tailnet node and user, the
request id and when it lapses, and what building here allows. **Allow** runs
`stim-server devices grant <id> --build`, **Deny** runs `stim-server devices
revoke <id>`, and **Later** closes the dialog; Allow is never the default
button, and nothing approves a request without it. The card and the macOS
notification go away once the request is answered or lapses.

The **Machines** page shows where builds ran. While `offload.machines` names a
machine, **Where builds ran** under **This Mac** counts today's compiling builds that built here, on a build machine, or
here after trying one, and lists the latest placements with the reason Stim
gave, such as `load 0.6/core, 1 of 3 build slots busy here`. Then each
`offload.machines` entry has its own section: its state and first reason from
doctor (the same check as Settings, each minute while the page is open), its
load per core, cores, offloaded builds running and free disk from its offer,
and the builds it ran for this Mac today and in total, their average time, the
time they saved against this project's last build here (an estimate), and the
fallbacks. Below are its latest placements. The counts and placements come from
`stim stats --json` run in the home directory. **Pair or remove build machines
in Settings** opens **Build Machines**; the page itself changes nothing.

## Notifications

Stim Desktop notifies with the phone app's oversight rules
(`packages/server/src/oversight.ts`, ported to `StimKit/Oversight.swift`), run
on each `stim status --watch --json` payload and every 30 seconds: **Work
started** (a workspace begins warming, or an agent starts driving a device),
**Agent looks stuck** (a driven workspace with no agent activity for the stuck
threshold), **Agent repeats the same failure** (the third build failure in a row
with the same cause), **Work finished or PR ready** (an agent stopped after a
green build, or git finds the branch merged), and **Machine in trouble** (free
disk under Stim's floor, or critical memory pressure for a minute). Each
workspace notifies once per episode, and a later notification replaces the
earlier one. The first payload after launch records what is already true without
notifying. Desktop does not look up pull requests, so it never notifies a pull
request ready for review; a merged branch notifies once git finds it merged. The
phone's "Someone takes over your device" is a push to a phone and never fires
here. A phone controlling a simulator
through stim-server counts as an agent driving it, because Desktop cannot read
stim-server's leases.

Each category has a level, with the phone's names: **Alert**, **Silent** or
**Off**. Every category is Silent by default, except **A Mac asks to build
here**, which is Alert because a request lapses after 15 minutes. An Alert
appears as a card in the main window's top right corner while that window is in
front, newest on top, with its call to action (**Open workspace**, **Show
device**, **Show page**, **Show build**, **Show machine**) and a dismiss button; clicking the
card opens its target. Work started and finished cards leave after 6 seconds,
unless the pointer is over them; stuck, repeated failure and machine cards stay
until dismissed. Otherwise an Alert is a macOS notification with sound, and
clicking it brings Stim Desktop up on the target. macOS asks for permission the
first time one is posted. Silent and Off never interrupt.

Every notification also lands in **Notifications**, pinned in the sidebar with
the unread count: newest first, grouped by day, each row with its category icon,
title, body, time and the same call to action. Clicking a row, a card's action
or a macOS notification opens the target and marks the row read. An Off category
is listed as **Muted**, and an Alert held by quiet hours as **Quiet hours**, as
in the phone app's inbox. The page filters by category and by workspace (or the
machine), and **Mark all read** and **Clear** act on what the filters show. The
history keeps the last 200 notifications from the last 7 days in
`notifications.json` in Stim Desktop's Application Support folder.

Build requests from other Macs also land here; see [Build machines](#build-machines).

**Settings > App > Notify when** sets each category's level, the stuck threshold
(5 to 60 minutes, 15 by default) and quiet hours, stored in `UserDefaults`.
During quiet hours an Alert is delivered as Silent. The rules always run every
category without quiet hours, so switching a category on later does not notify
what it missed.

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

## Window and shortcuts

Closing the main window, with Command-W or the close button, leaves the app
running: the Dock icon stays, the status watch, notifications, autopilot and
`stim-server` keep working, and clicking the Dock icon or choosing **Open Stim**
in the menu bar extra reopens the window. There is one main window; Command-N
does not open another. **Quit Stim** (Command-Q) is the only way to stop the app,
and it stops `stim-server` and the log followers. Command-1, Command-2 and
Command-3 in the View menu open All devices, Notifications and Machine.

## Workspace links

`stim-desktop://workspace?path=<workspace>[&platform=<ios|android|web>][&slot=<name>]`,
which `stim worktree warm`, `start`, `ios`, `android` and `web` print, shows a
card for that workspace with **Open**; the app navigates only when Open is
clicked. A malformed link, or a path `stim status` does not list within 10
seconds, shows **Workspace not found**; if the workspace appears within the
next minute, its card replaces that one. Another link to the same workspace
replaces its card. With the main window closed, the link reopens it.

- macOS 14 or later and Xcode 27, selected with `xcode-select` or `DEVELOPER_DIR`. Stim Desktop falls back to `/Applications/Xcode.app` when the selected developer directory has no simulator support.
- `stim` on the login shell's `PATH`, `STIM_BIN` set to its path, or the override in Settings. The cleanup
  preview needs a `stim` with `gc --json`. At launch the app reads the
  environment of `zsh -lic` once and runs every `stim` command with it, so
  commands see the same `PATH` and variables such as `ANDROID_HOME` as a
  terminal. It adds `STIM_DESKTOP_APP`, set to the app's bundle path, which
  tells `stim` that Stim Desktop is installed without a Launch Services lookup.

At launch the app runs `stim --version` and needs 1.11.0 or later. When
`stim` is missing, too old, or reports no version, a banner explains Stim and
offers **Install stim** or **Update stim**, and **Choose stim executable…**.
**Update stim** runs the package manager that owns the resolved `stim`: the
app resolves the `stim` file through symbolic links and pnpm shims and checks
it against `npm prefix -g`, `pnpm root -g` and `bun pm bin -g`, and runs
`npm install --global`, `pnpm add --global` or `bun add --global` with
`stim@latest`. A `stim` outside every manager's global directory, such as a
linked checkout or a project-local copy, gets no Run button and a note, since
the app cannot tell what installed it. **Install stim** uses the manager picked
in the setup guide's tabs; the banner uses the default, pnpm or bun when its
global bin directory is on the login shell's `PATH`, else npm. A pnpm whose
global bin directory is not on the `PATH` is not offered, because pnpm refuses
global installs then. `stim-server` is still installed and updated with npm. A newly found `stim` at another path asks for a
restart, because the app resolves `stim` once at launch. While phones are
served, `stim-server --version` gets the same check, installing
`@stim-cli/server@latest`. Once `stim` is recent enough, the banner offers once
to set `iosSimulatorApp` and `androidEmulatorApp` to `stim-desktop` with
`stim settings set … --scope machine`. It skips a key that is already set or
that the installed `stim` does not list. **Not now** hides the offer for good.

### Setup guide

The first launch opens a setup guide over the main window, unless everything it
sets up is already in place; **Help > Setup
Guide…** and **Open Setup Guide…** in **Settings > App** reopen it. Each step
shows what it found, the exact command its **Run** button runs with the
directory it runs in, and that command's output. Nothing runs until Run is
pressed, commands run one at a time through the same runner as the banner, and
the step checks again when the command ends. Return presses the step's Run
button, or **Continue** once the step is done, and never skips a step; Escape is **Set Up
Later**.

1. **Welcome**.
2. **Install the CLI**: `node --version` from the login shell must report
   22.12.0 or later. Without it, the step offers `brew install node` when
   `brew` is on the `PATH`, else a link to nodejs.org. Then it
   shows tabs for npm, pnpm and bun, only for the managers on the `PATH`
   (the default is pnpm or bun when its global bin directory is on the `PATH`,
   else npm), and runs `npm install --global stim`, `pnpm add --global stim`
   or `bun add --global stim` in the home folder, then shows the `stim` found
   afterwards with its version. A `stim` that no manager owns shows a note
   instead of a Run button. A `stim` the app did not resolve at launch
   asks for a restart, which reopens the guide on the same step. Checks use
   the `PATH` captured at launch, so a Node.js installed into a new
   directory, as nvm does, needs a restart to be found.
3. **Add the agent skill**: `npx skills add appandflow/stim --yes` in the
   home folder, where the skills CLI's project scope is the user's own agent
   folders. `--yes` keeps the skills CLI from asking which agents to install
   to, which fails without a terminal. It counts as installed when `~/.agents/skills/stim/SKILL.md`,
   `~/.claude/skills/stim/SKILL.md` or `~/.codex/skills/stim/SKILL.md` exists.
4. **Notifications**: asks macOS for permission, or opens System Settings
   after a denial, and sets the level of the notifications that ask for you.
5. **Check your setup**, optional: `xcodebuild -version` and `java -version`,
   the Android SDK found the way `stim` finds it, and `stim doctor --json` in a
   project folder the user chooses, which needs the restart above first. The
   findings show as rows with their severity, detail and fix, and the raw
   output stays behind a disclosure. A finding whose fix names
   `stim doctor --fix` gets a Fix button that runs that command after the
   confirmation the Needs attention page uses, then runs doctor again. The
   step shows a green check once the three commands ran this session and
   doctor reported no finding that costs time, and the warning mark when one of
   them failed or doctor reported such a finding.
6. **You're set**: the state of steps 2 to 4.

When the CLI, skill and notifications are already set up at a launch without
`setupGuide.completed`, the app sets the flag and does not show the guide;
opened from the menu, it starts on the summary. **Start Using Stim** or **Set
Up Later** also sets the flag, which lives in the app's `UserDefaults`, so Stim
and Stim Dev each track their own. The `stim` banner stays
hidden while the guide is open.

## Develop

```bash
cd apps/desktop
swift run
swift test
```

`scripts/format.sh` formats the Swift sources with `swift-format` from the
Xcode toolchain, tuned by `.swift-format`; `scripts/format.sh --check` runs
the same rules as a lint, which is what desktop CI runs. CI also builds and
tests with `-Xswiftc -warnings-as-errors`, so fix a warning instead of
introducing one.

`Sources/StimDesktop/Design/Tokens.swift` is generated from the phone app's
design tokens in `apps/mobile/src/design/tokens.ts`: spacing, radii, opacity,
the text styles with their macOS sizes from `macosText`, and the light and dark
colors. `Sources/StimDesktop/AgentPrompts.swift` is generated from the phone
app's empty-state prompts in `apps/mobile/src/lib/agent-prompts.ts`. After
changing either file, regenerate both with
`node apps/desktop/scripts/generate-tokens.mjs`. Desktop CI runs the same
script with `--check` and fails when a committed file is stale. The color
names match the phone's; `Palette` colors follow the system appearance and the
app's Appearance setting.

## Build the app

```bash
apps/desktop/scripts/bundle.sh
open "apps/desktop/build/Stim Dev.app"
```

`bundle.sh` builds **Stim Dev**, a variant that runs next to the installed
release app: bundle id `dev.stim.desktop.dev`, `build/Stim Dev.app`, the phone
app's orange Stim Dev icon (`Support/AppIcon-Dev.icns`), and no update feed,
Sentry DSN or `stim-desktop` URL scheme. It has its own `UserDefaults`, login
item, notification permission and notification history, and pairs with
stim-server under its own name (see [Replay](#replay)). Both apps use port
7787, so the one that starts second uses the other's server instead of starting
one; when that app quits, the remaining one starts its own within two minutes while
**Serve to phones** is on. Paired phones and the `tailscale serve` route keep working
because they belong to the Stim home, not to either app. Both apps run their
autopilot. `stim ios` and `stim android` open device links with `open -a Stim`,
which reaches the release app, never Stim Dev.

`bundle.sh --release` builds the release variant, `build/Stim.app` with bundle
id `dev.stim.desktop`, which `scripts/release.sh` and the release workflow use.

The bundle copies Inter, JetBrains Mono, and the brand artwork, including the animated jar's Lottie files, from `website/`, and embeds `Lottie.framework` from the `lottie-spm` package and `Sparkle.framework` from the `Sparkle` package in `Contents/Frameworks`. Sentry is linked into the executable. Resolving the `sentry-cocoa` package downloads every xcframework it declares, about 450 MB, and extracts about 3 GB into `.build/artifacts` ([getsentry/sentry-cocoa#9146](https://github.com/getsentry/sentry-cocoa/issues/9146)).

## Updates

Stim Desktop checks for updates with Sparkle 2 against the appcast at `SUFeedURL` in `Support/Info.plist`, `https://github.com/appandflow/stim/releases/download/desktop-latest/appcast.xml`. **Check for Updates…** in the app menu checks now, and Sparkle checks in the background once the user accepts its prompt on the second launch; **Settings > App > Updates** turns the background checks on or off. `scripts/bundle.sh --release` writes `SPARKLE_PUBLIC_ED_KEY` from its environment into `SUPublicEDKey`. A build without that key, which includes `swift run`, every Stim Dev build and every test copy, never starts the updater: the menu item stays disabled and the toggle is off.

`scripts/release.sh <version>` builds the signed, notarized universal DMG and zip; see [RELEASING.md](./RELEASING.md).

## Crash reports

Stim Desktop reports crashes and uncaught exceptions to Sentry with sentry-cocoa, linked statically from its `Sentry` product. It starts Sentry only when the bundle's Info.plist carries a DSN in `StimSentryDSN`. The DSN is not in the repository: `scripts/bundle.sh --release` writes it from the environment, so `swift run`, `swift test`, Stim Dev, a bundle built without it, forks and CI report nothing and send nothing.

| Variable                  | Used by     | Effect                                                                                             |
| ------------------------- | ----------- | -------------------------------------------------------------------------------------------------- |
| `STIM_DESKTOP_SENTRY_DSN` | `bundle.sh` | With `--release`, written into `StimSentryDSN`. Empty or unset turns crash reporting off.          |
| `SENTRY_AUTH_TOKEN`       | `bundle.sh` | With `--release`, the two below and `sentry-cli` on `PATH`, uploads the app's dSYM after bundling. |
| `SENTRY_ORG`              | `bundle.sh` | The Sentry organization slug for the dSYM upload.                                                  |
| `SENTRY_PROJECT`          | `bundle.sh` | The Sentry project slug for the dSYM upload.                                                       |
| `STIM_DESKTOP_CRASH_TEST` | the app     | `exception` raises an uncaught NSException and `crash` traps, 3 seconds after launch.              |

Without all three upload variables or `sentry-cli`, `bundle.sh --release` prints one line to stderr and skips the upload; a failed upload never fails the bundle. The dSYM is made with `dsymutil` from the bundled executable, so its UUIDs match the binary that `scripts/release.sh` later signs.

An event carries the release `stim-desktop@<CFBundleShortVersionString>+<CFBundleVersion>` and the dist `<CFBundleVersion>`, read at launch. Sentry runs with `sendDefaultPii` off, tracing, session tracking, app hang tracking, network breadcrumbs and failed-request capture off, so it sends nothing but crash and exception events; macOS has no screenshot or view hierarchy capture. Before it records a breadcrumb or sends an event, the app replaces file paths outside system locations and `/Applications` with `<path>`, keeping the part from `Stim.app` on, and removes the Mac's host names, `.local` and tailnet hosts, IPv4 addresses other than `127.x` and Tailscale IPv6 addresses, URL hosts other than `localhost`, URL paths and query strings, and tokens, keys, passwords and other credentials. A path stops at whitespace, so after a space only a `/Users/<name>` folder is removed. A crash is sent on the next launch.

To check a bundle, point the DSN at a local listener, such as `http://<key>@127.0.0.1:<port>/1`, and launch it with `STIM_DESKTOP_CRASH_TEST=crash`, then again without it; the listener receives a gzipped envelope at `/api/1/envelope/`.

## Layout

- `Sources/StimKit`: models for the CLI's JSON, the login shell environment, the CLI and `stim-server` clients, project grouping, warning remedies, the streaming runner, `stim logs` records and the follow runner, process, disk and gc usage, the status machine section, the Machine report, free plan and worktree lifecycle, the autopilot schedule, pressure plan and log, and the crash report scrubber. Unit-tested.
- `Sources/StimStores`: the observable stores whose ordering and staleness rules have tests: the status refresh and watch, the gc report and the action runs. They take the `stim` call, and the clock where they decide staleness, as closures, so `Tests/StimStoresTests` can order results by hand. Tests cannot import the `StimDesktop` executable target.
- `Sources/SimulatorFrames`: live simulator frames through CoreSimulator, and input through the simulator's CoreDevice HID service (`dtuhidd`) or, when a simulator has none, SimulatorKit's legacy HID client. All of them are private Apple interfaces. Expect Xcode releases to break it.
- `Support/SimFold`: the `sim-fold` helper, an iOS Simulator executable that `scripts/bundle.sh` builds into the app's resources. stim-server builds the same sources to fold an iPhone Duo from the phone.
- `Sources/EmulatorFrames`: live emulator frames through the emulator's localhost gRPC `streamScreenshot` call, found through its discovery file, and input through the same endpoint. An emulator without a hardware keyboard (`hw.keyboard=no`) drops key events, so Desktop types on it with `adb shell input`. Emulators Stim booted before it passed `-grpc` show no frames until their next boot.
- `Sources/WebFrames`: the Stim-owned Chrome page from `stim web`, over the Chrome DevTools Protocol on the loopback `cdpEndpoint` `stim status` reports. It connects only when `SystemInfo.getProcessInfo` names the Chrome pid status reports, attaches to the page's `targetId`, streams it with `Page.startScreencast` and sends `Input.dispatch*` events. Public protocol only; no WebKit view, which would render a different engine than the one agents test.
- stim-server's `stim-frames` helper compiles the non-view files of these modules, listed in `packages/server/helper/desktop-sources.txt`, together with its own `main.swift`. Desktop CI compiles it, so keep those files free of AppKit views, SwiftUI and StimKit. Desktop and the helper both send simulator keys through `SimulatorHID.hardwareKey`, and page input through `WebPage`.
- `Sources/StimDesktop`: the SwiftUI app. `Design/` holds the generated tokens, the theme layer over them (`.textStyle(_:)`, `Font.stim(_:)` and the dynamic colors), and the component kit that mirrors the phone's: `.buttonStyle(.stim(_:_:))`, `IconButton`, `Pill`, `Banner` and `ListSection`/`ListRow`. A debug build has **Window > Component Gallery**, which shows every token and component in light and dark.
