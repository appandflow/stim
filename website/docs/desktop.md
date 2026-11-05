---
title: 'Stim Desktop'
description: 'Run, watch and debug your Stim workspaces from your Mac.'
---

import StimTabs from '@site/src/components/StimTabs';
import PromptBox from '@site/src/components/PromptBox';

Stim Desktop puts your workspaces, live devices, builds and logs in one Mac app. Open a device to use it yourself, or replay what your agent did.

## Download

<a className="button button--primary button--lg" href="https://github.com/appandflow/stim/releases/download/desktop-latest/Stim.dmg">Download Stim.dmg</a>

Open the disk image and drag **Stim** to **Applications**. You can also install it with Homebrew.

```sh
brew install --cask appandflow/tap/stim
```

Desktop runs on macOS 14 or later, on Apple silicon and Intel. Live iOS simulator screens require Xcode 27. The app includes its local server. Install the CLI if you or your agent will run commands in a terminal. [Install Stim](./getting-started.md#install-stim)

### Prerelease updates

To try new builds, turn on **Get prerelease updates** in **Settings > App > Updates**. [GitHub releases](https://github.com/appandflow/stim/releases)

## First steps

1. Open Stim and follow the setup guide. Reopen it anytime from **Help > Setup Guide**.
2. Run an app from its project directory. Choose iOS or Android.

<StimTabs
code={`stim doctor
stim start
stim ios        # or: stim android`}
/>

3. Select the workspace in the sidebar, then click its device. Choose **Control** to use the device and press **Esc** to release it.

![Stim Desktop showing a workspace with two iPhone simulators, the build stage, and the current branch and pull request](/img/desktop/workspace.webp)

For a separate workspace per task, see [Worktrees](./worktrees.md).

## Tutorial

Open **Help > Stim Tutorial** to try two changes in parallel, each with its own worktree and simulator. The tutorial gives you prompts to copy and guides you through inspecting logs, controlling the device and replaying your agent's actions.

<PromptBox title="Start the tutorial with your agent">
{`Clone appandflow/stim-tutorial into ~/stim-tutorial and follow stim guide tutorial run.`}
</PromptBox>

The first iOS build can take a few minutes. The second shows what a cache hit saves. To see recorded agent actions, install agent-device when the tutorial offers it. **Finish and Archive** removes the tutorial worktrees and their changes. You can still open their retained logs and recordings in **Archived**.

## What it does

| I want to…                       | Where to go                                                                                 |
| -------------------------------- | ------------------------------------------------------------------------------------------- |
| Check what my agents are running | **Overview** or a workspace in the sidebar. Apps in the same checkout share a row.          |
| Use a simulator or emulator      | Open its device tile, then choose **Control**.                                              |
| See what an agent did            | Open **Agent Actions** or play the recording in the device viewer.                          |
| Diagnose a build or app error    | Open **Builds** for timings and cache results, or **Logs** for build, Metro and app output. |
| Review an agent's changes        | Open the workspace's Git chip and choose **Review Changes**.                                |
| Free disk space                  | Open **Machines > This Mac** to review storage and cleanup options.                         |
| Share a live device in a browser | Choose **Share…** in the device menu. [Web shares](./share.md)                              |

Open **Help > Discover Stim** for more workflows and copyable agent prompts.

## Connections

Open **Settings > Connections**. **Using this machine** shows incoming access and running shares. **This machine uses** shows the machines you connect to.

- **Pair a phone.** Enable **Phone app** under **Settings > Advanced > Feature flags**, then choose **Using this machine > Add… > Pair a Phone…**. The wizard sets up private Tailscale access. [Phone app](./phone-app.md)
- **Pause incoming connections.** For the server Desktop starts, turn off **Allow connections**. This keeps existing pairings. If you run a standalone service, check its exposure with `stim-server service status`. Stop web shares separately under **Share links**.
- **Remove incoming access.** Choose **Revoke Access…** on a phone or machine's row. To end a hosted session, use **Running here > Stop**.

### Pair with another machine

Use Tailscale or configure a private LAN address on the machine you want to view. A loopback-only address such as `127.0.0.1` works only on that machine. [Local network setup](./remote-machines.md#local-network-without-tailscale)

1. On the other machine, run `stim-server pair` for viewing or `stim-server pair --control` to also allow device control, reload and stop.
2. In Desktop, choose **This machine uses > Add… > View or Control Its Work…** and paste the command output. Verify the fingerprint against the other machine. The code works once and expires in five minutes.
3. Open the machine's workspace from the sidebar.

Pair only with machines you own. Pairing can expose live device screens, logs and unignored files. To revoke access on the other machine, run the `stim-server devices revoke <id>` command that Desktop shows when you remove the pairing.

## Add a remote machine

To build or run devices elsewhere, choose **This machine uses > Add… > Build or Run Simulators There…**. Follow the wizard and approve access on the worker. Macs can build and host devices. Linux and Windows workers handle Android builds. Hosted devices show their machine's name on the device tile. [Remote machine setup](./remote-machines.md#use-the-desktop-wizard)

## Troubleshoot Desktop

- **Can't connect to the local server.** Click the warning at the bottom of the sidebar for the reason and retry. If a compatible `stim-server` service already serves your Stim home, Desktop uses it.
- **Desktop can't find a tool or environment variable.** Check the **Toolchain** section in `stim doctor`. Set variables under **Settings > Advanced > Environment** and restart Desktop. These preferences store values in plain text, so keep secrets out of them.
- **Simulator shut down when Device Hub quit.** [Keep simulators running when Device Hub quits](./owned-devices.md#keep-simulators-running-when-device-hub-quits).
- **Looking for crash reporting details?** [Crash reports](https://github.com/appandflow/stim/blob/main/apps/desktop/README.md#crash-reports)

## SwiftUI playground for contributors

Use **Window > SwiftUI Playground** in a debug build. [Desktop development guide](https://github.com/appandflow/stim/blob/main/apps/desktop/README.md#swiftui-playground)

## Suggestions

Desktop can suggest adding a remote machine, pairing a phone or reviewing disk space. Choose **Don't Suggest Again** to dismiss that kind of suggestion.
