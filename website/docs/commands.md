---
title: 'Command reference'
sidebar_position: 1
description: 'What each Stim command does, in one place'
---

import StimTabs from '@site/src/components/StimTabs';
import Tabs from '@theme/Tabs';
import TabItem from '@theme/TabItem';

:::note[Command examples]

Commands use `stim`. If Stim is not installed globally, replace `stim` with
`npx stim`.

:::

This page is a map of the commands, so you can recognise what your agent runs.
Your agent does not read it. It gets the flags and payloads for your installed
version from `stim <command> --help` and `stim guide <topic>`.

## Normal workflow

<StimTabs
code={`stim doctor
stim start
stim ios                 # or: stim android, or: stim web
stim logs --errors
stim stop`}
/>

React Native and Expo Debug runs need a dev server, and `ios` or `android`
starts one when none runs. Release builds and native Xcode or Gradle apps run
without Metro.

When [Stim Desktop](./desktop.md) is installed, `worktree warm`, `start`, `ios`,
`android` and `web` print an `Open in Stim` link. Your agent shares it with you
once when it starts work in a workspace.

## Named device slots

`ios`, `android`, `device lock`, `device unlock`, `logs` and `stop` take
`--slot <name>` to run a second device in the same workspace. `status` lists
every slot. See [devices](./owned-devices.md) for an agent prompt.

## Check the setup

### `doctor`

```bash
stim doctor
stim doctor --platform ios
stim doctor --fix
```

Reports what can make builds slow or broken: missing or stale dependencies,
CocoaPods state, cache conflicts, device capacity, remote machine problems. It
changes nothing unless you pass `--fix`. Doctor, `worktree warm`, `start`,
`ios` and `android` run project code, such as the project's config files.

### `guide`

```bash
stim guide
stim guide lifecycle builds
stim guide errors
```

Prints reference text that matches the installed Stim. This is what agents
read. A refusal prints its own remedy, and names `stim guide errors <name>`
when the fix is too long for one. The same text is on the
[troubleshooting page](./troubleshooting.md).

## Run the app

### `start`

```bash
stim start
stim start --reset-cache
```

Starts this workspace's dev server on its reserved port and waits until it
answers as this project's. A healthy server is reused. `--reset-cache` clears
this app's Metro caches, which makes other worktrees of the same app rebuild
their transforms too. See `stim guide metro`.

### `ios`

```bash
stim ios
stim ios --device
stim ios --eas-profile development
stim ios --remote my-mac
```

Builds the app or restores it from the cache, boots this workspace's owned
simulator, installs, launches and checks the launch. Useful options:

- `--device [udid]` runs on a connected iPhone. Stim leases the phone for the
  run and never creates, boots or deletes hardware.
- `--eas-profile <name>` downloads a matching
  [EAS development build](./eas-builds.md) instead of compiling.
- `--remote <target>` runs on an approved Mac, on `eas` (an EAS cloud
  simulator) or on `proxy` (a device an existing Agent Device daemon serves). An EAS
  Simulator session can be billable while it runs; `stim stop` ends it.
- `--remote-build <value>` compiles on a [remote machine](./remote-machines.md).
- `--device-type`, `--runtime` and `--configuration` pick the simulator model,
  iOS version and Xcode configuration. `--install-runtime` lets Xcode download
  a missing runtime, typically 8 to 10 GB, and needs 20 GB free.
- `--plan` predicts the next build without building.

Flags: `stim ios --help` and `stim guide lifecycle options`.

#### Native Xcode apps

Run `stim ios` from the directory that holds the `.xcodeproj` or
`.xcworkspace`. No `package.json` is needed. Use `--scheme` and
`--configuration` when the automatic choice is wrong. See
`stim guide lifecycle native-ios`.

#### Exact apps

An [Exact](https://github.com/expo/exact) app has `exact.mjs` next to
`app.json`. `stim ios` runs Exact's own build on the owned simulator and
launches the app without Metro. Exact builds in the checkout's `target/`
folder, so Stim keeps no artifact cache for it, and a new worktree's first
build compiles in full. Cleanup can clear `target/` of an idle workspace. See
`stim guide lifecycle exact-ios`.

### `android`

```bash
stim android
stim android --device
stim android --variant productionDebug
```

Same flow on this workspace's owned emulator. `--variant` selects the Gradle
variant, `--system-image` and `--device-profile` shape the emulator, and
`--device [serial]` runs on a connected phone. Flags:
`stim android --help` and `stim guide lifecycle options`.

#### Predict the next build

```text
$ stim ios --plan
  plan        ios 1b625d.. -> local cache hit
  expect      ~2.7s (median of 1 hit run)
```

`stim ios --plan` and `stim android --plan` say whether the next run comes from
the cache and how long it should take. They build nothing, boot nothing and
write no Stim state. A native Xcode plan refuses a remote; plan it with
`--remote local`. See `stim guide facts plan`.

### `web`

```bash
stim web
stim web --headed
```

Opens the workspace's page in a Stim-owned headless Chrome and captures its
console, errors and failed requests in `stim logs`. See
[web](./web.md).

### `macos`

```bash
stim macos
```

Builds and launches an owned Swift Package macOS Debug app. See
[macOS](./macos.md).

### `reload`

```bash
stim reload
```

Reloads the JavaScript in the live app, or the owned Chrome page. Use it when an
error screen stays up after a fix, not after every edit. It never restarts the
app.

### `revive`

```bash
stim revive
```

Resumes a workspace after an idle stop, or relaunches an installed Release or
native app. It uses the recorded owned device and never builds. Use it when the
app shows "could not connect" or a blank screen after a pause.

### `agent-device`

```bash
stim agent-device open com.example.app
stim agent-device snapshot
```

Runs [agent-device](https://github.com/callstack/agent-device) on this
workspace's device, so your agent never passes device ids. Stim revives an idle
workspace first and shows each action to Stim Desktop and phone viewers. The
arguments are agent-device's own. After `--remote eas`, it drives the recorded
EAS Simulator session; Stim fetches the EAS token from eas-cli for each call
and passes it only in the child environment.

## Logs and status

### `logs`

```bash
stim logs --errors
stim logs --since 10m --source device
stim logs --follow
```

Queries the workspace's merged timeline: Metro, the app, the device, builds,
agent actions and maintenance. `--errors` shows errors since the last launch or
bundle. An empty result is a success. See `stim guide logs`.

### `status`

```bash
stim status
stim status --watch
```

Shows every Stim environment on this machine: worktrees, ports, devices, dev
servers, builds, leases, capacity and free disk. Each linked worktree shows its
git state, such as `git: 2 changed, 1 untracked, ahead 3`. `--json` may come
from stimd's snapshot, whose age is the `ageMs` field; `--fresh` makes stimd
read the state first. See `stim guide facts status`.

### `stats`

```bash
stim stats
```

Shows how many `ios` and `android` runs this project and this machine recorded,
how many hit the build cache, and an estimate of the time saved.

## Devices

### `device lock` and `device unlock`

```bash
stim device lock ios
stim device lock android --for 30m
stim device unlock
```

Leases a connected phone, or this workspace's own simulator or emulator, to
this workspace, so another workspace's `--device`
run waits instead of installing over it. `--for` runs from `10s` to `30m` and
defaults to `5m`. A `--device` run takes its own lease, so `lock` is for holding
a phone across runs, such as a device-tool session. See
`stim guide lifecycle lease`.

### `device location`, `permission`, `push` and `network`

```bash
stim device location ios --set 45.5,-73.6
stim device permission ios grant photos
stim device push ios --payload '{"aps":{"alert":"Hello"}}'
stim device network android off
```

Change this workspace's own simulator or emulator without looking up its id.
They refuse on a phone, a hosted device or a device Stim does not own. Changing
a permission can terminate the running app. See `stim guide lifecycle tools`.

### `device provision`

```bash
stim device provision ios
```

Registers a connected iPhone with the project's Apple Developer team and
creates or refreshes its development profile, which `stim ios --device` needs
the first time. It is the only Stim command that changes your developer
account. It prints what it will change and asks `[y/N]`; without a terminal it
refuses unless you pass `--yes`. Agents run it only when you ask:

```text
My iPhone is connected but stim ios --device fails on signing. Run stim device provision ios without --yes, show me what it would change, and wait for me to confirm.
```

It signs in with the Apple ID in Xcode > Settings > Accounts, or with an App
Store Connect API key set in `ios.appStoreConnectKeyPath`,
`ios.appStoreConnectKeyId` and `ios.appStoreConnectIssuerId`. Stim passes the
key path to xcodebuild and never reads the key. See
`stim guide lifecycle devices`.

## Stop and clean up

### `stop`

```bash
stim stop
stim stop --slot tablet
```

Stops the dev server and log collectors, shuts down the owned devices, ends an
owned remote or EAS session, releases phone leases and frees the port. It never
deletes a device: the next run reuses it. An owned iOS simulator can stay
booted for `pool.bootedGraceMinutes` when memory allows. A `stop` during a
build interrupts that build. On a phone, stopping the log collector closes the
app; Stim never uninstalls it.

### `worktree warm`

```bash
stim worktree warm
stim worktree warm --refresh
```

Copies missing ignored files, such as `node_modules`, native build output and
`.env` files, from the source checkout into a new linked worktree. Existing
entries stay untouched, and an entry the new branch does not ignore is left
out. `--refresh` first fast-forwards the source checkout and reinstalls
dependencies when its lockfiles moved. Let warm finish before
anything else writes to the worktree. See [worktrees](./worktrees.md).

### `worktree remove`

```bash
stim worktree remove
stim worktree remove --force
```

Reclaims the workspace's port, build output and owned devices, then removes the
linked worktree when that is safe. It refuses when the worktree has
uncommitted, untracked or unpushed work; `--force` discards that work. A
worktree locked with `git worktree lock` is kept even with `--force`. In the source checkout it
reclaims the environment and keeps the files. Git branches with commits of
their own stay. On Windows it refuses when run from inside the worktree,
because Windows cannot delete a working directory; run it from the parent
folder with the worktree path.

### `worktree list`

```bash
stim worktree list
stim worktree list --all
```

Lists linked worktrees by real size, with branch, idle age and whether cleanup
would remove each. It deletes nothing.

### `gc`

```bash
stim gc --dry-run
stim gc
stim gc --pressure critical --dry-run
```

Runs one automatic maintenance pass now and deletes what it finds: build
outputs and caches over their caps, orphaned devices and records of removed
projects, old archives, finished worktrees past their grace period, and the
regenerable files of idle workspaces. Preview with `--dry-run` first.
`--pressure high` or `critical` deletes more; `critical` empties every shared
cache Stim registered and cleans other tools' caches through their own
commands.

`gc` never touches a workspace that is building, driven, leased, hosted or
pinned with `maintenance.keep`, unpushed work, or a simulator or emulator you
created. A finished worktree past its grace period is removed even with
uncommitted changes, after they are archived; pin it with `maintenance.keep`
or `git worktree lock` to keep it. [How cleanup works](./maintenance.md) lists
every rule, and the agent reads `stim guide cleanup gc`.

## Servers, ports and tests

### `services`

```bash
stim services
stim services start
stim services stop
```

Starts, stops and lists the databases, API servers and workers the project
declares in its `services` setting, each on its own ports. `stop` keeps their
data. See [workspace services](./dev-server-and-logs.md#workspace-services).

### `ports`

```bash
stim ports get api
stim ports reverse api
stim ports stop api --dry-run
```

Reserves ports 8900 to 8999 for web or API servers Stim does not run. `get`
prints the port number. `reverse` makes a server on this machine reachable from
the workspace's emulator or Android phone. `stop` kills the listener on a named
port, including a process outside the workspace, so preview with `--dry-run`.
See `stim guide ports`.

### `share`

```bash
stim share ios
stim share ios --control
stim share stop
```

Gives anyone a public web link to watch the running app, and with `--control`
to tap and type in it. The link is public on the internet, through Tailscale
Funnel or your own reverse proxy (`share.exposure`), and protected by a generated password unless you pass `--no-password`.
A share expires after 60 minutes by default, at most 480, and ends with
`stim share stop` or `stim stop`. See [share](./share.md) for the security
model.

### `test`

```bash
stim test
stim test js -- src/cart.test.ts
stim test --list
```

Runs the project's tests under a machine-wide test slot, so parallel agents
queue instead of each starting one worker per core. This version runs the
`js` kind: the project's `test` script through its package manager. The output
and exit status are the test command's own.

### `ci`

```bash
stim ci build --platform ios
stim ci run --platform ios -- npm run e2e
```

`ci build` is the only step that compiles. `ci run` installs the last matching
build, runs the command after `--` and stops the app. See
[continuous integration](./ci.md).

## Settings and remote machines

### `settings`

```bash
stim settings
stim settings get ios.deviceType
stim settings set ios.deviceType "iPhone 17 Pro" --scope workspace
stim settings unset ios.deviceType --scope workspace
```

Lists every setting with its effective value and the layer it comes from, or
changes one layer: `machine`, `workspace`, `repo` or `committed` (the app's
`.stim.json`). See the [settings reference](./settings.md).

### `remote`

```bash
stim remote add my-mac
stim remote list
stim remote remove my-mac
```

Manages the remote machines this machine builds on and runs devices on. `add`
asks the machine for approval and prints a `stim setup` command that a person
on that machine runs. `remove` forgets the machine here; the remote machine
keeps its approval until someone there runs the `stim pairings revoke`
command `remove` prints. `update` updates an approved worker's Stim. See
[remote machines](./remote-machines.md).

### `stim setup` {/* #stim-setup */}

A person on the worker machine runs `stim setup` to approve build, device-host
or test access (`--build`, `--device-host`, `--test`) for the machine that holds
one setup ticket, until one expiry. Each grant asks Y/n. Agents never run setup
or approve requests. Setup never enables Funnel and never changes macOS
permission settings. Stim Desktop's Add Machine flow, `stim remote add` and
`stim doctor --fix` print the command:

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

### `serve`, `pair` and `pairings`

```bash
stim pair
stim pairings list
stim pairings revoke <id>
```

`serve` runs stim-server, which serves paired phones, Stim Desktop on other
Macs and approved clients. `pair` prints a single-use pairing code; `--control`
lets the paired device run actions, not only watch. `pairings` lists, grants,
renames and revokes paired devices, approved clients and hosted sessions, and
`pairings log` lists the actions paired devices ran. See the
[phone app](./phone-app.md) and [remote machines](./remote-machines.md).

### `service`

```bash
stim service install
stim service status
stim service uninstall
```

Installs, checks or removes stim-server as a per-user service that starts at
login. `--serve` adds a tailnet-only Tailscale route.

### `engine`

```bash
stim engine status
stim engine update
stim engine rollback
```

The engine is the one Stim build every copy on the machine runs. `status`
shows it and its previous build. `update` moves it to the newest version on
its channel. `use <version|path>` pins a version or a built checkout, with
`--channel latest|next` to pick a channel. `rollback` runs the previous build,
and `--restore-state` also puts back the state snapshot taken before a newer
build migrated the home. `install` makes this copy the engine and `uninstall`
removes it.

### `plugin`

```bash
stim plugin list
stim plugin test <plugin>
```

Lists the plugins Stim loads and tests one against the plugin contract. See
[plugins](./programmatic-api.md#plugins).

## Structured output and exit codes

Plain output is for agents and people. Use `--json` when a script parses the
result: it prints one payload on stdout and sends progress to stderr.
`logs --json` writes NDJSON, one record per line, and nothing when no record
matches. `status --watch --json` prints one payload per line.

Commands exit 0 on success. A refusal exits nonzero and prints a `STIM_*` code,
a message and a remedy. An empty `logs` result exits 0.

Within Stim 2.x, JSON payloads only gain fields and values; ignore the ones you
do not know. See `stim guide facts payloads` for every field.
