---
title: 'Remote machines'
description: 'Set up a remote machine to build your app or host iOS and Android devices'
---

import StimTabs, { StimInstallTabs } from '@site/src/components/StimTabs';
import Tabs from '@theme/Tabs';
import TabItem from '@theme/TabItem';
import PromptBox, { PromptGrid } from '@site/src/components/PromptBox';

A **remote machine** is another machine on your tailnet that Stim can use in two ways.
It can compile your app and return the artifact; the app still runs on this
machine's device unless you select a remote target. It can also host an owned
simulator or emulator and run your app there. One list, `remote.machines`,
names the machines. Each use needs its own approval from a person on that machine, so a
listed machine that has not granted one is not used for it, and `stim doctor`
reports it.

The server command comes from `@stim-cli/server`; its npx form is
`npx --yes --package @stim-cli/server@1.21.0 stim-server`.

## Pause incoming work

On the worker machine, pause new builds and hosted sessions independently:

<StimTabs code={`stim settings set server.buildsPaused true
stim settings set server.devicesPaused true`} />

The running server reads these machine settings without a restart. A pause
rejects new work even when a client received an offer before the setting changed.
Running builds and existing hosted sessions continue; clients can still attach,
fetch completed artifacts, and stop their sessions. Hosted sessions include iOS,
Android and macOS. Client approvals are preserved, and local CLI builds and devices
remain available. These worker settings apply to every requesting machine, including
explicitly selected workers; Desktop's pool switches only affect that requester's
automatic placement.

Resume either capability when the machine is available again:

<StimTabs code={`stim settings set server.buildsPaused false
stim settings set server.devicesPaused false`} />

Both settings default to `false`. Pausing does not make the machine idle: let
existing work finish or stop the relevant sessions before timing benchmarks.

## Choose where to build and run

`remote.machines` names your remote machines; a build needs the machine's build approval.
Entries use tailnet names, optionally with an HTTPS route port, such as `janics-mac-mini:7444` (default 7443).
`remote.build` defaults to `auto`. With that selection, `remote.buildMode`
controls placement:

- `auto` (default) builds here while this machine has capacity. When it is busy,
  Stim considers accepting workers and their load.
- `force` prefers a remote machine when one accepts the build.
- `off` builds here when local remains enabled in the automatic build pool.

Automatic selection considers enabled pool members and falls back locally only when local remains enabled.
`--remote-build <auto|local|name>` overrides `STIM_REMOTE_BUILD`, which
also overrides `remote.build`. `STIM_REMOTE_BUILD_MODE` overrides `remote.buildMode`
for automatic selection. A named worker ignores that mode and local capacity;
it refuses with `STIM_OFFLOAD_REFUSED` instead of trying another worker or
building locally. For a configured, paired worker, a cache hit needs no
compilation and contacts no worker.
For native Xcode simulator builds, a local and configured-provider cache miss
also checks enabled paired workers for an exact completed artifact. A hit skips
source upload and compilation, even if the worker's build slots are full or this
machine is idle. The fingerprint and full cache key must match; the key includes
Xcode, SDK, architecture and target options. Missing or corrupt archives follow
the normal build placement rules. For React Native and Expo builds, among eligible workers, a verified matching
dependency installation ranks before load; checkout and build-folder presence
do not count as cache state. Older workers' unverified dependency hints are
ignored. `remote.buildMode: off` and
`--remote-build local` keep this flow local. Workers that lack the
`build-artifact-cache` feature continue to use normal build placement.
Native Gradle builds also query completed worker APKs when both source transfer
and artifact inputs are declared complete. The worker checks its current private
inputs against its saved receipt for the requested source, resolved variant, ABI
and build options, then rechecks before download. Its opaque identity stays
worker-scoped; the returned caller fingerprint remains `null`. This requires
`native-gradle-peer-cache`.
React Native and Expo development builds also check enabled paired workers after
local and configured-provider misses. Exact post-mutation fingerprints, native
build options and compatible toolchains must match. A worker keeps its completed
archive after changing or removing its checkout; a hit downloads it without
source upload or a build slot. This requires `react-native-peer-cache` and remote
artifact reads. Release and physical-device builds keep their existing paths.
SwiftPM, compiler and dependency caches keep their existing paths.

`--no-build-cache` skips artifact lookup and still stores the fresh build;
it can be used to test a named worker.

<StimTabs
code={`stim ios --remote-build janics-mac-mini --no-build-cache
stim ios --remote-build local`}
/>

Hosting needs the Mac's device-host approval. For a hosted
iOS simulator, use the machine name as the remote target:

<StimTabs code={`stim ios --remote janics-mac-mini`} />

The host's own owned devices count toward `concurrency.maxDevices`.

On the host, `stim-server devices` shows **Hosted here** rows with the client,
platform, device, installed app, state and time; `--json` includes
`hostedSessions`. Parked and unresolved sessions remain visible, while plain
stopped sessions are omitted. The person on that machine can list and stop any
client's session through loopback `device-host.sessions` and
`device-host.sessions.stop` (`{ session }`). Both require an authenticated local
Desktop control connection. Stop uses the existing cleanup path; remote
clients keep their own-session-only `device-host.stop` access.

The host boots its owned simulator headless. Debug keeps Metro on this machine
and connects it through a private tailnet bridge; no `stim start --remote` is
needed. `--device-type`, `--runtime` and `--slot` select the hosted simulator.
`--remote-build` independently selects a compatible worker for a Debug cache
miss. Named hosting has no local fallback. Stop the slot with `stim stop` before
moving it between local and hosted devices or between hosts.

Native Xcode apps build on this machine and run on the host without Metro; the host
reports live process readiness. That needs a host that advertises
`hosted-ios-process`. An older host refuses before reservation or upload; update
stim-server on it, or use `--remote auto`, which skips it. See
[native Xcode apps](./commands.md) for the build limits.

`--remote` also accepts two backend names: `eas` creates an EAS Simulator
session; `proxy` uses an existing agent-device daemon configured with
`AGENT_DEVICE_DAEMON_BASE_URL` and `AGENT_DEVICE_DAEMON_AUTH_TOKEN`, without
creating a session. Those targets prepare remote Metro exposure, as
`stim start --remote` does, and compile locally. They do not select a machine in
`remote.machines`. See [remote devices and Metro](./owned-devices.md#remote-devices).
`--remote auto` places iOS or Android on an approved Mac when this machine is full
or busy; see [automatic device placement](#automatic-device-placement).
Android also accepts these backends. The [macOS prototype](./macos.md) also supports named hosts.

## Automatic machine pools

In **Settings > Remote Machines**, **Builds enabled** and **Simulators enabled**
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
Each pool must retain local or at least one configured remote already approved for
that role. An offline approved member still counts as configured, but must be
reachable and compatible to take a run. A remote that Tailscale reports as running
an OS other than macOS, such as a Linux or Windows machine, never counts for the device pool
and is never a hosting candidate, since it cannot host; an unknown OS counts as
able to host. Settings also refuses removing the last
member from `remote.machines`.

Named placement and `--remote-build local` bypass membership. Devices stay local
by default unless `--remote auto` or the matching platform setting requests automatic
placement. Existing local and hosted sessions retain their owner. A cache hit needs
no compiler; remote build preparation still follows the normal local prebuild and
Pods flow. If local is excluded and no enabled machine can take the work, Stim refuses
instead of compiling or booting here. Disabling local alone never triggers billed
EAS fallback; an existing `remote.easFallback` opt-in still needs the physical device
cap or queue condition.

## Hosted parking and restart

On stop, the host parks healthy iOS simulators and Android emulators of approved
clients up to its `pool.iosParkedMax` and `pool.androidParkedMax`. The host reads
these settings from its own Stim home, with `STIM_POOL_IOS_PARKED_MAX` and
`STIM_POOL_ANDROID_PARKED_MAX` overrides. Each platform's hosted limit applies
across all clients, separately from the local parked pool. `0` disables parking;
with `STIM_HOME` set, the corresponding environment override is required.

A parked device stays ledger-owned in its session's private home and reports
`stopped` to the client. A later reserve by the same client adopts the oldest
compatible device: the resolved model, runtime and architecture match for iOS;
the system image, device profile and architecture match for Android. Adoption
clears app data by uninstalling every third-party app, and resets iOS privacy and
keychain. Another client never adopts it. Parking and adoption remove session
app copies but keep the content-addressed upload store, so the first run after
adoption uploads only changed files.

The oldest parked devices beyond the host's platform limit are deleted, also
after a limit decrease. Adoption-time reconciliation retires unusable devices;
revocation retires that client's parked devices. All deletion rechecks ownership
and uses centralized teardown. If GC removes a ledger-owned device, the next
reconciliation clears its parked marker.

On the hosting Mac, `stim gc` lists parked hosted iOS and Android devices with
their session, client id, device label, parked time and session-home ledger
ownership. `stim gc --delete` deletes them through the packaged stop worker in
each session home while holding its claim. Held claims, changed sessions and
unverified ownership keep the device; an unreadable journal keeps all hosted
devices. Android deletion also requires visibility from this shell's Android
environment; otherwise run gc with the server's `ANDROID_AVD_HOME`/`HOME`.
Records no longer listed in their session ledger are already removed and skipped.
`--older-than` filters by parked time; cache scopes omit hosted sessions.
The CLI leaves the journal unchanged, and the server clears the parked marker
when it reconciles the empty ledger.

A clean `stim-server` close parks eligible devices, which persist across restart
and can be adopted by the next reserve. The server never re-attaches to a booted
device after restart. A running session left by a crashed server stays `unknown`
until an explicit `stim stop` reconciles it.

## Run Android on a hosting Mac

Use the same device-host approval and name from `remote.machines`:

<StimTabs code={`stim android --remote janics-mac-mini --device-profile pixel_7
stim reload android
stim stop`} />

`android.remote` sets the default (machine scope for every app on this machine; a workspace, repo or committed value overrides it). `--system-image` and
`--device-profile` select choices installed on the host; the build targets
its offered ABI. `--remote-build` remains independent. Named hosting is strict:
refusal or an unreachable host fails with `STIM_HOSTING_REFUSED`. Stop before
changing hosts or moving between local and hosted devices. `--device` with
`--remote <machine>`, a running local emulator in that slot, and
`--no-metro-check` for hosted Debug refuse.

Native Gradle apps run on a hosted emulator too, without Metro; the host reports
live process readiness. That needs a host that advertises `hosted-android-process`.
An older host refuses before reservation or upload; update stim-server on it, or
use `--remote auto`, which skips it.

The owned emulator boots headless and is parked on stop within the host's
`pool.androidParkedMax` limit, or deleted when ineligible. Debug keeps Metro
here through a private tailnet bridge; `metro.publicUrl`, `metro.tunnel` and
`androidEmulatorApp` are ignored. Each run and reload restores the host's adb
reverse, including after an adb server restart. Release variants skip Metro.
Status reports `android.host` per slot with a profile and API name, keeping the
host serial and AVD name private. Unreachable cleanup retains the placement;
retry stop when the host answers.

Set `hosting.agentDriver` to `agent-device` on the hosting Mac and install
agent-device 0.21.22 or later on both machines. `android.host.agent` in
`stim status --json` reports a private remote-config file per slot:

```sh
agent-device open <packageId> --remote-config <file>
agent-device snapshot --remote-config <file>
agent-device click <ref> --remote-config <file>
```

Use the returned config, keeping the host serial on the host. One daemon per
session pins the exact owned emulator serial; its inventory lists only that
emulator. It allows inspection and interaction with installed apps and refuses
install, reinstall, uninstall, boot, shutdown, `close --shutdown`, record, logs,
other devices and host paths. Stim installs the app. An unavailable or older
driver reports `none` with the host's reason. Stop closes the matching agent
connection and stops the daemon and its helpers before parking or deleting the emulator.
An unresolved daemon claim blocks replacement and deletion.

Copy this prompt to try it: "Run this app with `stim android --remote <machine>`.
Read `android.host.agent` from `stim status --json`, open the installed package
with its remote config, and verify the first screen with agent-device."

Desktop uses placement set by config or agents, for example
`stim settings set android.remote auto --scope machine` (or `ios.remote`; a
workspace, repo or committed value overrides the machine default),
or per run `stim android --remote auto` / `stim android --remote <machine>`.
New runs pass no `--remote` flag; recorded hosted sessions keep their machine
until `stim stop`. When a device is not on this Mac, Desktop shows
the machine's name on its tile, workspace page, viewer toolbar and sidebar row,
with the placement reason as hover text. Local devices show no placement label.

Stim Desktop shows the machine's name and the phone app an **on &lt;machine&gt;** label; both view and control
hosted Android through the client machine's local stim-server relay. Turn on
**Serve to phones** in Desktop and pair the phone with the client machine. Named
slots stream independently. Touch, text and hardware buttons reach the exact
hosted emulator through the host's compiled `stim-frames` helper and scrcpy jar;
its temporary jar and adb forward are removed when capture stops. Desktop
hides local emulator actions. Rotation, posture, replay (`at`/`rate`), Duo
frames and physical hosted targets are unavailable. Tiles report connecting,
unavailable and stopped sessions; stopped sessions offer the rerun command.

Reruns upload only missing manifest and APK content from a session-scoped store,
verified by digest; each new attempt still installs the APK. If the build ran on
this hosting Mac's own stim-server, Stim hands over only the single `App.apk` matching
the client's manifest. Both build and hosting approvals must belong to the same
client key. Any handoff failure falls back to upload.

`stim logs --errors` and `stim logs --json` pull app-filtered native logcat records
as `src: device`; JavaScript logs still arrive through local Metro. The host verifies
the exact ledger-owned serial, resolves the app's PID on each query and drains its
last observed PID after a crash or restart. A successful drain retires the exited
PID. A failed PID lookup preserves the checkpoint without querying logcat, so the
next collection can retry. A crash before any PID was observed,
evicted logcat entries and entries persisted beyond the five-second overlap may
be unavailable. Collection has a bounded output and time budget; an oversized
query retries the recent tail and records any dropped interval. Stop copies logs
before and after the host's final collection and retains them locally after
emulator parking or deletion. Older hosts without `hosted-android-data` get an update note,
use uploads and show logs already copied here.

Try this with your agent: "Run this app with `stim android --remote mini`, inspect
`stim logs --errors`, fix any native or bundle error, then run `stim stop`."

## Requirements

Install the client CLI globally or run it with npx:

<StimInstallTabs />

A remote machine can compile iOS simulator Debug, Android emulator debug and
macOS SwiftPM Debug apps. Android builds on a
worker machine need Java and the Android SDK. Device and Release/non-Debug builds,
EAS/proxy runs, Android CAS compiler-cache builds, and iOS/Android runs with
artifact caching disabled in settings do not offload.

Both machines need Tailscale running on the same tailnet and Node 22.12.0 or
later. Sign in to a GUI login session on a worker Mac to run setup and
answer its permission prompts. A reused server must speak protocol 2 (stim-server 1.21.0 or later).
Setup refuses an older Desktop-run server with an update remedy and never
downgrades a newer server.

For iOS builds, Xcode and the simulator SDK must match. When the worker has no
usable Xcode, `stim doctor` and the Tools step say why and give the command to
run on the worker: `sudo xcode-select -s /Applications/<Xcode>.app/Contents/Developer`
when an Xcode is installed but the Command Line Tools (which Homebrew selects)
or another Xcode is selected (it prefers the Xcode of this machine's version,
else the newest), `sudo xcodebuild -license accept` and `sudo xcodebuild -runFirstLaunch`
when those checks fail, or `xcodes install <version>` when no Xcode is installed.
A missing simulator runtime on a working Xcode gets
`xcodebuild -downloadPlatform iOS -buildVersion <version>`; when the cause is
`xcode-select`, the runtime row says it follows from the Xcode row. The worker
also needs
an iPhone simulator on the target runtime. The Stim build compatibility version
must match (see [Stim versions](#stim-versions)), and so must the CPU architecture for iOS and macOS builds (macOS builds that run on the same worker excepted). A global CocoaPods that is missing or another version never stops a build; see
[CocoaPods on the worker](#cocoapods-on-the-worker). When the project's `Gemfile.lock`, in `ios/` or the project root, pins CocoaPods,
the worker needs Bundler and both machines use the pinned version. For macOS, Xcode and the macOS SDK must match, except when `stim macos --remote <machine> --remote-build <machine>` builds and runs the app on the same Mac; then only the Stim build compatibility version must match (see [Run it on another Mac](./macos.md#run-it-on-another-mac)). For Android, JDK major
versions must match: the worker builds on an installed JDK of this machine's major
when its default JDK is another one, so no restart is needed, and the fix for a
missing major is the install command for the worker's OS (for example
`brew install --cask zulu@17`). Gradle, AGP and Kotlin support only some JDK
majors and the build cache and artifacts assume one JDK, so a nearby major does
not count. Also, the worker needs the project's NDK, build-tools and
compile SDK, or the Android SDK licenses accepted so Gradle downloads what is
missing on the first build there (the NDK is about 1-2 GB). The project can
turn that download off with `android.builder.sdkDownload=false` in
the `gradle.properties` of the Android project. An Android worker can have another CPU architecture, and it can
be an x86_64 Linux or Windows machine; see [Linux worker](#linux-worker) and
[Windows worker](#windows-worker). See [machine settings](./settings.md#machine-settings) for the
full toolchain and placement rules.

### CocoaPods on the worker

The worker runs `pod install` only when its `ios/Pods` is not installed or does
not match `Podfile.lock`. Stim syncs the files git lists, and `Pods` is
gitignored, so the first build of a project on a worker installs them there.
A worker without CocoaPods, or with another version, still takes the build. Doctor
and the placement line show a note, with `brew install cocoapods` when there is
none. If `pod install` then fails there, the build reports "pod install failed"
and the command to run on that machine; a named `--remote-build` stops with it,
and `auto` builds on this machine. A different version rewrites the `COCOAPODS:`
line of a committed `Podfile.lock`, which the fingerprint check reports as
`fingerprint-mismatch`. For `stim ios`, a named `--remote-build` is also checked against the
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
there. A warm Gradle daemon keeps
running React Native's Node steps on the Node it started with
([#4081](https://github.com/appandflow/stim/issues/4081)). A pin naming a version the
worker does not have, such as `22.22.0`, uses the newest installed Node of that
major that is not older than the pin, such as Homebrew's `node@22` at 22.23.2.
Without one, the steps run on the worker's own `node`, and a failed install or
prebuild names the pin and that Node's version. Install a matching Node on the
worker, for example `brew install node@22`. When the pinned Node's major
changes, the worker reinstalls dependencies so native modules match it.

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

## Use the Desktop wizard

Open **Stim > Settings > Remote Machines** on your main machine. It lists your
remote machines, each with a status (**Approved**, **Waiting for approval**,
the layer that stopped an unreachable machine (such as **Server not ready** or **Mac is offline**), **Needs update** or the reason it is not offloading, with the reason and a fix under it), what it does and **Remove...**. Readiness covers every platform of the app: a Linux machine that matches for Android shows as approved even though it cannot build iOS, and a Mac without an Android SDK shows that reason for an app with Android. Choose **Add Remote Machine...** to start the wizard,
which finds the Macs, Linux and Windows machines on your tailnet itself. **Remove** takes the machine out of
`remote.machines` and shows the optional commands to run on that machine: `stim-server devices revoke <id>` for each
request and `stim-server service uninstall`.

The wizard has five steps. It refreshes in the background every few seconds,
so there is no Check again button:

1. **Pick a Machine.** The wizard first checks that Tailscale runs on this machine and
   shows Checking Tailscale until it has an answer. If
   the Tailscale app is off, turn it on from its menu bar item. With only the
   CLI installed, run `tailscale up`. Without Tailscale, the step links to the
   download. Then select an online macOS, Linux or Windows peer from your
   tailnet; a Linux or Windows peer is marked **Linux · Android builds only** or
   **Windows · Android builds only**. Other peers are not listed. When no such
   peer is on the tailnet, the step says so and links to the Tailscale downloads
   for a Mac, for Linux and for Windows; the list
   appears by itself when that machine joins. When every listed machine is
   offline, a line under the list tells you to turn on Tailscale on it.
   A machine you already added is marked **Added** and shows the same status as
   the Remote Machines list (**Approved**, **Unreachable**, a Tailscale or
   stim-server problem and what to do about it) instead of Tailscale's
   online flag. Choosing it does not start setup again; it says the machine is
   already added and offers to close the wizard so you can use its row in
   Remote Machines.
   `stim-server setup` on the worker Mac gives the same three answers when it
   cannot read Tailscale: install it from `https://tailscale.com/download/mac`,
   turn the app on from its menu bar icon, or run `tailscale up`.
2. **What it does.** The step is titled with the machine you picked. Choose **Builds**, **Hosted simulators**, or both. The
   preview shows what setup will do. With neither chosen, **Next** stays
   disabled. A Linux or Windows machine offers **Builds** only: it takes Android Debug
   builds, and **Hosted simulators** is unavailable because it needs a Mac.
3. **Set it up.** Copy the generated command and run it in Terminal while
   signed in at the worker Mac. It needs Node 22.12 or later there. Answer Y/n
   for each new capability grant there; Yes is the default, so Enter lets the
   client machine build here, or run its app code in hosted simulators here. After
   the last answer, setup prints "Waiting for the requesting machine to connect.
   Stim Desktop sends this automatically." and confirms each approval when
   Desktop's request arrives; you do not press anything in Desktop. Desktop
   mirrors setup progress live and sends the requests by itself until the
   command's ticket expires. Already approved capabilities are omitted from the
   command. When every chosen capability is approved and setup finished, Desktop moves to Tools by itself.
   A skipped permission keeps this step open and shows its fix. There is no SSH option.
   For a Linux machine the command first runs `sudo tailscale set --operator=$USER`
   and `sudo loginctl enable-linger $USER` (see [Linux worker](#linux-worker)),
   and setup installs a systemd user service instead of a LaunchAgent and Stim
   Host. It needs JDK 17 and the Android SDK there as well.
   For a Windows machine the command is for PowerShell (it runs `npx.cmd`, so
   the script execution policy does not matter), needs no administrator
   rights, and setup installs a per-user scheduled task. It needs JDK 17 and the
   Android SDK there; if the first `node.exe` on `PATH` is a version manager's
   shim, such as pnpm's, add `--path-prepend` with the real Node's folder.
4. **Tools.** Compare the worker's tools with this machine, including the Android
   tools when **Builds** is chosen. A problem that stops the chosen
   capability is shown in red and never disables **Next**; the machine stays added,
   builds that cannot run there stay on this machine, and Settings > Remote Machines
   lists the iOS tool problems on its row (Android-only ones are shown only here). Red problems are an incompatible Stim build
   or no Xcode for Builds, and no iOS simulator runtime for Hosted simulators. **Install This Mac's Build**
   fixes an incompatible Stim build. A Linux or Windows machine shows only the Stim build and
   Android rows, and a missing Android SDK or any JDK difference is red
   there, since no build could offload. The other problems are warnings that name what
   they cost:
   - A different Xcode or runtime version.
   - Missing Android tools (NDK, build-tools or compile SDK): a note when the
     worker's SDK licenses are accepted, since Gradle downloads the package on
     the first build there. Otherwise Android builds stay on this machine, and
     the row shows the `sdkmanager` commands to run on the worker, each with a
     **Copy** button; `sdkmanager --licenses` accepts the licenses.
   - A missing or different global CocoaPods is a note, not a problem: the build
     still goes there. With no CocoaPods the row shows `brew install cocoapods`
     to run on the worker. Projects whose `Gemfile.lock` pins CocoaPods run that
     version through Bundler on both machines and need Bundler there.
5. **Done.** Copy the **Try it** agent prompt, or run
   `stim ios --remote-build <machine>` yourself (`stim android` for a Linux or Windows machine).
   - **Builds** sets `remote.buildMode`: **Auto**, **Always** or **Never**
     (`auto`, `force` or `off`). It is Auto when this wizard added the first
     remote machine. Otherwise it keeps your mode.
   - When Hosted simulators was chosen, **Simulators** sets `ios.remote` and
     `android.remote` at machine scope. **This Mac** unsets them, **Auto** sets
     `auto` (run there when this machine is full) and **Always** names the Mac's
     `remote.machines` entry. A current value the
     wizard does not offer, such as `eas`, is kept unless you choose another.
   - **Run a Test Build with a Sample App** builds a sample through the worker
     and then locally, for Android on a Linux or Windows machine.

Desktop adds entries when it finds the setup journal and connects with that
command's ticket. When adding the first remote machine
with the default mode, it temporarily sets `remote.buildMode` to `off` during
setup. Closing the wizard before Done puts the previous value back. An expired ticket needs **New Command**.

Agents never run `stim-server setup`, edit `remote.*`, `server.*` or `hosting.*` for you,
or approve requests; use Desktop or perform the setup yourself.

## CLI equivalent

For a new machine with both capabilities selected, Desktop generates this
command, with the ticket and expiry filled in. On a machine without Desktop,
`stim doctor --fix` makes the ticket and prints the same command:

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
Desktop tickets last 30 minutes, tickets from `stim doctor --fix` just under two hours;
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

On your main machine, add the machine and request access from an app directory.
This example sets the list to one entry; keep any remote machines you already use.
Use the route's actual port if it differs from 7443. `stim doctor --fix` asks
the machine for both approvals:

<StimTabs
code={`stim settings set remote.machines '["janics-mac-mini"]'
stim doctor --fix`}
/>

`stim doctor --fix` prints a `stim-server setup` command with a new setup
ticket. A person on the worker runs it there to approve this machine, as in
[Use the Desktop wizard](#use-the-desktop-wizard); it asks once for build and once for
device hosting. Approve only what you want to use; a listed machine that never granted an approval
is not used for it, and `stim doctor` says so.
Tickets from `stim doctor --fix` expire just under two hours later. While a request is pending, `stim doctor --json`
reports its `expiresAt`; after it lapses doctor reports `lapsed`, and
`stim doctor --fix` asks again. Run `stim doctor` on the main machine to check
approval and compatibility before running the app.
When Doctor prints a setup command, run it on the worker and approve the requested
access there. Then run `stim doctor` again on the requesting machine to complete
the connection. That setup command also prints this reminder after approval;
ordinary setup commands do not add the Doctor-specific instruction.

A worker whose stim-server predates protocol 2 cannot authenticate this machine.
`stim doctor` reports it as `outdated` and names the update: run
`stim-server service update --release <version>` there with this machine's
Stim version, then `stim doctor --fix` here.

If active builds or hosted simulators prevent that update, add `--no-wait` to
the service update command. This interrupts the server's active work during
restart instead of waiting for it to finish; shutdown, health checks and rollback
still apply. Setup also accepts `--no-wait` for its managed-service update.

### Linux worker

An x86_64 Linux machine can take this machine's offloaded Android debug
builds. It cannot build for iOS or macOS, and it cannot host simulators or
emulators. On the Linux machine:

1. Install Node 22.12.0 or later, Tailscale signed in to the same tailnet,
   JDK 17 and the Android SDK with the project's NDK, build-tools and compile
   SDK. The service finds the SDK in `~/Android/Sdk`; pin any other location
   below.
2. Let your user run `tailscale serve`, and keep your services running after
   you log out:

   ```bash
   sudo tailscale set --operator=$USER
   sudo loginctl enable-linger $USER
   ```

3. Install the server globally (the service records its paths, so not from an
   npx cache) and run it as a systemd user service with a tailnet-only route:

   ```bash
   npm install --global @stim-cli/server@latest
   stim-server service install --serve \
     --env JAVA_HOME=/usr/lib/jvm/java-17-openjdk-amd64 \
     --env ANDROID_HOME=$HOME/Android/Sdk
   stim-server service status
   ```

   The unit is `~/.config/systemd/user/dev.stim.server.service` and the log
   `~/.local/state/stim/dev.stim.server.log`. `service update` and
   `service rollback` work as on a Mac, and an approved client can update the
   server remotely.

4. On your main machine, add it to `remote.machines` and run
   `stim doctor --fix` as above. Run the setup command it prints on the Linux
   machine, or the one the Desktop wizard generates; both carry `--build` only. Setup on
   Linux refuses `--device-host` and skips Stim Host and the permission steps.
   `stim doctor --fix` does not ask a machine that Tailscale reports as running
   an OS other than macOS for device-host access, since it can never grant it.

`stim doctor` on the main machine rates a Linux machine for Android only, so a
project with iOS too still reports it offloadable for Android builds.

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

3. On your main machine, add it to `remote.machines` and run
   `stim doctor --fix` as above. Run the setup command it prints on the
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

The worker restarts only once its offloaded builds and hosted sessions end, and
the card says what it waits for, such as "Waiting for 1 hosted simulator to
end...". When this Mac's own workspaces hold those hosted simulators, **Stop and
Update...** stops them with `stim stop` after a confirmation that names each
device and workspace; another machine's sessions can only be stopped on the worker.
The update shows as finished once the worker runs this machine's Stim build, even
when another update installed it, and a refused update (for example, one already
running there) shows the worker's reason.

## Test build

Desktop creates a pinned Expo blank SDK 58 sample under
`~/Library/Application Support/Stim Desktop/Onboarding/sample-sdk58`.
Preparation downloads the template and installs its dependencies, so it needs
network access. Desktop uses the sample for setup requests when no workspace
is listed. It is optional: start it with **Run a Test Build with a Sample App**
on the wizard's last step. It tests iOS builds.

The first run uses `stim ios --remote-build <name> --no-build-cache --json`.
It must report the selected `offloadedTo` and a launch state of `true` or
`bundling`. Desktop reads the `offload_done` log's offer, sync, worker and fetch
timings. The second run uses `--remote-build local --no-build-cache` to prove
this machine can still build and launch. This tests local build readiness; it does
not deliberately disconnect the worker to trigger automatic fallback.

The sample stops when the test ends. **Run again** reuses the folder. When the
sheet closes, Desktop removes the sample's Stim workspace and folder and releases
its owned simulator (parked for reuse within the parked-simulator limit, deleted
otherwise). This cleanup is best effort and silent; if it fails, the leftover sample stays
until the next wizard reuses it or its removal succeeds.

## Undo

**Cancel** removes only entries the wizard added, restores the mode only if
it changed it, and runs doctor to forget removed pairings. Worker grants
remain until revoked there. After finishing, use **Settings > Remote Machines >
Remove** on the main machine. Remove the corresponding `remote.machines` entry
as well if you enabled hosting, then run `stim doctor --fix` to forget it.

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

`stim doctor` stops at the first layer that fails and names it. Stim Desktop
shows it as the pill of the machine's row, with what failed and what to do
under the name. `stim doctor --json` carries it as `diagnosis` (`layer`, `code`, `title`,
`message`, `remedy`) under `remoteMachines` and `deviceHosts`. The `state` stays
`unreachable`, `tailscale-off` or `not-on-tailnet`, so an older Desktop or phone
app still shows its short label.

| Layer                 | Code                                | What it means                                                                                                                                                                               | What to do                                                                                                                                                          |
| --------------------- | ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Tailscale on this Mac | `tailscale-stopped`                 | Tailscale is turned off.                                                                                                                                                                    | Turn it on in the menu bar app, or run `tailscale up`.                                                                                                              |
|                       | `tailscale-logged-out`              | Tailscale is signed out.                                                                                                                                                                    | Sign in, then run `stim doctor` again.                                                                                                                              |
|                       | `tailscale-unavailable`             | No Tailscale answered: it is not running or not installed.                                                                                                                                  | Install or open Tailscale and sign in.                                                                                                                              |
| The peer              | `peer-not-found` / `peer-ambiguous` | No peer, or several, match the `remote.machines` name.                                                                                                                                      | Check the name with `tailscale status`, or use the full MagicDNS name.                                                                                              |
|                       | `peer-offline`                      | Tailscale lists the Mac as offline and nothing answered; the message says when it was last seen.                                                                                            | Wake it, check its network, and check that Tailscale runs there.                                                                                                    |
|                       | `peer-no-answer`                    | The connection got no reply and `tailscale ping` does not reach the Mac either.                                                                                                             | Check that it is awake and its network is up; run `tailscale ping <name>` here.                                                                                     |
| The serve route       | `route-missing`                     | The Mac answers, but nothing accepts connections on the serve port.                                                                                                                         | On that Mac, run `stim-server service status`; `stim-server service install --serve` creates the route.                                                             |
|                       | `route-tls`                         | The route's certificate was not accepted.                                                                                                                                                   | On that Mac, run `tailscale serve status`, then `stim-server service install --serve`.                                                                              |
|                       | `route-http-error`                  | The route answered an HTTP status stim-server never sends (not 502 or 503).                                                                                                                 | On that Mac, run `tailscale serve status` and check what the port points to.                                                                                        |
| stim-server           | `server-not-running`                | The route answers 502: nothing listens behind it.                                                                                                                                           | On that Mac, run `stim-server service status`; `stim-server service install --serve` starts it.                                                                     |
|                       | `server-not-ready`                  | The route answers 503: stim-server runs but does not serve. The message gives the cause when the server reports one, such as a Stim home it cannot read because its disk stopped answering. | Check the disk that holds the Stim home on that Mac; stim-server serves again by itself once it answers. `stim-server service status` there shows the exact reason. |
|                       | `server-no-answer`                  | `tailscale ping` reaches the Mac, but the serve route and stim-server sent no reply in time: stim-server may be starting, stalled or restarting.                                            | On that Mac, run `stim-server service status`; it reports a restart loop or a Stim home it is still reading, and the log file to read.                              |
|                       | `connect-failed`                    | The connection failed in a way none of the other codes names.                                                                                                                               | On that Mac, run `stim-server service status`.                                                                                                                      |
| Compatibility         | `server-outdated`                   | stim-server speaks an older protocol.                                                                                                                                                       | Run the update command the finding prints.                                                                                                                          |

A machine that answers outranks Tailscale's own online flag, which can lag a
reachable Mac. Approval states (`pending`, `revoked`, `lapsed`, `key-changed`)
mean the machine answered; they have their own findings and remedies.

### Find out why a remote machine was slow or refused

Every placement decision is a record: `stim logs --source placement` lists the
machines checked with a reason code each, and a failed request to a machine (for
example one that did not answer hello in time) is a `remote_connect_failed` or
`remote_request_failed` record in `stim logs --source build`. On the machine that
serves the request, stim-server writes request errors to its service log
(`~/Library/Logs/Stim/<label>.log`) with the client's device id and the run id
of the `stim` command that sent it. To see every request with its duration and
slow steps, run `stim settings set debug.logs true --scope machine` on that machine,
or set `STIM_DEBUG=1` for its stim-server. Nothing is sent anywhere, and no
token or ticket is logged.

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
With no `remote.machines`, auto is local.

Auto stays local when the device cap has room (0 means unlimited), no run is
queued ahead, host memory pressure is normal, the budget has no
shortfall, and five-minute load per core is below `server.maxLoadPerCore`.
An unknown device count stays local for the binding boot admission to decide.
A recorded hosted session is reused regardless of load; a live local owned
slot stays here. A stopped hosted session places again, while an unreachable
or unknown one refuses.

When this machine is full or busy, Stim probes every approved host in parallel with
three seconds per probe and the run's device selectors. It skips declined
hosts, incompatible choices, elevated or unknown memory pressure and zero
available capacity. If this machine has a free slot, the host must report a lower
load. When the cap is full or a queue is ahead, unknown host load is allowed.
It resolves the build preference from `--remote-build`, then `STIM_REMOTE_BUILD`,
then `remote.build`. A named preference ranks first, followed by lowest load,
most free memory and configuration order. Automatic
build offload resolves later, using the device's offered architecture.

If none admits and this machine is at its `concurrency.maxDevices` cap (or runs are
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
`--remote auto` and ignores an `auto` setting, and eas/proxy and native macOS placement keep their existing behavior.

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
