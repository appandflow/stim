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
`stim gc --json`, which finds the pull request whose head is the worktree's
HEAD, and `stim worktree remove` on each worktree gc reports as safe:

- no uncommitted or untracked files;
- no unpushed commits; for a closed pull request, no commit that exists only
  locally;
- no running Metro, build or owned device;
- 2 hours since the merge and since its last activity
  ([`gc.worktreeGraceMinutes`](./settings.md)).

A worktree that fails a check is never removed. It is listed under **Finished
pull requests** in **Needs attention** with the reason, such as "PR #123
merged, 2 uncommitted or untracked files". Removals are listed under
**Autopilot activity** and posted as a notification, such as "Removed 3
worktrees for merged PRs". `stim worktree remove` cannot be undone, so the
checks are the safeguard. The option needs the GitHub CLI, `gh`, signed in;
without it the app removes nothing for this option, and `stim gc` reports why
(see [removing finished worktrees](./worktrees.md#remove-finished-worktrees-in-bulk)).
