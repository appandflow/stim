---
title: 'Stim Desktop'
description: 'A macOS app that shows every workspace, device and build Stim runs'
---

import StimTabs from '@site/src/components/StimTabs';

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
- The `stim` CLI, on your login shell's `PATH` or set in **Stim > Settings >
  App**. See [Install Stim](./getting-started.md#install-stim).
- Xcode 27 for live simulator screens.

The app updates itself. Release builds report crashes to Sentry with file paths,
host names, addresses and credentials removed, and send no screenshots or
performance traces. Every release is listed under
[desktop-v releases](https://github.com/appandflow/stim/releases?q=desktop-v&expanded=true).

## What it does

- **Every workspace at a glance.** Each workspace shows its stage (warming,
  building, running, failed), its devices side by side, and its branch and pull
  request status.
- **Watch and take over a device.** Open a device to see its screen large,
  take it over with your mouse and keyboard, and read what the agent did
  and when.
- **Replay.** Scrub back through a device's recent screen, with agent actions
  and errors marked on the timeline. Needs **Serve to phones** in **Stim >
  Settings > Phones**.
- **Logs.** Metro, app and device logs in one place, with repeated errors
  grouped.
- **Builds.** Progress, the reason for a cache miss, and a prediction of the
  next build. Run iOS or Android from a menu.
- **Machines.** What fills the disk and memory, what Stim can free, and for
  each build machine whether it takes builds, the builds it ran for this Mac and
  why recent builds stayed here.
- **Phones.** Pair the Stim phone app, and watch a leased phone from the
  desktop: Android can be controlled, an iPhone over USB is view only. Needs
  **Serve to phones**.
- **Notifications and cleanup.** Alerts for stuck agents and builds that keep failing, and
  automatic removal of worktrees after their pull request merges. The **Needs
  you** category lists only what agents cannot handle, such as a doctor
  finding, a signing failure or an expired device lease, with **Run**, **Copy
  command**, **Fix**, **Open logs** or **Show in Finder** on its row in
  **Notifications**. It is Silent by default.

![A device viewer: the simulator screen with the agent's recent actions, including two that failed](/img/desktop/viewer.webp)

![The logs drawer with a Metro syntax error and its code frame grouped into one entry](/img/desktop/logs.webp)

![The Machine page: free disk split by category, and a checklist of what Stim can free](/img/desktop/machine.webp)

Workspace device cards fill the available width up to 640 points and wrap into
centered rows. Each complete card, including its header, fits the canvas height;
additional rows scroll vertically. Screens keep their aspect ratio and a
900-point height cap. Small previews use a 6-point inner inset, while the canvas
keeps 20 points of outer padding.

Closing the window leaves Stim Desktop running, so notifications and the phone
server keep working. Click the Dock icon to reopen the window, or press
Command-Q to quit. Command-1, Command-2 and Command-3 open All devices,
Notifications and Machine.

Stim Desktop checks the npm registry once a day for a newer `stim`. When the
`stim` it runs was installed by npm, pnpm or bun and is older, the sidebar
footer says so and **Settings > App > Stim CLI** has an **Update** button that
runs that package manager's update command. It never updates by itself, and it
never offers an update for a `stim` that no package manager installed, such as a
linked checkout.

## First steps

Unless you are already set up, the first launch opens a setup guide that
installs the `stim` CLI with npm, pnpm or
bun, whichever of them you use, and the agent skill, asks for notification
permission and checks Xcode, the Android SDK and a project with `stim doctor`.
Each step shows the command it runs and runs
it only when you press **Run**. The project check lists each `stim doctor`
finding with its fix, and offers **Fix** for the findings `stim doctor --fix`
repairs. Reopen the guide from **Help > Setup Guide…**.

In a project, warm a worktree and run the app:

<StimTabs
code={`git worktree add -b my-feature ../my-app-feature
cd ../my-app-feature
stim worktree warm
stim start
stim ios`}
/>

1. The workspace appears in the sidebar as soon as it warms. Its simulator
   shows in the app instead of a separate Simulator window.
2. Click a device to open its viewer. **Take over** lets you use it; Escape
   gives it back.
3. To use the phone app, open **Stim > Settings > Phones**, turn on **Serve to
   phones** and choose **Pair a Phone…**.

Revoking a paired phone closes its active connections on the next pairing
check. The server checks pairings on changes and once a second.

![The Pair a Phone sheet with a QR code to scan with the phone app](/img/desktop/pair.webp)

Stim prints `Open in Stim Desktop: stim-desktop://workspace?path=...` when it
starts work, and coding agents share the same link, so you can jump straight to
a workspace. Settings and other details are in the
[app's README](https://github.com/appandflow/stim/blob/main/apps/desktop/README.md).
