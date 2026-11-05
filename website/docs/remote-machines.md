---
title: 'Remote machines'
description: 'Set up a remote machine to build your app or host iOS and Android devices'
---

import StimTabs, { StimInstallTabs } from '@site/src/components/StimTabs';
import Tabs from '@theme/Tabs';
import TabItem from '@theme/TabItem';
import PromptBox, { PromptGrid } from '@site/src/components/PromptBox';

Use a remote machine to build your app or run a simulator when this machine is busy. Macs can build and host devices. Linux and Windows workers handle Android builds. Building and hosting require separate approvals on the worker.

[Set up in Desktop](#use-the-desktop-wizard) · [Set up from the CLI](#cli-equivalent) · [Check requirements](#requirements) · [Troubleshoot](#troubleshooting)

The server command ships in `@stim-cli/server`. See [CLI setup](#cli-equivalent) for global and npx invocations.

## Use the Desktop wizard

1. Open **Settings > Connections > This machine uses > Add… > Build or Run Simulators There…**.
2. Choose an online Tailscale peer. Select **Builds**, **Hosted simulators**, or both. For Linux and Windows, select **Builds**.
3. Copy the setup command. A person at the worker runs it in Terminal and approves each requested capability. On a Mac running Desktop's own server, you can also [approve in Desktop](#approve-in-stim-desktop-on-the-worker).
4. Review **Tools**, choose where new builds and devices should run, then try a build if you requested **Builds**. See [Test build](#test-build).

If the wizard shows a key that needs confirmation, compare it with the key printed on the worker before accepting. If it reports a Stim version mismatch, see [Stim versions](#stim-versions).

## Approve in Stim Desktop on the worker

On the worker Mac, choose **Settings > Connections > Using this machine > Add… > Machine to Build or Run Simulators Here**. Paste the copied setup command and choose **Allow** for each expected grant. Keep the window open until the requester connects.

This works with the server that the worker's Desktop started. For a standalone service or a command with custom options such as `--port` or `--yes`, run the setup command in the worker's Terminal.

## Pause incoming work

Run on the worker. These switches pause new requests and let existing builds and sessions continue. Set either back to `false` to resume.

<StimTabs code={`stim settings set server.buildsPaused true
stim settings set server.devicesPaused true`} />

## Keep the worker awake

On a plugged-in Mac worker, prevent sleep while the server is serving other devices.

<StimTabs code="stim settings set server.keepAwake true" />

## Choose where to build and run

**Builds and devices can go to different machines.** Use `--remote-build` to choose where to compile and `--remote` to choose where to run. A cache hit can skip compilation altogether.

<StimTabs
code={`stim ios --remote-build build-mini
stim ios --remote run-mini
stim ios --remote-build run-mini --remote run-mini`}
/>

| Value          | Placement                                                         |
| -------------- | ----------------------------------------------------------------- |
| `local`        | This machine only.                                                |
| `auto`         | This machine first. Try remote machines when it is full or busy.  |
| `remote`       | Remote machines first. Fall back here if enabled.                 |
| `remote-only`  | Remote machines only. A device run can wait for a host with room. |
| A machine name | Exactly that machine.                                             |

Automatic placement follows `remote.machines` order among eligible workers. For a device run, an eligible host named for the build takes priority. Builds default to `remote.build=auto`. Devices and macOS apps default to running here. Set `ios.remote`, `android.remote` or `macos.remote` to change the default. `STIM_REMOTE_BUILD` overrides the build setting, and the CLI flags override both. Stop a running device before switching its host.

Use `stim doctor` for compatibility and `stim logs --source placement` for the last decision. [Build cache behavior](./build-caches.md) · [Automatic device placement](#automatic-device-placement)

## Automatic machine pools

In **Settings > Connections > This machine uses**, **Builds enabled** and **Simulators enabled**
control this machine and each configured remote independently; a remote that Tailscale reports
as Linux or Windows shows only **Builds enabled**. All members start enabled.
Turning a switch off keeps pairing and active builds or sessions intact. It only
changes new automatic work requested by this machine; other requesters keep their own policy.

The same controls are machine settings listing excluded members:

<StimTabs code={`stim settings set remote.buildPoolDisabled '["local"]'
stim settings set remote.devicePoolDisabled '["janics-mac-mini"]'
stim settings unset remote.buildPoolDisabled`} />

Use `local` for this machine. Remote entries match `remote.machines` exactly, including
case and port; whitespace is not normalized. An unmatched entry excludes nothing,
so copy the configured entry or use Desktop's switches. Both lists default to `[]`.
Excluding `local` keeps this machine out of every automatic workload of that role at
once, like `remote-only`, except that a device or macOS app refuses at once when no
host admits it, where `remote-only` waits for a host that is only full.
Each pool must retain local or at least one configured remote already approved for
that role. An offline approved member still counts as configured, but must be
reachable and compatible to take a run. A remote that Tailscale reports as running
an OS other than macOS, such as a Linux or Windows machine, never counts for the device pool
and is never a hosting candidate, since it cannot host; an unknown OS counts as
able to host. Settings also refuses removing the last
member from `remote.machines`.

Named placement and `--remote-build local` bypass membership. Devices stay local
by default unless `--remote auto|remote|remote-only` or the matching platform setting requests automatic
placement. Existing local and hosted sessions retain their owner. A cache hit needs
no compiler; remote build preparation still follows the normal local prebuild and
Pods flow. If local is excluded and no enabled machine can take the work, Stim refuses
instead of compiling or booting here. Disabling local alone never triggers billed
EAS fallback; an existing `remote.easFallback` opt-in still needs the physical device
cap or queue condition.

## Reverse ports on hosted devices

`stim ports reverse <label|port>` also works for a hosted simulator or emulator, so an app on the host reaches a server on your machine at the same `localhost:<port>`. The machine you run Stim on can be a Linux sandbox that accepts no inbound connections: the host never connects to it.

<StimTabs code={`stim start
stim ios --remote janics-mac-mini
stim ports reverse 4318`} />

Your Metro supervisor, started by `stim start`, keeps idle connections open to the host, one set per reversed port. The host listens on its own loopback and hands each connection the device makes to one of them, and your machine forwards it only to the same port on its own loopback. The port list comes from your workspace, so the host cannot ask for another port. This needs the same `device-host` approval as the hosted session and a host stim-server that advertises `hosted-reverse-ports`.

- A hosted iOS simulator shares the host's loopback, so the host listens on the same port number. A port another process holds on the host is refused; reverse another port or free it there.
- A hosted Android emulator has its own loopback, so the host listens on a private loopback port and points the emulator's `adb reverse` at it. Two sessions can reverse the same port.
- Any process on the host Mac can connect to those loopback ports while the session lasts. Reverse only servers you would let that Mac's users reach.
- `stim ios --remote` and `stim android --remote` set the reversed ports up again when they place an app, `stim reload android` restores an emulator's, and a host restart resumes them with the session. Stopping or losing the session, or `ports reverse --remove`, closes them.

Copy this prompt into your agent:

```text
My agent runs in a sandbox and the app runs on the hosted simulator on
janics-mac-mini. Read stim guide ports, reverse the port of the server the app
must reach, and confirm the app connects at localhost:<port>.
```

For Appduct, set `advertisedIp` in `~/.appduct/config.json` to `127.0.0.1`, run `stim ports reverse <daemon port>`, and deliver its link with `stim agent-device open <app> "<link>"`.

## Hosted parking and restart

A host can park a healthy simulator or emulator after `stim stop` and reuse it for the same client. Adoption clears app data. The host's `pool.iosParkedMax` and `pool.androidParkedMax` set limits across clients, separate from the local device pool. Set a limit to `0` to disable parking.

Verified sessions can survive a server restart. If the server cannot confirm the device's state, run `stim stop` again when the host answers. On the host, `stim gc` lists parked hosted devices and `stim gc --delete` can remove them.

### Hosted sessions stop when they are idle

The client and host each apply their own `maintenance.idleStopHours` (six hours by default, `0` to disable). The client stops a confirmed idle workspace. The host can stop a session after its client has gone away and no viewer, Metro link or agent is using it. The host uses its machine setting. [Idle workspace stop](./dev-server-and-logs.md#idle-workspace-stop)

## Run Android on a hosting Mac

<StimTabs
code={`stim android --remote janics-mac-mini --device-profile pixel_7
stim reload android
stim stop`}
/>

Use the worker's installed device profiles and system images. A worker with `android.installImages=auto` can install a missing image if its SDK licenses are accepted. For Debug, Metro stays on this machine and Stim connects it to the emulator. Release and native Gradle apps run without Metro. Stop before switching hosts or moving the slot back here.

For agent control, set `hosting.agentDriver=agent-device` on the host and install agent-device 0.21.30 or later on both machines. Use [`stim agent-device`](./commands.md#agent-device) from the workspace to target its hosted emulator.

## Requirements

Install the client CLI globally or run it with npx:

<StimInstallTabs />

A remote machine can compile iOS simulator Debug and Release apps, Android
emulator debug and release apps, and macOS SwiftPM Debug apps. An iOS Release app built there
carries the JavaScript of the checkout this machine synced, including gitignored
`.env.production` files, so a machine without Xcode, such as Linux, can run
`stim ios --configuration Release --remote-build <mac>`. The worker bundles it
in its own environment: an `EXPO_PUBLIC_` variable set only in this shell is not
applied; put it in an `.env` file.
Android builds on a
worker machine need Java and the Android SDK. Device builds,
EAS/proxy runs, Android CAS compiler-cache builds, and iOS/Android runs with
artifact caching disabled in settings do not offload.

### Android release variants

Use `stim android --variant release --remote-build <machine>`. The worker bundles JavaScript from the synced checkout, including eligible ignored `.env.production` files. Shell-only `EXPO_PUBLIC_` values do not travel with it.

- Template releases that use the debug keystore are signed on the worker.
- Custom signing normally builds an unsigned APK there, then aligns and signs it here. The client needs Android SDK build-tools and the local keystore.
- Release offload skips recognized signing files and refuses known configurations that would send signing credentials. Review the transfer rules before using a checkout with secrets. Guard Gradle configuration reads for missing keys or build locally. [Security model](#security-model)

Use a worker with Java, the Android SDK and accepted SDK licenses. JDK major versions must match when the client has a JDK. On iOS and macOS, Stim checks Xcode and SDK compatibility when required. Check both machines with `stim doctor` or open **Tools** in the Desktop wizard. [Machine settings](./settings.md#machine-settings)

### CocoaPods on the worker

The worker runs `pod install` only when its `ios/Pods` is not installed or does
not match `Podfile.lock`. Stim syncs the files git lists, and `Pods` is
gitignored, so the first build of a project on a worker installs them there.
A worker without CocoaPods, or with another version, fails or rewrites the
`COCOAPODS:` line of a committed `Podfile.lock` there, which the fingerprint check
reports as `fingerprint-mismatch`. So `auto`, `remote` and `remote-only` placement skip it for a project
that does not pin CocoaPods, unless it already holds the exact artifact, and
the placement line and `stim doctor` say why, with `brew install cocoapods` for a
worker that has none. A named `--remote-build` still sends the build there. If
`pod install` fails, the build reports "pod install failed" and the command to
run on that machine, and stops. For `stim ios`, a named `--remote-build` is also checked against the
machine's Xcode, runtime and CPU before this Mac runs prebuild and `pod install`.

The CocoaPods version is read in the project's `.ruby-version` when that Ruby
is installed, using the same UTF-8 locale defaults as `pod install`. Without
an installed project Ruby, it uses rvm's or rbenv's default Ruby, and without
one of those the `GEM_HOME`, `GEM_PATH` and Ruby-related `PATH` entries of each
machine's login shell, so Desktop, terminal and agent callers agree; `pod install`
(including the Bundler run) runs in the same environment. A caller that already
sets `GEM_HOME` keeps it, and if the login shell cannot be read the caller's
environment is used.

The worker installs dependencies with the lockfile nearest the app: the first
`pnpm-lock.yaml`, `yarn.lock` or `package-lock.json` in the app's directory or
above it in the repository, in the directory that holds it. An app with its own
lockfile inside a larger repository installs its own dependencies there. In a
pnpm workspace the worker installs every workspace package, as `pnpm install`
does locally, because a native build can run a script of a package the app does
not depend on, such as a Gradle task that runs `pnpm run --filter <package>`.

When the app pins Node in `.nvmrc`, `.node-version`, `.tool-versions` or
`package.json`'s `volta.node`, in its own directory or the nearest one above it
in the repository, the worker installs dependencies, runs prebuild and pods, and
runs xcodebuild with an installed Node that satisfies the pin: an nvm, fnm,
Volta, asdf, mise or linked Homebrew `node`/`node@NN` install. On every
offloaded iOS build, pinned or not, the worker also writes the first `node` on
its `PATH` (the pinned Node when it put one first) as `NODE_BINARY` in the iOS
project's `.xcode.env.local`, replacing any `export NODE_BINARY=` line already
there. Offloaded React Native and Expo Android builds keep a separate Gradle
home for each selected Node executable and version. Changing Node starts a cold
Gradle dependency cache and can retain another warm daemon; switching back reuses
that Node's cache. These caches go with their repository area, see [Worker disk](#worker-disk). Native Gradle
projects keep their existing home. A pin naming a version the
worker does not have, such as `22.22.0`, uses the newest installed Node of that
major that is not older than the pin, such as Homebrew's `node@22` at 22.23.2.
Without one, the steps run on the worker's own `node`, and a failed install or
prebuild names the pin and that Node's version. Install a matching Node on the
worker, for example `brew install node@22`. When the pinned Node's major
changes, the worker reinstalls dependencies so native modules match it.

### Worker disk

Each source checkout a client builds from, including each worktree, gets its own
repository area on the worker with its checkout, dependencies, build outputs and
Gradle home. The worker removes these areas by itself:

- An area with no build or cached artifact fetch for
  `server.workerAreaMaxAgeDays` days (default 7, `0` turns this off).
- While the volume of `server.workerRoot` has less than 50 GB free, the least
  recently used areas until it has that much again, sparing areas used in the
  last 3 hours. If only those are left, they stay, the log says so once, and
  builds keep running.
- Under 10 GB free the worker declines builds, so those recent areas can go too,
  until the volume is back over 10 GB.

It always keeps each client's most recently used area. It retains an area with a
running or unfetched build, a bundle a hosted session can still take, an open
connection sending it a manifest, a running Gradle daemon, or an ownership claim
that is held or unresolved. The stim-server log has one line for each removal and
one for each area it retains, with the reason. If a delete fails, the log says so
once and a later pass finishes it. The next build of a removed
checkout uploads what it needs again and starts cold. A client's shared blobs and
CocoaPods, pnpm and SwiftPM caches stay until the client is removed.

`stim-server service status` prints a `worker root:` line with the root's size as
last measured, about every 6 hours, and the local `/health` answer carries it as
`workerRoot`. Windows workers do not measure it.

### Stim versions

Each Stim release carries a build compatibility version. Two machines build for
each other when the versions are equal, whatever their Stim releases or builds.
The version changes only in a release that changes what a worker builds, how it
builds it, or the build and artifact messages, so a release on one machine and a
checkout build on the other usually still offload. Completed artifacts on a
worker are reused under the same rule. A stim-server too old to report a build
compatibility version needs exactly the same Stim build as this machine. When
the versions differ, doctor reports `stim-build` and builds stay on this
machine until the worker runs a compatible release; see [Tools](#tools).
Hosted simulators and emulators do not compare versions: they check the
features the host's stim-server reports.

Stim Desktop's **Install This Mac's Build** only moves a worker forward. It reads
the worker's Stim release first and disables the button, with the reason beside
it, when the worker would refuse: it runs a newer release than this Mac (the
fix is **Check for Updates** in Stim Desktop, or updating Stim here), this Mac
runs a build from a checkout and the worker has `server.acceptClientBuilds` off,
the worker's stim-server cannot update itself, or it did not answer. **Keep
remote machines on this Mac's Stim version** never installs on such a worker.

## CLI equivalent

For a new machine with both capabilities selected, Desktop generates this
command, with the ticket and expiry filled in. On a machine without Desktop,
`stim remote add <machine>` makes the ticket and prints the same command:

<Tabs groupId="stim-invocation" defaultValue="global">
<TabItem value="global" label="Global">

```bash
STIM_SETUP_TICKET=<43-base64url-characters> stim-server setup \
  --expires <ISO-time> \
  --build \
  --device-host
```

</TabItem>
<TabItem value="npx" label="npx">

```bash
STIM_SETUP_TICKET=<43-base64url-characters> npx --yes --package @stim-cli/server@<version> stim-server setup \
  --expires <ISO-time> \
  --build \
  --device-host
```

</TabItem>
</Tabs>

Run the actual copied command on the worker. The ticket goes in
`STIM_SETUP_TICKET`, not an argument, because other users on the worker can
read a process's arguments; setup refuses `--ticket` and `--client`. The ticket
is 32 random bytes the requesting machine made, and it alone names that machine.
Desktop tickets last 30 minutes, tickets from `stim remote add` or `stim doctor --fix` just under two hours;
setup accepts a future expiry at most two hours away. `--yes` above belongs
to npx. It does not skip setup's per-grant Y/n questions. Setup's own `--yes`
flag approves without those questions and is required for new approvals
without a terminal. A person on the worker makes that decision.

Setup installs its exact server release, Stim Host, and a per-user
LaunchAgent, then creates or reuses a tailnet-only HTTPS route. By default,
the server uses port 7787, the service label is `dev.stim.server`, and the
route uses 7443 or the next free HTTPS port. It reuses a Desktop-run server
on that port only when it uses the same Stim home and already has a private
route; it installs no LaunchAgent for that server.

Optional `--port`, `--label`, repeatable `--env KEY=VALUE` and
`--path-prepend <absolute-dir>` customize the service. A new service inherits
only `STIM_HOME` and `SHELL`; pass tool paths and variables explicitly.
Export `STIM_HOME` before setup if needed; `--env` cannot set it.
`--json` prints one final payload and sends progress to stderr.

| Exit | Meaning                                                                    |
| ---- | -------------------------------------------------------------------------- |
| 0    | All selected capabilities, needed permissions and tools are ready.         |
| 1    | A refusal or failed step; completed steps remain in place.                 |
| 2    | No grant before expiry, or an expired command.                             |
| 3    | At least one grant, but another capability, permission or tool is missing. |

See [Set up a worker machine](https://github.com/appandflow/stim/blob/main/packages/server/README.md#set-up-a-worker-machine)
for the full server reference.

### Manual setup

Without the wizard, install or run the server on the worker machine:

<Tabs groupId="stim-invocation" defaultValue="global">
<TabItem value="global" label="Global">

```bash
npm install --global @stim-cli/server@1.21.0
stim-server service install --serve
```

</TabItem>
<TabItem value="npx" label="npx">

```bash
npx --yes --package @stim-cli/server@1.21.0 stim-server service install --serve
```

</TabItem>
</Tabs>

On your main machine, add the machine and request access. This works from any
directory and keeps the remote machines already in `remote.machines`. Add
`:<port>` to the name if the route listens on another port than 7443.
`stim remote add` asks the machine for both approvals:

<StimTabs code={`stim remote add janics-mac-mini`} />

`stim remote add` prints a `stim-server setup` command with a new setup
ticket. A person on the worker runs it there to approve this machine, as in
[Use the Desktop wizard](#use-the-desktop-wizard); it asks once for build and once for
device hosting. Approve only what you want to use; a listed machine that never granted an approval
is not used for it, and `stim remote list` says so.
Tickets from `stim remote add` expire just under two hours later. While a request is pending, `stim remote list --json`
reports its `expiresAt`; after it lapses it reports `lapsed`, and
`stim remote add` asks again. After a person approves on the worker, run
`stim remote list` on the main machine to complete the connection. That setup
command also prints this reminder after approval; setup commands from Stim
Desktop do not add it. Run `stim doctor` in an app directory to also check
that the machine can build that app.

```bash
stim remote list
stim remote remove janics-mac-mini
```

`stim remote list` reports each machine's build and device-host approval in
placement order and asks nothing new. `stim remote remove` drops the entry and
forgets this machine's credentials for it; the worker keeps its approval until
a person there runs the `stim-server devices revoke <id>` command it prints.
If the hosting credentials file is unreadable, `stim remote remove` keeps the
entry and credentials and names the file. Use a compatible Stim version,
restore read access, or restore the file from a trusted backup, then retry.
With `--json`, each machine also carries its server key fingerprint, its
reachability in this run and those revoke commands.
`stim settings set remote.machines` replaces the whole list; use it to reorder
machines. `stim doctor --fix` in an app directory still asks every listed
machine that has not been asked.

A worker whose stim-server predates protocol 2 cannot authenticate this machine.
`stim doctor` reports it as `outdated` and names the update: run
`stim-server service update --release <version>` there with this machine's
Stim version, then `stim remote add <machine>` here.

If active builds or a hosted native step (an install, for example) prevent that
update, add `--no-wait` to the service update command. This interrupts that work
during restart instead of waiting for it to finish; a server that resumes its hosted
sessions leaves its other ready simulators and emulators running through the restart; shutdown, health checks and rollback
still apply. Setup also accepts `--no-wait` for its managed-service update.

### Linux worker

An x86_64 Linux machine can take this machine's offloaded Android debug
builds. It cannot build for iOS or macOS, and it cannot host simulators or
emulators for Stim. The commands below target Ubuntu 22.04 and 24.04.

#### Quick path

On the Linux machine, as the user that will own the service (not root), run
[`scripts/linux-worker/setup.sh`](https://github.com/appandflow/stim/blob/main/scripts/linux-worker/setup.sh)
from a checkout of this repository, or download that file. It needs `sudo`, and
it is safe to run again (a rerun restarts the server, which stops a build
that is running on it):

```bash
scripts/linux-worker/setup.sh --hostname stim-linux-worker
```

It installs or verifies:

- Node 22.12.0 or later, with Corepack enabled for `pnpm` and `yarn`, so the
  worker runs the package manager version in the app's `packageManager` field
  (a project without that field gets Corepack's default version, which can
  refuse `--frozen-lockfile`);
- JDK 17;
- the Android command-line tools in `~/Android/Sdk`, with `platform-tools`,
  `platforms;android-37.0`, `build-tools;37.0.0`, `ndk;27.1.12297006` and
  `cmake;3.22.1`. Name other `sdkmanager` packages as arguments to replace the
  last four; the script accepts the Android SDK licenses;
- Tailscale from the official package repository. It runs `tailscale up`, which
  prints a login URL: open it in a browser to sign the machine in to your
  tailnet. The script never takes an auth key. It then runs
  `tailscale set --operator=$USER`;
- `@stim-cli/server` (`--server-version <version>`, default `latest`), a
  `loginctl enable-linger`, and the systemd user service from
  `stim-server service install --serve` with `JAVA_HOME` and `ANDROID_HOME`.

Add `--emulator` to also put your user in the `kvm` group and install the
Android emulator package and an x86_64 API 36 system image (see
[Emulators and memory](#emulators-and-memory)). `--no-tailscale` and
`--no-service` skip those steps, for a container or an image build.

When it finishes it prints the steps for your main machine, which are the same
as step 4 of the manual path below.

#### Manual path

1. Install what the build needs:

   - **Node 22.12.0 or later.** On Ubuntu, install it from
     [NodeSource](https://github.com/nodesource/distributions) or use nvm.
   - **The package manager of the app's lockfile**, on the `PATH` of the
     service: `pnpm` for a `pnpm-lock.yaml`, `yarn` for `yarn.lock`, and npm
     comes with Node. The worker runs `pnpm install --frozen-lockfile` (or the
     yarn or npm equivalent), and without the tool the build is refused with
     `deps-failed: spawn pnpm ENOENT`. Corepack, which ships with Node 22,
     provides the version the project pins:
     `sudo corepack enable pnpm yarn` (without `sudo` when Node is under your
     home, as with nvm).
   - **Tailscale**, signed in to the same tailnet.
   - **JDK 17**: `sudo apt install openjdk-17-jdk-headless`.
   - **The Android SDK**, in `~/Android/Sdk` (the service finds it there; pin
     another location with `ANDROID_HOME` below). Install the command-line
     tools from the
     [Android Studio downloads page](https://developer.android.com/studio#command-line-tools-only)
     into `~/Android/Sdk/cmdline-tools/latest`, accept the licenses, and
     install the packages the app names:

     ```bash
     export JAVA_HOME=/usr/lib/jvm/java-17-openjdk-amd64
     yes | ~/Android/Sdk/cmdline-tools/latest/bin/sdkmanager --licenses
     ~/Android/Sdk/cmdline-tools/latest/bin/sdkmanager "platform-tools" \
       "platforms;android-37.0" "build-tools;37.0.0" \
       "ndk;27.1.12297006" "cmake;3.22.1"
     ```

     These are the packages for `apps/mobile` in this repository (React
     Native 0.88). The platform package is `android-37.0`, not `android-37`.
     For another app, read `compileSdk`, `buildTools` and `ndkVersion` from
     `node_modules/react-native/gradle/libs.versions.toml`, or let Gradle
     download what is missing on the first build (the NDK is 1-2 GB).

2. Let your user run `tailscale serve`, and keep your services running after
   you log out:

   ```bash
   sudo tailscale set --operator=$USER
   sudo loginctl enable-linger $USER
   ```

3. Install the server globally (the service records its paths, so not from an
   npx cache) and run it as a systemd user service with a tailnet-only route.
   With NodeSource Node the global prefix is `/usr`, so `npm install --global`
   needs `sudo`; with nvm it does not:

   ```bash
   sudo npm install --global @stim-cli/server@latest
   stim-server service install --serve \
     --env JAVA_HOME=/usr/lib/jvm/java-17-openjdk-amd64 \
     --env ANDROID_HOME=$HOME/Android/Sdk
   stim-server service status
   ```

   The unit is `~/.config/systemd/user/dev.stim.server.service` and the log
   `~/.local/state/stim/dev.stim.server.log`. `service update` and
   `service rollback` work as on a Mac, and an approved client can update the
   server remotely.

4. On your main machine, add the machine to `remote.machines`:

   ```bash
   stim remote add stim-linux-worker
   ```

   It prints a setup command with a one-time ticket. Run it on the Linux
   machine (add `--yes` over a non-interactive SSH session), then run
   `stim remote list` so the client finishes the connection. The command carries
   `--build` only. Setup on Linux refuses `--device-host` and skips Stim Host
   and the permission steps. `stim remote add` does not ask a machine that
   Tailscale reports as running an OS other than macOS for device-host access,
   since it can never grant it.

5. Try a build:

   ```bash
   stim android --remote-build stim-linux-worker --no-build-cache
   ```

`stim doctor` on the main machine rates a Linux machine for Android only, so a
project with iOS too still reports it offloadable for Android builds.

#### Serve the phone app from Linux

A Linux machine that starts workspaces, such as a bot running `stim ios --remote <mac>`, can run `stim-server` as the owning server for them. The phone app pairs with that machine and sees its workspaces, its offloaded builds and the hosted simulators it started, which it reaches through the Linux machine's server and not through the Mac that hosts them. Stim Desktop does not pair with other machines' servers yet.

1. Install the server beside `stim` and run it as a systemd user service, as in the manual path above:

   ```bash
   npm install --global --prefix ~/.local @stim-cli/server@<stim version>
   stim-server service install
   ```

   `service status` finds the user manager without a login session by defaulting `XDG_RUNTIME_DIR` to `/run/user/<uid>`. Run `sudo loginctl enable-linger $USER` once so the service survives logout.

2. Run `stim-server pair` on the Linux machine, over SSH if you like. Without a `tailscale serve` route it prints the server's direct tailnet address, `ws://<tailnet IP>:7787`, which the server already listens on, and says so on stderr. With `--serve` at install, or `sudo tailscale set --operator=$USER` and the `tailscale serve` command it prints, the endpoint is `wss://<name>.<tailnet>.ts.net:7443`.

Pairing needs the phone to reach the machine's tailnet address, so a phone on another tailnet needs the machine shared to it.

What does not run on Linux: Mac window capture, Xcode builds, the `stim-frames` helper and iOS devices. The server leaves the matching `features` out of its `hello` and does not try to build the helper.

#### Emulators and memory

Stim does not host emulators on a Linux worker. If you run one there yourself
(outside Stim, for example to check an APK):

- The emulator needs `/dev/kvm`, which is `root:kvm 0660`. Add your user to the
  group with `sudo usermod -aG kvm $USER` and log in again; `emulator
-accel-check` then reports KVM as usable. On a cloud VM, pick an instance
  type with nested virtualization.
- It needs an x86_64 build. An offloaded build targets the ABI of the emulator
  on the client, which is `arm64-v8a` on an Apple Silicon Mac. An arm64-only
  APK installs on an x86_64 emulator through translation but crashes when it
  loads its native libraries. `stim android` builds the ABI of its own device;
  for an emulator on the worker, run Gradle there yourself with
  `-PreactNativeArchitectures=x86_64`.
- On Ubuntu 24.04 with emulator 37.2, an API 36 `google_apis` x86_64 image
  booted and stayed up; an API 37 image rebooted every 20 seconds. The
  emulator API level does not have to match the app's `compileSdk`.

A build and an emulator together need memory. A 16 GB machine ran out of it
with one emulator (3.3 to 3.7 GB resident for a 2 GB guest) next to a warm
Gradle daemon (4 GB or more), and the kernel stopped the daemon and restarted
`stim-server`. Use 32 GB, or stop the daemon (`./gradlew --stop`) before
starting an emulator.

### Local network, without Tailscale

A worker on the same local network as this machine can take its builds without
Tailscale. Name it in `remote.machines` as `local:` and its private IPv4 address
or host name, with an optional stim-server port (default 7787). Every connection
runs Stim's own authenticated, encrypted handshake, so it travels as plain
WebSocket without TLS.

On the worker, first choose where stim-server listens. `server.lanAddresses`
takes network interface names, such as `en0`, or private IPv4 addresses. It is
empty by default, which listens on no local network address, and refuses
`0.0.0.0`, loopback, public and IPv6 addresses. A running server applies a
change within a few seconds. An interface name follows the interface onto any
private network it joins, such as a coffee shop's, so on a laptop or any machine
that moves between networks, name its address instead; use an interface name
only on a worker that stays on one network:

<StimTabs code={`stim settings set server.lanAddresses '["10.0.0.92"]'`} />

On this machine, add the worker and ask for access:

<StimTabs code={`stim remote add local:10.0.0.92`} />

On the worker, run the `stim-server setup` command it printed; on a Linux or
Windows worker, which takes builds only, leave out `--device-host`. Setup checks
that stim-server listens on the local network, and skips the tailnet route when
Tailscale is not running there. It prints the endpoints and the worker's
**server key fingerprint**, and waits for this machine.

Then run `stim remote list` on this machine, **in a terminal**. It shows
the fingerprint the worker answered with and asks whether it matches the one
setup printed. Answer `y` only when it does. Stim pins the worker's key only
then, and every later connection must prove that key. Until a person confirms,
`stim remote list` reports the machine as `key-unconfirmed` and Stim does not use it.
Stim never answers this question for you, and neither should an agent.

Nothing on a local network vouches for a machine the way a tailnet does: an
address can be taken over. The setup ticket already keeps a machine without it
from completing the handshake, and the fingerprint check also catches a ticket
that reached the wrong machine. When the fingerprints differ, do not confirm;
check the address in `remote.machines`.

The setup command doctor prints carries the ticket in `STIM_SETUP_TICKET`, and
the ticket is a credential: once setup stores it, the first machine to spend it
gets the approval. On a tailnet that machine also had to be in your tailnet; on
a local network it only needs the ticket and a route to the worker. Copy the
command only to the worker. Afterward, `stim-server devices` on the worker lists
the address each approved machine connected from; the name in setup's approval
line is the one the requesting machine chose. A person on the worker can give
a record a clearer name with `stim-server devices rename <id> <name>`; its
access does not change. The ticket also lands in
the worker's shell history; it stops working when it expires, within two hours.

On a Mac with the macOS firewall on, setup warns that macOS asks whether the
stim-server's `node` may accept incoming connections. Choose **Allow**, or allow
it in **System Settings > Network > Firewall > Options**; other machines cannot
connect until then. The question appears in the worker's logged-in session, so
answer it there. Setup never changes the firewall. On Linux, allow TCP port 7787
from your local network in the firewall you use, for example
`sudo ufw allow from 192.168.1.0/24 to any port 7787 proto tcp`. A Linux worker
set up with `scripts/linux-worker/setup.sh --no-tailscale` takes the same
`server.lanAddresses` setting.

Offloaded builds and hosted Debug and Release runs on a simulator or emulator
work over the local network. Agent control of hosted iOS and Android Debug runs
works there too: the remote config points agent-device at a loopback port of
this workspace's Metro supervisor, which carries each request to the worker
over its own authenticated connection, so it works while `stim start` runs.
The worker needs a stim-server that advertises `hosted-agent-link`. Hosted
Release runs and hosted macOS apps on a local network machine report agent
control as `none` with the reason. `stim-server pair` puts the worker's local network
endpoint in the phone pairing code when Tailscale is not running there and
`server.lanAddresses` is set.

### Windows worker

A Windows machine can take this machine's offloaded Android debug builds. It
cannot build for iOS or macOS, and it cannot host simulators or emulators. On
the Windows machine:

1. Install Node 22.12.0 or later, Tailscale signed in to the same tailnet,
   JDK 17 and the Android SDK with the project's NDK, build-tools and compile
   SDK.
2. Install the server globally and run it as a scheduled task with a
   tailnet-only route. No administrator rights are needed:

   ```powershell
   npm install --global @stim-cli/server@latest
   stim-server service install --serve --path-prepend "C:\Program Files\nodejs" `
     --env JAVA_HOME="C:\Program Files\Eclipse Adoptium\jdk-17" `
     --env ANDROID_HOME="$env:LOCALAPPDATA\Android\Sdk"
   stim-server service status
   ```

   The task starts at your logon and keeps running after you sign out; the
   log is `%LOCALAPPDATA%\Stim\Logs\dev.stim.server.log`. `service update`
   and `service rollback` work as on macOS and Linux, and an approved client can update
   the server remotely.
   `--path-prepend` puts the real Node first on the server's `PATH`. A version
   manager's `node.exe` shim, such as pnpm's, breaks the Node IPC that Expo's
   config loader uses, and the build then fails with `fingerprint-mismatch`;
   `install` says so when the first `node.exe` on `PATH` is not the Node that
   runs the server.

3. On your main machine, run `stim remote add <machine>` as above. Run the setup command it prints on the
   Windows machine, or the one the Desktop wizard generates; both carry
   `--build` only. Setup on Windows
   refuses `--device-host` and skips Stim Host and the permission steps.

The NDK's ninja on Windows cannot open a path longer than 260 characters, so
a Windows worker keeps each checkout and each client's Gradle home in a short
directory under `C:\sw` (the system drive) that only its user can open, and
deletes them when the client loses `build`. A project whose native object
paths are still too long refuses with `STIM_PATH_TOO_LONG`.

`stim doctor` on the main machine rates a Windows machine for Android only.

## Permissions

| Approval      | What it enables                                                                              |
| ------------- | -------------------------------------------------------------------------------------------- |
| `build`       | Compiling the requesting machine's project as the worker user.                               |
| `device-host` | Running the client's native app in its own hosted device or app session.                     |
| `read`        | Reading workspaces, logs and device screens, including workspace text diffs where supported. |
| `control`     | Device input and workspace Reload/Stop actions for a paired viewer.                          |

Build and device-host grants are separate from each other and from viewer
read/control grants. Pairing a phone does not grant build or hosting access.

For hosting, setup asks for normal macOS screen recording and device control
permissions on the worker. Missing screen recording prevents viewing; missing
device control prevents controlling the simulator. A terminal lets you skip a
permission with `s`; skipped permissions remain unavailable. Setup opens the
matching Privacy & Security panes when needed. For a reused Desktop server,
allow that app. Setup does not change macOS permission settings itself.

## Tools

Setup checks installed tools and prints fixes; it does not install Xcode,
runtimes, CocoaPods, Java or the Android SDK. Desktop's Tools step compares
them against the client. No tool result blocks the next step: problems are
shown, and the machine stays added. Hosting alone does not need CocoaPods
or Android tools.

**Install This Mac's Build** can update an approved worker over the tailnet.
An exact npm release needs no extra setting. Installing this checkout's own
build requires `server.acceptClientBuilds=true` on the worker; it defaults to
false. A failed server health check restores the previous version.

The worker restarts only once its offloaded builds and hosted native steps end (a
worker that resumes its hosted sessions leaves ready iOS and Android sessions running
and does not wait for them), and the card says what it waits for. When a worker that
does not resume holds this Mac's hosted simulators, **Stop and
Update...** stops them with `stim stop` after a confirmation that names each
device and workspace; another machine's sessions can only be stopped on the worker.
The update shows as finished once the worker runs this machine's Stim build, even
when another update installed it, and a refused update (for example, one already
running there) shows the worker's reason.

## Test build

When you request build access, choose **Run a Test Build with a Sample App** on the wizard's last step. The sample needs network access to install. It tests an iOS build on a Mac worker or an Android build on Linux and Windows. Desktop shows upload, build and download timings. The first build may take longer while the worker's caches are cold.

The sample stops when the test ends. **Run again** reuses it. Closing the wizard starts cleanup of the sample workspace and its device.

## Undo

**Cancel** removes only entries the wizard added, restores the mode only if
it changed it, and runs doctor to forget removed pairings. Worker grants
remain until revoked there. After finishing, use **Settings > Connections > This
machine uses > Remove** on the main machine, or run `stim remote remove <machine>`, which also
forgets this machine's credentials for it.

On the worker, run the summary's `stim-server devices revoke <id>` for each
grant you want to remove. Optional `stim-server service uninstall --label
<label>` removes the managed service and only the route that install created.
A reused Desktop server and its route remain managed by Desktop. Stim Host,
other pairings and macOS permission grants remain; remove permissions in
System Settings if desired.

## Security model

Connections use Tailscale and private Serve routes, never Funnel. On top of
Tailscale, every connection runs Stim's own authenticated, encrypted handshake:
the worker recognizes the client by its key, and the client pins the worker's
stim-server key. The tailnet address and node never decide who a machine is.
Setup approves the key that holds one ticket, until one expiry, once per selected
capability. Its live journal holds no secret; anyone who knows the journal name,
which only the ticket holder can derive, can read it until expiry.

An offloaded React Native build sends the checkout's tracked and untracked
files, and the gitignored files its native fingerprint hashes or its Expo config
reads, such as `.env.local` and the other Expo `.env` files. Those files can hold
secrets: Stim assumes every paired Mac belongs to the same person. Nothing under
`node_modules` is sent, since the build Mac installs dependencies itself, and
neither is build output the fingerprint ignores, such as `ios/Pods` or
`android/build`.

A worker on the local network listens only on the private addresses
`server.lanAddresses` names. Before a client authenticates, it answers only the
handshake, its version on `/health`, and setup journals named by a ticket. A
setup journal, at `/setup/<journal>`, shows setup's progress, such as its steps,
endpoints and grant ids, but never a ticket or secret, and its name derives from
the ticket, so a peer cannot guess it. Each listening address holds at most 64
unauthenticated connections, 16 from one address, closes one that sends no
request within 10 seconds or does not finish the handshake within 5, and turns
an address away for a minute after 5 failed handshakes or 60 first contacts
naming a ticket it does not hold. An address never authenticates anyone or names
a client's records.

Build approval permits the client's project code, including config plugins,
CocoaPods hooks, Xcode script phases and Gradle plugins, to run as the server
user. It is not a sandbox for untrusted projects. Approved build or device-host
clients can also request managed server updates. Only accept requests from
machines you trust. Forwarded peer addresses label approvals and key rate
limits. A local process on the server can forge one to lock a peer out
temporarily; it cannot authenticate.

## Troubleshooting

- [STIM_OFFLOAD_REFUSED](./troubleshooting.md#STIM_OFFLOAD_REFUSED): a named
  worker cannot take or finish the build. Check approval, tool compatibility,
  capacity and the pinned server key. A `fingerprint-mismatch` reason names the
  fingerprint sources that differ and the files `pod install` or prebuild rewrote
  on the worker; make that input agree on both Macs. Rerun with
  `--remote-build auto` or `local` only when you want to change placement.
- [STIM_HOSTING_REFUSED](./troubleshooting.md#STIM_HOSTING_REFUSED): the host
  is unreachable, has no compatible simulator or cannot confirm the session.
  Retry the same host, or reconcile with `stim stop` when it is reachable.
- [STIM_BAD_ARG](./troubleshooting.md#STIM_BAD_ARG): check the named host,
  simulator selectors and incompatible flags. Automatic hosting and named
  Android hosting are unavailable.
- For setup failures, follow the named step's fix and exit code. Update a
  reused server older than 1.21.0, generate a new command after expiry, and
  check Tailscale and the private route when the live mirror cannot connect.

### A remote machine is unreachable

Run `stim doctor` or open the machine's details in Desktop. The result shows where the connection failed, from Tailscale or LAN discovery to the HTTPS route, server or approval. Check that the worker is awake and serving on the expected network. Confirm a changed key on the worker before trusting it.

### Find out why a remote machine was slow or refused

<StimTabs
code={`stim logs --source placement
stim logs --source build`}
/>

Placement logs show why each machine was selected or skipped. For request timings, set `debug.logs` on the worker and read its stim-server service log.

### Check this machine's stim-server setup

Run `stim doctor` on the worker. It reports competing servers, version or home mismatches, route problems, missing permissions and service startup failures, with suggested fixes. Use `stim-server service status` for the installed service.

## Ask your agent

These responses are illustrative. Placement comes from `stim status --json`
(`buildMachine`, `builtOn`, `offloadedTo`, `offloadFallback`) and
`stim stats --json`. Today's per-machine `savedMs` is an estimate against
previous local cold builds; without a local baseline, Stim cannot estimate
savings. Stats retains at most 100 placements from the last seven days.

<StimTabs
code={`stim status --json
stim stats --json`}
/>

<PromptGrid>
  <PromptBox
    title="Check the last build"
    response={`The last iOS build compiled on janics-mac-mini.
Selected: auto. Placement: this machine was busy; the worker accepted the build.
No local fallback was recorded.`}
  >
    {`Check whether my last iOS build ran on my remote machine, and why or why not.`}
  </PromptBox>
  <PromptBox
    title="Review today's savings"
    response={`janics-mac-mini: 3 offloaded builds today; estimated savings 6m against previous local cold builds.
This is an estimate from the retained build history.`}
  >
    {`Show how much time my remote machine saved today.`}
  </PromptBox>
  <PromptBox
    title="Run on a hosting Mac"
    response={`Ran stim ios --remote janics-mac-mini.
Trailhead launched on the hosted iOS simulator on janics-mac-mini.
com.appandflow.trailhead · ready · errors clean`}
  >
    {`Run the app on a hosted iOS simulator on janics-mac-mini.`}
  </PromptBox>
</PromptGrid>

## Automatic device placement

Use `stim ios --remote auto` or `stim android --remote auto`, or set `ios.remote`
or `android.remote` to `auto`. Without a flag or setting, runs stay on this machine.
With no `remote.machines`, `auto` and `remote` are local and `remote-only` refuses with `STIM_HOSTING_REFUSED`.

`remote` skips the check below and asks the hosts first, in `remote.machines` order;
the device runs here only when none admits it, with the same wait and EAS fallback as
`auto`. `remote-only` never runs here, never joins the local queue and never uses EAS.
When every host that answered is only full, loaded or short of memory, it waits for
one to have room, checking every 5 seconds for `--wait` seconds (600 by default) and
printing one `placement:` line. `--no-wait`, `--wait 0` or the end of the wait refuse
with `STIM_AT_CAPACITY`. When no host could ever take the run (none configured,
unreachable, or declined for another reason such as paused), it refuses at once with
`STIM_HOSTING_REFUSED`, naming each skipped host and its reason. `--plan` never waits.

Auto stays local when the device cap has room (`concurrency.maxDevices`,
derived from RAM when 0), no run is queued ahead, host memory pressure is
normal, disk pressure is normal, and five-minute load per core is below
`server.maxLoadPerCore`.
An unknown device count stays local for the binding boot admission to decide.
A recorded hosted session is reused regardless of load; a live local owned
slot stays here. A stopped hosted session places again, while an unreachable
or unknown one refuses.

When this machine is full or busy, Stim probes every approved host in parallel with
three seconds per probe and the run's device selectors. It skips declined
hosts, incompatible choices, elevated or unknown memory pressure, zero
available capacity and a host whose load per core is at or above its own
`server.maxLoadPerCore` (a host that reports no limit uses this machine's). If this
machine has a free slot, unknown host load is skipped under `auto` (`remote` admits it); when the cap is full or a queue
is ahead, it is allowed. It resolves the build preference from `--remote-build`, then
`STIM_REMOTE_BUILD`, then `remote.build`. A named preference ranks first, followed by
`remote.machines` order, so the first host with room fills before the next gets a run.
Automatic
build offload resolves later, using the device's offered architecture.

If none admits and this machine is at its `concurrency.maxDevices` or per-platform cap (or runs are
queued ahead), the opt-in `remote.easFallback` setting runs the device on an EAS
Simulator, exactly as `--remote eas` would. EAS Simulator is billed, so the
setting defaults to `false`; set it per machine or per project:

```sh
stim settings set remote.easFallback true --scope machine
```

The build still runs here and Stim never starts an EAS cloud build. `stim stop`
ends the session, and `stim status` reports it like any `--remote eas` session.
A machine that is busy but has a free device slot never uses EAS. Before choosing
it, Stim checks without starting a session that eas-cli has the simulator
commands, `eas simulator:availability` accepts this project's account,
agent-device is on PATH, the run uses the default slot and no `--runtime`,
`--system-image` or `--device-profile` flag, no EAS Simulator session of this
workspace runs another platform or model, and a Debug run's Metro can be
reached (not `metro.tunnel` `off`; with an Expo tunnel, run
`stim start --remote` first). A recorded EAS session is not sticky: once this
machine has room, auto runs locally and the session bills until `stim stop` or
`remote.easMaxDurationMinutes`. When a check
fails, the run continues as below and the placement record says why.

If none admits and EAS is off or unusable, the run stays local and may wait in
the FIFO device slot queue.
`--no-wait` or `--wait 0` refuses with `STIM_AT_CAPACITY`; an admitted host can
still take those runs. The `placement:` line reports the decision and skipped
hosts; JSON mode sends it to stderr. Run facts and each status slot include
`devicePlacement: { decision, reason, machine? }`, where `decision` is `local`,
`hosted`, `waited-locally` or `eas`. Hosted status also preserves
`host.selected: "auto"` and `host.reason`.

A reservation can be refused after a successful offer because another run
wins the capacity race. That run fails with `STIM_HOSTING_REFUSED`, names the
host and asks to retry. Stim does not try the next host or local placement
because the build already targets the host's architecture. There is no fallback once a session exists.
`--simulator-app` with auto is honoured locally and ignored with a note on a host.
Placement measures budgets without reclaiming; only a new local run reclaims.
Named machines stay strict, physical `--device` cannot combine with
`--remote auto|remote|remote-only` and ignores those settings, and eas/proxy keep their existing behavior. macOS apps follow [`macos.remote`](./macos.md#run-it-on-another-mac).

Try this with your agent:

```text
Run this workspace's iOS app with stim ios --remote auto using the approved
remote.machines. Report the placement reason and verify the launched app on
the reported device. Keep using any recorded session, then stop this workspace
when finished.
```

```text
This Mac is often at its simulator cap. Explain what remote.easFallback costs
and give me the stim settings command to enable it; I will run it myself. Once
it is on, run stim ios --remote auto, report
the placement line from stim logs --source placement, and stop this workspace
when finished so the EAS Simulator session ends.
```
