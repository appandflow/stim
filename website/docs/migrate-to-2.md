---
title: 'Upgrade to Stim 2.0'
description: 'Move a Stim 1.40 installation, workspaces, and automation to Stim 2.0'
---

import StimTabs from '@site/src/components/StimTabs';
import PromptBox from '@site/src/components/PromptBox';

:::note[Command examples]

Commands use `stim`. Use `npx stim` if you run without a global installation.
For step 1, use `npx stim@1.40.0 stop` if your workspace was running 1.40 and
you need to invoke it explicitly.

:::

Upgrading from 1.40 takes three steps. Then hand the leftovers to your agent.

## Upgrade

1. With 1.40 still installed, run `stim status` to find your running
   workspaces, and run `stim stop` in each one. Repeat for each Stim home you
   use.
2. Upgrade the [CLI](./getting-started.md) and any project pins or
   CI inputs that still select 1.x. Keep the same `STIM_HOME` so 2.0 reads your
   settings, workspaces and device ownership. Before you open Desktop or run
   any other command, decide on the [changed defaults](#changed-defaults) and
   set the ones you want to keep with `stim settings set`: the first workspace
   command after the upgrade runs cleanup under the values then in force.
3. Update [Stim Desktop](./desktop.md), the phone app and any
   [remote workers](./remote-machines.md). Run `stim doctor` in each app
   directory whose project code you trust, then restart the workspaces you
   need. Check the connection and the next build on each worker before you rely
   on it.

## Let an agent migrate

After the upgrade, `stim guide agent` prints a STATUS line while anything from
1.x is left: old settings or environment variables, a 1.x daemon, a `stim` 1.x
or `@stim-cli/*` dependency, or a doctor run from 1.x. Paste this:

<PromptBox title="Migrate to Stim 2.0">
{`Follow https://stim.appandflow.com/docs/migrate-to-2#for-agents to migrate this Stim home and project to the installed Stim. Ask me before you change my shell, CI or service environment, edit ~/.stim/config.json, keep or change a default, reinstall a service, update another machine, or stop a process.`}
</PromptBox>

The STATUS line clears once nothing is left.

## Changed defaults

2.0 cleans up sooner. An explicitly configured value still wins.

| Setting                     | 1.40  | 2.0  |
| --------------------------- | ----- | ---- |
| `idle.dormantDays`          | 3     | 1    |
| `maintenance.olderThanDays` | 7     | 3    |
| `disk.minFreeGb`            | 20    | 40   |
| `disk.criticalFreeGb`       | 6     | 20   |
| `ios.simslim`               | `off` | `on` |

To keep the 1.40 dormancy and age thresholds:

<StimTabs
code={`stim settings set idle.dormantDays 3 --scope machine
stim settings set maintenance.olderThanDays 7 --scope machine`}
/>

`ios.simslim` `on` also applies to simulators Stim created before the upgrade,
at their next boot. Set it to `off` for a project that needs stock simulator
services.

## `stim gc` now deletes

Update any script that ran `stim gc` to preview, including scripts that parse
its JSON:

<StimTabs
code={`stim gc --dry-run
stim gc --dry-run --json`}
/>

- `--delete` is gone. Plain `stim gc` applies cleanup at the measured pressure
  level.
- `--cache`, `--older-than` and `--worktrees` are gone. `--pressure normal`,
  `high` or `critical` picks the level for one pass, and the maintenance
  settings set age and worktree policy.
- `stim worktree remove` refuses a changed `project.pbxproj`, and a tracked
  file marked `assume-unchanged` or `skip-worktree`. Commit or discard the
  change, or pass `--force`.
- Review any configured `maintenance.discoverRoots` in a dry run first. See
  [checkouts Stim never ran in](./worktrees.md#checkouts-stim-never-ran-in).

## First build after the upgrade

- **Cold native cache.** 2.0 uses new cache keys, so expect one cold build per
  native fingerprint.
- **Expo `ios/` and `android/`.** An untracked native directory that a 1.x Stim
  generated is prebuilt again once. Save manual edits first. If
  `STIM_PREBUILD_FAILED` says the record is unreadable, move only the named
  directory aside and rerun.
- **`fingerprint.config.js`.** 2.0 reads only `extraSources` from it (and not
  when `cache.fingerprintInputs` is set). Other options such as
  `preset: 'strict'` are ignored without a warning at build time, so a native
  dependency edited in place in `node_modules` can reuse a cached build.
  `stim doctor` lists ignored options. Move inputs to `extraSources` or
  `cache.fingerprintInputs`, or commit the edit as a patch.
- **Build credentials.** Offloaded builds strip Stim's own credentials from the
  worker's build environment. A build that reads a private Stim credential is
  not cached.

## Daemon, engine and services

- A per-home `stimd` now runs Metro, tunnels and device logs. `daemon.mode`
  controls automatic maintenance; a command that needs `stimd` can start it
  even when that is `off`.
- A 1.40 daemon can keep running after its workspaces stop. While it
  does, `stim start` and `stim serve` refuse and print its PID and the command
  that stops it. Check the PID before you run that command.
- A managed engine is optional: `stim engine install` sets one up,
  `stim engine status` shows it, `stim engine update` follows its channel, and
  `stim engine rollback` returns to the previous build.
- 2.0 workers use peer compatibility version 3 and build compatibility
  version 6. Workers: run `stim remote update <machine> --to <version>` with the
  version this machine runs. A worker that still runs 1.x cannot take that
  update, so on the worker install the Stim this machine runs and rerun
  `stim service install` with its existing options. On Windows, reinstall the
  service after an engine update too. If an old server still holds the serving port, stop it or pick
  another port with `stim serve --port <port>` and point clients at it.
- If `stim service install` refuses because a daemon it does not own holds the
  port, stop that daemon with the `kill <pid>` it prints once its work drains,
  then rerun the install.
- If `stim service uninstall` reports its daemon is still listening, let it
  finish, stop it, and rerun `stim service uninstall --label <label>`.
- A phone app from before the 2.0 protocol is refused with a prompt to update
  Stim Mobile, and the current phone app shows an update card for a machine
  that still runs 1.40. Update Stim Desktop together with `stim`.

## Legacy settings

`stim settings` and `stim doctor` report leftover keys. Fix each in the layer
that defines it, and remove old exports from your shell, service or CI
environment. These names give no hint in the CLI:

| Old key                      | Use in 2.0                                                                          |
| ---------------------------- | ----------------------------------------------------------------------------------- |
| `remote.buildMode`           | `remote.build`: `auto` to `auto`, `force` to `remote`, `off` to `local`.            |
| `share.webrtc`               | Remove it, and `STIM_WEBRTC_STUN`.                                                  |
| `devices.reclaimIdleMinutes` | Remove it. Stim reclaims a device idle for two minutes when a run waits for a boot. |
| `daemon.enabled`             | `daemon.mode`: `true` to `on`, `false` to `off`.                                    |
| `caches.injectMetroStore`    | `optimizations.metroSharedCache`.                                                   |

The pressure ladder now uses fixed rules. Remove `budget.maxCommittedMemoryGb`,
`budget.maxLiveWorkspaces`, the old `maintenance.*` tuning keys listed in
[For agents](#for-agents), and their `STIM_` exports.

`start`, `ios`, `android`, `web`, `macos`, `revive` and `gc` refuse when a
removed environment variable below is set to a nonempty value, when old config
sets `maintenance.mode` to `off` or `report`, or when it sets either old local
idle timeout to `0`. The refusal prints the `stim settings` commands to run,
with one scoped `unset` per layer that holds the key.

| Old key or environment variable                                             | Replacement                                                     |
| --------------------------------------------------------------------------- | --------------------------------------------------------------- |
| `metro.idleStopMinutes`, `devices.idleShutdownMinutes`                      | `idle.minutes` stops the dev server and owned devices together. |
| `maintenance.deviceIdleDays` / `STIM_MAINTENANCE_DEVICE_IDLE_DAYS`          | `idle.dormantDays`.                                             |
| `budget.minFreeDiskGb` / `STIM_BUDGET_MIN_FREE_DISK_GB`                     | `disk.minFreeGb` / `STIM_DISK_MIN_FREE_GB`.                     |
| `budget.hardFloorDiskGb` / `STIM_BUDGET_HARD_FLOOR_DISK_GB`                 | `disk.hardFloorGb` / `STIM_DISK_HARD_FLOOR_GB`.                 |
| `maintenance.criticalFreeDiskGb` / `STIM_MAINTENANCE_CRITICAL_FREE_DISK_GB` | `disk.criticalFreeGb` / `STIM_DISK_CRITICAL_FREE_GB`.           |
| `maintenance.mode` / `STIM_MAINTENANCE`                                     | `daemon.mode` / `STIM_DAEMON`, same `on`, `report` or `off`.    |

`maintenance.idleStopHours` stays: hosted device sessions still read it.

## Scripts, packages and code

- `stim-server` is now `stim serve`, `stim pair` and `stim pairings` (`list`,
  `grant`, `revoke`, `log`). `stim-ci` is now `stim ci`.
- Subcommands refuse options they do not define, for example
  `stim pairings grant <id> --json`.
- For the [GitHub Action](./ci.md), move to a 2.x ref and set
  `version` to 2.0.0 or later in the same change.
- `@stim-cli/core`, `cache`, `agent-driver`, `agent-driver-agent-device`,
  `metro`, `expo-build-cache`, `ci`, `transport`, `transport-tailscale`,
  `transport-local` and `server` are bundled into `stim` and no longer publish.
  Import from `stim`, `stim/ci` or `stim/plugin`. `@stim-cli/cache-s3` stays
  published; upgrade it to 2.x.
- Remove `@stim-cli/metro` and `sharedCacheStores` from `metro.config.js`; Stim
  sets Metro's shared store itself (`optimizations.metroSharedCache`).
- Remove `@stim-cli/expo-build-cache` from dependencies and from Expo's
  `buildCacheProvider` config.

### JavaScript and TypeScript

| 1.40                      | 2.0                                                                                   |
| ------------------------- | ------------------------------------------------------------------------------------- |
| `StimOptions.buildCache`  | `buildCacheDir`. The run and build `buildCache` boolean stays.                        |
| Run option `wait`         | `waitSeconds`: a positive whole number or `false`.                                    |
| `diagnostics({ errors })` | `diagnostics({ errorsOnly })`.                                                        |
| `gc()`                    | `previewGarbage()` to preview, `collectGarbage()` to apply. Both take `{ pressure }`. |

The old spellings refuse with `STIM_BAD_ARG` and name the replacement.
`collectGarbage()` always deletes: without options it was a dry run in 1.40 and
now deletes, so call `previewGarbage()` to preview. It takes only `pressure`
and `signal`, and
its 1.40 options `delete`, `cache`, `olderThan` and `worktrees` refuse with
`STIM_BAD_ARG`.
`collectGarbage()` returns `{ report, exitCode }`. `StimLogsOptions.sources`
and `minLevel` use the `LogSource` and `LogLevel` unions. Operation errors are
rejected promises. `stim/internal/*` and `@internal` APIs carry no stability
guarantee; replace deep imports such as `stim/api-self` with public operations.
`stim/cache-manifest` keeps only `register(entry)` and `unregister(dir)`.

### Plugins

The stable 2.x plugin contract is `cache-provider`. A provider declares its
kind in its package manifest and exports `CacheProviderModule.apiVersion`;
`builds.resolve` and `builds.store` return promises. `transport` and
`agent-driver` are experimental and bundled. Replace
`cacheProviderContractChecks` with `runCacheProviderContract` or
`runContract`, and remove `CacheProvider.metro`. See
[plugins](./programmatic-api.md#plugins).

## For agents {/* #for-agents */}

Follow this section when `stim guide agent` prints `Not migrated from an earlier Stim`, or when a refusal or a `stim doctor` finding links here. Work through the steps in order. A step marked **Ask first** changes the user's machine, environment, defaults or another machine: describe the change and wait for the user's answer. When you are done, run `stim guide agent` again; its STATUS line clears once nothing is left.

### 1. Settings

**Check:** list each key Stim does not read with the `scope` and `file` that hold it, without its value, which can be a secret:

```bash
stim settings --json 2>/dev/null | node -e "let s = ''; process.stdin.on('data', (d) => (s += d)).on('end', () => { for (const { key, scope, file } of JSON.parse(s).unknown) console.log(key, scope, file); })"
```

Do not print the whole payload, and send its errors to `/dev/null` as above, since a validation error can quote a value. Rerun `stim settings` without the filter only if the user asks. `stim doctor` rates each leftover.

**Migrate:**

- When `start`, `ios`, `android`, `web`, `macos`, `revive` or `gc` refuses, its printed `stim settings set` and `stim settings unset` commands are the plan. The refusal leaves out the `set` when the replacement is already configured. Run each `unset` with the `--scope` of the occurrence it removes, as the bullets below say, and for `maintenance.mode` check the machine layer first.
- Otherwise, check the replacement before you touch it: `stim settings get <replacement> --json` shows its `origin`, a layer, `env` for its environment variable, or `default`. A 1.40 home can hold an explicit replacement, such as `daemon.mode` `off`, next to an inert old key, such as `maintenance.mode` `on`.
  - If the origin is a layer or `env`, keep the replacement as it is and remove only the old key, as the table says.
  - If the origin is `default`, the old key's value would change what Stim does. **Ask first** whether to carry it over with `stim settings set <replacement> <value>`, adding `--scope <scope>` of the old key when the replacement accepts that layer. Then remove the old key.
- Handle each reported occurrence on its own: decide its replacement, then remove only that one with `stim settings unset <key> --scope <scope>`, using the scope the inventory reported. Without `--scope`, `unset` removes the key from every layer at once, including a committed `.stim.json` that has its own decision to make.
- Ask the user which value each layer should keep before you remove anything when the same retired key is reported in more than one file, or when the replacement comes only from another layer or from your shell. When one scoped `unset` would touch several files, edit the approved file directly instead: a `--scope committed` unset removes the key from every committed `.stim.json`, the app's and the repository's.

| Old key                                                                                                                                                                                                                                                                                                                                                                                                      | Replacement                                                                  | Remove the old key with                                |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------- | ------------------------------------------------------ |
| `maintenance.mode`                                                                                                                                                                                                                                                                                                                                                                                           | `daemon.mode`; for the machine occurrence, see the machine-layer check below | `stim settings unset maintenance.mode --scope <scope>` |
| `metro.idleStopMinutes`, `devices.idleShutdownMinutes`                                                                                                                                                                                                                                                                                                                                                       | `idle.minutes`                                                               | `stim settings unset <key> --scope <scope>`            |
| `maintenance.deviceIdleDays`                                                                                                                                                                                                                                                                                                                                                                                 | `idle.dormantDays`                                                           | `stim settings unset <key> --scope <scope>`            |
| `budget.minFreeDiskGb`                                                                                                                                                                                                                                                                                                                                                                                       | `disk.minFreeGb`                                                             | `stim settings unset <key> --scope <scope>`            |
| `budget.hardFloorDiskGb`                                                                                                                                                                                                                                                                                                                                                                                     | `disk.hardFloorGb`                                                           | `stim settings unset <key> --scope <scope>`            |
| `maintenance.criticalFreeDiskGb`                                                                                                                                                                                                                                                                                                                                                                             | `disk.criticalFreeGb`                                                        | `stim settings unset <key> --scope <scope>`            |
| `remote.buildMode`                                                                                                                                                                                                                                                                                                                                                                                           | `remote.build`: `auto` to `auto`, `force` to `remote`, `off` to `local`      | `stim settings unset <key> --scope <scope>`            |
| `daemon.enabled`                                                                                                                                                                                                                                                                                                                                                                                             | `daemon.mode`: `true` to `on`, `false` to `off`                              | `stim settings unset <key> --scope <scope>`            |
| `caches.injectMetroStore`                                                                                                                                                                                                                                                                                                                                                                                    | `optimizations.metroSharedCache`                                             | `stim settings unset <key> --scope <scope>`            |
| `devices.reclaimIdleMinutes`, `share.webrtc`                                                                                                                                                                                                                                                                                                                                                                 | none                                                                         | `stim settings unset <key> --scope <scope>`            |
| `budget.maxCommittedMemoryGb`, `budget.maxLiveWorkspaces`, `maintenance.pressureCheckMinutes`, `maintenance.sizeCheckMinutes`, `maintenance.maxLoadPerCore`, `maintenance.memoryPressureLevel`, `maintenance.memoryWarningMinutes`, `maintenance.minAvailableMemoryGb`, `maintenance.capTargetPercent`, `maintenance.idleCheckMinutes`, `maintenance.urgentFreeDiskGb`, `maintenance.pressureProtectMinutes` | none                                                                         | `stim settings unset <key> --scope <scope>`            |

- **Another unknown key:** `stim settings unset` refuses a name Stim never read. Ask the user what it was for, then remove the property from the file that `stim settings --json` reports for it: `.stim.json` for the `committed` scope, and `~/.stim/config.json` (or `$STIM_HOME/config.json`) for `machine`, under `projects["<path>"].settings` for `workspace` and `repos["<git dir>"].settings` for `repo`. Edit the config file only while no Stim command runs.
- Keep `maintenance.idleStopHours`: hosted device sessions still read it.
- While the machine config holds `maintenance.mode` `off` or `report` and neither `STIM_DAEMON` nor a machine `daemon.mode` is set, the daemon stays at `report` and acts on nothing. Setting either one, to any value, ends that hold.
- Before you remove the machine occurrence of `maintenance.mode` when it is `off` or `report`, read the machine layer on its own with `stim settings get daemon.mode --scope machine --json`. A `STIM_DAEMON` in your shell does not reach Stim Desktop, `stim serve` or other shells. When the machine layer has no valid `daemon.mode` (its `value` is `null` or not `on`, `report` or `off`), **ask first** which machine policy to keep, `off`, `report` or `on`, and run `stim settings set daemon.mode <value> --scope machine` before `stim settings unset maintenance.mode --scope machine`. Do this even when a refusal or your shell's `STIM_DAEMON` suggests only the unset.

### 2. Environment

**Check:** list the names of the `STIM_` variables, never their values, which can hold secrets such as passwords and access tickets:

```bash
node -e "console.log(Object.keys(process.env).filter((k) => k.startsWith('STIM_')).join('\n'))"
```

Compare the names with the table. STATUS names the ones set in your own shell. The user's shell profile, CI and service definitions can also export them; read those only with the user's permission, and never print a value.

**Migrate (ask first):** the user changes each export where it is set. Leave other `STIM_` variables alone; for example `STIM_MAINTENANCE_SWEEP_HOURS` and `STIM_MAINTENANCE_IDLE_STOP_HOURS` are still read.

| Retired export                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | What to do                                                                                                    |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------- |
| `STIM_MAINTENANCE`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | Rename it to `STIM_DAEMON`, same value.                                                                       |
| `STIM_MAINTENANCE_DEVICE_IDLE_DAYS`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | Run `stim settings set idle.dormantDays <value>`, then remove the export; `idle.dormantDays` has no variable. |
| `STIM_BUDGET_MIN_FREE_DISK_GB`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | Rename it to `STIM_DISK_MIN_FREE_GB`.                                                                         |
| `STIM_BUDGET_HARD_FLOOR_DISK_GB`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | Rename it to `STIM_DISK_HARD_FLOOR_GB`.                                                                       |
| `STIM_MAINTENANCE_CRITICAL_FREE_DISK_GB`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | Rename it to `STIM_DISK_CRITICAL_FREE_GB`.                                                                    |
| `STIM_REMOTE_BUILD_MODE`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | Rename it to `STIM_REMOTE_BUILD`: `auto` to `auto`, `force` to `remote`, `off` to `local`.                    |
| `STIM_WEBRTC_STUN`, `STIM_BUDGET_MAX_COMMITTED_MEMORY_GB`, `STIM_BUDGET_MAX_LIVE_WORKSPACES`, `STIM_MAINTENANCE_CAP_TARGET_PERCENT`, `STIM_MAINTENANCE_IDLE_CHECK_MINUTES`, `STIM_MAINTENANCE_MAX_LOAD_PER_CORE`, `STIM_MAINTENANCE_MEMORY_PRESSURE_LEVEL`, `STIM_MAINTENANCE_MEMORY_WARNING_MINUTES`, `STIM_MAINTENANCE_MIN_AVAILABLE_MEMORY_GB`, `STIM_MAINTENANCE_PRESSURE_CHECK_MINUTES`, `STIM_MAINTENANCE_PRESSURE_PROTECT_MINUTES`, `STIM_MAINTENANCE_SIZE_CHECK_MINUTES`, `STIM_MAINTENANCE_URGENT_FREE_DISK_GB` | Remove it; nothing replaces it.                                                                               |

The first five refuse `start`, `ios`, `android`, `web`, `macos`, `revive` and `gc` while set. 2.0 ignores the rest without a warning.

### 3. Changed defaults

**Ask first** whether to keep the 1.40 values, and apply the answer before step 4: the first `stim start` after the old daemon stops runs cleanup under the values then in force. 2.0 cleans up sooner by default: `idle.dormantDays` 1 (was 3), `maintenance.olderThanDays` 3 (was 7), `disk.minFreeGb` 40 (was 20), `disk.criticalFreeGb` 20 (was 6), and `ios.simslim` `on` (was `off`). To keep a 1.40 value, run `stim settings set <key> <value> --scope machine`.

### 4. Old processes

Do this after steps 1 to 3: `stim start` refuses while a refusing setting or export is left, and the first 2.0 daemon runs cleanup under the defaults step 3 settled.

**Check:** `stim status`. It lists the live workspaces of this Stim home, and the line `Daemon: pid <n> from an older stim holds the daemon claim` means a 1.x daemon still runs.

**Migrate (ask first):** a shared home can hold other people's or other agents' active work. List the live workspaces and the old daemon to the user, and wait for an answer before you stop anything.

- With the user's go, run `stim stop` in each workspace they name that a 1.x Stim started before the upgrade.
- With the user's go, run the stop command the daemon line prints (`kill <pid>`, or `taskkill /PID <pid> /F` on Windows).

### 5. Project files and scripts

**Check:** from the repository root, `git grep -nE '@stim-cli/|stim-server|stim-ci|stim gc|gc\(|"stim": *"'`, and review each `stim` dependency range in `package.json`.

**Migrate:**

| In 1.40                                                                        | In 2.0                                                                                                                                                                                                        |
| ------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `stim gc`, `stim gc --json` (they only previewed)                              | `stim gc --dry-run`, `stim gc --dry-run --json`. Plain `stim gc` now deletes. The `--json` payload is the level run: `level`, `actions`, `blocked`, `results`.                                                |
| `stim gc --delete`                                                             | `stim gc`, after reviewing `stim gc --dry-run`.                                                                                                                                                               |
| `stim gc --cache`, `--older-than`, `--worktrees`                               | No replacement with the same scope: `--pressure normal`, `high` or `critical` runs a whole cleanup pass. Change the script to `stim gc --dry-run`, and **ask first** before any `stim gc` that deletes.       |
| `stim-server`                                                                  | `stim serve`, `stim pair`, `stim pairings`.                                                                                                                                                                   |
| `stim-ci`                                                                      | `stim ci`.                                                                                                                                                                                                    |
| the GitHub Action pinned to a 1.x ref, with `version` below 2.0.0              | Move the `uses:` ref to a 2.x release tag or commit and set `version` to 2.0.0 or later in the same change. Only the 2.x action runs `stim ci`; a new `version` under the v1.40.0 action breaks the workflow. |
| a `stim` range that admits no 2.x version                                      | A 2.x range, then install.                                                                                                                                                                                    |
| `@stim-cli/metro`                                                              | Remove it and `sharedCacheStores` from `metro.config.js` and the dependencies.                                                                                                                                |
| `@stim-cli/expo-build-cache`                                                   | Remove it from the dependencies and from the Expo `buildCacheProvider` config.                                                                                                                                |
| `@stim-cli/ci/artifacts` (`diagnosticArtifactFiles`, `copyDiagnosticLogs`)     | `stim/ci/artifacts`, with the same names.                                                                                                                                                                     |
| other `@stim-cli/*` imports                                                    | Import from `stim`, `stim/ci` or `stim/plugin`.                                                                                                                                                               |
| `@stim-cli/cache-s3` 1.x                                                       | Keep the name and upgrade it to a 2.x release: 1.40.0 lacks the plugin manifest 2.0 reads. Then check that `stim plugin list` shows it.                                                                       |
| `StimOptions.buildCache`, run option `wait`, `diagnostics({ errors })`, `gc()` | `buildCacheDir`, `waitSeconds`, `diagnostics({ errorsOnly })`, and `previewGarbage()` or `collectGarbage()`. See [JavaScript and TypeScript](#javascript-and-typescript).                                     |

### 6. Services and remote machines

**Check:** `stim service status` on this machine, and `stim remote list` for the workers it uses.

**Migrate (ask first):**

- A service that a 1.x Stim installed: run `stim service install` with its existing options. `stim service status` prints the exact command on its `stale:` line when the LaunchAgent or systemd unit is out of date.
- A worker that still runs 1.x cannot take `stim remote update`. On the worker itself, install the target Stim, reinstall its service with `stim service install` and the same options, then check the connection with `stim remote list` and the next offloaded build. A worker that already runs a 2.x Stim takes `stim remote update <machine> --to <version>`, with the version this machine runs, from here.

### 7. First build

Expect one cold native build per fingerprint. An untracked `ios/` or `android/` that a 1.x Stim generated is prebuilt again once: **ask first** whether it holds manual edits to preserve. `stim doctor` lists the `fingerprint.config.js` options 2.0 ignores.

### 8. Verify

Run `stim doctor`, then `stim guide agent`. STATUS no longer lists leftovers.
