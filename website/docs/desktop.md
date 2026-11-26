---
title: 'Stim Desktop'
description: 'Run, watch and debug your Stim workspaces from your Mac.'
---

import StimTabs from '@site/src/components/StimTabs';
import PromptBox from '@site/src/components/PromptBox';

Stim Desktop shows your workspaces, live devices, builds and logs in one Mac
app. Open a device to use it yourself, or replay what your agent did.

## Download

<a className="button button--primary button--lg" href="https://github.com/appandflow/stim/releases/download/desktop-latest/Stim.dmg">Download Stim.dmg</a>

Open the disk image and drag **Stim** to **Applications**, or use Homebrew:

```sh
brew install --cask appandflow/tap/stim
```

Desktop runs on macOS 14 or later, on Apple silicon and Intel. Live iOS
simulator screens need Xcode 27. The app includes its own server. Install the
CLI too if you or your agent run commands in a terminal:
[Install Stim](./getting-started.md#install-stim).

### Prerelease updates

To try new builds, turn on **Get prerelease updates** in **Settings > App > Updates**.

## First steps

1. Open Stim and follow the setup guide. Reopen it from **Help > Setup Guide**.
2. Ask your agent to run the app, or run it yourself from the project directory:

<StimTabs
code={`stim start
stim ios        # or: stim android`}
/>

3. Select the workspace in the sidebar and click its device. Choose **Control**
   to use it; press **Esc** to give it back.

![Stim Desktop showing a workspace with two live iPhone simulators running a music player and a fitness app](/img/desktop/workspace.webp)

## Tutorial

**Help > Stim Tutorial** walks you through two changes in parallel, each with its
own worktree and simulator. Or start it from your agent:

<PromptBox title="Start the tutorial with your agent">
{`Clone appandflow/stim-tutorial into ~/stim-tutorial and follow stim guide tutorial run.`}
</PromptBox>

**Finish and Archive** removes the tutorial worktrees and their changes. Their
logs and recordings stay under **Archived**.

## What it does

| I want to…                       | Where to go                                                    |
| -------------------------------- | -------------------------------------------------------------- |
| Check what my agents are running | **Overview**, or a workspace in the sidebar.                   |
| Use a simulator or emulator      | Open its device tile, then **Control**.                        |
| See what an agent did            | **Agent Actions**, or play the recording in the device viewer. |
| Diagnose a build or app error    | **Builds** for timings and cache results, **Logs** for output. |
| Review an agent's changes        | The workspace's Git chip, then **Review Changes**.             |
| Free disk space                  | **Machines > This Mac**.                                       |
| Share a live device in a browser | **Share…** in the device menu. See [Web shares](./share.md).   |

**Help > Discover Stim** has more workflows and agent prompts.

## Connections

**Settings > Connections** lists who uses this machine and which machines it uses.

- **Pair a phone:** turn on **Phone app** in **Settings > Advanced > Feature
  flags**, then **Using this machine > Add… > Pair a Phone…**. See [Phone app](./phone-app.md).
- **Pause incoming connections:** for the server Desktop starts, turn off
  **Allow connections**. Pairings stay. A standalone service keeps listening;
  check its exposure with `stim service status`. Stop web shares separately
  under **Share links**.
- **Remove access:** **Revoke Access…** on a phone or machine's row.

### Pair with another machine

To view or control another machine's work from this Desktop:

1. On the other machine, run `stim pair` to allow viewing, or `stim pair --control`
   to also allow device control, reload and stop.
2. Here, choose **This machine uses > Add… > View or Control Its Work…** and paste
   the output. Check the fingerprint against the other machine. The code works
   once and expires in five minutes.

Pair only with machines you own. Pairing can expose live device screens, logs
and files that git does not ignore. The other machine needs Tailscale or a
[private local network address](./remote-machines.md#local-network-without-tailscale).
To revoke, run the `stim pairings revoke <id>` command Desktop shows when you
remove the pairing.

## Add a remote machine

To build or run devices on another machine, choose **This machine uses > Add… >
Build or Run Simulators There…** and follow the wizard. See
[Remote machines](./remote-machines.md#use-the-desktop-wizard).

## Troubleshoot Desktop

- **Can't connect to the local server:** click the warning at the bottom of the
  sidebar for the reason, then retry.
- **A tool or environment variable is missing:** check **Toolchain** in
  `stim doctor`. Set variables in **Settings > Advanced > Environment** and
  restart Desktop. These values are stored in plain text, so keep secrets out.
- **Crash reports:** see the [Desktop README](https://github.com/appandflow/stim/blob/main/apps/desktop/README.md#crash-reports).
