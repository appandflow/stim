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
- **Machines.** Select **This Mac** for local disk, memory and cleanup, or a
  configured build machine for its readiness, capacity and build history.
  **Link machine** opens the existing **Build Machines** settings flow.
  A removed selection returns to **This Mac**; remote selections have no local
  cleanup actions. Select checklist items to enable **Free space**;
  cleanup previews or confirms the selection before deleting anything.
  Build-cache stats and placement totals use the
  existing local server connection when it allows reads for the same Stim home;
  otherwise they use the CLI. This does not turn on **Serve to phones**. A
  cancelled stats refresh stops waiting without disconnecting device viewing;
  its server read may continue until it finishes or reaches its existing limit
  (normally 60 seconds). The shared connection limits each complete response to
  16 MiB, including its JSON envelope; an oversized response shows a read error
  without retrying through the CLI.
- **Phones.** Pair the Stim phone app, and watch a leased phone from the
  desktop: Android can be controlled, an iPhone over USB is view only. Needs
  **Serve to phones**. On wide iPad and Duo windows, the app keeps its navigation
  beside the main screen; details use the full window. A book fold aligns the panes with the display
  division; a narrow cover screen uses the menu drawer. Duo fold detection
  needs an app built with the iOS 27.1 SDK and an iOS 27.1 runtime.
- **Tablet phone-app layout.** Workspace summary cards use one row when the
  content pane has room for all four, and wrap on smaller panes. Device cards
  stay centered, fill available width up to 640 points, and form extra columns
  only when full-width cards fit.
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
keeps 20 points of outer padding. Stopped devices use compact, consistently sized
cards up to 420 points wide. **Boot** runs the device's platform and slot through
Stim, building and launching when needed; the button is disabled while the workspace
has an action running. Unowned and physical devices have no Boot button. Closed web
cards offer **Open** instead. Workspace cards show **Control** for a running
controllable device, or **View** otherwise. Clicking the rest of the card opens the
viewer, with Control already on when the device allows it. Physical iOS devices
and remote previews stay view-only; Android phones require a valid lease and a
control-capable pairing. **Release control** or Escape returns to viewing.

On the All devices and project wall, active workspaces without running or building
devices use compact cards labelled **No running devices**, with Metro status,
warnings and error links. CPU and RAM stay on the workspace page.

Run, Reload app and Stop from the workspace or sidebar menus keep you on the
workspace page. Open **Last output** or **Operations** for command details,
including failed runs. Click the **Recent builds** label or chevron to expand
the build history.

An empty workspace shows a purple device floating above a round plinth and a
short launch hint. Reduce Motion stops the illustration's animation.

On a foldable held like a book, the phone app's device viewer places the screen
and replay controls on the leading side of a vertical fold, with Control
toolbars and agent actions on the other side. An iPhone Duo needs a build
compiled with iOS SDK 27.1 or newer and an iOS 27.1 or newer runtime. Android
needs WindowManager fold support. Builds using an older iOS SDK receive no fold
divisions and keep the default viewer layout.

When the phone is partly folded like a laptop and reports a horizontal fold,
the viewer places its title and screen above the fold, with read-only messaging,
Control toolbars, replay controls and agent actions below it. This tabletop
layout uses `react-native-hinges` posture readings and the reserved fold geometry;
without both, the default layout remains. The same iOS SDK/runtime and Android
WindowManager requirements apply.

Actions open a sheet with progress and one completion or failure status. The sheet
stays open until you close it. Expand **Command output** to see the command and
raw output during or after a run; it is collapsed by default. Launch progress
uses **Launching app** and **Verifying launch** labels.

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
