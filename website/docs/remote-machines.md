---
title: 'Remote machines'
description: 'Build your app or host simulators and emulators on another machine you own'
---

import StimTabs, { StimInstallTabs } from '@site/src/components/StimTabs';
import Tabs from '@theme/Tabs';
import TabItem from '@theme/TabItem';
import PromptBox, { PromptGrid } from '@site/src/components/PromptBox';

Let another machine compile your app or run its simulator when this one is busy.
Your agent keeps working here; Stim sends the build or the device to the worker
and brings the result back.

<PromptGrid>
  <PromptBox
    title="Run on a hosting Mac"
    response={`Ran stim ios --remote build-mac.
Trailhead launched on the hosted iOS simulator on build-mac.
com.appandflow.trailhead · ready · errors clean`}
  >
    {`Run the app on a hosted iOS simulator on build-mac.`}
  </PromptBox>
  <PromptBox
    title="Check the last build"
    response={`The last iOS build compiled on build-mac.
Selected: auto. Placement: this machine was busy; the worker accepted the build.
No local fallback was recorded.`}
  >
    {`Check whether my last iOS build ran on my remote machine, and why or why not.`}
  </PromptBox>
  <PromptBox
    title="Review today's savings"
    response={`build-mac: 3 offloaded builds today; estimated savings 6m against previous local cold builds.
This is an estimate from the retained build history.`}
  >
    {`Show how much time my remote machine saved today.`}
  </PromptBox>
</PromptGrid>

Setup and approval are yours to do: a person at the worker approves each machine
that may use it.

## What a worker can do

| Worker         | Builds                                                                                     | Hosts devices                                 |
| -------------- | ------------------------------------------------------------------------------------------ | --------------------------------------------- |
| Mac            | iOS simulator Debug and Release, Exact iOS, Android debug and release, macOS SwiftPM Debug | iOS simulators, Android emulators, macOS apps |
| Linux (x86_64) | Android                                                                                    | No                                            |
| Windows        | Android                                                                                    | No                                            |

Physical-device builds, EAS and proxy runs, Android CAS compiler-cache builds,
and runs with artifact caching turned off always build here. A machine without
Xcode, such as Linux, can still run
`stim ios --configuration Release --remote-build <mac>`.

## Use the Desktop wizard

1. In Stim Desktop, open **Settings > Connections > This machine uses > Add… > Build or Run Simulators There…**.
2. Choose an online Tailscale peer. Select **Builds**, **Hosted simulators**, or both. Linux and Windows offer **Builds** only.
3. Copy the setup command. A person at the worker runs it in Terminal and approves each capability.
4. Review **Tools**, choose where new builds and devices run, then try the sample build.

When the wizard shows a key to confirm, compare it with the key printed on the
worker before you accept.

### Approve in Stim Desktop on the worker

On a worker Mac that runs Desktop's own server, you can approve there instead:
**Settings > Connections > Using this machine > Add… > Machine to Build or Run
Simulators Here**. Paste the setup command and choose **Allow** for each grant.
A standalone service, or a command with options such as `--port` or `--yes`,
still needs the worker's Terminal.

## CLI equivalent

On the machine that wants to use the worker:

<StimTabs code={`stim remote add build-mac`} />

It prints a `stim setup` command with a one-time ticket. Run it on the worker:

<Tabs groupId="stim-invocation" defaultValue="global">
<TabItem value="global" label="Global">

```bash
STIM_SETUP_TICKET=<ticket> stim setup --expires <ISO-time> --build --device-host
```

</TabItem>
<TabItem value="npx" label="npx">

```bash
STIM_SETUP_TICKET=<ticket> npx --yes stim setup --expires <ISO-time> --build --device-host
```

</TabItem>
</Tabs>

Setup asks Y/n for each capability, installs the server as a per-user service,
and creates a private tailnet-only route. Then finish the connection here:

<StimTabs code={`stim remote list
stim doctor        # in an app directory: can this worker build this app?`} />

- The ticket is a credential. The first machine to spend it gets the approval,
  so copy the command only to the worker. It expires within two hours.
- Setup's `--yes` approves without the Y/n questions. Only a person on the
  worker should make that call. The `--yes` after `npx` is npx's own and skips
  nothing.
- `stim remote add` keeps the machines already in `remote.machines`. Add
  `:<port>` when the route does not use 7443.
- `stim remote update <machine>` updates an approved worker to the newest
  compatible Stim release on its channel.

Without a ticket yet, install the server on the worker first with
`stim service install --serve`, then run `stim remote add` here.

## Choose where to build and run

Builds and devices can go to different machines. `--remote-build` picks where to
compile; `--remote` picks where the device runs. A cache hit skips compilation.

<StimTabs
code={`stim ios --remote-build build-mac
stim ios --remote run-mac
stim android --remote run-mac`}
/>

| Value          | Placement                                                         |
| -------------- | ----------------------------------------------------------------- |
| `local`        | This machine only.                                                |
| `auto`         | This machine first; remote machines when it is full or busy.      |
| `remote`       | Remote machines first; this machine when none takes it.           |
| `remote-only`  | Remote machines only. A device run can wait for a host with room. |
| A machine name | Exactly that machine.                                             |

Builds default to `remote.build=auto`. Devices and macOS apps run here unless
you set `ios.remote`, `android.remote` or `macos.remote`, or pass `--remote`.
Machines are tried in `remote.machines` order. Stop a running device before you
switch its host.

### Automatic machine pools

**Builds enabled** and **Simulators enabled** in **Settings > Connections > This
machine uses** take a machine out of automatic placement without unpairing it.
The same lists are the `remote.buildPoolDisabled` and `remote.devicePoolDisabled`
settings, where `local` means this machine. A named machine bypasses them.

### Automatic device placement

With `--remote auto`, a device runs here while this machine has a free device
slot and normal memory, disk and load. Otherwise Stim asks each approved host
and takes the first with room. If none has room, the run waits in the local
queue.

`remote.easFallback` can send that run to an EAS Simulator instead. EAS Simulator
is billed, so it defaults to `false`. The session bills until `stim stop` or
`remote.easMaxDurationMinutes` (30 by default).

<PromptBox
title="Turn on EAS fallback"
response={`remote.easFallback bills an EAS Simulator session whenever this Mac is at its device cap.
To enable it: stim settings set remote.easFallback true --scope machine`}

>

{`This Mac is often at its simulator cap. Explain what remote.easFallback costs and give me the stim settings command to enable it; I will run it myself. Once it is on, run the app with stim ios --remote auto, report the placement line, and stop this workspace when finished so the EAS Simulator session ends.`}
</PromptBox>

## Hosted devices

A hosted simulator or emulator belongs to your workspace. `stim stop` ends it,
and `stim status` shows the host. Debug runs keep Metro on this machine; the
host never connects back to it.

### Run Android on a hosting Mac

<StimTabs
code={`stim android --remote run-mac --device-profile pixel_7
stim stop`}
/>

The worker uses its installed device profiles and system images.

### Reverse ports on hosted devices

`stim ports reverse <label|port>` lets an app on a hosted device reach a server
on your machine at the same `localhost:<port>`. This works from a sandbox that
accepts no inbound connections. Any process on the host Mac can reach a
reversed port while the session lasts, so reverse only servers you would let
that Mac's users reach.

### Hosted parking and restart

After `stim stop`, a host can park a healthy device and reuse it for the same
client, with its app data cleared. The host's `pool.iosParkedMax` and
`pool.androidParkedMax` (3 each) cap parking; `0` turns it off.

### Hosted sessions stop when they are idle

Client and host each apply their own `maintenance.idleStopHours` (6 by default,
`0` turns it off).

## Permissions

| Approval      | What it allows                                                               |
| ------------- | ---------------------------------------------------------------------------- |
| `build`       | Compiling the requesting machine's project as the worker's user.             |
| `device-host` | Running the client's app on its own hosted simulator, emulator or macOS app. |
| `read`        | Viewing workspaces, logs and device screens, including workspace text diffs. |
| `control`     | Device input and Reload/Stop for a paired viewer.                            |
| `test`        | A separate record that can authorize managed worker updates.                 |

Each approval is separate. Pairing a phone or a viewer never grants `build`,
`device-host` or `test`.

For hosting, setup asks for macOS screen recording and device control
permissions on the worker. Without screen recording you cannot view the device;
without device control you cannot drive it. Setup never changes those settings
itself.

### Test approval

`stim test` runs on this machine only. A person on the worker can still record a
test approval with `stim setup --test`, in a terminal. Approve it only for your
own machines: it is meant to let the approved machine run commands as the worker
user without a sandbox. Windows workers refuse it.

## Requirements

Install the CLI on each machine:

<StimInstallTabs />

- **iOS builds:** Xcode and the client's simulator runtime on the worker, and
  CocoaPods when the project does not pin it. Automatic placement skips a worker
  that would rewrite `Podfile.lock`, and says so.
- **Android builds:** Java and the Android SDK with accepted licenses. When this
  machine has a JDK, the major versions must match.
- **Node:** a worker uses an installed Node that satisfies the project's pin
  (`.nvmrc`, `.node-version`, `.tool-versions` or Volta). Install one there if
  it has none, for example `brew install node@22`.
- **Hosting:** no CocoaPods or Android tools needed.

`stim doctor` and Desktop's **Tools** step compare both machines.

### Android release variants

`stim android --variant release --remote-build <machine>` builds on the worker.
Apps signed with the template's debug keystore sign there. Custom signing builds
unsigned on the worker, then aligns and signs here with your local keystore and
build-tools.

### Exact apps on the worker

An Exact build needs Exact's toolchain on the worker, under the user that runs
its Stim service. A worker without it is skipped, and the placement line names
the missing piece and the command that installs it. See
`stim guide lifecycle exact-ios`.

### Stim versions

A build runs your exact Stim release on the worker, which installs it from npm
the first time. A build from a checkout is accepted only while the worker's
`server.acceptClientBuilds` is `true` (default `false`). A worker older than
this machine is refused with the command to update it. Desktop's **Install This
Mac's Build** only moves a worker forward.

### Worker disk

Each checkout a client builds from gets its own area on the worker. The worker
removes an area when:

- you remove that worktree here, or the client's `build` approval is revoked;
- it saw no build for `server.workerAreaMaxAgeDays` days (7 by default, `0` turns it off);
- the volume has under 50 GB free, least recently used first, sparing areas used
  in the last 3 hours.

Under 10 GB free the worker declines builds.

## Linux worker

An x86_64 Linux machine takes Android builds only. On Ubuntu 22.04 or 24.04, as
the user that will own the service (not root), run
[`scripts/linux-worker/setup.sh`](https://github.com/appandflow/stim/blob/main/scripts/linux-worker/setup.sh)
from this repository:

```bash
scripts/linux-worker/setup.sh --hostname stim-linux-worker
```

It installs Node, JDK 17, the Android SDK packages, Tailscale (you open the login
URL; it never takes an auth key) and `stim` as a systemd user service. It needs
`sudo` and is safe to rerun, but a rerun restarts the server and stops a build
in progress. Then run `stim remote add stim-linux-worker` on your machine, and
the printed setup command on the Linux machine.

To set it up by hand, install Node 22.12.0 or later with Corepack enabled, JDK
17, the Android SDK and Tailscale, then:

```bash
sudo tailscale set --operator=$USER
sudo loginctl enable-linger $USER
npm install --global stim@latest
stim service install --serve \
  --env JAVA_HOME=/usr/lib/jvm/java-17-openjdk-amd64 \
  --env ANDROID_HOME=$HOME/Android/Sdk
```

Stim does not host emulators on Linux.

## Windows worker

A Windows machine takes Android builds only. Install Node 22.12.0 or later,
Tailscale, JDK 17 and the Android SDK, then run, without administrator rights:

```powershell
npm install --global stim@latest
stim service install --serve --path-prepend "C:\Program Files\nodejs" `
  --env JAVA_HOME="C:\Program Files\Eclipse Adoptium\jdk-17" `
  --env ANDROID_HOME="$env:LOCALAPPDATA\Android\Sdk"
```

Put the real Node first with `--path-prepend`: a version manager's `node.exe`
shim breaks Expo's config loader. A Windows task keeps the build it was
installed with, so install again after an update. Very deep native paths can
still refuse with `STIM_PATH_TOO_LONG`.

## Local network, without Tailscale

A worker on your local network can take builds without Tailscale.

<StimTabs code={`# on the worker: listen on one private address
stim settings set server.lanAddresses '["10.0.0.92"]'

# on this machine

stim remote add local:10.0.0.92`} />

Run the printed `stim setup` on the worker. It prints the worker's server key
fingerprint. Then run `stim remote list` here, in a terminal: it asks whether
the fingerprint matches. Answer `y` only when it does. Never let an agent answer
this question for you.

- On a local network nothing vouches for an address, and anyone with the ticket
  and a route to the worker can spend it.
- On a laptop, name an address, not an interface: an interface follows the
  laptop onto any network it joins.
- With the macOS firewall on, choose **Allow** when macOS asks about the
  server's `node`. On Linux, open TCP port 7787 to your local network.

## Pause incoming work

On the worker, pause new builds or devices; running ones finish:

<StimTabs code={`stim settings set server.buildsPaused true
stim settings set server.devicesPaused true`} />

## Keep the worker awake

<StimTabs code="stim settings set server.keepAwake true" />

## Undo

- Here: **Settings > Connections > This machine uses > Remove**, or
  `stim remote remove <machine>`. This forgets your credentials for it.
- On the worker: the approval stays until a person runs the
  `stim pairings revoke <id>` command that removal prints.
- On the worker, `stim service uninstall` removes the service and the route its
  install created. macOS permissions stay; remove them in System Settings.

## Security model

- Connections run over private Tailscale Serve routes, never Funnel, or over the
  local network addresses you name. Every connection also runs Stim's own
  authenticated, encrypted handshake. The worker knows the client by its key, and
  the client pins the worker's key. A network address never decides who a
  machine is.
- **Build approval runs your project's code on the worker as its user:** config
  plugins, CocoaPods hooks, Xcode script phases, Gradle plugins. It is not a
  sandbox. Approve only machines you trust. Approved clients can also request
  managed server updates.
- An offloaded build sends your tracked and untracked files, the gitignored
  files the build reads (such as Expo `.env` files), and the environment
  variables the build reads from your shell, which is every variable in your
  shell when project code enumerates `process.env`. These can hold secrets: Stim
  assumes every paired machine belongs to you. It never sends `node_modules`,
  Stim's own secrets, or toolchain and home paths.
- An iOS offload leaves out `*.p8`, `*.p12`, `*.mobileprovision` and
  `*.provisionprofile`, unless the Xcode project or a script names the file.
  `.env` files, `google-services.json`, `GoogleService-Info.plist`, `*.pem` and
  `*.cer` are still sent. Device builds are signed here and never offload.
- A release offload refuses known configurations that would send signing
  credentials. Review your checkout before offloading one that holds secrets.
- Before a client authenticates, a worker answers only the handshake, its
  version, and setup progress named by a ticket. It rate-limits unauthenticated
  connections.

## Troubleshooting

- **`STIM_OFFLOAD_REFUSED`:** the named worker cannot take or finish the build.
  The reason names what differs. See [troubleshooting](./troubleshooting.md#STIM_OFFLOAD_REFUSED).
- **`STIM_HOSTING_REFUSED`:** the host is unreachable or cannot confirm the
  session. Retry the same host, or run `stim stop` once it answers.
- **Unreachable:** run `stim doctor`, or open the machine in Desktop, to see where
  the connection fails. If a worker refuses tailnet connections, run
  `stim serve --tailnet` on it once so it always listens on the tailnet.
- **Slow or skipped:** `stim logs --source placement` shows why each machine was
  picked or skipped.
- **The worker itself:** run `stim doctor` and `stim service status` there.

Your agent finds the details in `stim guide lifecycle hosted-ios`,
`stim guide lifecycle hosted-android` and `stim guide settings`.
