---
title: 'Stim Desktop'
description: 'Download the macOS app that shows the devices Stim runs'
---

Stim Desktop is a macOS app that shows every Stim workspace with its live
simulators and emulators, build progress, logs and settings. It runs `stim`
commands for you and reads Stim's state through the CLI, so it needs
`stim` installed as described in [Getting started](./getting-started.md).
Device replay comes from the `stim-server` it runs for the phone app.

A workspace appears from the moment `stim worktree warm` starts in it: the
sidebar and the wall show it as **Warming…** with an activity indicator, then
**Ready** until its first run, even under the Live filter. The default Name sort keeps
rows in place by project, then workspace title, so a workspace does not move while
agents work; choose Last activity in View Options to put the busiest first.

## Download

[Download Stim.dmg](https://github.com/appandflow/stim/releases/download/desktop-latest/Stim.dmg),
open it and drag **Stim** to **Applications**. The app is a universal build for
Apple silicon and Intel Macs, signed with Developer ID and notarized by Apple.
A 404 from that link means no stable desktop release is out yet; build the app
from source with `apps/desktop/scripts/bundle.sh` in the meantime.

The app checks for newer releases with Sparkle; **Stim > Check for Updates…**
checks right away.

Release builds report the app's crashes and uncaught exceptions to Sentry, with
file paths, host names, IPv4 and tailnet addresses and credentials removed
first. They send no screenshots, performance traces or personal data. A build
from source reports nothing.

That link always serves the newest stable release. Desktop releases are tagged
`desktop-v<version>`, apart from the CLI's `v<version>` releases, so GitHub's
"latest release" page shows the CLI. Every desktop version, release candidates
included, is listed under
[desktop-v releases](https://github.com/appandflow/stim/releases?q=desktop-v&expanded=true),
with a `SHA256SUMS` file for its downloads.

### Homebrew

Coming soon: the `appandflow/homebrew-tap` tap does not exist yet. Once it
does, install with:

```sh
brew install --cask appandflow/tap/stim
```

## Requirements

- macOS 14 or later.
- Xcode 27 for live simulator frames and input. The app loads Xcode's
  simulator frameworks from the selected developer directory, or from
  `/Applications/Xcode.app` when the selected one has none.
- `stim` on the login shell's `PATH`, or its path set in **Stim > Settings >
  App**.

## A workspace at a glance

A workspace's page opens with one line. A stage line says whether it is
**Running**, **Building**, **Build failed**, **Warming**, **Ready** or
**Stopped**, with how long and any problem ("3 errors", "iOS app closed").
While a build runs, the line adds its phase, a short progress bar and the
elapsed time over the estimate. Next to it, the git chip shows unpushed
commits and uncommitted files when there are some, and the branch's pull
request coloured by its state with a single CI mark; click it for the branch,
the pull request and a link to GitHub.

The devices take the rest of the page: every device of the workspace shows at
once, side by side at one height, wrapping when the window is narrow. Each tile
is a preview with the device's CPU, memory and disk, and which agent drives it
or how long it has been idle. While its build runs, a device shows the phase
and progress over its screen.

Click a device to open its viewer: the screen as large as the sheet allows,
**Take over** (the hand button) and **Stop**, the device's buttons while you
have it (Home and Lock on a simulator; Home, Back, Apps and Lock on an
emulator), the agent's last actions and the replay
bar. Escape gives the device back, and a second Escape closes the viewer.

**All actions** in the agent row's popover, or a click on a tile's "Driven by"
chip, opens the device's agent action log beside the screen: up to 200 actions,
newest first, with filters for failed actions and the most used commands.
Click an action to show it in the logs. When the replay recorded that moment,
the replay plays it from just before the action; otherwise the viewer closes
so the logs show.

The inspector, toggled from the toolbar, holds the details: **Build** (the
running build's phases and output, or each platform's last build, the next
build's estimate, **Check** and **Run**), **Resources** (CPU and memory over
the last 10 minutes, every process and the disk breakdown), **Metro & logs**
(Metro's port and health, the error count and the latest bundle), **Agents**
and the project's **Build cache**.

The logs are hidden until you ask for them. The toolbar's logs button, which
shows the error count, or **Show logs** in the inspector opens them in a drawer
below the devices; drag its edge to resize it. The app remembers whether the
logs are shown and how tall they are.

When nothing runs, on **All devices**, a project, or a workspace with no
device that is not warming, the page offers three example prompts to copy for your coding agent,
the same ones the phone app shows.

## Run the app

Each workspace's context menu and "..." menu offer **Run on iOS** and **Run on
Android** for the platforms the workspace has a device or a build for, or both
when it has neither. They run `stim ios` or `stim android` in the workspace
with no options, so they use the default slot and configuration, and stream
the output into the activity sheet. **Reload app** is available only while the
dev server and a local device run. The inspector's
**Build** section has a **Run** button per platform, which reads **Rebuild**
after a failed build, and a **Check** button that predicts the next build with
`stim ios --plan` or `stim android --plan` without building.

When a device is up but the app is not running on it, because it crashed, was
closed or was never launched there, the device shows **App not running**. On a
Stim-owned simulator or emulator it also has a **Run** button; any other device
has none.

## See which agent works in a workspace

The inspector's **Agents** section lists the Claude Code and Codex sessions
associated with the workspace, such as "Claude Code · Fix the login bug":
those running there, from `agents` in `stim status`, and those that stopped
there in the last 3 days, from `endedAgents`. The earliest started comes
first, and a session looks the same whether its process runs or ended, so the
list stays put as agents come and go. Click a session to open it in the Claude
desktop app or the Codex app. A Claude Code session started in a terminal has
no link, because the Claude app can only open sessions it hosts. The phone app
shows the first session on each workspace screen and all of them on the Work
sheet, and opens one in the Claude app when it had Claude Code Remote Control
connected.

## See what uses the disk

**Machine** in the sidebar shows what fills the Mac's disk, largest first, and
what Stim can free. Every row has a size, or a reason when it has none, and
the action that frees a row sits next to it.

- The top of the page shows free disk against your Stim disk budget
  ([`budget.minFreeDiskGb`](./settings.md)), with one bar split into Stim's
  devices, Stim's caches and build outputs, `node_modules`, other simulators and
  AVDs, simulator runtimes and Android system images, and other tools.
- **Safe to free now** lists what `stim gc` reports as reclaimable: parked,
  orphaned and stale owned devices, merged worktrees, build outputs of idle
  workspaces, logs over the cap, records of deleted folders and shared caches.
  Each row has a checkbox. Rows marked **stim gc** are freed together by one
  `stim gc --delete`, which also covers the worktree and build-output rows.
  Shared caches start unchecked, because builds refill them. **Free** previews a
  single `stim gc` run in the activity sheet before deleting. When the
  selection needs several commands, it lists them and asks you first.
- **Projects** groups worktrees by repository, with each repository's total.
  Expand one to see each worktree's `node_modules`, devices, build outputs, logs
  and lifecycle, and remove a worktree from its menu.
- **Simulators and emulators** lists every simulator and AVD with its runtime,
  last use, size and owner. The owner is a Stim workspace, Stim's parked pool,
  this Stim home with no workspace, another Stim home, or you. Stim only lists devices it did not create in this
  home; manage those in Xcode or Android Studio.
- **Runtimes and system images** shows how many devices use each iOS runtime
  and Android system image, and marks unused ones. **Copy** copies the
  `xcrun simctl runtime delete` or `sdkmanager --uninstall` command. Stim never
  runs it.
- **Other tools** shows Xcode DerivedData, Gradle caches and `~/Library/Caches`
  for information.

The device, runtime and system image lists need a `stim` whose `stim gc --json`
reports an inventory.
When Stim cannot read a device or system image folder, the page says which
one above the list. If macOS privacy protection blocked it, as it can for AVDs
or an Android SDK on an external disk, allow Stim Desktop under
System Settings > Privacy & Security > Files and Folders (Removable Volumes),
or give it Full Disk Access, and refresh.

Try it with an agent:

```text
Run `stim gc --json` and list the simulator runtimes and Android system images
that no device uses, with their sizes and the command to remove each. Do not
run those commands.
```

## Open a workspace from a link

When Stim Desktop is installed, `stim worktree warm`, `start`, `ios`, `android`
and `web` print a link to the workspace, and coding agents share it with you
when they begin work:

```text
Open in Stim Desktop: stim-desktop://workspace?path=/Users/me/app-feature
```

Opening the link starts Stim Desktop or brings it to the front and shows a card
for that workspace with an **Open** button; the app switches to the workspace
only when you click it. A link from `ios`, `android` or `web` also selects that
device. A link to a path Stim does not list shows **Workspace not found**.

## Show devices in the app

While Stim Desktop is installed, Stim shows owned simulators and emulators in
it instead of their own windows, unless `iosSimulatorApp` or
`androidEmulatorApp` is set to another viewer. See
[Devices and cleanup](./owned-devices.md).

## Watch and drive a leased phone

With **Serve to phones** on in **Stim > Settings > Phones**, the tile of a
phone the workspace leases with `stim android --device`, `stim ios --device`
or `stim device lock` shows its screen live. On an Android phone, **Take over**
in its viewer sends your clicks, trackpad scrolls and typing to it, and adds Home, Back, Apps
and Lock buttons. An iPhone over a USB cable is view only. The tile says so
when the phone is disconnected, when the lease has ended, and when
`stim-server` is too old to stream phones. See
[Physical devices](./owned-devices.md).

```text
Lease my connected Android phone to this workspace with stim device lock for 30 minutes, then tell me to open the workspace in Stim Desktop.
```

## Replay device screens

With **Serve to phones** on in **Stim > Settings > Phones**, a device's viewer
shows a replay bar under its screen, as in the phone app: drag to scrub, hover
the track to preview a frame from that moment (one every 5 seconds or so),
hover a marker to see the agent action or error, click it to land just before it,
step to the previous or next agent action with the buttons beside play,
and play at 1x or 2x. **Live** returns to the live screen; Take over is off
while you look at the past. **Record device screens for replay** in the same
tab turns `recording.enabled` on or off for the Mac. See
[Replay device screens](./owned-devices.md#replay-device-screens).

## Build on another Mac

Another Mac on your tailnet can build for this one once someone on it
approves this Mac. On this Mac, **Stim > Settings > Build Machines** lists the
Macs on your tailnet that run stim-server; **Use for Builds** adds one to the
`offload.machines` setting and sends it a request. Each listed Mac shows
whether it approved this Mac, is waiting, revoked it, or is now a different
tailnet node, which Stim refuses to connect to. An approved Mac shows
**Ready**, or the first reason `stim doctor` gives that it would not take a
build now, with its remedy, such as **Stim build differs** (update the build
machine) or **Busy (load 8.2/core)**; hover it for every reason. **Remove**
takes it out of the setting. The **Machine** page lists the same readiness
under **Build machines**, and so does the phone app's Machine screen.

While a build runs on another Mac, the workspace's build card says
**Building iOS on janics-mac-mini** and shows the step it runs there, such as
Pods, with how long that step has taken. A run another Mac compiled reads
**Built on janics-mac-mini** in the last build and **Recent builds**. A run
that considered offloading and built here shows a short line such as
**janics-mac-mini busy → built here**; hover it for the full reason.

On the other Mac, with **Serve to phones** on and its `tailscale serve` route
set up, Stim Desktop notifies `<Mac> wants to build on this Mac`. **Review**
shows the Mac's name and tailnet node; **Allow** lets it build there, and
**Deny** refuses. The Macs that build there are listed under **Macs that build
here** in **Stim > Settings > Phones**, each with **Revoke**. See
[`offload.mode`](./settings.md#machine-settings) for which builds offload.

## Notifications

Stim Desktop notifies you with the same rules as the phone app: work started,
an agent that looks stuck, an agent that repeats the same build failure, work
finished, a machine low on disk or memory, and another Mac asking to build on
this one. Each category is Alert, Silent or Off; every category is Silent by
default except a build request, which alerts. An alert appears as a card in the
corner while the window is in front, with a button that opens the workspace,
device or build, and as a macOS notification otherwise; macOS asks for
permission the first time. Every notification, Silent and Off (as Muted) ones
included, is kept in **Notifications** in the sidebar, the last 200 from the last
7 days, with an unread count and filters by category and workspace. The levels, the stuck threshold and quiet hours are
under **Settings > App > Notify when**.

## Remove worktrees of finished pull requests

The autopilot in **Stim > Settings > App** removes a worktree soon after its
pull request is merged or closed. It is on by default. Every 5 minutes, and
when the app becomes active, it asks `gh` for each repository's merged and
closed pull requests. When a Stim worktree's branch is among them, it runs
`stim gc --json`, which finds the pull request whose head is or contains the
worktree's HEAD, and `stim worktree remove` on each worktree gc reports as
safe:

- no uncommitted or untracked files;
- no commit that exists only locally, except commits a merged pull request
  holds;
- no running Metro, build or owned device;
- 2 hours since the merge and since its last activity
  ([`gc.worktreeGraceMinutes`](./settings.md)).

Just before removing, the app skips a worktree that `stim status` now shows
live, building or on another branch, and `stim worktree remove` checks again for
uncommitted and unpushed work under its locks. A worktree that fails a check
is not removed. It is listed under **Finished
pull requests** in **Needs attention** with the reason, such as "PR #123
merged, 2 uncommitted or untracked files". Removals are listed under
**Autopilot activity** and posted as a notification, such as "Removed 3
worktrees for merged PRs". `stim worktree remove` cannot be undone, so the
checks are the safeguard. The option needs the GitHub CLI, `gh`, signed in;
without it the app removes nothing for this option, and `stim gc` reports why
(see [removing finished worktrees](./worktrees.md#remove-finished-worktrees-in-bulk)).
