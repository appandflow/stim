---
title: 'Stim Desktop'
description: 'A macOS app that shows every workspace, device and build Stim runs'
---

Stim Desktop is a macOS app for watching and steering the work Stim runs:
every workspace with its live simulators and emulators, builds, logs and the
agents driving them. It runs `stim` for you, so it needs the CLI from
[Getting started](./getting-started.md).

![The workspace page in Stim Desktop: two iPhone simulators side by side with the build stage, git branch and pull request above them](/img/desktop/workspace.webp)

## Download

<a className="button button--primary button--lg" href="https://github.com/appandflow/stim/releases/download/desktop-latest/Stim.dmg">Download Stim.dmg</a>

Open the disk image and drag **Stim** to **Applications**. Or use Homebrew:

```sh
brew install --cask appandflow/tap/stim
```

- macOS 14 or later, on Apple silicon or Intel.
- The `stim` CLI: `npm install --global stim`.
- Xcode 27 for live simulator screens.

The app updates itself. Every release is listed under
[desktop-v releases](https://github.com/appandflow/stim/releases?q=desktop-v&expanded=true).

## What it does

- **Every workspace at a glance.** Each workspace shows its stage (warming,
  building, running, failed), its devices side by side, and its branch and pull
  request status.
- **Watch and take over a device.** Open a device to see its screen large,
  take it over with your mouse and keyboard, and read what the agent did
  and when.
- **Replay.** Scrub back through a device's recent screen, with agent actions
  and errors marked on the timeline.
- **Logs.** Metro, app and device logs in one place, with repeated errors
  grouped.
- **Builds.** Progress, the reason for a cache miss, and a prediction of the
  next build. Run iOS or Android from a menu.
- **Machine.** What fills the disk and memory, and what Stim can free.
- **Phones.** Pair the Stim phone app, and watch a leased Android or iOS
  phone from the desktop.
- **Notifications and cleanup.** Alerts for stuck agents and failed builds, and
  automatic removal of worktrees after their pull request merges.

![A device viewer: the simulator screen with the agent's recent actions, including two that failed](/img/desktop/viewer.webp)

![The logs drawer with a Metro syntax error and its code frame grouped into one entry](/img/desktop/logs.webp)

![The Machine page: free disk split by category, and a checklist of what Stim can free](/img/desktop/machine.webp)

## First steps

1. Install the `stim` CLI and open Stim Desktop.
2. In a project, warm a worktree and run the app:

   ```sh
   git worktree add ../my-app-feature -b my-feature
   cd ../my-app-feature
   stim worktree warm
   stim start
   stim ios
   ```

3. The workspace appears in the sidebar as soon as it warms. Its simulator
   shows in the app instead of a separate Simulator window.
4. Click a device to open its viewer. **Take over** lets you use it; Escape
   gives it back.
5. To use the phone app, open **Stim > Settings > Phones**, turn on **Serve to
   phones** and choose **Pair a Phone…**.

![The Pair a Phone sheet with a QR code to scan with the phone app](/img/desktop/pair.webp)

Stim prints `Open in Stim Desktop: stim-desktop://workspace?path=...` when it
starts work, and coding agents share the same link, so you can jump straight to
a workspace. Settings and other details are in the
[app's README](https://github.com/appandflow/stim/blob/main/apps/desktop/README.md).
