---
title: 'Settings reference'
sidebar_position: 2
description: 'The settings worth knowing, how layers work, and every setting'
---

import StimTabs from '@site/src/components/StimTabs';
import PromptBox from '@site/src/components/PromptBox';
import ArchiveSettings from './_generated/settings-archive.md';
import BudgetSettings from './_generated/settings-budget.md';
import EnvSettings from './_generated/settings-env.md';
import MachineSettings from './_generated/settings-machine.md';
import MaintenanceSettings from './_generated/settings-maintenance.md';
import ProjectSettings from './_generated/settings-project.md';

:::note[Command examples]

Commands use `stim`. If it is not installed globally, replace `stim` with
`npx stim`.

:::

Most projects need no settings. This page lists the ones a person decides:
cost, disk, memory, cleanup, where work runs, and what is exposed. Your agent
reads the full rules from `stim guide settings`.

<PromptBox
title="Review my settings"
response={`3 settings differ from their defaults:
ios.deviceType "iPhone 17 Pro" (workspace), concurrency.maxDevices 4 (machine), recording.enabled false (machine).`}

>

{`Run stim settings --json and tell me which settings are not at their defaults and which layer sets each one.`}
</PromptBox>

## Read and change settings

```bash
stim settings                                   # every setting, its value and its layer
stim settings get ios.deviceType
stim settings set ios.deviceType "iPhone 17 Pro" --scope workspace
stim settings unset ios.deviceType --scope workspace
```

## Settings layers

Stim uses the first value it finds, in this order:

1. An environment variable that overrides the setting.
2. `--scope workspace`: this app in this checkout, stored in `~/.stim/config.json`.
3. `--scope repo`: every checkout of the repository, in the same file.
4. `--scope committed`: `.stim.json` beside the app's `package.json`, committed with the project.
5. `--scope machine`: a default for every project on this machine, in `~/.stim/config.json`.
6. The Stim default.

Each setting lists the layers it accepts in the tables below. A value of the
wrong type is refused by name, never silently replaced by a default.

For editor completion, point `.stim.json` at the shipped schema:

```json
{
  "$schema": "https://unpkg.com/stim@2/dist/settings.schema.json",
  "ios": { "deviceType": "iPhone 17 Pro" }
}
```

## Committed settings

Each app in a monorepo reads its own `.stim.json`. Do not put secrets in it:
keep them in ignored files, which `worktree warm` carries into a worktree.
`android.keystorePassword` is stored there only as an `env:` or `file:`
reference, and `stim settings` never prints it.
`cache.provider` names a module Stim runs in every worktree of the app, so
review a committed value the way you review a build script.

## Settings worth knowing

### Cost

- `remote.easMaxDurationMinutes` (default `30`): EAS stops each EAS Simulator
  session Stim creates after this many minutes, which bounds the bill for a
  session nobody ended. `stim stop` and `stim gc` end it sooner.
- `remote.easFallback` (default `false`): when this machine is at its device
  cap and no remote machine takes the run, run on a billed EAS Simulator
  instead of waiting. See [EAS development builds](./eas-builds.md).

### Disk

- `disk.minFreeGb` (`40`), `disk.criticalFreeGb` (`20`), `disk.hardFloorGb`
  (`5`): below the first two, the Stim daemon starts reclaiming caches, devices
  and dormant workspaces, deeper at critical. It only reports the
  `node_modules` and Pods of idle worktrees. Below the hard floor, `start`,
  `ios` and `android` refuse with `STIM_LOW_DISK`. `0` turns a threshold off.
- `caches.buildCache`, `caches.metroCache` and `tempDir` move the large
  caches and temporary copies to another volume (absolute paths, machine only).
- `ios.autoInstallRuntime` (default `false`): allow Stim to install an iOS
  runtime you asked for. A runtime download is typically 8 to 10 GB and needs
  20 GB free. Maintenance deletes an older runtime only when no
  simulator uses it and no project pins it with `ios.runtime`; remove others
  in Xcode Settings > Components.

#### Installing a missing Android system image

`android.installImages` (default `auto`) lets `stim android` install a missing
system image (about 2 GB) with the SDK's `sdkmanager`. It never accepts an SDK
license for you. Set it to `never` on a metered connection or a full disk:

```bash
stim settings set android.installImages never --scope machine
```

### Memory and parallel work

- `concurrency.maxBuilds` and `concurrency.maxDevices`: how many native builds
  and booted owned devices run at once. `0` derives them from the machine:
  `max(1, floor(CPU cores / 6))` builds and
  `max(2, floor((RAM - 4 GB) / 1.5 GB))` devices. Extra runs wait in line.
- `concurrency.maxIosDevices`, `concurrency.maxAndroidDevices`,
  `concurrency.maxMacosApps`: tighter caps per platform.
- `idle.minutes` (default `15`): after this long without activity a workspace
  goes idle. Its dev server stops, its devices shut down and its build outputs
  are deleted; `stim revive` resumes it. `0` keeps everything running.
- A booted iOS simulator takes roughly 1 to 2 GB of RAM, an Android emulator
  2 to 3 GB.

```bash
stim settings set concurrency.maxDevices 4 --scope machine
```

### Cleanup and retention

- `daemon.mode` (default `on`, `off` in CI): `report` logs what automatic
  cleanup would do and deletes nothing; `off` runs no pass, but `stimd` still
  stops a dev server it runs and the workspace's devices after `idle.minutes`.
- `maintenance.keep` (project): pin a workspace so nothing automatic touches
  it.
- `maintenance.removeFinishedWorktrees` (default `true`): remove linked
  worktrees whose branch or pull request finished.

[How cleanup works](./maintenance.md) lists the phases, the idle and dormant
days, the disk thresholds, the caps and the other settings that change what
Stim deletes by itself.

```bash
stim settings set daemon.mode report --scope machine   # see what it would delete first
```

### Where work runs

- `remote.machines`: the other machines this one may build on and run devices
  on, in priority order. Add one with `stim remote add <machine>`; a person on
  that machine approves it.
- `remote.build` (default `auto`): `local`, `auto` (here while this machine has
  room), `remote`, `remote-only`, or a machine name.
- `ios.remote`, `android.remote`, `macos.remote`: where the simulator,
  emulator or macOS app runs, including `eas` (billed) and `proxy`.
- `server.acceptClientBuilds` (default `false`, on the worker): lets an
  approved client push its own Stim build to this machine's server.
- `hosting.agentDriver` (default `none`, on a hosting Mac): `agent-device`
  lets a client's coding agent drive the devices this Mac hosts for it.

See [Remote machines](./remote-machines.md) for setup, approvals and the
security model.

### Network exposure

`stim share` publishes a public link. Choose how it is reached:

```bash
stim settings set share.exposure proxy                      # auto (default), tailscale or proxy
stim settings set share.publicUrl https://demo.example.com  # links print under this address
stim settings set share.port 7790                           # loopback port the proxy forwards to
```

`auto` uses Tailscale Funnel when Tailscale is installed and logged in.
`proxy` never runs `tailscale serve` or `tailscale funnel`. See
[Share a running app](./share.md).

Two other settings open this machine to others:

- `server.lanAddresses` (default empty): stim-server also accepts machines and
  phones on these local network addresses, authenticated and encrypted but
  without TLS. See [remote machines](./remote-machines.md).
- `metro.tunnel`: `auto` gives Metro a public ngrok or cloudflared URL for a
  remote device; `tailscale` keeps it on your tailnet. See
  [dev server and logs](./dev-server-and-logs.md).

### Privacy

- `recording.enabled` (default `true`): `stim-server` records owned device
  screens while an agent drives them or the phone app watches, and keeps the
  last 15 minutes per device. Recordings stay on this machine and are served
  only to paired devices. `false` stops recording and deletes the recordings.
- `debug.logs` (default `false`): extra local debug logs under
  `~/.stim/logs/debug/`. Nothing is sent anywhere.
- `STIM_TRACE=<path>` writes one command's timeline as a Chrome trace. It holds
  full paths and arguments, so treat it like a log.

```bash
stim settings set recording.enabled false --scope machine
```

### Device windows

- `iosSimulatorApp`: `stim-desktop` (the default with Stim Desktop installed),
  `xcode`, `siniulator` or `none`. On Xcode 27, quitting Device Hub shuts
  down every booted simulator on the machine, including other agents' ones.
  Do not quit it to free memory.
- `androidEmulatorApp`: `stim-desktop` (the default with Stim Desktop
  installed) or `emulator`.

### Engine updates

`engine.autoUpdate` (default `auto`): `stimd` moves the engine to the newest
release on its channel by itself when Stim Desktop or a service installed it.
`on` and `off` force it.

### Runaway Apple background services

On macOS, `stim service install --helper` registers an optional root helper in
Stim Host. It restarts only PerfPowerServices, mds_stores, mdworker_shared,
photoanalysisd, mediaanalysisd and fseventsd when one uses more than 150% CPU or
2 GiB of memory for 10 minutes, at most once per hour. It needs administrator approval
in **System Settings > General > Login Items & Extensions**.
`stim service uninstall --helper` removes it.

## Old setting names

Stim 2.0 removed some settings and refuses while a config file or the
environment still sets them. The refusal prints the commands that fix it. See
[Upgrade to Stim 2.0](./migrate-to-2.md).

## All settings

Generated from the settings registry, so it matches this release.

## Project settings

<ProjectSettings />

## Machine settings

These live only in `~/.stim/config.json`.

<MachineSettings />

### Disk thresholds

<BudgetSettings />

## Automatic maintenance

<MaintenanceSettings />

## Archive retention

<ArchiveSettings />

## Device recordings

`recording.enabled` takes the machine, repo and workspace layers; the workspace layer wins.
`STIM_RECORDING=0` overrides every layer.

## Stim daemon

`daemon.mode` and the idle settings above control it. `stim status` shows the
daemon's mode, its last action and each workspace's stage. Its log is
`~/.stim/daemon/daemon.ndjson`.

## Environment variables

These override a setting and win over every layer:

<EnvSettings />

Stim also reads these, which have no setting:

| Variable                | Purpose                                                           |
| ----------------------- | ----------------------------------------------------------------- |
| `STIM_HOME`             | Runtime state root, an absolute path. Default: `~/.stim`          |
| `STIM_METRO_PUBLIC_URL` | Public Metro URL for remote use                                   |
| `STIM_NO_UPDATE_CHECK`  | Turn off the daily check for a newer Stim release in `stim guide` |
| `STIM_RUN_ID`           | Id stamped on every log record of one `stim` invocation           |
| `STIM_TRACE`            | Write the command's timeline to this path as a Chrome trace       |

For every rule, layer and interaction, run `stim guide settings`.
