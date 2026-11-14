---
title: 'Command reference'
sidebar_position: 1
description: 'Every Stim command and option'
---

import StimTabs from '@site/src/components/StimTabs';
import Tabs from '@theme/Tabs';
import TabItem from '@theme/TabItem';

:::note[Command examples]

Commands use `stim`. If Stim is not installed globally, replace `stim` with
`npx stim`.

:::

Run `stim <command> --help` for parser help. Run `stim guide` for the full
reference that ships with the installed version. Every refusal code has an
entry in the [troubleshooting reference](./troubleshooting.md).

`start --json`, `ios --json`, `android --json` and `macos --json` report
`agentDevice: { stateDir }`, an absolute path under
`$STIM_HOME/workspaces/<name>/agent-device/`. Each `status --json` environment
reports the same field, shared by its slots, without creating the directory.
Set `AGENT_DEVICE_STATE_DIR` to it when driving a device yourself; see
[agent-device actions](./dev-server-and-logs.md#agent-device-actions).

Successful owned simulator and emulator launches print a copyable `stim agent-device open` command
for the workspace's device. A local macOS launch prints the app-scoped
`agent-device open` command once LaunchServices lists the app. With `--json`,
these local handoff commands go to stderr so stdout remains parseable.

## Normal workflow

<StimTabs
code={`stim doctor
stim start
stim ios                 # or: stim android, or: stim web
stim logs --errors
stim stop`}
/>

React Native and Expo Debug runs use a dev server and start it when needed.
Their Release builds embed JavaScript and skip that requirement.
[Native Xcode apps](#native-xcode-apps) run without Metro in every configuration.

When [Stim Desktop](./desktop.md) is installed, `worktree warm`, `start`,
`ios`, `android` and `web` print an HTTPS workspace link, on
stderr, and add it to their `--json` payload as `links.desktop`:

```text
Open in Stim: https://stim.appandflow.com/open?v=1&machine=<home-id>&workspace=<workspace-id>
```

The agent guide tells agents to share this link with you once, when they
begin work in a workspace.

`reload` is a recovery command that reloads JavaScript in the live app and never
restarts it. Use it when an error screen remains after a fix, not after every
JavaScript edit. It also recovers an Android app whose first bundle failed; an
iOS app in that state never connects to Metro, so reload cannot reach it.

`revive` resumes a workspace after an [idle stop](./dev-server-and-logs.md#idle-stop).
Use it when the app shows "could not connect" or a blank screen after a pause.

`agent-device` runs [agent-device](https://github.com/callstack/agent-device) on
this workspace's device, so an agent never passes device ids. See
[`agent-device`](#agent-device).

## Named device slots

`ios`, `android`, `device lock`, `device unlock`, `logs`, and `stop` accept
`--slot <name>`. Omitting it selects the default target for a device run;
plain `logs` and `stop` still cover the whole workspace. `status` lists every
slot. Slots can hold multiple simulators of the same model as well as physical
devices. See [multiple devices with slots](./owned-devices.md#multiple-devices-with-slots)
for commands, a copyable agent prompt, and shared-server limitations.

## `doctor`

```text
stim doctor [--platform <ios|android>] [--json] [--fix]
```

Inspects the current app and, in a repository with linked worktrees, the source
checkout's fitness as a seed. It reports missing or stale dependencies,
CocoaPods state, cache conflicts, device capacity, remote session problems and
fingerprint evaluation problems. The checkout is left untouched unless
`--fix` is passed.

Fingerprint checks evaluate project configuration, including
`fingerprint.config.js`, in a child process. Doctor reads a project eas-cli's
version from its `package.json` and runs `eas whoami` only with an `eas` on
`PATH` outside the repository and its `node_modules/.bin` directories.
`worktree warm`, `start`, `ios`, and `android` also run project code.

`--platform ios` or `--platform android` limits native findings to that
platform while keeping shared project checks. The selected project integration
supplies framework checks and repairs; React Native and Expo checks include
Metro, CocoaPods and fingerprint parity (the parity check uses a temporary
git worktree; doctor first removes the leftovers of ended Stim processes and
unregisters them in the repository they were created for); [Exact](#exact-apps) checks cover
Bun, rustup and the exact2 checkout. Shared findings appear before
framework findings. Each run in a supported native app is recorded for the
inspected platforms in Stim's state, which also registers the project for
`stim status`, so `stim guide` can tell when doctor is due again. A run in a
directory that is not an app records nothing.

The `offload-candidate` note appears after at least 3 successful local cold builds in 7 days average over 3 minutes, with no `remote.machines` and an online tailnet Mac; it points to Stim Desktop **Settings > Connections > This machine uses > Add**.

The `readiness-markers-missing` note appears when no JavaScript or TypeScript source under the app directory contains `[stim:readiness]`. The scan skips `node_modules`, the native project and build output directories (`ios`, `android`, `macos`, `windows`, `Pods`, `build`, `dist`, `web-build`, `coverage`) and dot-directories. It does not read shared packages outside the app directory, and it reports nothing in an app with more than 5000 source files. It points to `stim guide lifecycle readiness` and the [app-declared readiness](./dev-server-and-logs.md#recommended-app-declared-readiness) logs.

On macOS, a `memory-culprit` finding names each process whose physical
footprint is abnormal, with its restart command when one is known to be safe.
See [memory pressure](./owned-devices.md#abnormally-large-processes).

Doctor also prints the running CLI version and the `stim` installation resolved
from `PATH`, and flags a resolved installation that is older than another
available one.

On macOS, a **Toolchain** section reports where `node`, `ANDROID_HOME`, `JAVA_HOME`,
`stim`, `brew` and `adb` come from: this shell's environment, or the location
stim-server would discover them at without a login shell (a version manager's
default Node, Homebrew, `~/.local/bin`, the standard Android SDK, a system or Homebrew JDK
or Android Studio's bundled runtime), with how to override each. When the app
pins Node in `.nvmrc`, `.node-version`, `.tool-versions` or `package.json`'s
`volta.node`, it also names the installed Node Metro runs on when the `node` on
`PATH` does not satisfy the pin: an nvm, fnm, Volta, asdf, mise or linked
Homebrew `node`/`node@NN` install. When no install has the version the pin
names, it names the newest installed Node of the pinned major that is not older
than the pin, and says so. `--json` adds this as `toolchain`.

A `pressure` line reports the machine's pressure level, normal, high or
critical, and why, against the
[disk thresholds](./settings.md#machine-settings); above normal a finding says
what the `stim-daemon`'s ladder reclaims. `--json` adds this report as
`pressure`. Doctor also prints the [`stim-daemon`](./settings.md#stim-daemon)
line with its mode, whether it runs and when it last ticked, its last action
(or its snapshot file before the first), the daemon log and the cleanup
log with the last pass. It reports a daemon that stopped ticking, a stim-daemon from before Stim 2.0 that
holds the daemon claim, with its pid and stop command, a daemon
that stays up for a child whose cleanup it could not verify, with how to check
the child, and that stopping that stimd is safe and ends the wait, a stimd held back after
three abnormal exits in 10 minutes with what to fix, abnormal exits of the last
day, a daemon claim it cannot
resolve, and any [removed setting](./settings.md#stim-daemon)
left in a config file or the environment, with the setting that replaces it.
Both `stim status` and `stim doctor` show the claim and remedy when stimd cannot
recover a physical iPhone console.

`doctor` also flags when an agent harness sandboxes shell commands and Stim is
not allowed through it, which shows up as unrelated-looking failures against
the simulator service, the adb server, and Stim's own state directory, or as
`STIM_SANDBOX_BLOCKED` when the sandbox denies stimd's socket.
For that finding, `--fix` writes the missing allowance into `.claude/settings.local.json` at the
repository root, the per-user file, merging it with whatever is already there
and preserving other settings. It cannot add a Codex allowance because that
sandbox has no per-path allowance to add. When Claude Code on Linux denies
the Unix socket, `--fix` refuses the path-specific repair; run Stim outside the
sandbox. This repair runs only when the report shows that finding, so an
unsandboxed session leaves the file alone.
See `stim guide errors sandbox` for the failure signatures and the manual
settings.

Unless `--platform ios` is selected, `--fix` also removes stale ignored,
untracked Android `.cxx` configurations with obsolete compiler launchers,
including those in installed native modules. Stop native builds before this
repair: its cache-lock check cannot detect uncached, release-swap fallback, or
direct Gradle builds. The next build recreates these files; source, custom launcher settings,
and shared ccache entries are preserved. See `stim guide lifecycle options`.

When no Android system image matches the project and `android.installImages`
is `auto`, doctor reports it as a note, and `--fix` installs the image
`stim android` would install on its first emulator run (about 2 GB). See
[installing a missing Android system image](./settings.md#installing-a-missing-android-system-image).

In a terminal, `--fix` also brings the source checkout to a state worktrees can
clone, one step at a time. Each step prints what it does and what it costs, and
runs only after you answer `y` to `Run this step? [y/N]`:

- **Stale or missing dependency tree**: runs the lockfile's install command, the
  one `stim worktree warm --refresh` runs (`npm ci` deletes `node_modules` first).
- **Broken links under `ios/Pods`, or Pods that do not match `Podfile.lock`**:
  runs `pod install --clean-install`. When CocoaPods reports that a gitignored
  `Podfile.lock` pins a version a pod no longer allows ("could not find
  compatible versions"), it runs `pod update` for only the named pods and retries
  the clean install once if links are still broken. It never edits a `Podfile.lock`
  that Git tracks: with `ios/` tracked it stops and prints the manual command.
- **No current prebuild record** (`source-prebuild-record-ios` and
  `source-prebuild-record-android`, costs time): in an Expo app whose `ios/` or
  `android/` Git ignores, Stim has no finished prebuild record for the source
  checkout's directory, or the record no longer matches the app's current
  fingerprint, so `worktree warm` leaves the directory out and every worktree
  generates it again, and on iOS installs its own Pods, about 1.5 to 2 GB each.
  The step runs the prebuild, and on iOS the pod install after it, the way
  `stim ios` does, without compiling. It fingerprints again and records the
  result, except when a config input changed while it ran, which it reports.

A step is skipped when an earlier step it depends on was declined or failed. Without a
terminal, with `--json`, from Stim Desktop or from the programmatic API, each
step is printed with its manual command and none runs; progress goes to stderr, so
`--json --fix` still prints one payload. Every step refuses while a `stim ios`,
`stim android`, `stim start` or other run holds the source checkout's workspace,
or while a `stim worktree warm` holds the repository's warm claim. Doctor never
switches a branch.

In a linked worktree of a React Native app, doctor notes when the source
checkout's `ios/Pods` holds React Native's prebuilt frameworks
(`React-Core-prebuilt`, `ReactNativeDependencies`, `hermes-engine`) built as
Debug or Release and the worktree builds the other, which is Debug unless
`ios.configuration` says otherwise. React Native re-extracts those frameworks
on the first build, so each such worktree costs about 1 GB of unshared disk plus
extraction time. Build the source checkout once in that configuration with
`stim ios` before warming more worktrees. `--fix` does not build for you: a
build needs a simulator, a build slot and several minutes, so it prints one
`flavor` line saying it left this to you.

Doctor reports a checkout that holds linked worktrees inside it, such as
`.worktrees/<name>`, when the checkout's `.watchmanconfig` does not list them in
`ignore_dirs`. A Watchman root at that checkout, which Jest or a Metro started
there registers, crawls every worktree's files, `node_modules`, and build output,
which grows the shared Watchman daemon's memory and its recrawls. The finding
says when Watchman watches the checkout now. `--fix` merges the worktrees' shared
parent directory (such as `.worktrees`) when Git tracks nothing in it, otherwise
each worktree path, into that `.watchmanconfig`, keeping every other key and
entry. It refuses a file that is not a JSON object or whose `ignore_dirs` is not
an array, and names the entries to add by hand. Watchman matches entries
literally, so `.worktrees/` or `./.worktrees` ignores nothing. Commit
the file: Watchman reads `ignore_dirs` only from a root's `.watchmanconfig`, with
no global equivalent. It reads the file only when it adds a root, so for a root
it already watches run `watchman watch-del <checkout>`, then restart Watchman to
free its memory now. Doctor never runs either command.

On macOS, each stimd started by launchd registers a job named
`dev.stim.stimd.<hash>.<id>` in your login domain. Doctor reports stopped jobs
whose `STIM_HOME` folder no longer exists, which a deleted scratch or test home
leaves behind. `--fix` removes them, and so does the next stimd that launchd
starts. It never removes a running job or a job whose home exists, and it keeps
a job whose home is under `/Volumes`, unreadable, or behind a broken symlink.
A home on a share mounted elsewhere, such as SMB or NFS at `~/mnt/x`, reads as
gone while it is unmounted, so its stopped job is removed; that loses nothing,
because each stimd start registers a new job.

When [`remote.machines`](./settings.md#machine-settings) names remote machines,
doctor reports their separate device-host approval in `deviceHosts`. Only
`--fix` requests approval, retries a revoked or lapsed request, and forgets
names removed from the setting; [`stim remote add`](#remote) also requests and
retries approval, outside an app. It makes a setup ticket and prints the
`stim setup` command a person on the hosting Mac runs. Setup tickets stay
private. The first connection after approval pins the Mac's stim-server key,
and a Mac that cannot prove that key is refused; unreadable credentials and
uncertain replies preserve the pin. Invalid hosting
settings report an error and preserve every saved credential. JSON states
are `approved`, `pending`, `not-asked`, `revoked`, `lapsed`, `key-changed`, `outdated`,
`not-on-tailnet`, `tailscale-off`, `unreachable`, `invalid`,
`credentials-unavailable` and `busy`. A `pending` entry carries `expiresAt`,
when its setup ticket expires, except for a Stim Desktop ticket; `lapsed` means
the request expired before approval. Hosting approval does not yet change
`ios` or `android` placement.

When the [`remote.machines`](./settings.md#machine-settings) setting names
remote machines, doctor reports each one this machine is not approved on: not on the
tailnet, not asked yet, waiting for approval (with the `stim setup`
command to run there), revoked, lapsed, answering with a different
stim-server key than the one this machine pinned at approval, or running a
stim-server too old to speak protocol 2 (`outdated`, with the
`stim service update --release <version>` command to run there). A listed machine
that never granted an approval is not used for it. `--fix` makes one setup
ticket for each named machine without a pairing, covering build and device-host
access, asks again one that revoked or let the request lapse, and forgets the
pairing of a machine no longer named. It never accepts a different key: run
`stim remote remove <machine>` to forget the old pairing, then
`stim remote add <machine>`. `--json` lists
each named machine's build approval under `remoteMachines`, and its device-host
approval under `deviceHosts`, with a `state`: `approved`, `pending`, `not-asked`,
`revoked`, `lapsed`, `key-changed`, `outdated`, `not-on-tailnet`, `tailscale-off`, `unreachable` or
`invalid`. A `pending` entry carries `expiresAt`, when its setup ticket expires;
until a person runs setup, the remote machine answers `unknown-secret` and every
doctor run tries again. `lapsed` means the ticket expired before approval, while
`revoked` means the remote machine revoked this machine.

Approved entries in `remoteMachines` and `deviceHosts` also include
`host: { name, screenRecording, accessibility }` when the worker reports its
Stim Host permissions; otherwise `host` is omitted.

Doctor also asks each approved machine for one build offer, the same offer
`stim ios` and `stim android` ask for, and reports every reason that machine
would not take this app's builds now, each as a finding with a fix: it does
not answer, it runs an incompatible Stim build (update it to this machine's build), its
CPU differs; for iOS (unless `--platform android`) its Xcode, simulator SDK or
CocoaPods selected for this project differ, it has no Bundler for a project whose `Gemfile.lock` pins
CocoaPods (its own CocoaPods version does not matter then), or it has no
iPhone simulator on the runtime `stim ios` builds for here; for Android (with
`--platform android`, or an app with `android/` or Expo) its JDK major differs
or its SDK lacks the NDK, build-tools or compile platform; its worker volume has less than 10 GB free;
or it is busy. A machine that is not a Mac cannot build iOS or macOS apps: it
reports one `platform` reason for them instead of every missing Apple tool,
and when it can build another of the app's platforms, such as Android on
Linux, doctor leaves those platforms out and judges it on the rest. Busy and
no answer are notes; the others cost time. In `--json` such a machine also carries `offloadable`,
`reasons`, `problems` (each reason with its finding code), and `capacity`,
its reported load:

```json
{
  "machine": "janics-mac-mini",
  "state": "approved",
  "offloadable": false,
  "reasons": ["x86_64 there, arm64 here"],
  "problems": [{ "code": "arch", "reason": "x86_64 there, arm64 here" }],
  "capacity": {
    "running": 0,
    "max": 1,
    "cpus": 10,
    "loadPerCore": 0.4,
    "builds": 0,
    "maxBuilds": 0,
    "maxLoadPerCore": 2,
    "declined": null,
    "diskFreeBytes": 812000000000,
    "minDiskFreeBytes": 10737418240,
    "memoryUsedBytes": 9663676416,
    "memoryTotalBytes": 17179869184
  }
}
```

## `ports`

```text
stim ports
stim ports get <label>
stim ports stop [label] [--dry-run]
stim ports release [label]
stim ports reverse <label|port> [--remove] [--json]
```

Reserves TCP ports 8900–8999 for web or API servers started by the
project. `get` prints only the number and reuses an existing allocation.
New allocations skip reserved and occupied ports; retry notices go to stderr.
Allocation reads native TCP tables through `netstat` on macOS and Windows and
`/proc/net` on Linux. When the table is denied, empty or unreadable, it checks
each port with `lsof` and loopback connects instead, and refuses only when
none of them can answer. Stopping listeners still requires `lsof` on macOS and
Linux, or `netstat` on Windows.
`ports` lists named allocations and Metro, marked managed, and the ports the
workspace reverses. `ports --json` prints one payload with `ports`, `metroPort`
and `reverses`.

`ports reverse <label|port>` makes a server on this machine reachable at the
same `localhost:<port>` from the workspace's devices, like `adb reverse`. It
takes a label from `ports get` or a raw port, records it for the workspace (at
most 16), and applies it to the devices the workspace has now. A local iOS
simulator shares this Mac's loopback and needs nothing, an Android emulator or
phone gets `adb reverse tcp:<port> tcp:<port>`, and an iPhone is refused because
USB carries no reverse forward. Hosted devices are bridged through the Metro supervisor's links to the host; see [Remote machines](./remote-machines.md#reverse-ports-on-hosted-devices). `--remove` removes it, and `--json` prints
`action`, `port`, `ports` and a `devices` list whose `status` is `reachable`,
`applied`, `removed`, `pending`, `unsupported` or `failed`. See
[Reverse ports](./dev-server-and-logs.md#reverse-ports).

Labels start with a letter and contain up to 64 letters, digits, underscores,
or hyphens. `metro` is reserved for `stim start` and `stim stop`.

The workspace is the nearest `package.json` directory. In a monorepo, a package
that is not a React Native or Expo app, such as a Vite web app in `apps/web`,
uses the one Stim app registered in the same Git worktree instead, and stderr
names it. `web`, `settings`, `logs`, `reload`, `revive`, `stop` and `status` follow the
same rule; `status` stars the app instead of printing the note. Every `ports` command there then acts on that app's ports, including
`stop` and `release` without a label. `status`, `worktree remove` and `gc`
treat the ports as the app's. A package that already holds ports keeps them
until you release them. With no registered app, or more than one, run `ports`
from the app directory.

`stop` terminates listeners on the selected named ports, including processes
outside the workspace, and prints their PIDs and commands. It sends SIGTERM,
then SIGKILL after two seconds if needed. `--dry-run` previews without killing
or releasing. Failed stops retain the allocation. `release` removes the
reservation without signalling the server. Omit the label to select all named
ports. Neither command touches Metro; `stim stop` leaves named ports alone.

`worktree remove`, `gc` and automatic maintenance release named ports
without signalling their listeners. `gc` reports allocations for missing
workspaces, and `gc` releases them. Unmounted or unresolved workspace
paths remain registered.

See [server examples and limitations](./dev-server-and-logs.md#named-server-ports).

## `start`

```text
stim start [--wait <seconds>] [--remote] [--reset-cache] [--json]
```

Starts the project dev server on the workspace's reserved port. The Stim
home's stimd runs it as its own child and captures its output; `start` starts
stimd when none runs, whatever `daemon.mode` says. A healthy existing server for the same
project is reused. A Debug `ios` or `android` run starts the dev server the
same way when it is not running, so running `start` first is optional.

- `--wait <seconds>` changes the startup timeout. The default is 60 seconds.
  It waits for the dev server; `--wait` on `ios`, `android`, and `device lock`
  instead bounds the wait for a device another workspace holds.
- `--remote` prepares Metro for a remote device.
- `--reset-cache` restarts only this app's verified owned Metro, preserving its
  port and devices, with Metro's own reset (`resetCache` on a bare server,
  `expo start --clear` on Expo). Every store in the app's Metro config is
  cleared, including this app's shared transform store, so other worktrees of
  the same app rebuild their transforms too; the file map is rebuilt. Other
  apps and native build caches are unchanged. Externally started servers are
  left alone, and a failed startup can be retried with `stim start`.
- `--json` prints one stable result object on stdout.

## `ios`

```text
stim ios [--slot <name>] [--scheme <name>] [--configuration <name>] [--device-type <name>] [--runtime <version>] [--install-runtime]
         [--simulator-app <xcode|siniulator|stim-desktop|none>] [--device [udid]] [--wait <seconds> | --no-wait] [--remote <eas|proxy|auto|local|machine>]
         [--eas-profile <name>] [--no-metro-check] [--no-build-cache] [--plan] [--json]
```

Builds or restores the iOS app. Stim then boots an owned simulator, installs the
app, opens it, and checks launch logs. Native builds run locally by default;
`--eas-profile` downloads an existing EAS development build. A simulator build
can compile on a paired remote machine instead: see `remote.build` in
[machine settings](./settings.md#machine-settings).

- `--configuration <name>` selects an Xcode configuration. The default is Debug.
- `--remote-build <local|auto|remote|remote-only|name>` overrides `STIM_REMOTE_BUILD` and
  `remote.build`. `remote` tries the remote machines first, in `remote.machines` order, and builds here only when none takes the build; `remote-only` refuses instead. A name requires that configured, paired worker and fails
  with `STIM_OFFLOAD_REFUSED` without local fallback. Unlisted or unpaired names refuse at setup before checking the cache, without
  a build record or failed-run stats. A listed paired name with a cache hit
  contacts no worker. Prebuild and pod install run on this machine before
  a named offload, after a check of the worker's toolchain. A refusal starts no local xcodebuild, Gradle or SwiftPM compile.
  Run `stim remote add <machine>` to ask for build access if not approved; a person on
  the worker approves it by running the `stim setup` command it
  printed, with its ticket and expiry.
  See [machine settings](./settings.md#machine-settings) for supported builds and remedies.
- `--scheme <name>` selects an exact shared Xcode scheme when the automatic
  app selection is not the one you need. Explicit schemes have separate build
  caches and DerivedData. This is a build scheme, not the app's URL scheme.
- `--device-type <name>` creates this workspace's owned simulator as that model,
  overriding `ios.deviceType` for one invocation. A model no installed runtime
  can create refuses with `STIM_BAD_ARG` and prints the ones they do offer.
- `--runtime <version>` creates it on that iOS runtime, overriding `ios.runtime`
  the same way. It takes a version (`26.5`) or a runtime's full name
  (`iOS 26.5`), exactly. When the workspace's simulator already runs another
  installed version, `stim ios` refuses instead of booting it: remove the
  simulator with `stim worktree remove`, or pass
  `--slot <name>` to create one beside it.
- `--install-runtime` opts in to installing the explicitly requested missing
  runtime with Xcode before continuing. Use `--remote local` or one named
  approved Mac; automatic placement, EAS, proxy and physical phones do not
  install runtimes. The `ios.autoInstallRuntime` setting enables the same policy
  and defaults to `false`. Downloads are typically 8–10 GB, with a 20 GB free-space
  requirement for download and unpacking. Stim serializes installs in the Mac's
  Stim home, uses a build slot, and verifies the installed version with `simctl`.
  Xcode progress appears locally; remote installs print periodic waiting messages
  and `stim status` shows the install phase. Xcode Settings > Components lists
  available versions and removes shared runtimes when no workspace needs them.
  Stim does not prune runtimes or replace Xcode's availability checks.

  To try it with an agent: “Run this app on iOS 26.5 on my approved Mac. Use
  `stim ios --remote <mac> --runtime 26.5 --install-runtime` and report any Xcode
  or disk-space refusal.”

- On an eas/proxy run (`--remote` or `ios.remote`), `--runtime` refuses
  with `STIM_BAD_ARG` because the remote backend chooses the iOS version, and so
  does `--device-type` on the proxy backend. `--remote eas` honors
  `--device-type` by starting the EAS Simulator session with
  `eas simulator:start --device <name>`, which needs eas-cli 22.2.0 or later.
  A recorded EAS session still running another model refuses with
  `STIM_REMOTE_DEVICE_MISMATCH`; run `stim stop`, then rerun. The
  `ios.deviceType` and `ios.runtime` settings are ignored on an eas/proxy run. A named hosting Mac uses both selectors.
- `--simulator-app <xcode|siniulator|stim-desktop|none>` overrides the machine `iosSimulatorApp`
  preference for this run. `none` opens no viewer. It also opens an already running owned simulator in
  that app without rebooting it. The preference is not saved. Local simulators
  only; cannot be combined with `--device` or a remote target.
- `--device [udid]` builds, installs, and launches on a connected iPhone instead
  of the owned simulator. With no UDID it takes the first connected device it
  can lease. It ignores `ios.remote` and cannot be combined with `--remote`
  other than `--remote local`. Stim never creates, boots, or deletes hardware.
- `--wait <seconds>` bounds the wait for a physical-device lease (default 60;
  `0` refuses immediately if busy). Without `--device`, it bounds the
  owned-device slot wait across the Stim home; without it, a waiting run
  keeps waiting while the devices ahead of it are listed and refuses after 90
  minutes, or once the devices cannot be counted for max(10 minutes, position
  x 5 minutes). Remote targets do not join this local slot queue.
  While a run waits to boot at a full cap, the `stim-daemon` shuts down the
  longest-idle owned device of another workspace idle 2 minutes, one per
  tick. Reclaim shuts down, never deletes, and excludes this workspace,
  physical, hosted, remote, parked and other homes' devices.
- `--no-wait` bypasses leasing, including when another workspace holds the
  device. Installing the same app terminates that workspace's running app.
  Without `--device`, it refuses a full device cap or existing slot queue
  immediately. It cannot be combined with `--wait`.
- `--remote <machine>` runs on a named approved Mac in `remote.machines`, with no local fallback.
  `auto` places on an approved Mac when this machine is full or busy, falling back
  to the local device queue when no host admits. `remote` tries the approved Macs first, in
  `remote.machines` order, and runs here only when none admits; `remote-only` never runs here and waits for a host with room. See [hosted iOS](./owned-devices.md#run-ios-on-another-mac).
  With `hosting.agentDriver=agent-device` on the host and agent-device 0.21.30 or later on both machines,
  `ios.host.agent` returns a per-slot 0600 remote config. `stim agent-device <command>` passes it for you,
  starting with `open <bundleId>`. It reaches only that hosted simulator; inventory, installs,
  uploads, device selectors, shutdown and host paths are refused. `stim stop` closes its connection and removes the config.
- `--remote proxy` uses a configured Agent Device daemon.
- `--remote eas` uses an EAS remote simulator. It needs eas-cli 21.6.0 or later.
- `--eas-profile <name>` selects a compatible [EAS development build](./eas-builds.md),
  including with `--device`. It needs eas-cli 18.9.0 or later. A miss stops
  and prints an EAS build command; cloud builds require authorization. Cannot
  be combined with `--scheme`, `--configuration`, or `--no-build-cache`.
- `--no-metro-check` skips the Debug dev-server check and does not start the
  dev server. Hosted Debug iOS refuses this flag with `STIM_BAD_ARG`; it requires
  the local supervisor, which carries Metro to the host.
- `--no-build-cache` ignores cached artifacts and replaces the matching entry.
- `--plan` predicts the next build instead of running it. See
  [Predict the next build](#predict-the-next-build).
- `--json` prints one stable result object on stdout. It includes `buildMachine`
  (the selected `auto`, `local`, or machine name) and `builtOn` (`here` or the
  worker name, absent when no build ran, including cache hits).

A React Native or Expo Debug run starts the workspace's dev server as `stim start` would when it is
not running, including after an idle stop. With eas/proxy `--remote`, it starts it as
`stim start --remote` would. The JSON result then carries
`devServer: { "started": true, "reason": "not running" | "stopped (idle)" }`.
The run refuses only when that start fails, with the start's error code.

A React Native or Expo configuration whose name contains `Debug`, such as `Debug` or `Dev.Debug`,
uses the dev server, as React Native's bundling script decides. Any other configuration embeds its JavaScript bundle.

A locally compiled device build is local-tier only. Its cache key ends `-device`, so it cannot
collide with a simulator build, and no build-cache provider or Expo remote cache
is read or written on that path, because every entry they hold is keyed
for the simulator. `--eas-profile <name> --device` uses EAS CLI's artifact cache and
installs the signed app without re-signing it.

A `--device` run installs with `devicectl device install app` and launches with
`devicectl device process launch`. The iPhone can be cabled or paired over
Wi-Fi; an Apple TV, Vision Pro, or simulator is never picked. With no UDID, a
cabled iPhone that is paired and has Developer Mode on is taken first, and a
Wi-Fi one only when there is none. A Wi-Fi run prints one line saying so,
allows each install step 15 minutes and the launch 120 seconds, and fails with
`STIM_DEVICE_WIRELESS_FAILED` when devicectl times out or loses the phone;
connect the cable and run again. A locked phone or another cause devicectl
names keeps its own error and remedy. Every device install is signed, Debug
included, so the app's own `embedded.mobileprovision` must be unexpired and must
name the phone, and the identity it names must be in this machine's keychain
whenever Stim modifies the bundle. A build never registers the phone or creates
a profile: when signing fails for a new phone, run
[`stim device provision ios`](#device-provision) or build once from Xcode.

In React Native or Expo Debug, the phone reaches Metro over the LAN, because it shares no loopback
with the host and USB carries no reverse forward. Stim gates a non-internal IPv4
address as this workspace's Metro, then hands it to the app: an expo-dev-client
app through the deep link (`--payload-url`), a bare app by writing
`<addr>:<port>` into a copy of the bundle's `ip.txt` and re-sealing that copy.
The cache entry is never modified. Set `ios.lanHost` when this machine has several
interfaces and the phone shares one that is not the first.

Two things a phone needs that a simulator does not, both one-time and both taps
on the phone: trusting the developer certificate under Settings > General > VPN &
Device Management, and allowing the Local Network prompt the first time the app
looks for Metro. Neither can be pre-granted from this machine. The trust tap has no
API at all and is always the user's; the Local Network prompt can be accepted by
a device tool once it is showing, and Stim's `unverified` remedy prints those
commands when this launch's device log carries iOS's path reason for an
ungranted app. A prior Don't Allow logs the same reason, and the remedy covers
that too. Until it is granted, `launched` comes back `unverified`. Run
`stim guide errors unverified` for the signature and the full recovery.

A React Native or Expo `--device` run in a Release configuration builds fresh every time: a cached
Release app carries its builder's JavaScript, and Stim does not swap JavaScript
into cached iOS physical-device builds.

### Native Xcode apps

Run from the directory containing the `.xcodeproj` or `.xcworkspace`; no
`package.json` is required. React Native and Expo apps keep their existing
integration.

<StimTabs
code={`stim doctor --platform ios
stim ios --scheme MyApp --configuration Debug --json
stim ios --scheme MyApp --configuration Release --json
stim logs --errors
stim stop`}
/>

Replace `MyApp` and the configuration with names from your project. Shared Run
schemes select application targets; a unique application target can also use
its automatic scheme. A workspace owns its referenced projects. `--scheme`
selects an exact name, and duplicate container/scheme matches refuse rather
than guessing. `--configuration` overrides `ios.configuration` in `.stim.json`,
then defaults to Debug. Custom configurations such as Staging work the same way.

Every native configuration uses process launch without Metro or JavaScript
bundle injection. Results report `metroPort: null`; `launched: true` establishes
a live process, so verify the expected UI and interaction separately. Rerun
`stim ios` after native source edits. `stim reload` reloads JavaScript.
Existing simulator ownership, physical-device leases and signing checks, logs,
and scoped cleanup still apply.

Artifact identity includes configuration, source and known dependency inputs,
toolchain and build options. Native Release cache reuse is independent of
`releaseBundleSwap`, and compatible Xcode builds use the shared compilation
cache. `--plan` predicts the same local artifact without preparing dependencies
or choosing a device. An unbounded input graph skips artifact caching and
reports why: examples include shell build phases, custom build rules, C-family
header graphs, Swift package graphs and unresolved external inputs or compiler
overrides. Planning refuses these cases; run without `--plan` to build locally.

A compatible approved remote Mac can compile a native Xcode app with
`--remote-build auto` or `--remote-build <name>`. Both peers must support
`native-xcode-build`. The worker path requires a verified artifact identity and
all inputs contained in the repository and visible to git. Ignored or external
inputs keep the build on this machine, and placement names the first one, instead of
being silently omitted. The common case is a Finder `.DS_Store` that a global
gitignore hides: delete it, or stop ignoring it, to offload. Before compiling,
the worker compares its own toolchain and compiler environment identity with
this Mac's and refuses, naming the differing parameter, so the build falls back
to this Mac. Worker source mirrors remove stale inputs; Xcode compilation caches
remain in the worker's private Stim home. Physical builds stay local.

An already approved hosting Mac can run the built app:

<StimTabs code={`stim ios --scheme MyApp --configuration Debug --remote janics-mac-mini --json`} />

The host must support `hosted-ios-process`; older hosts refuse with an update
remedy before reservation or upload. `--remote auto` skips incompatible hosts,
while recorded sessions stay on their host until `stim stop`. Every native
configuration builds for the offered simulator architecture, uses process
readiness with `metroPort: null`, and closes a previous session's Metro bridge.
The existing [hosted iOS](./remote-machines.md) logs, view/control, agent access
and scoped cleanup apply. Verify UI and interaction separately from process
readiness.

Unbounded native Xcode build offload, hosted `--plan`, eas/proxy devices and EAS
artifact profiles remain unsupported. These limits do not change React Native or Expo support.

Copy this request to your agent, substituting your scheme:

```text
Run this native Xcode app with stim ios --scheme MyApp --configuration Debug
--json. Verify its expected screen and interaction on the reported device,
inspect stim logs --errors, then stop only this workspace with stim stop.
```

### Exact apps

An [Exact](https://github.com/expo/exact) app has `exact.mjs` next to
`app.json`. Run `stim ios` from that directory. It runs the app's own
`./exact.mjs ios --no-install` with `EXACT_SIM` set to the workspace's owned
simulator, installs the reported `.app` and launches it as a native process
without Metro. Exact compiles incrementally in the checkout's `target/`
directory, so Stim keeps no artifact cache for it. `target/` is build output:
the idle stage and `gc` clear it from an idle workspace, never while
another process, such as a shell or an `exact.mjs` command, runs from or works in
the app, nor on Windows, and the next build then compiles from scratch.
`stim worktree warm` leaves `target/` out of a new worktree, because Exact fails
every build in a `target/` built at another path; the worktree's first build
compiles in full, starting from the registry crates Exact keeps for the machine. `--configuration Release`
adds `--release`, Exact's shipping build, whose first build takes minutes.
`--scheme` and any other configuration are refused. The build starts once Stim
has booted the simulator. Build-only runs (`stim ci build`) build without a
simulator, except for apps whose `app.json` declares native modules: Exact may
run code on a simulator to read them, so those are refused and build only with
`stim ios`.

`stim ios --plan` and Stim Desktop's Next Build show the next run as an
uncached build with the app's bundle id from `app.json`, where it builds, and an
estimate from recorded runs:

```text
$ stim ios --plan --remote-build local
  plan        ios -> no build cache: compiles
  app         com.example.shop
  device      this machine
  build       local: builds on this machine
  cache       miss: Exact builds incrementally in its own target/ directory
  expect      unknown: no cold run of this project is recorded yet
```

`stim ios --remote <mac>` runs the app on the workspace's own hosted simulator
on a hosting Mac (see [remote machines](./remote-machines.md)): Stim builds the `.app` with no
`EXACT_SIM`, here or on a build Mac, then installs and launches it there like
any app without Metro, and view, input, `stim agent-device`, `stim logs` and
`stim stop` work as for other hosted runs. An app whose `app.json` declares
native modules cannot run hosted, because Exact may run code on a simulator
next to the build to read them: `--remote <mac>` and `remote-only` are refused,
and `ios.remote` `auto` or `remote` keep it on this Mac.

On this Mac, drive and test the app with Exact's own commands, pointed at the
simulator `stim ios` reported:

```sh
EXACT_SIM=<udid> ./exact.mjs agent ios tree "screenshot out.png"
EXACT_SIM=<udid> ./exact.mjs test ios
```

Exact limits worktrees: a worktree needs the same folder name as the checkout
it was created in, and `EXACT2` set to the Exact checkout when it sits at
another folder depth. Only iOS simulators, here or hosted, are supported; macOS, web, Android
and physical devices use Exact's own commands. `stim android` (iOS
simulators only) and `stim start` (no Metro) refuse an Exact app with `STIM_NO_PROJECT`.

`stim doctor --platform ios` checks what `./exact.mjs ios` needs on this Mac,
where the launcher looks for it:

- Bun at the version `exact.mjs` pins or newer: `$BUN`, else
  `~/.bun-<version>`, else the Bun the launcher names, `bun` on `PATH` or the
  path of the Bun that created the app.
- The exact2 checkout `EXACT2` or the launcher's default path names, set up with
  Exact's setup.
- rustup with `RUSTUP_TOOLCHAIN` or the app's Rust toolchain and its
  `aarch64-apple-ios-sim` target,
  which Exact's setup does not add.

Each missing piece is an `exact-tools` finding with the command that installs
it. Doctor reads files and runs only `bun --version`, `rustup` and `git`; it
never runs the app's code.

With [remote machines](./remote-machines.md), `remote.build` and
`--remote-build` place an Exact build like any iOS simulator build. The worker
runs the same `./exact.mjs ios --no-install` in the app's directory, with
`EXACT2` at its exact2 checkout for the app's commit (or at the copy it
places at the app's relative path to exact2), and
this Mac installs the `.app` on its owned simulator. Nothing is cached. For an
app whose `app.json` declares native modules, the worker creates and boots a
simulator of its own for that build, passes it as `EXACT_SIM` so Exact can read
the module roster, and deletes it afterwards. The values of the settings
`app.json` `env` declares travel with the build: this shell's, else
`.env.local`'s, else `.env`'s, as Exact reads them. These build here: an
`exact2` checkout with local changes, one that shares no top directory with the
app or whose folder name is not a plain ASCII file name, an app in a
subdirectory whose `exact2` sits more than one folder above its repository, and
repository-root apps whose folder name is not a plain ASCII file name. See
[Exact apps on a worker](./remote-machines.md#exact-apps-on-the-worker) for
what the worker needs; `stim doctor` reports what each machine in
`remote.machines` lacks.

Copy this request to your agent:

```text
Run this Exact app with stim ios --json. Drive it with ./exact.mjs agent ios and
test it with ./exact.mjs test ios, both with EXACT_SIM set to the simulator stim
ios reported. Inspect stim logs --errors, then stop only this workspace with stim stop.
```

## `android`

```text
stim android [--slot <name>] [--variant <name>] [--system-image <id>] [--device-profile <id>]
             [--device [serial]]
             [--wait <seconds> | --no-wait] [--remote <proxy|eas|local|auto|remote|remote-only|machine>]
             [--eas-profile <name>] [--no-metro-check] [--no-build-cache] [--plan] [--json]
```

Native Android Gradle apps need a wrapper and `settings.gradle` or
`settings.gradle.kts`, with one AGP application module. Run `stim android`
(default variant `debug`) or pass an exact `--variant freeDebug`. Kotlin DSL,
Groovy DSL, version catalogs and convention plugins are evaluated by Gradle;
Stim does not infer their model from source text. No Node dependencies or Metro
are required. Stim verifies the APK signature and installs one universal or
matching-ABI APK on an owned emulator or leased physical Android phone.

Use `--remote <approved-mac>` or `--remote auto` for a hosted emulator. The host
must support `hosted-android-process`; older hosts refuse before reserving a
device or uploading the APK. Native variants require a live app process and
never open a Metro bridge.

Multiple application modules, density/split APK sets, unsigned APKs and
EAS/proxy targets are unsupported. Set `org.gradle.configureondemand=false` so all
application modules can be enumerated; configuration cache remains supported.
APK caching is opt-in through `android.artifactInputs` in `.stim.json`.
It declares complete repeatable inputs, including signing files and environment
names; [the artifact-input contract](./build-caches.md#native-gradle-artifact-inputs)
describes eligibility, sharing through configured file providers, and private
input handling. Without it, builds retain
Gradle's incremental and task-cache reuse and skip Stim artifact caching.
Build workers require their separate transfer declaration:

```json
{
  "android": {
    "offloadInputs": {
      "complete": true,
      "ignored": ["app/src/main/assets/generated.json"],
      "outputs": ["build", "app/build"]
    }
  }
}
```

Review this list, then run `stim android --remote-build <approved-mac>`. Replace
`stim` with `npx stim` when it is not installed globally. Paths are exact and
repository-relative. `complete: true` affirms that Git-visible files plus the
listed ignored files suffice; omitted optional inputs can silently change a
Gradle build. Never declare secrets or a user Gradle home. External inputs,
directory links, submodules and custom `local.properties` refuse. SDK-only
`local.properties` stays local. Custom project-state locations must be removed
or made explicit source; only default `.gradle`/`.kotlin` state is retained.

List every build directory of the build's projects that the build creates in
`outputs`: the root `build` and each module's, library modules included. A
remote build that creates an undeclared one fails with the directory's name and
Stim builds locally; add it to `outputs`. A `buildSrc` directory refuses before
upload. Included builds (`includeBuild`, such as a `build-logic` plugin build)
and `externalNativeBuild` staging (`.cxx`) are not reported by AGP and cannot be
declared, so remote builds of those projects fail and Stim builds locally.

Only declared output directories reported by AGP and recorded after a successful
worker build survive the next sync. Gradle incremental, task-cache and
configuration-cache reuse remain available; the transfer digest is never an APK
cache key. Old workers refuse before source upload. Native `--plan` uses the local
artifact-input identity and verifies the cached APK without running Gradle or
preparing a device. Missing declarations, unknown local ABI (including legacy
unowned emulator assignments), hosted placement and experimental CAS setup refuse
a prediction. Existing emulator image/profile mismatches use the same refusals as
the normal run. `doctor` reports native prerequisites. `reload` refuses for a
process-only app. Re-run `stim android` after an edit; `stop` keeps the existing
scoped device cleanup and physical-device lease behavior.

Builds or restores the Android app. Stim then boots an owned emulator, installs
the app, opens it, and checks launch logs. A React Native emulator build, debug or release,
can compile on a paired remote machine instead: see `remote.build` in
[machine settings](./settings.md#machine-settings).

- `--remote-build <local|auto|remote|remote-only|name>` overrides `STIM_REMOTE_BUILD` and
  `remote.build`. `remote` tries the remote machines first, in `remote.machines` order, and builds here only when none takes the build; `remote-only` refuses instead. A name requires that configured, paired worker and fails
  with `STIM_OFFLOAD_REFUSED` without local fallback. Unlisted or unpaired names refuse at setup before checking the cache, without
  a build record or failed-run stats. A listed paired name with a cache hit
  contacts no worker. Prebuild and pod install still run on this machine before
  a named offload. A refusal starts no local xcodebuild, Gradle or SwiftPM compile.
  Run `stim remote add <machine>` to ask for build access if not approved; a person on
  the worker approves it by running the `stim setup` command it
  printed, with its ticket and expiry.
  See [machine settings](./settings.md#machine-settings) for supported builds and remedies.
- `--variant <name>` selects a Gradle variant. The default is `debug`.
- `--system-image <id>` creates this workspace's owned AVD from that sdkmanager
  package id, overriding `android.systemImage` for one invocation. An id this
  SDK has not installed is installed first with `sdkmanager --install` when it
  matches this machine's ABI and `android.installImages` is `auto` (the
  default); otherwise it refuses with `STIM_BAD_ARG` and prints the installed
  ids. When the workspace already owns an AVD made from another image, Stim
  refuses with the same remedy as a profile change, unless that AVD never
  finished a boot: Stim then deletes it through owned-device teardown and
  creates one from the requested image. `android.systemImage` still applies
  only to a new AVD.
- `--device-profile <id>` creates this workspace's owned AVD with that
  avdmanager hardware profile, such as `pixel_tablet` or `pixel_fold`,
  overriding `android.deviceProfile` for one invocation. An id that
  `avdmanager list device -c` does not print refuses with `STIM_BAD_ARG` and
  prints the offered ids. When the workspace already owns an AVD of another
  profile, Stim refuses instead of booting it; use another `--slot` or remove
  the workspace's devices first. `pixel_fold` and `resizable` need a system
  image with foldable support (`SupportPixelFold = on` in its
  `advancedFeatures.ini`, as recent images such as API 34 google_apis have);
  the emulator quits on boot without it. Stim refuses that pair with `STIM_BAD_ARG` before
  creating anything, and the remedy names an installed image that has it:

  ```bash
  stim android --slot fold --device-profile pixel_fold \
    --system-image "system-images;android-36;google_apis;arm64-v8a"
  ```

- `--system-image` and `--device-profile` select the local or named host's
  owned emulator. On eas/proxy runs they refuse with `STIM_BAD_ARG`: those
  backends choose their own device and ignore `android.systemImage` and
  `android.deviceProfile`.
- `--device [serial]` installs and launches on a connected physical device.
  With no serial it selects a connected device this workspace can lease. It
  ignores `android.remote` and cannot be combined with `--remote` other than
  `--remote local`.
- `--wait <seconds>` bounds the physical-device lease wait (default 60;
  `0` refuses immediately if busy). Without `--device`, it bounds the
  owned-device slot wait across the Stim home; without it, a waiting run
  keeps waiting while the devices ahead of it are listed and refuses after 90
  minutes, or once the devices cannot be counted for max(10 minutes, position
  x 5 minutes). Remote targets do not join this local slot queue.
  While a run waits to boot at a full cap, the `stim-daemon` shuts down the
  longest-idle owned device of another workspace idle 2 minutes, one per
  tick. Reclaim shuts down, never deletes, and excludes this workspace,
  physical, hosted, remote, parked and other homes' devices.
- `--no-wait` bypasses leasing, including another workspace's lease. Installing
  the same app terminates that workspace's running app. Without `--device`, it
  refuses a full device cap or existing slot queue immediately. It cannot be
  combined with `--wait`.
- `--remote <machine>` runs on a named approved Mac in `remote.machines`, with no fallback. `--remote auto` places on an approved host when this machine is full or busy, or joins the local device queue when no host admits. `--remote remote` tries the approved hosts first, in `remote.machines` order, and runs here only when none admits; `--remote remote-only` never runs here and waits for a host with room (`--no-wait`, `--wait 0` or the end of `--wait` refuse with `STIM_AT_CAPACITY`). `--system-image` and `--device-profile` select the host's installed choices. See [remote machines](./remote-machines.md#run-android-on-a-hosting-mac).
- `--remote proxy` uses a configured Agent Device daemon.
- `--remote eas` uses an EAS remote emulator. It needs eas-cli 21.6.0 or later.
- `--eas-profile <name>` selects a compatible [EAS development build](./eas-builds.md),
  including with `--device`. It needs eas-cli 18.9.0 or later. A miss stops
  and prints an EAS build command; cloud builds require authorization. Cannot
  be combined with `--variant` or `--no-build-cache`.
- `--no-metro-check` skips the Debug dev-server check and does not start the
  dev server.
- `--no-build-cache` ignores cached artifacts and replaces the matching entry.
- `--plan` predicts the next build instead of running it. See
  [Predict the next build](#predict-the-next-build).
- `--json` prints one stable result object on stdout. It includes `buildMachine`
  (the selected `auto`, `local`, or machine name) and `builtOn` (`here` or the
  worker name, absent when no build ran, including cache hits).

A Debug variant starts the workspace's dev server when it is not running, as
described for `ios`.

A variant that ends in `Release` embeds its JavaScript bundle and skips Metro.

### Predict the next build

`stim ios --plan` and `stim android --plan` tell you whether the next run will
come from the cache and how long it should take, without building, booting a
device, installing, or starting Metro. A plan takes no workspace lock and
writes no Stim state, so it can run while another build is in progress.

The selected project integration supplies the plan using its build recipe's
identity and cache policy. If the integration has no read-only planner,
`--plan` refuses with `STIM_BAD_ARG` and reports no cache hit. Run the command
without `--plan` to build and run the app. React Native and Expo planning
behaves as follows.

```text
$ stim ios --plan
  plan        ios 1b625d.. -> local cache hit
  expect      ~2.7s (median of 1 hit run)
```

A plan computes the fingerprint and cache key the same way the run does. It
honors `--slot`, `--scheme`, `--configuration`, `--variant`, `--device-type`,
`--runtime`, `--system-image`, `--device-profile`, `--eas-profile` and
`--no-build-cache`. It then
checks the caches in the run's order: the local cache, the `cache.provider`
setting's provider, and the app config's build cache provider. Providers have no
lookup that skips the download, so a remote check downloads the artifact. The
`cache.provider` tier downloads to a temporary directory that the plan removes;
the app config's provider keeps its download wherever it does during a run. On a miss, the plan also reports the
[prebuild decision](./build-caches.md#native-artifact-cache) the run would make. With cache reads on,
it also says why the cache has no app, the way the run would
([cache misses](./build-caches.md#generated-dependency-output-and-cache-misses)):

```text
$ stim ios --plan
  plan        ios 3d4168.. -> cache miss: compiles, regenerates the native dir
  cache       miss: native dependency added: expo-clipboard (before prebuild regenerates ios/)
  expect      unknown: no cold run of this project is recorded yet
```

A plan never runs `expo prebuild`. When the run would and there is an earlier
build to compare with, the reason's `kind` is `prebuild-pending` and it compares
the fingerprint before that prebuild. With
`--eas-profile`, it asks EAS for a matching build and downloads nothing.

`--json` prints
`{ platform, slot?, fingerprint, cacheKey, cacheHit, provider, cacheSkipped, prebuild, outcome, expectedMs, basis, missReason?, placement?, buildPlacement?, bundleId?, refusal? }`.
`fingerprint` and `cacheKey` are `null` for an integration with no build cache,
such as an [Exact app](#exact-apps), whose next build always compiles.
`missReason` has the shape of `lastBuilds.<platform>.missReason` in
[`stim status --json`](#status).
`cacheHit` is `"local"`, `"remote"` or `false`. `expectedMs` is the median of
this project's recorded runs with that outcome, `basis` counts those runs, and
both are empty (`null` and `0`) until the project has such a run. A run that
would refuse, such as an EAS miss, carries `refusal` and still exits 0.

A plan cannot see everything that happens during a run. Another workspace may
store the key first. A `prebuild` or `pod install` may move the fingerprint,
and the run then checks the new key. A Release hit whose JavaScript swap fails
builds from scratch. An Android plan uses the ABI of the emulator the slot
records, or of the system image a new emulator would use. A plan refuses
`--device`, `--remote`, `--wait`, `--no-wait`, `--no-metro-check` and
`--simulator-app` with `STIM_BAD_ARG`. With `ios.remote` or `android.remote`
set to `auto` or a Mac name, it asks that Mac for its device (a read-only
probe) and prints a `placement` line; it refuses `eas`, `proxy` and a Mac that
does not answer. Without `--eas-profile`, it also refuses the experimental
compiler CAS.

Try it with an agent:

```text
Before building, run `stim ios --plan --json` in this worktree and tell me
whether the next build is a cache hit, how long it should take, and, on a
miss, which native change causes it.
```

## `macos`

```text
stim macos [--remote-build <local|auto|remote|remote-only|name>] [--remote <placement>] [--json]
```

Builds the explicitly configured Swift Package executable in Debug and launches
an isolated development `.app`. Run from the `Package.swift` directory with
`macos.product` and `macos.infoPlist` configured. It uses fixed SwiftPM commands,
with no Metro or custom build scripts. Workspace logs include compiler output
and runtime stdout/stderr. `status` reports the app and build, and `stop` signals
only their verified owners. Stim Desktop can preview one owned window and open
the verified app for native input on the same Mac using existing permissions.
`--remote-build <local|auto|remote|remote-only|name>` selects build placement as described in
[machine settings](./settings.md#machine-settings). A name refuses with
`STIM_OFFLOAD_REFUSED` without fallback; `local` compiles here.

`--remote <placement>` and the `macos.remote` setting say where the built app
runs; the flag wins. A remote machine name from
[`remote.machines`](./settings.md#machine-settings) runs it on that approved Mac
over the tailnet and never falls back to a local launch. `auto` launches here
unless this machine is busy, `remote` on the first approved Mac in order that has
room and runs here only when none does, `remote-only` never launches here
(macOS apps take focus) and waits for a Mac with room, and `local` launches
here. `stop` or `worktree remove` stop a hosted app there. macOS refuses `eas` and
`proxy` because it has neither backend. These reserved names are case-insensitive
and trimmed; `eas` and `proxy` refuse with `STIM_BAD_ARG` before state access or a
connection. See the
[native macOS prototype](./macos.md) for metadata, arguments, hosting and current
limitations.

## `web`

```text
stim web [--headed] [--json]
```

Opens the workspace's page in a Stim-owned Chrome, headless unless `--headed`,
and captures its console, uncaught errors and failed requests in `stim logs`.
It never starts a web server: start the dev server first, then run
`stim web`. Expo apps open their Metro URL and start Metro with `stim start`.
Other apps set `web.url`, for example `http://localhost:{port:web}/`, and run
their own dev server on `stim ports get web`. When nothing serves the page,
`launched` is `"unverified"` and the remedy names that step. The payload
reports `launched`, the page URL, the Chrome `pid`, the `profile` directory and
the reserved `cdpEndpoint`. A second run with the same options navigates the
same Chrome again.

`stim stop` closes the browser and keeps its profile; `stim stop --slot web`
closes only the browser. `worktree remove` and
`gc` also delete the profile. See [Web in an owned Chrome](./web.md).

## `reload`

```text
stim reload [ios|android|web] [--json]
```

Requests a JavaScript reload in the live app on this workspace's owned local simulator
or emulator, or reloads its owned Chrome page. It never builds, installs, boots,
or cold-launches. Omit the platform when exactly one owned app or page is live;
name it when more than one is live. A bare reload picks the Chrome page only when
no native launch is recorded. A web reload sends `Page.reload` to the owned page
and reports `strategy: "cdp"`, with `appId` set to the URL the page was on when
Stim sent the reload.

Stim does not record launches on a physical device (`--device`) or an EAS
Simulator session (`--remote eas`). When no owned launch is live, `reload` asks
this workspace's Metro for its connected apps and reloads them, so it reaches an
app on a phone or in an EAS session that is running and connected to that Metro.
Without a recorded package name, every connected client that is not an iOS client counts as Android. Name the platform when Metro reports apps on both, and a platform with no connected client is never sent a request. The facts have `appId: null`
and `deviceId: "metro:<port>"` because Stim does not know the device, and
Stim changes nothing on it. An Android phone needs its `adb reverse` for the
Metro port, which `android --device` adds; reload does not restore it. When no
app is connected, it refuses with `STIM_RELOAD_STOPPED`. A launch error that
leaves an app without a Metro connection (an iOS first-bundle failure) is not
reached; use the device's own Reload control. An app in an EAS Simulator
session may not open Metro's websocket through the tunnel; `reload` then finds
no app there and refuses, and `stim ios --remote eas` relaunches it on the
session.

Every native reload goes over the workspace Metro websocket, on both platforms. It never
reopens a development-client URL, because that restarts the app rather than
reloading its JavaScript.

Before sending, Stim checks that the app process exists. On iOS that probe
(`simctl spawn launchctl list`) waits 5 seconds, scaled up with host load to at
most 30. When the device tool still does not answer, Stim sends the reload anyway;
`STIM_RELOAD_PROBE_FAILED` is then reported only if Metro finds no peer for the app after the reload fails.
A process the probe proves is gone still fails with `STIM_RELOAD_STOPPED`.

An Android reload first checks `adb reverse` on each live owned emulator launched
against this Metro and re-applies the Metro port's reverse where it is missing.
adb ties a reverse to its transport, so an emulator whose adb connection drops
and reconnects loses it silently, and the app stops reaching Metro and Fast
Refresh. After restoring one, Stim waits up to 8 seconds, sending nothing,
until the app on every emulator it checked is connected again, then sends the
reload once (a bare React Native dev server cannot name its clients, so there
it waits a fixed 2.5 seconds); `reverseRestored` names the serials it
restored. `stim status` reports the same loss as the `android-reverse-missing`
issue, with `stim reload android` as the remedy.

How the message is addressed depends on the dev server, and `strategy` reports
which you got. Where Metro can name its clients, Stim addresses every peer
matching the platform and reports `metro-websocket`. A workspace Metro serves one
app, so those peers are that app on however many devices are attached to the
port; `targets` says how many devices the request addressed: the peers Metro listed, capped at the devices Stim recorded for this app, because Metro keeps listing an app's earlier sockets after a reload. Android peers carry the package
name and iOS peers carry only `role=ios`, which is enough to keep a reload on one
platform but not to single out one iOS app among several.

The bare React Native dev server cannot name its clients at all, because
`@react-native-community/cli-server-api` answers that request out of a `ws`
property removed in ws 3.0. There Stim broadcasts: `metro-broadcast` means every
app on that port was sent a reload request, and that Stim could not confirm the recorded app was
among them. Verify the UI, and fall back to the app's own error screen or dev
menu if nothing changed.

When Metro names its clients and none match the platform, Stim still broadcasts
before giving up, because matching is best-effort and an unmatched peer may be
the app. It reports the miss either way, so verify the UI before acting on the
remedy.

When Metro reports no peer for the app, retry once first: a client reconnects
every 2 seconds, which is also the Metro probe's timeout, so a single miss can be a
reconnect window rather than an app that never connected. If it stays
unreachable on iOS, an error in the first bundle leaves the app without a
packager connection at all, and no retry will make it a peer. The command then
returns instructions to continue in the agent's existing automation session:
press the error screen's Reload button, or open the dev menu and press Reload
when no error screen is showing, and relaunch only when neither is reachable.
Stim does not take over that stateful session.

When Metro itself does not answer within the probe's 2 seconds, nothing is known
about the app, so the command says to retry and check the dev server rather than
sending the agent to the device.

The command refuses release builds, stopped or unowned devices, a missing or
foreign Metro server, and ambiguous selection. `--json` prints one object with
`platform`, `deviceId`, `deviceName`, `appId`, `metroPort`, and `strategy`.
Success, including exit 0 with `--json`, confirms that the request was sent.
The command does not observe completion. Verify the expected UI on the reported
device and inspect `stim logs --errors` before claiming recovery. When the
recorded device is shut down, as after an idle stop, the remedy is
[`stim revive`](#revive).

## `revive`

```text
stim revive [--json]
```

Resumes this workspace after an [idle stop](./dev-server-and-logs.md#idle-stop),
and restores exactly what the stop paused, never more:

- **Metro.** When the dev server's last stop was an idle stop, it starts it
  again on the workspace's port, as `stim start` would. A dev server that is
  running is left alone.
- **Devices.** For recorded local launches, it boots the owned simulator or
  emulator the app ran on (the same UDID or AVD) through device admission
  (`concurrency.maxDevices` included).
- **App.** For an app using Metro, it relaunches the app from the build cache
  entry used by its last launch. For Release React Native or native apps,
  it relaunches the app already installed on the device. In-app state is
  gone when the app is relaunched. A running app is left alone unless it
  needs Metro and Metro restarted.

Installed-only revival works after idle cleanup removes the build directory and
works without a Metro idle stop. Hosted launches stay on their host.

- `STIM_NO_METRO` when Metro is not running and its last stop was not an idle
  stop (it was never started, or a signal or crash stopped it), or when
  `stim stop` or automatic maintenance stopped the workspace after the idle
  stop. When the workspace's last launch ran without Metro, or its app never
  uses Metro, the remedy names `stim ios` or `stim android`, not `stim start`.
- `STIM_DEVICE_LOST` when a recorded launch's simulator or emulator is no longer
  this workspace's owned device, or, when agent-device runs it as its boot
  hook, when the device agent-device asked for is neither one of them nor one
  this workspace owns.
- `STIM_NO_RECORDED_BUILD` when the build cache entry a launch installed is
  gone or absent, when the recorded app that runs without Metro is missing from
  the device, or when the owned device requested by agent-device has no matching
  launch. The remedy names `stim ios` or `stim android`.

Stim checks device ownership and any required cache entry before restarting
Metro or booting a device. It checks for an installed app after the device boots.
Each line on stderr says what came back:

```text
Metro stopped idle 14h02m ago, restarted on port 8081.
Simulator stim-my-app (iPhone 17 Pro 26.0) rebooted.
com.example.app relaunched from cold on Simulator stim-my-app (iPhone 17 Pro 26.0); in-app state is gone.
```

`--json` prints one object, `{ "revived": { "metro": { "port", "stoppedAt",
"reason", "restarted" }, "devices": [{ "platform", "slot", "deviceId",
"deviceName", "rebooted", "app": { "bundleId", "relaunched", "launched" } }] } }`.
`relaunched: true` means in-app state is gone. `metro.port` is `null` when
revive relaunched only apps that run without Metro. agent-device runs
`stim revive --json` itself when it finds the workspace's device shut down and
reads the workspace's boot hook; revive then restores only the launch on that
device and resumes Metro when its app needs it. See
[agent-device actions](./dev-server-and-logs.md#agent-device-actions).

## `agent-device`

```text
stim agent-device <agent-device arguments...> [--slot <name>]
```

Runs agent-device on this workspace's iOS or Android device. Pass agent-device's
own arguments, without a device id:

```sh
stim agent-device open com.example.app
stim agent-device snapshot -i --json
stim agent-device press @e3
stim agent-device scroll down --slot tablet
```

Stim adds what agent-device needs to reach the device:

- `--platform` and `--udid` or `--serial` of the workspace's owned simulator or
  emulator, or of a phone it leases with `stim device lock` or `--device`. A
  leased phone wins over the slot's simulator or emulator.
- `--remote-config` for a [hosted iOS](./owned-devices.md#run-ios-on-another-mac)
  or [hosted Android](./remote-machines.md) session.
- `--session stim-<slot>-<platform>` unless you pass `--session`. A hosted session's
  name ends with the first eight hex digits of the workspace id
  (`stim-default-ios-1a2b3c4d`), because agent-device keeps one saved remote
  connection per session name on the machine and two workspaces would otherwise
  share it. The name stays the same across commands in one workspace.
- For a hosted session whose host no longer holds the agent-device session (its
  stim-server restarted, or no command reached the session for an hour, so agent-device
  answers `SESSION_NOT_FOUND`), a
  single-action command (`snapshot`, `press`, `tap`, `scroll`, `type` and the like)
  opens the app the workspace last launched on the same session and runs once more.
  The output of that command is held until it ends, and only the last run's output
  is printed. The command acts on that app's screen as it is after the reopen, so take a
  fresh snapshot when a coordinate gesture matters. Multi-step commands such as `batch`
  are not retried.
- `AGENT_DEVICE_STATE_DIR`, the workspace's
  [agent-device state directory](./dev-server-and-logs.md#agent-device-actions),
  except for a hosted session, which keeps agent-device's own.

`--slot` picks a [device slot](#named-device-slots), and `--platform ios|android`
picks the platform when the slot has both. Before the command, an
[idle-stopped](./dev-server-and-logs.md#idle-stop) workspace is revived as
[`stim revive`](#revive) would, through device admission, with progress on
stderr. It refuses with `STIM_BAD_ARG` a `--udid`, `--serial`, `--device` or
`--remote-config` that is not this workspace's, and `boot`, `shutdown` and
`close --shutdown`: Stim owns its devices' lifecycle. It refuses with
`STIM_NO_DEVICE` when the workspace has no device there, its emulator is not
running, the host of a hosted session offers no agent control, or agent-device
is missing or older than 0.21.30. It uses the shared `~/.local/bin/agent-device` (or
`STIM_AGENT_DEVICE_BIN`) and does not pin a version.

stdin, stdout, stderr and the exit code are agent-device's, so `--json` output
stays parseable and interactive commands such as `record` and `logs` work.
After each command, Stim shows the action to stim-server viewers that ask for
presence: `Agent · press` and where it landed. A `snapshot --json` taken through
the wrapper lets Stim outline the element a later `press @ref` acts on; text
snapshots give the point only. stim-server measures a point that has no JSON snapshot in
the device's own screen, and shows the actions of agent-device you run
directly too, from agent-device's session records for the workspace's device, about
a second after each one, for an owned simulator or emulator. A leased phone and macOS
apps are not covered that way; see
[native Mac agent actions](./macos.md#agent-actions).

:::tip[Ask your agent]

```text
Read stim guide agent, then drive this workspace's app only through
stim agent-device: open the app, take snapshot -i --json, press by ref, and
check stim logs --source agent.
```

:::

## `share`

```text
stim share ios|android [--control] [--expires <minutes>] [--password <value> | --no-password] [--view-password [value]] [--slug <name>] [--device] [--slot <name>] [--json]
stim share ios|android --reuse [--expires <minutes>] [--device] [--slot <name>] [--json]
stim share stop [--forget] [--json]
stim share list [--json]
```

Gives anyone a public, password-protected web link to watch the workspace's
running app, and with `--control` to tap, type and press its buttons. The share
runs inside this Stim home's stim-server, which `stim share` starts in the
background when none runs, and is served through Tailscale Funnel. The
password is generated unless you set one with `--password` or drop it with
`--no-password`. With `--control`, `--view-password` adds a second password that
only watches. `--slug <name>` makes the link `/s/<name>/` instead of a random
token and needs a password. Viewers see each other's touches live. Every share expires (60 minutes by default, at most 480) and ends with
`stim share stop`, `stim stop` (the workspace, or one slot with `--slot`),
`stim worktree remove`, or stim-server. A device that goes away, as it does when
you rebuild or relaunch the app, only stops it for now: it shows as stopped and comes back by itself. It refuses with
`STIM_SERVER_NOT_RUNNING` when it cannot start a stim-server,
`STIM_DAEMON_UNAVAILABLE` naming the build when a `stimd` of another Stim build
holds the home, and
`STIM_SHARE_REFUSED` with the reason otherwise, including at once on Windows. `--reuse` starts the saved link and passwords of the workspace's last share of
that target again, until it expires, or a new share with a warning when nothing
is saved, and `stop --forget` also deletes the saved links. See
[Share a running app](./share.md) for the requirements and the security model.

## `logs`

```text
stim logs [--slot <name>] [--source <metro|client|device|build|agent|maintenance|gc|builds|all...>]
          [--level <debug|info|warn|error|fatal>] [--since <duration>]
          [--grep <expression>] [--tail <count>] [--errors]
          [--follow] [--json]
```

Queries the workspace log timeline. No matching records is a successful empty
result.

- `--errors` selects errors and fatals from Metro, client, and build logs, plus
  confirmed native app-crash reports and the `stim web` page's failed requests
  and browser errors,
  since the last launch marker. The page's records start again at each page
  load instead, and a launch does not reset them. A completed
  bundle attempt resets only older Metro errors. Metro and client output is
  shared by every slot and names no device, so the newest launch of any slot
  resets it. `--slot <name>` includes that shared output windowed by the
  slot's own launch and the bundles of the platforms it launched, so after
  `stim android` hides an iOS JS error from the unfiltered query,
  `--slot <ios-slot>` still shows it. General device logs require
  an explicit `--source device` or `--source all`.
- `--source device` includes operating-system device logs.
- `--source maintenance` shows maintenance actions, planned (report mode) or taken (on mode),
  and failures for this workspace. Add `--errors` to show only maintenance failures from it;
  failures before a later launch marker are hidden.
- `--source gc` shows the machine-wide cleanup log: one record per item that
  `stim gc` or automatic maintenance cleared, kept or failed to
  clear, with the trigger, size and reason, plus each maintenance pass's summary,
  explaining skips and failures. It works from any directory, stands
  alone (`--source all` leaves it out), and takes `--json`, `--since`, `--tail`
  and `--follow`; `--errors` shows only failed items and maintenance failures.
- `--source builds` shows the machine-wide build ledger: one record per native
  `ios`, `android` or `macos` build run, newest 500, whether it compiled here, was
  offloaded to a build machine or came from a cache, and whether it succeeded,
  failed or was cancelled. A record has the project, workspace and branch, the
  scheme or variant, where it ran (and why an offload fell back to this Mac), the cache
  result and key, the time in each phase, the failure code, message and remedy,
  the simulator or emulator it targeted, this Mac's load per core when the run
  started, when the run's owned simulator or emulator boot started and the load
  per core then (`loadPerCore` and `boot`, absent from older records), the
  project key and the bytes a succeeded local compile took from free space on its
  volume (`projectKey` and `bytesWritten`, which Stim uses to
  estimate the disk a later build of the project needs), and the Stim version. It outlives the
  workspace, works from any directory, stands alone (`--source all` leaves it
  out), and takes the same options as `--source gc`; `--errors` shows only failed
  builds. `stim gc` never removes it.
- `--source agent` shows what agent-device did on this workspace's owned
  simulators and emulators: taps, typing, app opens, screenshots, and failed
  commands. A plain `logs` includes it; `--errors` includes it only when
  selected with `--source agent` or `--source all`.
- `--follow` streams new matching records. It exits with status 0 on Ctrl+C,
  SIGTERM, or when its stdout closes. On Linux it also exits when the process
  that started it exits while its stdout is a pipe. It notices within a few
  seconds, even when no record arrives, except a closed stdout pipe on Linux
  whose starter is still running, which it notices at the next record.
- `--json` writes NDJSON. Zero matches writes zero bytes. With `--errors`, an
  Expo error record also carries a `context` array: the code frame and stack
  lines Expo printed after it.

## `stop`

```text
stim stop [--slot <name>] [--json]
```

Without `--slot`, has stimd stop the dev server, stops all log collectors, shuts down every
owned local device, ends an owned remote session, and frees the port. Owned
local devices stay assigned for reuse. An owned iOS simulator stays booted for
`pool.bootedGraceMinutes` when macOS memory pressure is normal, a device slot
is free and `daemon.mode` is `on`: the stim-daemon shuts it down when the grace
period passes or under memory pressure, and `--json` reports it as
`device.ios.status` `kept-booted` with `until`. Run
`STIM_POOL_BOOTED_GRACE_MINUTES=0 stim stop` to shut it down at once. A dev server left behind by the supervisor of
an older Stim is stopped when its recorded process identity still matches. An
external server on the reserved port is left running, the port stays reserved
while that server runs from this project, and a process whose ownership cannot
be verified is not signalled.

`stop` verifies that a device actually shut down instead of trusting the
shutdown command: it waits for a simulator to report `Shutdown` and for an
emulator's process to exit. A device that does not get there is reported as
`failed`, not shut down, with a remedy naming the manual command to run and
`stim gc` as the fallback; `--json` carries the same outcome in
`device.<platform>.status` plus a `remedy` field. `stop` still never deletes
the device.

With `--slot <name>`, stops only that slot's owned devices and collectors and
releases its leases. Metro, the reserved port, and sibling slots keep running.
Use `--slot default` to stop only the workspace's default device -- the one
`ios`/`android` address with no `--slot` and `status` reports with no `[slot]`
label -- while a named slot stays up. `--slot` never ends an owned remote
session, even `--slot default`; use plain `stop` for that. `--slot web` closes
only the owned Chrome from `stim web` and keeps its profile; Metro and every
device keep running, so no device slot can be named `web`. A slot the
workspace has not recorded is refused with `STIM_BAD_ARG` and the list of its
slots, and nothing is stopped. A slot whose first build is still running
counts as recorded, and that build is interrupted.

### Stopping during a build

`ios`, `android`, and `stop` take turns on the workspace's build lock. A
command that has to wait prints what it is waiting for on stderr right away and
every 30 seconds:

```text
  lock        waiting for `stim ios` (pid 41233, running for 12m04s) in this workspace to finish
```

`stop` does not wait out a build that would be left with nothing to deploy to:
a plain `stop`, `stop --slot <name>` for the slot the build targets, or for the
workspace's only device. It asks that run to stop through the workspace state,
also sends SIGINT when the run is a Stim process of its own (the CLI, or the
worker behind `createStim`) whose recorded identity it verified, and waits up
to 60 seconds. A run inside a process that embeds Stim, such as stim-server, is
never signalled. The run stops xcodebuild or
Gradle, caches nothing from the interrupted build, and exits 130 with
`STIM_CANCELLED`. If the run does not exit in time, `stop` refuses with
`STIM_STOP_BLOCKED` and names the pid and lock to deal with. `stop --slot
<name>` while a build for another, still-running slot is in progress leaves
that build alone and stops the slot right away. A plain `stop` ends an EAS
session as soon as it sees a build holding the lock, so the session stops
billing even when the build cannot be interrupted.

On a physical iPhone, stopping the log collector closes the running app.
`stop` also releases this workspace's device leases. It never uninstalls the
app or shuts down the phone; hardware has no owned-device registry entry.
On a physical Android phone, `stop` and `worktree remove` also remove the
`adb reverse` that `android --device` added for this workspace's Metro port, and
leave every other reverse on the phone alone.

## `device lock` and `device unlock`

```text
stim device lock <ios|android> [id] [--slot <name>] [--for <duration>] [--wait <seconds>] [--json]
stim device unlock [ios|android] [--slot <name>] [--json]
```

Leases a connected physical device to this workspace, so another workspace's
`--device` run waits instead of installing over it. `--for` takes a whole
number of seconds or minutes from `10s` to `30m` and defaults to `5m`;
`--wait` bounds how long to wait for a device another workspace holds
(default 60 seconds, `0` refuses at once). Locking a device this workspace
already holds sets a new expiry, which can shorten it.

With no id, `lock` picks from the connected devices the resolver accepts: the
one this workspace already leases when it is connected, otherwise the first
free one in id order. The same rule serves `ios --device` and
`android --device` with no id, so two devices on one machine no longer refuse.

An id can also name this workspace's own Stim-owned simulator (its UDID) or
running emulator (its `emulator-NNNN` serial), in any slot. The lease then
tells agents and `stim status` that the device is being driven, reported as
`driven by stim device lock`. `--slot`, when given, must be the slot the device
is in. A workspace holds one lease per platform and slot, so this refuses with
`STIM_DEVICE_BUSY` while that slot already leases a phone.
With no id, `lock` still picks only physical devices.

`unlock` releases every lease this workspace holds, or only the platform
named. Adding `--slot <name>` restricts release to that slot; releasing nothing
is not an error. A `--device` run takes a lease of
its own for the length of the run, so `lock` is for holding a device across
runs, such as a device-tool session. `stim status` lists every lease on the
machine.

## `device location`, `permission`, `push` and `network`

```text
stim device location <ios|android> (--set <lat,lng> | --clear) [--slot <name>] [--json]
stim device permission <ios|android> <grant|revoke|reset> <service> [--slot <name>] [--json]
stim device push ios --payload <json> [--slot <name>] [--json]
stim device network android <on|off> [--slot <name>] [--json]
```

Change this workspace's own simulator or emulator without looking up its UDID
or serial, and without the risk of aiming `simctl` or `adb` at a device Stim
does not own.

- `location --set 45.5,-73.6` simulates a coordinate. Latitude and longitude
  are one value, so a negative latitude is not read as a flag. `--clear` stops
  simulating on iOS; the Android emulator has no way to clear one and refuses.
- `permission` grants, revokes or resets one service for the app. The app is the
  slot's last launch, else the project's bundle id or Android package.
  iOS services are the ones `simctl privacy` lists: `all`, `calendar`,
  `contacts`, `contacts-limited`, `location`, `location-always`,
  `media-library`, `microphone`, `motion`, `photos`, `photos-add`, `reminders`
  and `siri`. Android services are `calendar`, `camera`, `contacts`, `location`,
  `microphone`, `motion`, `notifications` and `photos`. A permission the app
  does not declare in its manifest cannot be changed; Android lists it under
  `skipped` and succeeds when the app declares at least one permission of the
  service, and refuses with `STIM_DEVICE_TOOL_FAILED` when it declares none. `reset` on Android revokes the permission and clears its user-set
  flags so the app asks again; the call fails if the device still reports a
  granted permission or a user flag. Changing a permission can terminate the
  running app on both platforms.
- `push ios --payload '{"aps":{"alert":"Hello"}}'` sends a test push to the
  app. The payload is a JSON object with an `aps` key, at most 4096 bytes. The app must
  already hold notification permission on the simulator, which `simctl privacy`
  cannot grant; otherwise `simctl` answers "Source is not authorized".
- `network android off` turns Wi-Fi and mobile data off and `on` turns them back
  on.

The target is the slot's owned, booted simulator or emulator, checked the way
`reload` checks it. A hosted device, an EAS Simulator session, a physical device
and a device Stim does not own refuse with `STIM_DEVICE_TOOL_TARGET` and run
nothing. A non-Mac client cannot run a local iOS simulator; use these iOS tools
on a Mac with a local Stim-owned simulator. An action the platform lacks refuses with
`STIM_DEVICE_TOOL_UNSUPPORTED`, and a tool call that fails, or a device that does
not report the change afterwards, with `STIM_DEVICE_TOOL_FAILED`.

`--json` prints one line: `platform`, `slot`, `deviceId`, `deviceName`, `tool`,
the parameters, and `readBack`. `readBack` is what the device reported after the
change: `{ "permissions": [{ "name", "granted" }] }` for Android permissions and
`{ "wifi", "data" }` for Android network. It is `null` where the platform has no
read: iOS location, permissions and push, and Android location. There the exit
status of `simctl` or `adb` is the only confirmation.

```text
Set this workspace's simulator to Montreal, grant the app photos access, and show me the JSON that stim device printed for each.
```

## `device provision`

```text
stim device provision ios [udid] [--scheme <name>] [--configuration <name>] [--yes] [--json]
```

Sets up signing for a connected iPhone or iPad in the project's Apple
Developer team, which `stim ios --device` needs before its first build for that
phone. It is the only Stim command that changes a developer account, and it
never runs as part of a build.

It finds the Xcode project the way `stim ios` does (`ios/` for React Native
and Expo, the app's own project or workspace for a native app). A native app
with Swift packages uses the packages `stim ios` already resolved, with
automatic package resolution off, so provisioning never fetches packages or
rewrites `Package.resolved`. Until `stim ios` or `stim ios --device <udid>`
has resolved them once, it refuses with `STIM_PROVISION_FAILED`. It reads every
target of the scheme (`--scheme`, then `ios.scheme`, then the detected one)
that is signed with a provisioning profile, on any platform, in the
configuration (`--configuration`, then `ios.configuration`, then `Debug`), and
prints what it will change: register
the phone with the team named by the project's `DEVELOPMENT_TEAM`, create or
refresh the iOS App Development profile for each bundle ID, and create an
Apple Development certificate for this Mac when the keychain holds none. It
then asks `[y/N]`; Ctrl+C or end of input counts as no. Without a terminal, or
with `--json`, it refuses with `STIM_PROVISION_UNCONFIRMED` and changes nothing
unless `--yes` is passed.

On confirmation it runs `xcodebuild -allowProvisioningUpdates
-allowProvisioningDeviceRegistration` for that phone in a throwaway
DerivedData directory and stops it at the first build task, which xcodebuild
only starts once it has resolved signing, before anything compiles. Ctrl+C
and SIGTERM are passed on to xcodebuild, the DerivedData is always removed,
and a run still unresolved after 15 minutes is stopped. It then reports the
profile it installed and any new keychain identity. Refusals use
`STIM_PROVISION_FAILED`: no Xcode account and no API key, an account or key
without access to the team, a target with no team or with manual signing, an
interrupt or a timeout. A refusal after xcodebuild ran still lists what had
already changed, and running the command again is safe.

It signs in with the Apple ID in Xcode > Settings > Accounts, or, on a Mac where
nobody signs in to Xcode, with an App Store Connect API key:

<StimTabs
code={`stim settings set ios.appStoreConnectKeyPath /Users/me/.appstoreconnect/private_keys/AuthKey_ABC123.p8 --scope machine
stim settings set ios.appStoreConnectKeyId ABC123 --scope machine
stim settings set ios.appStoreConnectIssuerId <issuer-id> --scope machine`}
/>

`STIM_ASC_KEY_PATH`, `STIM_ASC_KEY_ID` and `STIM_ASC_ISSUER_ID` each override
their own setting when set and non-empty. Stim passes the path to xcodebuild,
never reads the key, and never prints the path.

Because it changes your team's account, the agent guide tells agents to run it
only when you ask. A prompt you can give your agent:

```text
My iPhone is connected but stim ios --device fails on signing. Run stim device provision ios without --yes, show me what it would change, and wait for me to confirm.
```

## `settings`

```text
stim settings [--json]
stim settings get <key> [--scope <layer>] [--json]
stim settings set <key> <value> --scope <layer> [--json]
stim settings unset <key> --scope <layer> [--json]
```

Lists every setting with its effective value and the layer it comes from, or
changes one layer. `<layer>` is `machine`, `workspace`, `repo`, or `committed`.
`workspace` is this project's entry in `~/.stim/config.json`, `repo` is this
repository's entry, and `committed` is the app's `.stim.json` (the repository
root's for `worktree.*`). A key accepts only the layers Stim reads it from;
`--scope` can be omitted when there is one. Run it from the app directory, or
from a monorepo web package that resolves to the app (see `ports`).

Strings and choices are passed as-is. Booleans, numbers, arrays, and objects
are JSON:

```bash
stim settings set ios.deviceType "iPhone 17 Pro" --scope workspace
stim settings set worktree.exclude '["node_modules","ios/Pods"]' --scope committed
stim settings set concurrency.maxBuilds 2
stim settings unset ios.deviceType --scope workspace
```

An unknown key, a layer the key is not read from, or a value of the wrong
shape refuses with `STIM_BAD_ARG`, names the expected shape, and writes
nothing. `set` and `get` of a [removed setting](./settings.md#stim-daemon)
refuse with `STIM_BAD_ARG` as an unknown setting, and `unset` removes a
leftover one from every layer that has it, or from the one `--scope` names.
Machine-file writes take the config lock and replace the file
atomically. A committed write keeps the file's other keys and indentation.

`--json` on the list prints one object:

```json
{
  "project": "/path/to/app",
  "files": {
    "machine": "...",
    "workspace": "...",
    "repo": "...",
    "committed": "..."
  },
  "settings": [
    {
      "key": "ios.runtime",
      "value": "26.2",
      "origin": "repo",
      "layers": { "repo": "26.2", "committed": "26.0" }
    }
  ],
  "unknown": [{ "key": "bogus", "scope": "committed", "file": "...", "value": true }]
}
```

`origin` is the winning layer, `env` when an environment variable overrides
the file (`env` then names it), `default`, or `null` when unset. A default
that depends on the machine carries `defaultReason`: `iosSimulatorApp` and
`androidEmulatorApp` default to `stim-desktop` with `"defaultReason": "Stim
Desktop installed"` when Stim Desktop is installed. Plain `settings get`
prints the value on stdout and that reason on stderr. `unknown`
lists keys Stim does not read. `android.keystorePassword` is sensitive: it
prints as `********`, and `committed` accepts only an `env:` or `file:`
reference for it. `set` and `unset --json` print the layer written, its file,
and the setting's entry after the write.

## `remote`

```text
stim remote add <machine> [--json]
stim remote list [--json]
stim remote remove <machine> [--json]
stim remote update <machine> [--channel next]
```

Manages [`remote.machines`](./settings.md#machine-settings), the remote
machines this machine builds on and hosts devices on, from any directory; no
app checkout is needed. `<machine>` is a tailnet name, optionally with
`:<port>` of its serve route (default 7443), or `local:<host>` with an
optional stim-server port (default 7787).

- `add` appends the machine to the machine-scope list, keeping the entries
  already there, and asks it for build and device-host approval. It prints the
  `stim setup` command, with a setup ticket, that a person runs on that
  machine to approve this one. Adding a machine already in the list asks it
  again when its request lapsed or was revoked, and otherwise reports its state.
  A name that is not a tailnet name or `local:` address refuses with
  `STIM_BAD_ARG` and writes nothing.
- `list` contacts every listed machine, in placement order, and reports its
  build and device-host approval. It asks nothing new; it completes the
  connection to a machine that approved since the last contact. For a
  `local:` machine, run it in a terminal to confirm the server key fingerprint.
- `remove` drops the entry and forgets this machine's credentials for it. The
  remote machine keeps its approval until a person there runs the
  `stim pairings revoke <id>` command `remove` prints.
- `update` installs the newest release compatible with this caller's peer on the worker's channel; `--channel next` selects prereleases for this update without changing its channel. Pins and builds marked bad refuse it.

```bash
stim remote add janics-mac-mini
stim remote list
stim remote remove janics-mac-mini
```

The states are the ones `stim doctor --json` reports under `remoteMachines`
(`build` here) and `deviceHosts` (`deviceHost` here). `list --json` prints
`{ machines: [{ machine, priority, build, deviceHost, serverKeyFingerprint, reachability, revoke }], findings }`,
where `serverKeyFingerprint` is the fingerprint of the stim-server key this
machine pinned for it (`null` before it answered), `reachability` is
`reachable`, `unreachable`, `key-changed` or `unknown` from this run's contact,
and `revoke` lists the `stim pairings revoke <id>` commands a person on
that machine runs to withdraw its approvals; `add
--json` prints `{ machine, added, machines, build, deviceHost, findings }`,
where `machines` is the list after the change; `remove --json` prints
`{ machine, removed, forgot, machines, revoke, pending }`, where `pending` means a request
was still unanswered here, so the worker may hold an approval `revoke` cannot name. `stim settings set
remote.machines` replaces the whole list; use it to change the order.

## `status`

```text
stim status [--json] [--watch]
```

Shows every Stim environment on the machine. Last builds include `buildMachine`
(the selection) and `builtOn` (`here` or the worker name, absent when no build
ran, including cache hits and refusals after setup). Configuration refusals
create no build record or failed-run stats. Older records may lack
these additive fields. The output includes worktrees,
ports, devices, supervisors, builds, logs, capacity, and free disk space.
Each linked worktree shows its uncommitted changes, commits ahead of and
behind its upstream, and whether its branch is merged, as a
`git: 2 changed, 1 untracked, ahead 3` line. One-shot `stim status` shows it
only for live environments; `stim status --watch` shows it for every worktree. See
[Parallel environments](./worktrees.md#parallel-environments) for the JSON
fields.

One-shot `stim status` takes simulator state and device slot usage from the
device listing that a boot admission took in the last 10 seconds, when there
is one, and runs `simctl list` itself otherwise. It also lists itself when that
listing lacks a simulator or, for the emulator listing, an owned emulator that a
workspace records. Under a burst of starting workspaces the admissions keep that
listing fresh, so status does not wait on a slow `simctl`. The listing can be up
to 10 seconds old plus the time it took, and a boot admission lists before it
boots a device, so a device that boots or stops after that listing can show its
earlier state for that long. `stim status --watch` always lists the devices
itself.

Each workspace is marked with its lifecycle phase: `[warming: <step>]` while
`stim worktree warm` runs in it, or `[ready]` after a warm until its first run.
Other workspaces have no marker; their `stage:` line says whether they are running,
idle, dormant or stopped. In `--json`, each environment
carries `phase` (`warming`, `ready`, `live` or `idle`), `phaseSince` and, while
warming, `warmStep`; see
[Parallel environments](./worktrees.md#parallel-environments).

A workspace whose folder was deleted outside Stim, for example with
`git worktree remove` or `rm -rf`, stays registered, so status marks it
`[folder missing]` and `--json` sets `pathMissing: true` with a phase that is
never `warming` or `ready`. Status only reports it; `stim worktree remove <path>`
or `stim gc` removes the entry. A folder on a volume that is not mounted is not reported, since the
volume may come back.

Each environment also carries `stage`, the conclusion Stim Desktop and the
phone app show beside the git chip: `{ kind, since, platform, closedApps }`.
`kind` is the first of these that applies: `building` while a build runs,
`warming` or `ready` from `phase` when nothing is active, `build-failed` when the
newest run of either platform failed, `running` when the workspace is active or
holds a remote session, else `stopped`. `since` is when that began, `platform`
names the build for `building` and `build-failed`, and `closedApps` lists, for
`running`, the `{ platform, slot }` of each device whose app is closed. A
worktree entry with git facts also carries `gitChip: { parts, ci }`: the
commits ahead and behind, the uncommitted count, the branch it is merged into
(unless its pull request is merged) or a missing upstream, in display order,
and the pull request's checks as `failing`, `pending`, `passing` or `null`.

A workspace that needs attention prints each issue under it with the command
that fixes it:

```text
  ! owned AVD stim-app is not detected by adb; run `stim android`
```

In `--json`, each environment's `issues` array holds
`{ code, severity, message, remedy, workspace, slot? }`, and `warnings` holds
the `error` and `warning` issues as text. Run `remedy` from `workspace`.
`error` is something Stim cannot verify or safely act on, `warning` something
broken now that needs someone to act, and `info` a fact the next normal Stim
command handles by itself; the phone app and Desktop hide `info`. An
`info` issue is a note that blocks nothing: when another app holds an idle
workspace's reserved port, plain `status` prints
`- port 8083 is in use by a dev server in scratchpad/web-phase2/expo-web; stim start will choose a free port`,
and `metro.heldBy` carries that process's `pid` and `cwd`. The same port
taken while the workspace's supervisor runs is a `warning`. An idle workspace's
shut-down emulator is not an issue: Stim warns that adb does not see an owned
emulator only when the workspace holds a lease on it, or launched onto it and
has not stopped it since while its dev server runs or within the last 30
minutes. `stim stop --slot <name>` counts as stopping that slot's device. A
supervisor record whose process is gone is not an issue either; the next
`stim stop` or `stim start` clears it. `stim guide facts status` lists every
issue code.

A workspace with a recorded EAS Simulator session prints a
`remote <platform>: EAS session <id> billable` line with the session's preview
URL. In `--json`, each environment's `remoteDevices` array holds
`platform`, `backend`, `sessionId`, `state`, `startedAt`, and `webPreviewUrl`.
`status` reads Stim's local records and does not query EAS; `stim stop` in that
workspace ends the session.

A physical phone or tablet the workspace leases with `ios --device`,
`android --device`, or `device lock` prints under its workspace as
`ios: Old iPhone (physical, iPhone 12 Pro) connected -- leased until 17:04:53 (9m59s left)`.
In `--json`, each environment's `physicalDevices` array holds `platform`,
`slot`, `id` (the UDID or serial), `name`, `model`, `owned` (always `false`),
`physical` (always `true`), `connection` (`connected`, `disconnected`, or
`unknown`), and `lease` with `holder`, `kind`, `grantedAt`, and `expiresAt`.
Status reads the connection from `xcrun devicectl list devices` or
`adb devices`, only when the workspace holds such a lease. A run lease ends
with its run, so to keep a phone listed after the run, hold it with
`stim device lock`. Stim Desktop and the Stim phone app show each one as a
tile with a Physical badge.

A dev server stopped after
[`idle.minutes`](./dev-server-and-logs.md#idle-stop) with no activity
prints as `metro: port <port> stopped (idle)`. In `--json` that environment's
`metro` carries `idleStop` with `reason`, `at`, and `idleMinutes`. Any other
known cause prints after `not running`, and `metro.lastStop` carries it; see
[why the dev server stopped](./dev-server-and-logs.md#why-the-dev-server-stopped).

Plain `status` prints a `Daemon` line for the
[`stim-daemon`](./settings.md#stim-daemon): its mode, whether it runs, when it
last ticked, and the pressure level with its reasons. A `Last daemon action`
line follows once a daemon of this home has acted, then a line for each run
waiting for a build slot or a device boot, and one for each child whose cleanup
the running daemon could not verify, with its remedy, and a line for the crash
hold and for each of the last abnormal stimd exits. Each workspace prints a
`stage:` line with where the daemon's idle model has it: `running` with its last
activity, `idle` or `dormant` with the time in it and what the stage freed or
deleted, or `stopped`. This line is separate from the JSON `stage` object
above. In `--json`, `daemon` carries `mode`, `running`, `lastTickAt`,
`pressure`, `waiting`, `unverified`, `crashHold`, `abnormalExits` and `recent`, the last 20 actions any daemon of this home
took, oldest first; an environment the daemon staged carries `idleStage` or
`dormantStage`.

Status prints the recorded managed Metro tunnel's provider and URL, with
`tailnet-only` for Tailscale. In `--json`, `metro.tunnel` carries `{ provider, url }`
when a managed tunnel is recorded on the workspace's reserved port. This reports
the record without probing reachability. See [Metro on your tailnet](./owned-devices.md#metro-on-your-tailnet).

In `--json`, `metro.bundle` reports the dev server's bundle requests, from the
metro log: `{ bundling, platform?, startedAt?, percent?, last? }`. `bundling`
is `true` while an app's request, or Stim's own prefetch before a launch, is in
flight; `percent` is present when Metro reports progress for it. `last` is the
newest finished request: `{ platform, status, durationMs, finishedAt }`.

Once `stim status --watch` has measured them, each environment carries
`disk: { worktreeBytes, nodeModulesBytes, nodeModulesPrivateBytes, buildBytes, measuredAt }`,
and each owned simulator and emulator carries `disk: { bytes, measuredAt }` for
its data folder. `buildBytes` is Stim's own folder for the workspace, with Xcode
derived data, Gradle outputs and logs. `nodeModulesBytes` counts APFS clones in
full; `nodeModulesPrivateBytes` is what deleting `node_modules` would free, the
blocks no copy-on-write clone or outside hard link shares, and is `null` off
APFS or without the Command Line Tools. Both `node_modules` figures are `null`
again after a reinstall or a fresh clone until the tree is measured, and they
are the measurement `stim gc` and the daemon's cleanup use. The watcher
measures off its refresh path, at most every 5 minutes per folder while the
environment is active and every hour otherwise, and measures `node_modules`
when its install changes and at least every 6 hours. One-shot `stim status`
reads the cached sizes.

An environment carries `agents` when a coding-agent session works in it:
`[{ tool, sessionId, title?, cwd, startedAt?, lastActiveAt?, pid?, openUrl?, webUrl? }]`,
with `tool` either `claude-code` or `codex`. A session works in an environment
when its working directory is the environment's path, a folder inside it, or
its git worktree root. The watcher finds running Claude Code sessions in
`~/.claude/sessions` and Codex threads updated in the last 30 minutes in
`~/.codex`, at most every 15 seconds, and one-shot `stim status` reads what it
found for 2 minutes. These are the tools' own internal files, so Stim reads them
best-effort. `start`, `ios`, `android`, `web`, `reload`, `revive`, `logs` and `worktree warm` also
record the `CLAUDE_CODE_SESSION_ID` or `CODEX_THREAD_ID` of the shell that ran
them, which names the session exactly. `title` is the short name the tool keeps
for the session; Stim reads no prompts or conversation. `openUrl` opens the
session in the Claude desktop app or the Codex app when that app is installed,
and is absent for a Claude Code session started in a terminal. `webUrl` is the
session's `https://claude.ai/code/` link while Claude Code Remote Control is
connected, which opens it in a browser or the Claude mobile app; Stim's phone
app opens it from the workspace page.

When the watcher stops finding a session it found on its previous look, it
records the session in each workspace it worked in, and the environment
carries it for 3 days in `endedAgents`, most recently ended first. Each entry
has the fields above except `pid`, as the watcher last found them, including
its `openUrl` and `webUrl`, plus `endedAt`, the last time the watcher found it
running. A Codex thread ends 30 minutes after its last update. A session that
runs again is listed in `agents` only. Stim Desktop and the phone app show a
workspace's running and ended sessions alike, earliest `startedAt` first,
without times.

In `--json`, `machine` lists what uses CPU and memory now: each booted
simulator and emulator with its workspace, each Metro, running build and
`stim web` Chrome, stim-server, and a shared bucket for machine-wide processes
such as CoreSimulator services, the adb server and Gradle daemons. Each owner
carries `cpuPercent`, `memoryMb`, `residentMb` and `processes`, and every
process counts in exactly one owner. `owned` marks what Stim can stop: a
workspace's owned device with `stim stop --slot <name>`, and its Metro with
`stim stop`. `memoryMb` is the physical footprint Activity Monitor shows, read
by a small helper that Stim compiles with the Xcode command line tools on
first use. Without them, and on Linux, `machine.memorySource` is `rss` and
owners' `memoryMb` falls back to resident memory, which counts pages shared
between processes once per process, so a simulator reads many times its
footprint. An environment's `memoryMb` sums its own owners' footprints, builds
included, with `memorySource: "footprint"`. Without a footprint, or when
nothing runs and `machine` is `null`, it is a fixed estimate, with
`memorySource: "estimate"`. `stim guide facts status`
lists every field.

Status always shows this Mac's load, as a `load 17.6/core (busy at 2)` line and
in `--json` as `capacity.load`: `cpus`, `loadPerCore` (the 5-minute load
average divided by `cpus`), `busyAt` (`server.maxLoadPerCore`, the load at
which automatic placement prefers another machine), `limit` and `state`.
`state` is `free` under `busyAt`, `busy` at or over it, or `holding` at or
over `limit`. No setting sets `limit` yet, so it is `null` and `state` is
never `holding`.

Status shows how many build and device slots are in use and who holds them,
as a `builds 1/2 (concurrency.maxBuilds)` or
`devices 6/8 (derived; set concurrency.maxDevices to override)` line, the second
form while Stim derives the cap because the setting is unset, and in `--json` as
`capacity.builds` and `capacity.devices`: `max`, `inUse` and `holders`. A build slot's holder names
the workspace building in it, or the client whose offloaded build this Mac
runs; a device's holder names the workspace label and device slot that record
it. `capacity.devices.inUse` is `null`, with `unknown` saying why, when the
devices could not be listed.

`concurrency.maxIosDevices` and `concurrency.maxAndroidDevices` add an
`iOS simulators 1/2` or `Android emulators 0/1` line and, in `--json`,
`capacity.platformDevices.ios` or `.android`: `max` and `inUse`, with `unknown`
saying why `inUse` is `null`. Each appears only while its cap is set, whether or
not `concurrency.maxDevices` is. `concurrency.maxMacosApps` limits local app
workspaces in this Stim home and hosted reservations in separate pools; it
has no status line.

`--watch` keeps running and prints the status again each time it changes.
With `--json` it prints one complete payload per line: one immediately, then
one per change, never two identical payloads in a row. In a watch line, a CPU or memory figure keeps
its value from the previous line until it moves by 5 percentage points or 16 MB;
resident memory and process counts follow their owner's row, and `capacity.committedMb` is held on its own, so it can differ from the sum of the environments' `memoryMb`.
`capacity.load` keeps its value until its `loadPerCore` moves by 1 per core or its `state` changes.
A change in only a bookkeeping timestamp (each `pullRequest.checkedAt`, `maintenance.lastChecks`, `maintenance.lastPass.startedAt` and `durationMs`, `maintenance.running.startedAt`) prints no line; a line that prints carries the current values.
It reacts to changes in
`$STIM_HOME` state and the EAS session ledger, git HEAD, index and ref changes
in the worktrees' repositories, the exit of a recorded supervisor, Metro,
build, browser or macOS app process (checked every 2 seconds), adb device
arrivals and departures, and simulator boots, shutdowns, creations and
deletions (from CoreSimulator's device set and metadata files, with a simctl check every 30
seconds), and recomputes every 30 seconds as a fallback. A log append updates the
log-derived facts within about a second; device activity follows at most every
5 seconds. The first line does not wait for git: worktree git summaries can be
`null` in it, and the next line carries them. With `--json`, while
`machine` is not `null`, it rereads the process table every 15 seconds so
`machine` stays current. It exits with status 0
on Ctrl+C, SIGTERM, or when its stdout closes. On Linux it also exits when the
process that started it exits while its stdout is a pipe. It notices within a
few seconds, even when nothing changes, except a closed stdout pipe on Linux
whose starter is still running, which it notices at the next change.
Use it to wait for a device, a build, or a dev server instead of polling `stim status --json`.

While `stim ios` or `stim android` runs, the workspace shows the build's phase
and an estimate of the time left:

```text
  build: ios compile, 1m10s elapsed -- about 3 min left (median of 4 cold runs)
```

In `--json`, each environment carries `build`: `null`, or
`{ platform, slot, state, phase, startedAt, phaseStartedAt, outcome, outcomeKnown, cacheLookupOutcome?, expectedMs, expectedPhaseMs, completedPhaseMs?, basis, plannedPhases }`.
`phase` is one of `prepare`, `cleanup`, `cache-lookup`, `wait`, `prebuild`, `pods`,
`compile`, `device`, `install` and `launch`. Creating, adopting or booting the
owned simulator or emulator before the cache lookup counts as `prepare`,
except a new iOS simulator that waits to boot (a full device cap, a boot slot or
memory): the run builds for any simulator while it waits.
`device` starts once the app is ready and covers waiting for the device (its
boot, adoption cleanup, a new simulator's creation, or a physical device's lease and connection check); a
boot that finishes during the build adds no `device` time. `state` is `running` while the run's
`native-run.lock` claim is live, `stale` when that run was killed (the next run
replaces the record), and `unknown` when the claim cannot be read. `outcome` is
`cold` after the local/provider lookups resolve a miss, and `hit` after a cached
artifact is ready to reuse, including a shared-build hit or a recheck after
prebuild or pods. A later recheck can replace the first lookup's outcome.
Before resolution it follows the project's most recent run and `outcomeKnown`
is `false`. `cacheLookupOutcome` is `hit` or `miss` after an actual lookup resolves;
it is absent before resolution and on runs that skip lookup, such as `--eas-profile`
or `--no-build-cache`. Fingerprinting for a fresh build remains in `prepare` when
cache reads are disabled.
`completedPhaseMs` holds milliseconds spent in each phase the run already left,
summing repeated visits. It excludes the current visit; the current phase appears
only if visited earlier. It is absent before any phase completes and on older Stim versions.
`cleanup` covers the pressure ladder a run waits for under the disk hard
floor, and restores the interrupted phase on success. It has no learned
duration. Raw elapsed time and history include cleanup; estimates and progress
comparisons exclude it and pause while cleanup is current.
`expectedMs` and `expectedPhaseMs` are
medians of this project's last successful runs with that outcome, and `basis`
counts the runs behind `expectedMs`. Both are `null` until the project has such
a run. `plannedPhases` lists, in order, the phases at least half of those runs
entered, each as `{ phase, expectedMs }` with its median, so a progress bar can
be drawn before the run reaches them; it is `null` without such runs.

The run estimates twice: when it starts, and once its outcome is known. The
second estimate uses only runs that created, adopted or cold-booted their
device the way this run did, so a new worktree is not estimated from reruns
that reused a booted device. Runs recorded before Stim tagged them also count
for a run that reuses its device until three tagged ones exist. An Exact app's iOS
build says whether its `target/` already held simulator output for its
configuration; its estimate then uses only runs of the same kind, so a first
build is not estimated from incremental ones. Runs that finish while this one is running do not change its estimate.

Once the run knows why its cache lookup missed, `build` carries `missReason`,
in the shape of `lastBuilds.<platform>.missReason` below. When prebuild or
pod install will run, the miss is that of the key looked up first and
`build.missProvisional` is `true` until the run looks the key up again after
them, because they can change the fingerprint. A hit then removes `missReason` and
sets `outcome` to `hit`; a miss replaces it with the final reason. Once the native
build tool prints a line Stim reads, `build` also carries `detail` while the
run is in `compile`:
`{ step, unit, done, total, line, updatedAt }`. `step` is the tool's step:
`configure`, `compile`, `link`, `resources`, `script`, `dex`, `package` or
`sign`. For xcodebuild, `unit` is `targets`, `done` counts the targets it
finished and `total` the targets in its dependency graph. A target counts once
xcodebuild touches or signs its product, so an incremental build can end below
`total`. For Gradle,
`unit` is `tasks`, `done` counts the tasks it reported and `total` is `null`.
For SwiftPM (`stim macos`), `unit` is `steps`, and `done` and `total` are the
`[done / total]` of its latest progress line; `total` can grow while SwiftPM plans the build.
`line` is the latest compile, link or task line with paths shortened to file
names. These are counts, not a completion percentage: one target can take ten
minutes and a cached one no time at all.

During `device` and `launch`, once Stim observes what the run waits on, `build`
carries `activity`: `{ name, startedAt, percent? }`. `name` is `booting` while
`device` waits for the owned simulator or emulator the run is booting. During
`launch` it is `bundling` from the app's bundle request to this workspace's
Metro until Metro delivers it, and `waiting-ready` while the app reports its
readiness pending; `activity` is absent in between. `startedAt` is when that evidence was recorded. `percent`
is Metro's own progress for that bundle request, present only once Metro
reports one. Plain `stim status` shows it after the phase, as in
`build: ios launch (bundling JS 45%, 12s), 58s elapsed`. `activity` does not
change the run's `launched` result.

`build.placement` says where the build runs: `"local"`, or, while it is
offloaded to a [remote machine](./settings.md#machine-settings), an object with
the machine and its step there. `phase` is `sync`, `deps`, `prebuild`,
`pods`, `build` (xcodebuild or Gradle) or `fetch`; `startedAt` is when the offload
started and `phaseStartedAt` when that step did. Meanwhile `build.phase`
follows it as `prebuild`, `pods` or `compile`.

```json
"placement": {
  "host": "janics-mac-mini",
  "phase": "build",
  "startedAt": "2026-09-28T21:40:02.118Z",
  "phaseStartedAt": "2026-09-28T21:40:09.530Z"
}
```

`build.waitingOn` is present while `build.phase` is `wait`: another workspace
is already building the same artifact, and this run waits for it instead of
building. `waitingOn.path` is that workspace's root, usually the `path` of another entry
in `environments`; the build lock is machine-wide, so it can name a workspace
that is not listed. It is absent when the holder is not known.

Plain `status` adds the machine to the build line:

```text
  build: ios compile on janics-mac-mini (build, 2m10s), 3m05s elapsed
```

Each workspace also shows its last build per platform:

```text
  last build: ios local cache in 12s, android compiled in 7m02s
```

In `--json`, every environment carries `platforms: string[]`, ordered
`ios`, `android`, `macos`, `web`, with `[]` when no platform is detected.
Expo uses an explicit `platforms` list from `app.json` or a literal array in
`app.config.js/ts/cjs/mjs`; otherwise it defaults to iOS and Android, adding web
when `react-native-web` is declared or resolves. Bare apps use `.xcodeproj` or
`.xcworkspace` entries in `ios/`, or in the directory `ios.projectPath` names,
and Gradle project files in `android/`.
`web.url` adds web to any app, even when Expo has an explicit platform list; a
bare app has no other route to web. macOS needs `Package.swift`,
`macos.product` and `macos.infoPlist`. Detection never runs project scripts or
executes app config code.

Each environment also carries `devServer: boolean`: `true` when the app has a
dev server that `stim start` and `stim reload` act on (React Native and Expo),
`false` for Exact, native Xcode and Gradle apps, SwiftPM and web-only apps, and
for a folder inside another project. An unreadable `package.json` keeps it `true`. Stim
Desktop gives a workspace without one Stop and Show Logs instead of Start Dev
Server and Reload, and no Metro section.

In `--json`, an environment with a recorded run carries
`lastBuilds: { ios?, android? }`, each
`{ platform, status, cacheHit, cacheSkipped, durationMs, fingerprint, startedAt, finishedAt, errorCode?, missReason?, buildMachine?, builtOn?, offloadedTo?, offloadFallback?, diagnostics? }`.
`status` is `ok` or `failed`, and `cacheHit` is `local`, `remote`, or `false`
when the run compiled or failed before finding an app. `buildMachine` records the
selected `auto`, `local`, or machine name. `builtOn` records `here` or the worker
name when a build ran; it is absent on a cache hit or a refusal before building.
Invalid, unlisted or unpaired selections refuse at setup without a build record.
`offloadedTo` names the
remote machine that compiled the app; `offloadFallback` is why a run that
considered offloading built here instead, such as
`janics-mac-mini: busy (load at or above 2/core; load 8.2/core, 2 builds)`. A failed run whose
compiler reported errors carries `diagnostics`: up to five
`{ file, line, column, message }`, with `null` for a position the compiler
did not give. Every failed run carries `cause: { key, file, line }`: its first
diagnostic with a file and a line, keyed `<file>:<line>`, else its `errorCode`
(or `failed`). Failed runs in a row with the same `key` failed the same way.

A run that did not install a cached app (it compiled, or failed before finding
one) carries `missReason`: why the cache had no app for it.

```json
{
  "kind": "changed",
  "summary": "native dependency added: expo-clipboard",
  "changes": [
    {
      "source": "node_modules/expo-clipboard/ios",
      "change": "added",
      "category": "native-dependency"
    },
    {
      "source": "expoAutolinkingConfig:ios",
      "change": "changed",
      "category": "autolinking"
    }
  ],
  "changeCount": 2,
  "baseline": { "fingerprint": "5f9c79...", "from": "workspace" },
  "rekeyedBy": []
}
```

`kind` is `changed`, `no-baseline`, `same-sources`, `cache-skipped`, or
`fingerprint-error`. `changes` lists at most 20 of the `changeCount` changed
fingerprint sources. `baseline` is the cached build Stim compared with: this
workspace's last build of the platform, or else the newest build of the same
project in another worktree. `rekeyedBy` names `prebuild` or `pod install`
when those steps moved the cache key. The build prints the same summary on
stderr as `cache miss: <summary>`. To predict the next
build instead, use [`--plan`](#predict-the-next-build).

The same environment also carries `builds: { ios?, android? }`, each
platform's last 10 runs, newest first. Each entry has the fields of
`lastBuilds` plus `{ result, slot, configuration, cacheKey, phases }`.
`result` is `succeeded`, `failed`, `cancelled` (Stim stopped the run after an
interrupt or `stim stop`), or `interrupted`: the run's process ended without
recording a result, such as after a kill or a second interrupt, so the next run in the workspace recorded it without a duration or
cache facts. `configuration` is the iOS configuration or Android variant the run built
(`Debug` or `debug` by default), and
`phases` gives the milliseconds the run spent in each build phase it entered,
such as `pods`, `compile` and `install`. Only runs that record a last build are
listed: a run that stopped before looking up a build, such as one with a bad
flag, is not. A run that builds or reuses an app and then fails at
the device, install or launch step is listed with `failed` and its error code.

Each booted simulator and detected emulator also shows who is using it:

```text
  ios [duo]: stim-app-duo (iPhone Duo 27.1) booted (owned) -- driven by agent-device for 12m
  android: stim-app (emulator) detected (emulator-5554) (owned) -- idle 3h
```

In `--json`, those devices carry
`activity: { state, driver?, lastActivityAt?, basis, unknown? }`, where `unknown` lists the checks a `driven` device could not read. `state` is `driven`
when a tool holds the device now, `active` when it had activity in the last 10
minutes, `idle` otherwise, and `unknown` when a claim or driver check could not
be read. Stim counts as drivers a live agent-device session (its recorded
processes must still be alive with their recorded start times, so a stale or
reused pid does not count), an unexpired `stim device lock`, a host process
that names the device (Argent, xcodebuild test runners, idb, Maestro, Appium,
`simctl io|spawn`, except the screenshots stim-server itself takes of the device), and on Android a `uiautomator`, `androidx.test` or Argent
helper process.
An agent-device session whose last command is dated no longer keeps its device once it is idle: under disk pressure and when the daemon reclaims a device for a waiting run, it holds for 10 minutes after that command instead of the 2 minutes of other workspaces, and a session whose last command cannot be dated keeps it.
`lastActivityAt` is the newest of the device's app log records, changes to the
workspace's `client.ndjson` and `device.ndjson` logs, the platform's Metro
bundle requests, the workspace's last Stim run, and, while agent-device
drives the device, the agent's last recorded action, rounded down to the
minute; `recent` gives the newest time of each of those kinds of evidence, so a
reader can tell agent actions and reloads from app log records. Stim reads
agent-device state without changing it. `stim guide facts status` lists every
field.

An owned booted simulator or detected emulator also reports whether the
workspace's app is running on it now:

```text
  ios: stim-app (iPhone 18 Pro 27.0) booted (owned) -- idle 3h -- com.example.app not running
```

In `--json`, those devices carry `app: { id, state }`. `id` is the bundle
identifier or package Stim checked, and `state` is `running`, `stopped` (the
app crashed, was killed, or never launched), or `unknown` when the process list
or the app's `Info.plist` could not be read. `app` is absent when the device is
not owned or Stim knows no app id for it. Each of those device records also
carries `appPresence`: `none` when the device runs, its platform's latest run
failed and `builds` carries the platform with no succeeded run, `closed` when it runs and the app is
`stopped`, else `null`. This is the app's current process state, not a record of
the last launch. Stim reads it from one host `ps` for every simulator and the
same `adb shell ps` it reads for activity, so `status --watch` notices an app
that exits within 30 seconds. Run `stim ios` or `stim android` to launch it
again.

Try it with an agent:

```text
Run `stim ios` in this worktree. While it builds, follow
`stim status --watch --json` and tell me each phase change and the time left for
this workspace.
```

## `stats`

```text
stim stats [--json]
```

Shows how many `ios` and `android` runs this project and this machine have
recorded, how many hit the build cache, the mean cold run and hit run, and an
estimate of the time the cache saved. The aggregates are kept in
`$STIM_HOME/stats.json`, and every worktree of a repository counts into the
same project bucket. The same file keeps the last 10 successful runs per
project, platform and cache outcome (and the last 10 that created, adopted or
cold-booted their device), with their phase durations, for the
estimates `stim status` shows; `stats` does not print them. An iOS run whose
build skips the artifact cache (an Exact app's, or one the cache cannot key)
keeps only that sample, an Exact app's tagged as a first or incremental build,
and counts in none of the aggregates; such an Android run is not recorded. Outside a project only the
machine section prints. There is no reset flag: delete that file to start over.

`--json` prints one line:

```json
{
  "version": 1,
  "project": { "key": "/path/to/app", "ios": {}, "android": null },
  "machine": { "ios": {}, "android": null },
  "offload": {
    "today": { "here": 3, "offloaded": 0, "fellBack": 0 },
    "machines": {},
    "placements": []
  }
}
```

`project` is `null` outside a project, and a platform with no run yet is
`null`. A bucket carries `runs`, `failed`, `hits`, `misses`, `coldRuns`,
`coldRunMs`, `hitRuns`, `hitRunMs`, `timeSavedMs`, `firstRunAt` and
`lastRunAt`, plus `lastColdBuildMs` and `lastPodsMs` once the project has
compiled or installed pods; those two size the progress line a long build
prints (`build       still compiling (1m00s of ~3m10s)`). The saved figure is
an estimate: each cache hit is credited this project's mean cold run at that
moment, minus its own duration, floored at zero. These comparisons exclude
cleanup. Raw run totals remain unchanged; optional `coldCleanupMs`,
`hitCleanupMs` and `offloadedCleanupMs` carry the cleanup within each total.

Every run that compiles also records its placement: where it built (`here`,
`offloaded`, or `fell-back` when it tried a machine and built here), the
reason the run printed on its `placement:` line, the build time and this
project's last cold build here to compare it with. The `placements` list under
`offload` in the stats payload holds the last 100 from the last 7 days, newest
first, and its `machines` map gives each
remote machine's offloaded builds, offloaded time, estimated time saved and
fallbacks, for today (this machine's calendar day) and in total. The plain output
adds a `build placement` section with the same counts and the last 5
placements. Placements include `slotWaitMs` and `deviceSlotWaitMs` as whole milliseconds waiting for build and owned-device slots, omitted when zero. `stim guide facts stats` has every field.

Owned-device waits print the count, holder workspace names and elapsed time
at once and about every 10 seconds on stderr. Status JSON includes optional
`build.waitingFor: { kind: "build-slot" | "device-slot", inUse, max, since, position, resource }`
without changing the build phase. Overlapping waits show the one that started
first, then the remaining wait.

The optional top-level JSON `capacityWaits` lists each owned-device slot wait:
`{ at, kind: "device-wait", platform, ms, max, workspace }`. `ms` is whole
elapsed milliseconds, including waits that time out or fail. The list keeps
the last 50 events from 7 days, newest first, and is omitted when empty.
Recording is best effort.

The optional top-level JSON `capacityRefusals` lists the last 50 device
refusals from the last 7 days, newest first, and is omitted when empty. Each
entry carries `at` (ISO timestamp), `kind: "device"`, `platform` (`ios` or
`android`), `max` (the cap of the limit that was full: `concurrency.maxDevices`, or the platform's `concurrency.maxIosDevices` or `concurrency.maxAndroidDevices`), and `workspace` (the workspace
id used by status and Desktop). Only `STIM_AT_CAPACITY` device refusals are
recorded; build caps wait. Recording is best effort and does not change the
refusal or the plain stats output. Desktop uses events within 6 hours for
its device-limit suggestion, including runs from an agent's terminal.

The top-level JSON `agentDevice` reports agent-device disk usage: `version: 1`,
`measuredAt`, total known `bytes`, `complete`, `stateDir`, `runnerBuilds`,
`workspaces`, and `hosted`. Unknown byte fields are `null`. Runner entries
include last use, agent-device and Xcode versions, and lease/lock/unreadable
in-use flags. Plain output adds an `agent-device` block when state exists.
`$STIM_HOME/agent-device-usage.json` caches the result for 10 minutes when roots
match. Only `stats` and `gc --dry-run` measure it; server and phone stats read
the cache. Stim never trims or deletes the shared runner builds, sessions, logs and other state or the hosted driver dir; a workspace's own agent-device dir goes only with its workspace.

The top-level `swiftpmCache` reports the user-level SwiftPM cache with
`version: 1`, `measuredAt`, `dir`, `present`, `bytes`, and `complete`, or `null`
before a cached measurement exists. The directory is
`~/Library/Caches/org.swift.swiftpm` on macOS, or `org.swift.swiftpm` under
`XDG_CACHE_HOME` (default `~/.cache`) elsewhere. Missing directories have
`present: false`, `bytes: 0`; failed measurements have `bytes: null`,
`complete: false`. Plain output adds a **SwiftPM cache** block after agent-device
only when present. This cache is shared by every SwiftPM build on the machine;
Stim reports it, and only gc's last rung removes it, at critical. `$STIM_HOME/swiftpm-cache-usage.json`
caches `du -sk` measurements for 10 minutes, keyed on the resolved directory,
with a 20-second timeout. Only `stats` and `gc --dry-run` measure it; server and
phone stats read the cache. `status`, `start`, `ios`, `android` and the
pressure ladder never measure it.

Try it with an agent:

```text
Run `stim stats --json` and tell me whether any build was offloaded to a build
machine today, and why each of the last few builds stayed on this machine.
```

## `worktree warm`

```text
stim worktree warm [--refresh]
```

Copies missing ignored entries from the repository's source checkout into the
current linked worktree. It accepts a current subdirectory. The source checkout
must be available in the same Git repository; running warm in the source
checkout refuses.

`--refresh` updates the source checkout before the copy: it checks the upstream, fetches changes when needed,
fast-forwards whatever branch is checked out there, and installs dependencies or
Pods when the new commits moved a lockfile (or `patches/` in an npm project), when nothing is installed, or when
`ios/Pods` does not match `ios/Podfile.lock`. See
[worktree isolation](./worktrees.md#refresh-the-source-checkout-first).

The branch, tracked files, and existing destination entries stay untouched.
Existing directories, including `node_modules`, are skipped whole. Eligible
ignored `.env` and local configuration files are included. The source
checkout's nonempty `.worktreeexclude` replaces its resolved `worktree.exclude`
setting. See [worktree isolation](./worktrees.md) for exclusions.

Wait for warm to finish before any other process writes to the destination.
Concurrent writes are unsafe: files created after the initial existence check
can be overwritten or removed. This includes edits, installs, builds, Metro,
and another warm invocation.

stdout stays empty. stderr reports copied, kept, and failed entries. Failures
exit 1; inspect failed paths before retrying, since partially copied
entries remain and existing directories are skipped. Warm does not install
dependencies or build. It prints the install command when carried
`node_modules` or `Pods` do not match this worktree's lockfiles.

## `worktree remove`

```text
stim worktree remove [target] [--force]
```

Reclaims the target environment, build output, port, and owned device. It then
removes any linked worktree when safe, warmed or not, without requiring a
Stim registry entry. Git-created branches stay. An existing Stim ownership
record permits deleting a branch only when it has no unique commits. On the
source checkout it only reclaims the environment: from the checkout root, every
registered project under it; from a subfolder, only the project at or above that
folder (with the projects nested under it), and it refuses when none is registered
there. A linked worktree is removed only from its root, or when you pass its root
path; from a subfolder it reclaims only that project and leaves the tree. A bare
repository directory is refused because it is not a worktree. `--force` permits removal
with uncommitted, untracked, or unpushed work or initialized submodules. A
worktree locked with `git worktree lock` is refused until you unlock it.

Removal restores a modified `ios/Podfile.lock` itself only when
`Pods/Manifest.lock`, the copy `pod install` makes, holds the same text, or when
gc deleted `Pods` while they matched and the lock has not changed since. A
deliberate `pod update` followed by an install leaves the same evidence, so
commit it before removing. Any other change to the lock, and every change to
`project.pbxproj`, is treated as your edit and refused like any uncommitted
change. A tracked file marked `assume-unchanged`, or `skip-worktree` with the
file on disk, hides edits from `git status`, so removal refuses and names it
with the `git update-index` command that shows it, until you pass `--force`.
Files a sparse checkout leaves out are not on disk and do not count.

## `gc`

```text
stim gc [--dry-run] [--pressure <normal|high|critical>] [--json]
```

`stim gc` runs one automatic maintenance pass now, at the pressure level the
machine measures, and deletes. `stim gc --dry-run` reports what that run would
delete and deletes nothing. `stim gc --pressure <level>` runs at that level
instead of the measured one; add `--dry-run` to preview it. `gc` cannot pick a
single cache, archive, worktree or age. Preview with `--dry-run`, then run
`stim gc` when you want the space back. The summary and `--json` also list
discovered checkouts, ones no stim command ran in, with what each would lose
([worktrees](./worktrees.md#checkouts-stim-never-ran-in)).

What each level deletes. A level includes the ones below it.

- **normal** (every level runs this): the automatic maintenance plan. Workspace
  build outputs and shared caches over their caps, the age sweep
  (`maintenance.olderThanDays`), orphaned workspace directories (including a
  directory with no `workspace.json` that holds only logs or lock files left by
  a removed workspace), registry entries and owned devices of removed projects,
  stale records (the device ledger, the EAS ledger, gone Stim homes, dead build
  locks and slots, empty process locks, stale status caches, expired device
  leases), archives past retention, workspace logs over 8 MiB, parked hosted
  devices, orphaned EAS sessions of the current project when it has an Expo
  config file, unused iOS
  simulator runtimes, and finished (merged, or pull request merged or closed)
  linked worktrees once `gc.worktreeGraceMinutes` have passed. It also reduces
  every workspace with no activity for `idle.dormantDays` (1 by default) to its
  minimal size: its regenerable build outputs, its owned simulators and
  emulators (the parked pool stays), its logs archived and, for a linked
  worktree, its `node_modules` and `ios/Pods`.
- **high**: also the [pressure ladder](./build-caches.md#disk-pressure) at high,
  to its end. Idle dev servers and their build outputs (the idle stage), parked
  devices until the level clears, Build and Metro caches trimmed to half their
  caps, the dormant stage for workspaces idle 10 minutes, the `node_modules` and
  `Pods` of linked worktrees idle 1 hour that `stim worktree warm` can
  restore, idle Gradle and Kotlin daemons, unpinned Gradle versions unmodified
  for `maintenance.gradleVersionIdleDays`, TMPDIR leftovers, the worktree trash,
  and clean finished worktrees once `gc.worktreeGraceMinutes` have passed, while
  `maintenance.removeFinishedWorktrees` is true. It never cleans other tools'
  caches at high.
- **critical**: also every parked device, every shared cache Stim registered
  emptied whole (the compilation cache, ccache, the build cache except entries
  in use, Metro, the macOS artifact cache, and the React Native and Android
  caches), the fingerprint index and memo, the dormant stage and `node_modules`
  and `Pods` for workspaces idle 2 minutes, every unpinned Gradle version, clean
  finished worktrees without the grace period and clean pushed worktrees no Stim
  command used for 7 days (the first only while `maintenance.removeFinishedWorktrees`
  is true, the second only while `maintenance.removeIdleWorktrees` is true),
  every device recording not being written (except those of workspaces pinned
  with `maintenance.keep` or in use), archived logs, recordings and agent
  actions, and, for `stim gc` with `--pressure critical` or a measured critical
  that still leaves the disk under the critical level after the earlier rungs,
  other tools' caches. Worktree archives and archive records stay.

`gc` never touches anything building, driven, leased, hosted or pinned by
`maintenance.keep`, source, tracked or unignored files, uncommitted or unpushed
work, or a simulator or emulator you created. Of what Stim does not own, it
cleans only what the table lists, through the tool's own command. It only
reports Android NDKs, Android system images no AVD uses and `~/.cache/exact`,
with the command that removes each. Other DerivedData is never deleted; the
SwiftPM cache goes only with rung 9, at critical. Caches whose loss slows the
next build (an Exact app's `target/`, `node_modules` and Pods, DerivedData
outputs, shared compile caches) go only for an idle workspace or at critical.
The ladder runs whatever `daemon.mode` says and covers every registered
workspace, including the one you run `gc` from: at high its dev server stops and
its devices shut down after 2 idle minutes, its owned devices are deleted after
10, and a linked worktree's `node_modules` and Pods after an hour. A workspace whose `idle.minutes` is `0` stays out
of the idle and dormant stages. `stim revive` resumes an idle workspace; the
next `stim ios` or `stim android` creates the devices of a dormant one. Sizes in
a dry run are apparent sizes, while a run reports how much free disk actually
rose, so files APFS shares with a clone, such as `node_modules` a warm copied,
can free 0K.

A workspace reduced to its minimal size restores what it lost on the next Stim
command in it: `stim worktree warm` puts back `node_modules` and `ios/Pods`. When
warm cannot restore the same versions (the worktree's lockfile differs from the
source checkout's, or the source checkout's dependencies were not installed from
its own lockfile), the command refuses with `STIM_DEPS_FAILED` and asks for an
install. A source (main) checkout's `node_modules` and `ios/Pods` are deleted only
after every linked worktree's: once it has had no activity for
`idle.sourceDormantDays` (7 by default; `0` never; activity is a Stim command, a source file write, a
git write or a commit in the checkout or any workspace in it, registered or not,
and a `worktree warm` copying from it, which also keeps it while it runs, when the warmed app has a Stim workspace in the source) at any level, or at critical when the disk is still
under the critical level, which `stim gc --pressure critical` always does. Then
`stim worktree warm` and `stim status` say the source has no installed
dependencies to copy, and since when, until you install them there. `gc` deletes
only git-ignored regenerable directories: a real directory inside the checkout
whose files git ignores, with no tracked or unignored file, not reached through a
link. A tree under 256 MB of its own (a copy-on-write clone) is kept.

Automatic maintenance and `stim gc` never delete a `node_modules` or
`ios/Pods` folder in which they detect hand edits, at any pressure level,
critical included, so its disk is not freed; `gc --dry-run`, `stim status` and
`stim doctor` name the edited files. Automatic removal of a finished or
discovered worktree waits while one of its dependency folders has edits.
`stim worktree remove` runs no check. Detection is best effort, from file
times: a file modified after the install (when an install, `pod install` or
`stim worktree warm` that Stim ran there finished, or else the package
manager's stamp) is an edit, except in a 10-minute window after the stamp when
the root `package.json` declares an install script. Not checked:
dot-directories at the `node_modules` root other than `.pnpm`, `.bun`, `.deno`
and `.bin` (tool caches such as `.cache` and `.vite`, a custom pnpm
virtual-store directory included), Gradle, CMake and Xcode output, and the
package manager's state files. Known misses: an edit that keeps an older
modification time (`cp -p`, `rsync -t`, a tar extract), a file deleted by
hand, an edit inside an install window, and an edit to a package whose
`package.json` an editor replaced. An edit in `node_modules` is never durable:
make it a patch with `pnpm patch`, `yarn patch` or `patch-package`, or
reinstall to let maintenance free the folder.

Everything `gc` deletes, by category (N normal, H high, C critical):

| Category                                                                                                                                                                                                                                        | Pass or rung               | Level                 | Kept when                                                                                                                                                                                                                                                                                                                                                                                        |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------- | --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Workspace build outputs and shared caches over their caps                                                                                                                                                                                       | maintenance caps           | N                     | in use, pinned (`maintenance.keep`), running build                                                                                                                                                                                                                                                                                                                                               |
| What the age sweep removes after `maintenance.olderThanDays` (parked devices, outputs, idle worktrees opt-in)                                                                                                                                   | maintenance sweep          | N                     | recently used, pinned                                                                                                                                                                                                                                                                                                                                                                            |
| Unused iOS simulator runtimes (`xcrun simctl runtime delete <id>`)                                                                                                                                                                              | maintenance sweep          | N                     | any simulator uses it, simctl does not mark it deletable, only runtime, newest when none is used, a project's `ios.runtime` pins it, same major version as the active Xcode's simulator SDK, `lastUsedAt` within `maintenance.olderThanDays` or absent; unreadable SDK version, unreachable project path or unparsable `.stim.json` (reported under Needs a person); scoped home; listing failed |
| Owned simulators whose runtime is gone                                                                                                                                                                                                          | maintenance sweep          | N                     | not in this home's ledger (never a user simulator; Stim never runs `simctl delete unavailable`)                                                                                                                                                                                                                                                                                                  |
| Registry entries, workspace dirs, owned devices and records of removed projects; stale ledger entries, gone homes, stale build claims, expired leases, status caches                                                                            | maintenance prune          | N                     | path absence cannot be proven, holder alive                                                                                                                                                                                                                                                                                                                                                      |
| Workspace logs over their cap; recordings and archives past retention; parked hosted devices; orphaned EAS sessions of the cwd project                                                                                                          | maintenance prune          | N                     | live session, live recording                                                                                                                                                                                                                                                                                                                                                                     |
| Finished linked worktrees (branch merged, PR merged or closed, or no commits of their own), after `gc.worktreeGraceMinutes`                                                                                                                     | maintenance worktree check | N                     | uncommitted (archived first) or unpushed work, in use, leased, locked, pinned, cannot prove finished                                                                                                                                                                                                                                                                                             |
| Workspace idle `idle.dormantDays`: build outputs (`android/build`, `android/.gradle`, `.build`, `.cxx`, `.dd` DerivedData, Exact `target/`), owned devices, logs archived                                                                       | dormant reduction          | N                     | running dev server or build, booted device, leased, driven, locked, hosted, pinned, `idle.minutes` 0                                                                                                                                                                                                                                                                                             |
| The same: `node_modules` and `ios/Pods` of a linked worktree                                                                                                                                                                                    | dormant reduction          | N                     | source checkout, under 256 MB of its own (copy-on-write clone), in use, a running process inside, pinned                                                                                                                                                                                                                                                                                         |
| Idle dev servers and their outputs (idle 2 min)                                                                                                                                                                                                 | idle stage, rung 1         | H                     | as above                                                                                                                                                                                                                                                                                                                                                                                         |
| Parked devices                                                                                                                                                                                                                                  | rung 2                     | H until clear, C all  | -                                                                                                                                                                                                                                                                                                                                                                                                |
| Shared caches trimmed to half their caps; at C emptied, with the fingerprint index and memo                                                                                                                                                     | rung 3                     | H / C                 | entries a running build protects, report-only caches                                                                                                                                                                                                                                                                                                                                             |
| Dormant stage at 10 min (H) or 2 min (C)                                                                                                                                                                                                        | rung 4                     | H                     | as the dormant reduction                                                                                                                                                                                                                                                                                                                                                                         |
| `node_modules` and Pods of linked worktrees idle 1 hour (H) or 2 min (C)                                                                                                                                                                        | rung 5                     | H                     | `worktree warm` cannot restore the same versions, copy-on-write clone, in use, pinned                                                                                                                                                                                                                                                                                                            |
| Idle Gradle and Kotlin daemons, unused watchman, unpinned Gradle versions (C: all unpinned), TMPDIR leftovers, worktree trash                                                                                                                   | rung 6                     | H                     | build running, a project pins it, modified within 24 h                                                                                                                                                                                                                                                                                                                                           |
| Clean finished worktrees after the grace period (H) or without it (C); clean pushed worktrees idle 7 days (C, `maintenance.removeIdleWorktrees`)                                                                                                | rung 7                     | H / C                 | `maintenance.removeFinishedWorktrees` false, dirty, unpushed, in use, leased, locked, pinned                                                                                                                                                                                                                                                                                                     |
| At C first the `node_modules` and Pods of source (main) checkouts idle 2 min, after every worktree's, on a volume still under the critical level; then every device recording not being written and archived logs, recordings and agent actions | rung 8                     | C                     | live segment; recordings of workspaces pinned with `maintenance.keep` or in use; worktree archives and archive records stay                                                                                                                                                                                                                                                                      |
| npm (`npm cache clean --force`), Yarn (`yarn cache clean`), pnpm (`pnpm store prune`), CocoaPods (`pod cache clean --all`), Gradle `modules-2`, `transforms-N`, `build-cache-N`, the SwiftPM cache                                              | rung 9                     | C, per the rule below | tool not installed, a process of that tool runs, processes cannot be listed, its volume is not under the critical level (unless `--pressure critical`). Gradle and SwiftPM have no command, so Stim removes those directories only while no such build and no Stim build runs                                                                                                                    |
| Android NDKs (`sdkmanager --uninstall "ndk;<version>"`), Android system images no AVD uses, `~/.cache/exact`                                                                                                                                    | rung 9                     | report only           | never deleted; the command is printed                                                                                                                                                                                                                                                                                                                                                            |

Each rung-9 cache is listed with its size before and after. Rung 9 never runs at
high, in a `STIM_HOME`-scoped home, or in the in-process ladder a build command
runs at `disk.hardFloorGb`; only the stim-daemon and `stim gc` run it. The daemon
runs it at most hourly, while the disk is still short. `stim gc` with no
`--pressure` that measures critical measures free disk again after the earlier
rungs and runs rung 9 only if the disk is still under the critical level. An
explicit `stim gc --pressure critical` is the free-everything run and always runs
it. Stim finds the npm cache (`npm_config_cache` or `NPM_CONFIG_CACHE`, else
`~/.npm`), the Yarn cache (`YARN_CACHE_FOLDER` or the platform default) and the
pnpm store (`PNPM_HOME/store` or the platform default) by path, so no package
manager runs on a dry run; only an acting run executes the clean commands, with
`COREPACK_ENABLE_NETWORK=0`. Gradle and SwiftPM directories are removed only
while no Stim build lock or build slot is live or unresolved and no matching tool
process runs, by renaming the directory aside to a `.stim-delete-*` sibling on
the same volume and deleting it. A later run finds and finishes a leftover in
Gradle's `caches/` or the SwiftPM cache's parent and measures it; a removal that
fails after the rename is reported as failed with the bytes still left aside. A
cache directory that is itself a symbolic link is kept, with a remedy to remove
its target yourself. The Gradle build cache is report-only as a registered cache at
every level.

A dry run runs no `git fetch` and no `gh`: it judges merges from the refs already
on disk and the pull request cache that `stim status --watch` and the
maintenance worktree check write, and shows a verdict that fresher state could
change as not refreshed. An acting run fetches and asks GitHub first. See
[removing finished worktrees in bulk](./worktrees.md#remove-finished-worktrees-in-bulk)
for how gc decides that a branch is merged.

Plain output is short: one level line, one summary line (freed, or would free),
the totals per category with the 3 largest items each, a "Needs a person:" block
listing every failure, every reason the run could not decide and every cache Stim
only reports with its command, a "Where the disk goes:" block (the largest things
Stim measured and can reclaim, and other tools' caches it kept, with their size),
and "Full detail, kept entries with their reasons included:
`$STIM_HOME/gc/last-report.txt`". That file has one line per action (outcome,
size, maintenance or rung, kind, target, reasons) and each run overwrites it. A
dry run ends with `Apply with: stim gc`. An acting run also appends every
deletion to the machine cleanup log `$STIM_HOME/gc/gc.ndjson`, which
`stim logs --source gc` reads.

An acting `gc` takes the same exclusive maintenance claim as the stim-daemon's
maintenance pass. While one holds it the other refuses at once with
`STIM_CLAIM_REFUSED` naming the holder (pid, start, trigger); retry after it
ends. A dry run takes no claim. On a full disk `gc` gives back the 1 MB
`$STIM_HOME/maintenance/disk-reserve` before taking its claim, so it can start
at 0 bytes free, and writes it again when the run ends.

Single items cannot be deleted from the CLI. Stim Desktop deletes one cache, the
build outputs of idle workspaces, one archive or one part of it, watchman or the
Gradle daemons through stim-server's `desktop.gc.item.subscribe` on its
Unix-socket connection; the library API has
[`deleteGarbageItem`](./programmatic-api.md#doctor-and-gc-reports).

An orphaned device is one this Stim home created that no workspace references.
`gc` shows the size of an orphaned or stale owned device: for a simulator, the
data size `simctl` reports; for an AVD, the size of its directory. Other
devices whose names start with `stim-` appear under "Unrecognized stim-\*
devices" with the command that deletes them; `gc` never deletes them. It also
lists, under "Simulator launchd folders with no simulator", the
`/private/var/tmp/com.apple.CoreSimulator.SimDevice.<udid>` folders whose UDID
has no simulator in Xcode's device set, with their sizes, and never deletes
them either. See [owned devices](./owned-devices.md).

A workspace directory is orphaned when the project root its `workspace.json`
records is gone from a mounted volume and no registry entry names it. Deleting
a worktree with `git worktree remove` or `rm -rf` leaves one behind. A
directory without a readable `workspace.json` is reported and never deleted.
Nothing deletes a workspace that is in use: a running dev server, a `stim ios`
or `stim android` run, a live build, or a held tunnel or remote lock.

`stim status` caches each folder's size, each worktree's pull request and each
worktree's merge verdict under `$STIM_HOME/disk-usage`,
`$STIM_HOME/pull-requests` and `$STIM_HOME/git-merge`. `worktree remove` drops
the entries of the worktree it removes, but not the size entries of its owned
devices' data folders. `gc` lists the entries of a folder or
worktree that is gone from a mounted volume under "Stale status cache entries",
and `gc` removes them. An entry that records no readable path, or whose
volume is not mounted, is kept and counted under "Skipped".

`gc` also lists recognized leftovers directly in the user's `TMPDIR` under
"TMPDIR leftovers", with their count, size and a remedy: Stim temp directories
(`stim-claim-*`, `stim-host-*`, `stim-fakehome-*`, `stim-hosted-macos-*`,
`stim-server-*`, `stim-ws-*`, `stim-parity-*`), xctrace recordings (`instruments*.ktrace`),
SwiftPM temp directories (`TemporaryDirectory.*`, left by `swift` and `xcodebuild`) and
Jest's cache (`jest_<uid in base 36>`). `gc` at high or critical removes a Stim temp directory, recording or SwiftPM
temp directory only when nothing in it changed for 24 hours. It removes a `stim-parity-*` directory, with its git worktree registration, only when its Stim record names a process that has ended. It keeps a directory that contains or sits
inside a registered project, holds a live or unverifiable ownership claim or
a `.lock` directory with no claim set, or cannot be listed, and keeps a recording that
cannot be read, and keeps every recording while `xctrace` or Instruments runs and every
SwiftPM temp directory while a `swift` or `xcodebuild` process runs, or when the
process list cannot be read. Stim's own SwiftPM macOS builds run `swift` with the
ambient `TMPDIR`, because SwiftPM keeps the locks for its shared caches there, so
their temp directories land here too. Jest's cache is never deleted. gc never
follows a symlink or acts outside `TMPDIR`, and with `STIM_HOME` set it skips
them. The pressure ladder runs the same deletion daily and at
once under disk pressure.

`gc` lists each entry of `$STIM_HOME/trash` under "Worktree trash" with its
size and the worktree it came from: the ignored directories `worktree remove`
moved out of a worktree before git removed it. `gc` at high or critical deletes
an entry only when it is a `remove-*` directory with a valid `trash.json` written by
`worktree remove`, its ownership claim is free and the worktree it came from is
gone. It keeps one a removal or its background `rm` still holds, one whose
worktree still exists (a removal killed before git ran; run `stim worktree
remove` on it to finish), and any other directory under `trash`. A trash entry
that `worktree warm` wrote (its `trash.json` has `"kind": "warm"`) holds paths
removed from a copy of a live worktree, so `gc` deletes it once its claim
is free, whether or not the worktree exists. See [remove a worktree](./worktrees.md#remove-a-worktree).

`gc` clears the build outputs of a workspace over
`maintenance.workspaceOutputsMaxGb` or unused for `maintenance.olderThanDays`
that is not building and ran no `stim ios`, `stim android` or `stim macos` in the
last 15 minutes, even with its dev server running or its simulator booted:
`derived-data/`, `gradle-build/`, `android-cas/`,
`cache-provider/`, `js-swap-tmp/`, `macos/build`, staged `macos/<Product>.app`
and interrupted-build `macos/staging-*` directories, and the project's
git-ignored `android/app/build`, `android/build`, `android/.gradle`, `.build`,
`android/.cxx`, `android/<module>/.cxx`, `.dd` (a directory laid out as
Xcode DerivedData) and an Exact app's Cargo `target/`. At high or critical it
also clears them through the pressure ladder, for a workspace with nothing
running idle 2 minutes or more and in the idle stage of a running one. A running, building, unverified or hosted
macOS app keeps its workspace untouched. The workspace keeps its state, logs,
devices, ports, `macos/runtime.lock` and its claim set. See
[workspace build outputs](./build-caches.md#workspace-build-outputs).

`gc` reports the size of each workspace's logs. The Metro, client and device
logs rotate at about 8 MiB, but a file written by a Stim version before that cap
can be hundreds of MB. `gc` trims each of those files that is over 16 MiB
to its newest 8 MiB in every workspace that is not in use and has no device log collector recorded.
Build transcripts and other files under `logs/` are never trimmed.

The Memory section lists long-lived helpers that grow while they run: the
shared watchman daemon with its watched roots, Gradle daemons with their Gradle
version and Gradle home, and Kotlin compile daemons. Each shows its pid,
physical footprint, uptime and whether it is idle, and the section ends with
the memory that can be reclaimed. `gc` at high or critical runs the pressure
ladder with memory treated as under pressure, which stops an unused watchman of
1 GiB or more and the idle Gradle and Kotlin daemons:

- `stim gc` at high or critical removes the stale
  roots (a directory that is gone, or a linked worktree git pruned) that no
  subscription or trigger uses. They then shut watchman down only when no other
  client is connected, every root's subscriptions and triggers were readable
  and no root has a trigger; otherwise they keep the daemon and name each
  client, such as the Stim workspace whose Metro uses it. They report the
  shutdown only once the daemon's process has exited. Removing roots does not
  shrink watchman; only a restart does, and the next client that needs watchman
  starts it again and re-crawls its roots. Automatic maintenance applies the
  same check: the daily sweep and the memory-pressure ladder shut watchman down
  when it is over 2 GiB (over 1 GiB under memory pressure) and no Stim dev
  server started in the last minute.
- `stim gc` at high or critical stops each Gradle daemon that its
  own `gradle --status` reports idle, then each Kotlin compile daemon with no
  client connection once no Gradle daemon is busy. Nothing stops while a Stim
  Android build runs. While stim-server runs, it manages the daemons of builds
  offloaded to this machine, and gc leaves them alone.
- `stim gc` at high deletes the version caches
  (`caches/<version>`) and wrapper distributions (`wrapper/dists/gradle-<version>-*`)
  under `GRADLE_USER_HOME` for each Gradle version no registered project pins
  in the wrapper of its Android Gradle root or root, once unmodified for
  `maintenance.gradleVersionIdleDays` days (7; 0 keeps them); at critical it
  deletes every unpinned version. Nothing is deleted while
  a process that may be Gradle using this home runs: a Gradle main class, a
  Gradle wrapper or distribution jar, or a java process naming a path under
  the home (one is skipped only when it names no such path and every
  `gradle.user.home` or `-g` it names is an existing Gradle home elsewhere), while `ps` fails, while no Stim
  config exists, while a registered project is missing or its pin cannot be
  read, while a Gradle directory cannot be listed, or while `caches`,
  `wrapper` or `wrapper/dists` is a symlink or resolves outside the home. A
  version is also kept when one of its paths is not a plain directory inside
  the home, when an entry under it cannot be listed or stat'd, or when it holds more than
  500,000 entries. Right before removal gc checks processes and
  pins again, renames each directory to a `.stim-delete-*` sibling and deletes
  it; a later `gc` finishes a removal that
  failed, even while versions are blocked (not while the home is outside a
  scoped `STIM_HOME` or its layout is unsafe). `jdks` and the other shared
  Gradle caches are never deleted; `modules-2`, `transforms-N` and
  `build-cache-N` go only in rung 9.
  With `STIM_HOME` set, gc
  deletes nothing in a Gradle home outside that directory. Pressure ladder
  rung 6, daily, at once under disk pressure and in `gc` at high or critical,
  first stops the idle Gradle and Kotlin
  daemons, only when
  every Gradle process that keeps a version is such a daemon, and waits up to
  3 seconds for them to exit, then does the
  same for the versions (0 turns both off); a daemon that did not exit still keeps the versions.

Anything gc cannot prove idle is kept, with the reason. With `STIM_HOME` set,
gc skips these machine-global processes. `stim doctor` notes a watchman
footprint over 2 GiB.

`gc --dry-run` also reports agent-device state, including runner builds per
platform and entry, last use and versions, sessions, logs, other state,
workspace directories and stim-server hosted state. JSON `sections.agentDevice`
contains the same payload as `stats.agentDevice`; This state never appears under `caches` and
never changes `actionable`. Stim never trims or deletes the shared runner builds, sessions, logs and other state or the hosted driver dir; a workspace's own agent-device dir goes only with its workspace.
A lease flag means a live owner or runner matched by start time. A lock flag
means a live or unknown lock owner. Unreadable lock owners and unreadable or
unknown leases conservatively mark entries in use; dead lock owners and leases do not. Clear unused state with
agent-device's own tooling or by removing the directories yourself.

`gc --dry-run` reports the shared user-level SwiftPM cache after agent-device.
JSON `sections.swiftpmCache` carries the same payload as `stats.swiftpmCache`.
It never appears in `caches` or changes `actionable`. Only gc's last rung, 9,
removes it, at critical.

`gc --dry-run` also reports other tools' machine-wide caches with each size and
the owning tool's remedy, as JSON `sections.machineCaches`:

- Gradle version caches and wrapper dists for versions no registered project
  pins in the Gradle wrapper of its Android Gradle root (`android.gradleRoot`,
  default `android`, relative to the app and inside the repository; a custom
  root must hold `settings.gradle` and the module build script) or of its
  root, with `stim gc --pressure high` as the remedy, and the
  `modules-2` dependency cache. A registered project that is missing, whose
  settings cannot be resolved, or whose wrapper cannot be read or names no
  Gradle version is named, since it may still pin a listed version; every
  version a readable wrapper of it pins still counts as pinned. A directory gc
  cannot list adds a notice and marks the section incomplete. Each listed
  version's `caches/<version>/transforms` directory is also shown with its size,
  its private size on APFS (`privateBytes`) and the manual remedy `rm -rf <dir>`;
  Gradle extracts the transforms again on the next build.
- Xcode DerivedData directories under `~/Library/Developer/Xcode/DerivedData`
  whose `info.plist` `WorkspacePath` no longer exists on a mounted volume, as
  `orphanedDerivedData` with the size, the recorded workspace path and the
  remedy `rm -rf <dir>`. A directory without a readable absolute
  `WorkspacePath`, or whose path is on a volume that is not mounted, is not
  listed.
- iOS simulator runtimes with their simulator count. `gc` runs `xcrun simctl
runtime delete <id>` for a deletable runtime no simulator uses, at every
  level; the only installed runtime stays, as does every runtime a project's
  `ios.runtime` pins, with the major version of the active Xcode's simulator SDK,
  or used within the larger of `maintenance.olderThanDays` and 7 days (or with no use recorded by
  simctl). When the SDK version, a registered project's path or its `.stim.json`
  cannot be read, no runtime is deleted and the run says why under Needs a person. entries, which Xcode copies again when the device
  next connects.
- agent-device runner builds grouped by agent-device and Xcode version,
  compared with the installed ones. agent-device has no prune command, so
  the remedy is to remove an entry that is not in use.

The sizes, runtimes and tool versions are cached for 10 minutes. This section
never appears in `caches` or changes `actionable`. Stim deletes none of these
except the unused runtimes and the rung 9 caches above.

While it works, `gc` prints each slow step on stderr as it starts, such as
`daemons     watchman pid 49040: checking 12 roots`, so a long run shows what it
is waiting on. The report stays on stdout, and `--json` prints only its payload
there.

- `--dry-run` reports what the run would delete and deletes nothing.
- `--pressure <normal|high|critical>` runs at that level instead of the
  measured one. Any other value refuses with `STIM_BAD_ARG`.
- `--json` prints the report as one object on stdout and every other line on
  stderr. Agents use it to show you what `gc` would remove before they
  ask to run it.

On a hosting Mac, `stim gc --dry-run` also lists parked hosted iOS and Android
devices; `stim gc` deletes each through its session home's stop worker
under a session claim. Held claims and unverified ownership keep the device,
and an unreadable journal keeps all hosted devices. Android deletion also
requires the AVD to be visible from this shell's Android environment; otherwise
run gc with the server's `ANDROID_AVD_HOME`/`HOME`. Records no longer listed in
their session ledger are already removed, skipped and excluded from `actionable`.
JSON adds
`sections.parkedHostedDevices` entries with `session`, `client` (id), `platform`,
`id` (UDID or AVD name), `name`, `parkedAt`, and
`listed` (session-home ledger ownership, null when unreadable). Deletion results
use `kind: "parkedHostedDevice"`. The server clears the parked marker when it
reconciles the emptied ledger.

`stim gc --dry-run` also lists stale entries of the machine EAS session ledger
(`~/.stim/machine/eas/sessions.json`): entries whose id is not a UUID and whose
absolute workspace root is missing on a mounted volume, such as ids written by a
test fixture. A valid id, an existing root, or a root on an unmounted volume
keeps the entry. `stim gc` re-checks each entry and removes it under
the ledger lock without contacting EAS. JSON adds `sections.staleEasLedgerEntries`
entries with `id` and `workspaceRoot`.

`stim gc --dry-run` also lists the other Stim homes on the machine, such as the
scratch `STIM_HOME`s agents and tests create. Every home other than `~/.stim` that
creates a workspace or a device lists itself once in
`~/.stim/machine/homes/homes.json`, which ignores `STIM_HOME`, with its path, its
creation and last-seen times, and the simulators and emulators its created-devices
ledger names. Homes inside `~/.stim`, such as hosted session homes, are not listed.
For each listed home that still exists, gc reports its private size, workspace count,
last-seen time, devices and the exact teardown commands:
`STIM_HOME=<home> stim worktree remove` from the root of each linked worktree, or from the
project folder in a source checkout, then
`STIM_HOME=<home> stim gc`, then removing the directory. A home whose
directory is gone from a mounted volume is listed as gone, and any of its devices
still on the machine appear as orphaned from that home with the command that deletes
them. The section is report-only: those devices belong to the other home, and gc
never tears down another home. `stim gc` removes only the list entry of a
gone home that has no device left. A scoped `STIM_HOME` lists nothing. JSON adds
`sections.otherHomes` entries with `path`, `state`, `createdAt`, `lastSeenAt`,
`bytes`, `privateBytes`, `workspaces`, `devices`, `teardown` and `forgettable`.

`--json` prints one line. On a dry run, each key under `sections` is one section of
the storage report, in the same order, and is always present.
`stim gc --dry-run --json` prints, for example:

```json
{
  "mode": "dry-run",
  "level": "normal",
  "pressure": { "level": "normal" },
  "actionable": true,
  "failures": null,
  "actions": [],
  "blocked": [],
  "results": [],
  "sections": {
    "deadProjects": [{ "path": "/path/to/removed-app" }],
    "orphanedWorkspaces": [
      {
        "dir": "~/.stim/workspaces/old--1a2b",
        "projectRoot": "/path/to/old",
        "bytes": 52428800
      }
    ],
    "linkedWorktrees": [
      {
        "path": "/path/to/feature",
        "idleDays": 12,
        "mergedInto": null,
        "pullRequest": null,
        "pullRequestUnknown": null,
        "willRemove": true,
        "reason": null,
        "detail": "idle 12d",
        "eligibleAt": null,
        "buildState": { "bytes": 0, "dirs": [] }
      },
      {
        "path": "/path/to/shipped",
        "idleDays": 0,
        "mergedInto": "origin/main",
        "pullRequest": null,
        "pullRequestUnknown": null,
        "willRemove": true,
        "reason": null,
        "detail": "merged into origin/main",
        "eligibleAt": null,
        "buildState": { "bytes": 0, "dirs": [] }
      },
      {
        "path": "/path/to/just-merged",
        "idleDays": 0,
        "mergedInto": "origin/main",
        "pullRequest": null,
        "pullRequestUnknown": null,
        "willRemove": false,
        "reason": "recent-activity",
        "detail": "recent activity: merged into origin/main 12m ago; removable after 2026-09-25T15:48:00.000Z",
        "eligibleAt": "2026-09-25T15:48:00.000Z",
        "buildState": { "bytes": 0, "dirs": [] }
      },
      {
        "path": "/path/to/wip",
        "idleDays": 20,
        "mergedInto": null,
        "pullRequest": {
          "number": 123,
          "state": "merged",
          "url": "https://github.com/acme/app/pull/123",
          "containsHead": true
        },
        "pullRequestUnknown": null,
        "willRemove": false,
        "reason": "dirty",
        "detail": "dirty: 2 uncommitted or untracked files (notes.txt, wip.ts)",
        "eligibleAt": null,
        "buildState": {
          "bytes": 2147483648,
          "dirs": [
            {
              "path": "node_modules",
              "bytes": 1610612736,
              "privateBytes": 10485760
            },
            {
              "path": "ios/Pods",
              "bytes": 536870912,
              "privateBytes": 536870912
            }
          ]
        }
      }
    ],
    "unlistedWorktreeDirectories": [
      {
        "path": "/path/to/repo/.worktrees/lost",
        "repository": "/path/to/repo",
        "bytes": 847249408,
        "remedy": "rm -rf '/path/to/repo/.worktrees/lost'"
      }
    ],
    "workspaceLogs": [
      {
        "dir": "~/.stim/workspaces/old-feature--9e8f",
        "projectRoot": "/path/to/old-feature",
        "bytes": 778043392,
        "trimBytes": 761266176,
        "willTrim": true,
        "reason": null,
        "detail": null
      }
    ],
    "workspaceBuildOutputs": [
      {
        "dir": "~/.stim/workspaces/app--3c4d",
        "projectRoot": "/path/to/app",
        "bytes": 1073741824,
        "idleDays": 0,
        "willClear": false,
        "reason": "in-use",
        "detail": "in use: its dev server supervisor (pid 4242) is running"
      }
    ],
    "caches": [],
    "agentDevice": {
      "version": 1,
      "measuredAt": "2026-10-05T17:44:35.000Z",
      "bytes": 8192,
      "complete": true,
      "stateDir": {
        "dir": "/Users/example/.agent-device",
        "present": true,
        "bytes": 8192,
        "sessions": {
          "dir": "/Users/example/.agent-device/sessions",
          "bytes": 4096,
          "count": 1
        },
        "logs": { "dir": "/Users/example/.agent-device/logs", "bytes": 4096 },
        "other": { "bytes": 0, "largest": [] }
      },
      "runnerBuilds": {
        "dir": "/Users/example/.agent-device/apple-runner",
        "present": false,
        "bytes": 0,
        "sharedBytes": 0,
        "platforms": []
      },
      "workspaces": [],
      "hosted": null
    },
    "swiftpmCache": {
      "version": 1,
      "measuredAt": "2026-10-05T17:44:35.000Z",
      "dir": "/Users/example/Library/Caches/org.swift.swiftpm",
      "present": true,
      "bytes": 1048576,
      "complete": true
    }
  }
}
```

The example omits the empty sections, `machineCaches` and `inventory`, and
shortens `pressure`. `level` is the level the run used: `pressure.level`, the
level the machine measures, unless `--pressure` chose one. `actions` lists every
action the run would take or took, each
`{ rung, kind, target, workspace?, outcome, bytes, reason, detail, restore? }`.
`rung` is `null` for the maintenance plan and the ladder rung otherwise;
`outcome` is `"would"`, `"done"`, `"kept"` or `"failed"`; `bytes` is what it
would free or freed where gc could measure it. `blocked` lists what the run
could not decide or reach, each for a person to look at. `failures` is `null` on
a dry run and otherwise counts the actions that failed.
`memory` lists each helper process as
`{ kind, cacheKind, pid, startedAt, bytes, measure, version, gradleHome, offloadClient, state, reclaimable, reason, detail }`,
where `reclaimable` marks the ones `gc` would
stop, and `watchmanRoots` lists each root with its `stale` reason and whether
it is `removable`. `reason` is `null` for an entry a run
acts on and otherwise a stable code; `detail` is the text the report prints.
A linked worktree's `eligibleAt` is the time a `recent-activity` worktree
becomes removable, and otherwise `null`. `pullRequest` is the pull request of
the worktree's branch whose head is or contains HEAD, found with `gh`, with
`state` `"open"`, `"merged"` or `"closed"`; `pullRequestUnknown` says why `gh`
could not answer, such as `"gh is not installed"`. `buildState` sizes the
worktree's in-tree build and dependency directories, the ones automatic
maintenance and the pressure ladder clear plus a root `.pnpm-store`, largest first; `du` counts APFS
clones in full, so the sum can exceed what deleting them frees. Xcode output
laid out as DerivedData under a name other than `.dd`, such as a rn-tester
`build-device`, is listed too with `"reportOnly": true`; Stim never deletes it.
Each entry's
`privateBytes` is what deleting `node_modules`, `ios/Pods`, `.dd`, `android/.cxx` or that output would free, the
blocks no copy-on-write clone or outside hard link shares, and is `null` for
other directories, off APFS and without the Command Line Tools. gc reuses a
size for up to an hour while no entry was added to or removed from the
directory (for `node_modules` and Pods, for up to six hours while their install
is unchanged, the measurement `stim status` and the daemon share),
measures the rest with one `du` or private-size walk per directory, 4 at a time with a
10-second limit each, and reports a directory it could not measure in time as
`null`.
`unlistedWorktreeDirectories` lists directories directly under a repository's
`.worktrees/` that `git worktree list` does not show and that have no `.git`,
or a `.git` file whose gitdir is gone; a worktree of another repository placed
there is not listed. gc never removes them,
because it cannot check them for uncommitted work; `remedy` is the command to
run after you have looked through one.
`bytes` is `null` when the size is unknown. Without `--dry-run`, `mode` is
`"delete"`, `results` lists each outcome, `failures` counts the actions that
failed, and `sections` and `inventory` are absent. A
nonzero count exits with status 1. Run `stim gc --dry-run --json` again to see
what is left. An unknown option, or a `--pressure` value other than `normal`,
`high` or `critical`, exits with status 1 and prints
`{ "code": "STIM_BAD_ARG", "message": "...", "remedy": "..." }`.

Ctrl+C stops pending GC actions and drains verified owned children before exiting 130. Completed actions remain applied. Unverifiable cleanup retains its ownership
claims and prints `STIM_CLAIM_UNAVAILABLE` with a recovery remedy. In JSON mode,
cancellation prints one `STIM_CANCELLED` payload, or the cleanup refusal when
cleanup cannot be verified.
Each `results` entry is `{ kind, status, label, id, bytes, detail }`. `status`
is `"done"`, `"kept"` or `"failed"`, and `detail` says why an entry was kept or
failed. For example, a deleted simulator reads
`{ "kind": "device", "status": "done", "label": "stim-app (iPhone 17 26.5)", "id": "9C1F...", "bytes": null, "detail": null }`.
`results` is empty on a dry run.
A dry run also carries `inventory`. It lists every simulator and AVD on the machine with its
runtime or system image, last use and `owner`: `workspace` (with `project` and
`slot`), `parked`, `orphaned`, `otherStimHome` for a `stim-*` device this Stim
home did not create, or `user`. It also lists the iOS simulator runtimes and
Android system images with how many devices use each (a runtime that
`simctl runtime list` does not show has no size), and the
`xcrun simctl runtime delete` or `sdkmanager --uninstall` command that removes
it. A system image with `stimInstalled: true` is one this Stim home installed
under `android.installImages`. `inventory.notices` says why a listing is missing or partial, such as an
AVD or system image folder Stim cannot read. When macOS privacy protection
blocks the read, for example for AVDs on an external disk, the notice names the
Privacy & Security setting that allows the app running Stim.
The inventory is report only, except that `gc` runs `xcrun simctl runtime delete`
for a runtime no simulator uses. Stim never runs `sdkmanager --uninstall` and
never acts on a device through the inventory.
`stim guide facts gc` lists every section, field and reason code.

Try it with an agent:

```text
Run `stim gc --dry-run --pressure high` and then `stim gc --dry-run --pressure
critical` and show me what each would free. Do not run `stim gc` until I
confirm.
```

```text
Run `stim gc --dry-run` and show me how much memory watchman and the Gradle and
Kotlin daemons use and what is reclaimable. If I ask you to free it, run
`stim gc --pressure high`.
```

## `plugin`

```text
stim plugin list [--json]
stim plugin test <plugin> [--json]
```

`list` prints the plugins this Stim bundles and the plugin `cache.provider`
names, with the kind integers each declares and whether Stim can load it.
`test` runs the contract kit of each transport or agent-driver kind a plugin
declares, with the module in a worker thread. See [Plugins](./plugins.md) for
what each kit runs and the JSON payloads.

## `guide`

```text
stim guide [topic] [section]
```

Prints version-matched reference text. Topics are agent, facts, metro, ports,
logs, errors, lifecycle, cleanup, and settings. Those topics also cover caches,
remote devices, and release builds. The errors, lifecycle, facts, and cleanup
topics have sections: called bare they print a section index, and a named
section prints on its own. `stim guide errors` lists every refusal code and
`stim guide errors <CODE>` prints one.

The bare index and the agent topic open with a STATUS block when something is
due: doctor for a platform that never ran in this app, ran more than seven
days ago, or ran under another Stim version (outside a React Native or Expo app
there is no doctor line); and a newer Stim release, checked
against the npm registry at most once a day and skipped when
`STIM_NO_UPDATE_CHECK` is set. The block is omitted when nothing is due.

## Structured output and exit codes

Use plain output for an agent workflow. It streams progress and includes all
facts needed for the next step. Use `--json` when a script must parse the result.

Commands exit with code 0 on success. Build, launch, ownership, or input errors
exit with a nonzero code and print an error code, message, and remedy. An empty
`logs` result exits with code 0.

A `start`, `ios` or `android` run that finds free disk under
`disk.hardFloorGb` has the `stim-daemon` run its pressure ladder first
and refuses with `STIM_LOW_DISK`, naming the largest uses of disk, only while
free disk stays under it. Run `stim guide errors
STIM_LOW_DISK` for the remedies.

### JSON stability within 2.x

Within Stim 2.x, a `--json` payload, a `logs --json` record and a programmatic
API result only gain fields and enum values: a field keeps its name, type and
meaning, and no value of an enum disappears. Ignore fields and values you do not
know. These parts carry no compatibility and can change in any release:

- in `status --json` and `doctor --json`: the `maintenance` and `daemon`
  objects; in `status --json` also the per-workspace
  `idleStage`, `dormantStage`, `sourceDependenciesCleared` and `idleShutdown`
  records, `tutorial`, `gitChip` and `agentDevice.stateDir`;
- file paths and process ids that describe Stim's own state, such as a device
  lease's `path` and `parsed`, a build's `waitingOn.path`, and the `path` and
  `pid` of `gc --json` lock entries.

### Archives and gc

`stim gc` deletes archives past their retention limits at every level. At
`--pressure critical` it also deletes the logs, recordings and agent actions of
every archive and keeps each archive record. The CLI cannot delete one archive
or one kind of one archive; Stim Desktop can, through stim-server.

`status --json` adds `archived` and `archivedUsage`, and `stats` prints an
archive usage line. See [archived workspaces](./worktrees.md#archived-workspaces).

## stim setup

A person on the worker machine runs `stim setup` to set it up and approve
build, device-host or test access (`--build`, `--device-host`, `--test`) for
the machine holding one setup ticket, until one expiry. Test access lets that
machine run any command it sends, as this user, with no sandbox; see
[test approval](./remote-machines.md#test-approval). The requesting machine makes the ticket: Stim Desktop's Add Machine
flow shows the command, and `stim remote add <machine>` or `stim doctor --fix`
prints it on a machine without Desktop. Each grant asks Y/n in a terminal (Enter approves); `--yes` is
required to approve without a terminal. Agents never run setup
or approve requests.
Setup reuses Desktop's server when it already answers and has a tailnet route.
Without a terminal or `--yes`, it refuses before installing anything unless
every requested capability already has a matching approval. A typed N, Ctrl-C
or SIGTERM exits 1; an interrupt completes the journal and releases the setup
claim. Setup never enables Funnel,
and never changes macOS permission settings. An SSH-driven run is not offered.
Setup prints one line per step; `--verbose` adds install, service and route
details and the long summary. `--json` is unchanged.

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

See the [server command reference](./remote-machines.md#cli-equivalent)
for flags, permissions, journals, exit codes and undo commands.
The [remote machines guide](./remote-machines.md) walks through Desktop and manual setup.
