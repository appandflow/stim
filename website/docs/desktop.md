---
title: 'Stim Desktop'
description: 'Download the macOS app that shows the devices Stim runs'
---

Stim Desktop is a macOS app that shows every Stim workspace with its live
simulators and emulators, build progress, logs and settings. It runs `stim`
commands for you and reads Stim's state only through the CLI, so it needs
`stim` installed as described in [Getting started](./getting-started.md).

## Download

[Download Stim.dmg](https://github.com/appandflow/stim/releases/download/desktop-latest/Stim.dmg),
open it and drag **Stim** to **Applications**. The app is a universal build for
Apple silicon and Intel Macs, signed with Developer ID and notarized by Apple.
A 404 from that link means no stable desktop release is out yet; build the app
from source with `apps/desktop/scripts/bundle.sh` in the meantime.

The app checks for newer releases with Sparkle; **Stim > Check for Updates…**
checks right away.

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

## Run the app

Each workspace's context menu and "..." menu offer **Run on iOS** and **Run on
Android** for the platforms the workspace has a device or a build for, or both
when it has neither. They run `stim ios` or `stim android` in the workspace
with no options, so they use the default slot and configuration, and stream
the output into the activity sheet. **Reload app** is available only while the
dev server and a local device run. The inspector's
**Builds** section has a **Run** button per platform, which reads **Rebuild**
after a failed build, and a **Check** button that predicts the next build with
`stim ios --plan` or `stim android --plan` without building.

When a device is up but the app is not running on it, because it crashed, was
closed or was never launched there, the device shows **App not running**. On a
Stim-owned simulator or emulator it also has a **Run** button; any other device
has none.

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

## Show devices in the app

While Stim Desktop is installed, Stim shows owned simulators and emulators in
it instead of their own windows, unless `iosSimulatorApp` or
`androidEmulatorApp` is set to another viewer. See
[Devices and cleanup](./owned-devices.md).

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
