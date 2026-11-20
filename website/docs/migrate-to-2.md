---
title: 'Upgrade to Stim 2.0'
description: 'Move a Stim 1.40 installation, workspaces, and automation to Stim 2.0'
---

import StimTabs from '@site/src/components/StimTabs';

## Stop workspaces and switch versions

1. With 1.40 still installed, run `stim status` to find your running workspaces. From each workspace, run `stim stop`. Repeat for each Stim home you use. Stopping first also prevents duplicate web logs from a Chrome instance that a 1.x supervisor started.
2. Upgrade the [CLI](./getting-started.md#install-stim) and any project pins or CI inputs that still select 1.x. Keep the same `STIM_HOME` so 2.0 can read your settings, workspace records, and device ownership. Review [legacy settings](#legacy-settings) before restarting.
3. Update [Stim Desktop](./desktop.md) and any [remote workers](./remote-machines.md) you use, then run `stim doctor` in each app directory and restart the workspaces you need. Run `stim doctor` only in checkouts whose project code you trust. Verify the connection and the next build on each worker before relying on offload.

:::note[Command examples]

Commands use `stim`. Use `npx stim` if you run without a global installation. For step 1, use `npx stim@1.40.0 stop` if your workspace was running 1.40 and you need to invoke it explicitly.

:::

### The resident daemon and engine

The per-home `stimd` runs workspace services such as Metro, managed tunnels, and device logs. `daemon.mode` controls automatic maintenance. Even in `off` mode, a command that needs one of those workspace services can start `stimd`.

A 1.40–1.42 maintenance daemon can keep its claim after all workspaces stop. The 2.0 daemon takes over automatically when it can verify that the old maintenance daemon owns the claim. If the claim remains held, follow the refusal from `stim start` or `stim serve`. Check the reported PID before using the suggested `kill <pid>` or, on Windows, `taskkill /PID <pid> /F`. Retry once the holder has stopped. Metro supervisors, log collectors, and devices already running are separate processes and can outlive the old daemon. `stim start` can adopt a verified dev server. If it reports a port held by another process, stop the old workspace first.

An npm installation can run directly. If you want a managed machine engine, use `stim engine install` once from the upgraded CLI. `stim engine status` shows the active build and channel. On an existing managed engine, `stim engine update` follows its current channel and `stim engine rollback` selects its previous build. See [engine and service updates](./settings.md#machine-settings).

2.0 workers use peer compatibility version 3 and build compatibility version 6. If `stim remote update <machine>` can reach and update the worker, use it. If the old worker cannot negotiate an update, upgrade it locally and reinstall its service with `stim service install`, retaining its service options. On Windows, reinstall the service even after an engine update so the scheduled task runs the new build. If an old server still holds the serving port, stop that server or choose a different port with `stim serve --port <port>` and point the clients at it.

If `stim service install` refuses because a Stim daemon serves the service's port outside the service's job and install cannot prove it belongs to the service, Stim Desktop, `stim serve`, or a Stim build older than this one started that daemon. Stop it once its work drains with the `kill <pid>` it prints, then run the same `stim service install` command again. Stopping it also stops what Stim Desktop or that command is using; its dev servers keep running and the next daemon takes them over.

If `stim service uninstall` reports that the service's daemon is still listening after an engine handoff, the service definition and any route it owns are kept. Let that daemon finish its work, stop the reported daemon, and retry `stim service uninstall --label <label>`. [Ubuntu uninstall check](https://github.com/appandflow/stim/actions/runs/43663535775/job/132657852299)

The live 1.40-to-2.0 upgrade checks kept the existing Metro process and verified the same bundle on macOS, Linux, and Windows. macOS and Linux exercised legacy daemon takeover. Windows started its first resident daemon while the 1.40 Metro was still running. [Upgrade results](https://github.com/appandflow/stim/issues/5590#issuecomment-6888597398)

Update the phone app alongside Desktop if you use it. Upgrades with paired clients and mixed-version app and engine combinations are still being verified. [App and engine compatibility checks](https://github.com/appandflow/stim/issues/5593)

## Let an agent migrate

After the upgrade, `stim guide agent` prints a STATUS line while the home or project still holds something an earlier Stim left: settings or environment variables that 2.0 does not read, a daemon from 1.x, a `stim` 1.x or bundled `@stim-cli/*` dependency in `package.json`, or a doctor check last run with 1.x. The line, the refusals for leftover settings and the old daemon, and the matching `stim doctor` findings link the agent to [For agents](#for-agents). The line clears once nothing is left.

```text
Follow https://stim.appandflow.com/docs/migrate-to-2#for-agents to migrate this Stim home and project to the installed Stim. Ask me before you change my shell, CI or service environment, edit ~/.stim/config.json, keep or change a default, reinstall a service, update another machine, or stop a process.
```

## First native build after the upgrade

- **Native cache.** The 2.0 fingerprint uses new keys. Expect one cold build per distinct native fingerprint whose only cache entry was made by 1.40. Matching 2.0 builds can reuse the new entry across worktrees. If a worktree warmed by 1.40 reports a lockfile newer than its npm install stamp, run `npm install` in the directory named by the warning so future builds can be cached. [Native artifact cache](./build-caches.md#native-artifact-cache)
- **Expo-generated native directories.** Preserve manual edits before the first native run. For an untracked `ios/` or `android/` with a readable prebuild record from an older Stim, 2.0 runs Expo prebuild once for that platform in each generated worktree. A local run prebuilds in place. An offload worker can regenerate its own copy with `--clean`. If `STIM_PREBUILD_FAILED` says the record is unreadable, preserve your edits, move only the generated directory named by the error aside, and rerun. Leave tracked and hand-maintained native directories in place. [React Native and Expo inputs](./build-caches.md#react-native-and-expo-inputs)
- **`fingerprint.config.js` options.** 1.40 passed the file's options to `@expo/fingerprint`, so `preset: 'strict'` hashed the contents of native dependencies. 2.0 applies only `extraSources` (not when `cache.fingerprintInputs` is set) and keys a registry package by its identity. It does not refuse or warn at build time, and `stim doctor` lists each ignored option. If your file sets other options, a native dependency edited in place, such as a hand edit in `node_modules`, reuses a cached build. Move needed inputs to `extraSources` or `cache.fingerprintInputs`, or commit the change as a patch. For a temporary native edit, run `stim ios --no-build-cache --remote-build local` (or `stim android`).
- **Build credentials.** An offloaded build removes Stim's own access and setup credentials from the worker's build environment. A build whose embedded config or dependency reads a private Stim credential, or that enumerates the project environment while one is present, is uncached. Remove the credential from the build environment to get caching back. Project build tools can still print the environment values they receive.
- **Owned iOS simulators.** `ios.simslim` now defaults to `on`, including for previously created Stim simulators at their next boot. Set `ios.simslim` to `off` for a project that needs stock simulator services. [Owned devices](./owned-devices.md)

## Change cleanup scripts before running them

**`stim gc` now deletes.** Update scripts that used it to preview, including scripts that parse JSON.

<StimTabs
code={`stim gc --dry-run
stim gc --dry-run --json
stim gc --dry-run --pressure high`}
/>

- `--delete` is gone. Use plain `stim gc` to apply the measured level after reviewing a dry run.
- `--cache`, `--older-than`, and `--worktrees` are gone. Review the [maintenance settings](./settings.md#automatic-maintenance) for age and worktree policy. Use `--pressure normal`, `high`, or `critical` to choose a level for one pass.
- `normal` includes age and dormancy cleanup, such as eligible worktree dependencies, parked devices, and unused iOS simulator runtimes. It can also clear dependencies from a dormant source checkout. `high` also applies pressure cleanup to idle workspaces and trims caches. `critical` can empty shared Stim caches and clean other tools' caches on the default home. An explicit `--pressure critical` runs the last stage even if space is recovered earlier. [Full cleanup rules](./commands.md#gc)
- `stim worktree remove` and the automatic sweep keep a changed `project.pbxproj` and any `ios/Podfile.lock` change they cannot prove came from `pod install`. The proof is `Pods/Manifest.lock` holding the same text, or, when gc deleted `Pods`, the lock hash gc recorded. `worktree remove` refuses a changed `project.pbxproj`, and a tracked file marked `assume-unchanged` or `skip-worktree`, naming the file. Commit or discard the change, or pass `--force`.
- Review configured `maintenance.discoverRoots` in the dry run. A root you explicitly configured brings eligible checkouts under the cleanup rules even if the root is in a home dot-folder or the system temp directory. [Discovery scope](./worktrees.md#checkouts-stim-never-ran-in)

If you relied on the 1.40 defaults, review these values. An explicitly configured value still takes precedence.

| Setting                     | 1.40  | 2.0  |
| --------------------------- | ----- | ---- |
| `idle.dormantDays`          | 3     | 1    |
| `maintenance.olderThanDays` | 7     | 3    |
| `disk.minFreeGb`            | 20    | 40   |
| `disk.criticalFreeGb`       | 6     | 20   |
| `ios.simslim`               | `off` | `on` |

These commands keep the 1.40 dormancy and age thresholds.

<StimTabs
code={`stim settings set idle.dormantDays 3 --scope machine
stim settings set maintenance.olderThanDays 7 --scope machine`}
/>

## Legacy settings

Use `stim settings` and `stim doctor` to find leftover keys. Old keys can be reported as unknown or inert, and previously exported variables can be ignored. Migrate the setting in the [layer](./settings.md#settings-layers) that defines it. Remove unknown keys from the config file that defines them, and remove old exports from your shell, service, or CI environment.

### Unknown names

The CLI gives no replacement hint for these names.

| Old key                      | What to use in 2.0                                                                                                                      |
| ---------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `remote.buildMode`           | `remote.build` / `STIM_REMOTE_BUILD`. Map `auto` to `auto`, `force` to `remote`, and `off` to `local`. Remove `STIM_REMOTE_BUILD_MODE`. |
| `share.webrtc`               | Only a `next` build could set it, with `STIM_WEBRTC_STUN`; 1.40 had neither. Remove both. Shared web video uses the share socket.       |
| `devices.reclaimIdleMinutes` | Remove it. While a run waits to boot, Stim can reclaim the longest-idle device of another workspace idle for at least two minutes.      |
| `daemon.enabled`             | `daemon.mode`. Map `true` to `on` and `false` to `off`.                                                                                 |
| `caches.injectMetroStore`    | `optimizations.metroSharedCache`.                                                                                                       |

The pressure ladder uses fixed rules for the choices below. Remove these keys and any matching `STIM_` exports, such as `STIM_BUDGET_MAX_COMMITTED_MEMORY_GB`, `STIM_BUDGET_MAX_LIVE_WORKSPACES`, and `STIM_MAINTENANCE_PRESSURE_CHECK_MINUTES`.

- `budget.maxCommittedMemoryGb`, `budget.maxLiveWorkspaces`
- `maintenance.pressureCheckMinutes`, `maintenance.sizeCheckMinutes`, `maintenance.maxLoadPerCore`, `maintenance.memoryPressureLevel`, `maintenance.memoryWarningMinutes`, `maintenance.minAvailableMemoryGb`, `maintenance.capTargetPercent`, `maintenance.idleCheckMinutes`, `maintenance.urgentFreeDiskGb`, `maintenance.pressureProtectMinutes`

### Names that can still block a command

`start`, `ios`, `android`, `web`, `macos`, `revive`, and `gc` refuse when a removed environment variable in the table is set to a nonempty value. Set the replacement and remove the old export. They also refuse when old config sets `maintenance.mode` to `off` or `report`, or sets either old local idle timeout to `0`. On these config refusals, follow the printed `stim settings` steps to preserve the intended behavior.

| Old key or environment variable                                             | Replacement                                                                  |
| --------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| `metro.idleStopMinutes`, `devices.idleShutdownMinutes`                      | `idle.minutes` stops the dev server and owned devices together.              |
| `maintenance.deviceIdleDays` / `STIM_MAINTENANCE_DEVICE_IDLE_DAYS`          | `idle.dormantDays`.                                                          |
| `budget.minFreeDiskGb` / `STIM_BUDGET_MIN_FREE_DISK_GB`                     | `disk.minFreeGb` / `STIM_DISK_MIN_FREE_GB`.                                  |
| `budget.hardFloorDiskGb` / `STIM_BUDGET_HARD_FLOOR_DISK_GB`                 | `disk.hardFloorGb` / `STIM_DISK_HARD_FLOOR_GB`.                              |
| `maintenance.criticalFreeDiskGb` / `STIM_MAINTENANCE_CRITICAL_FREE_DISK_GB` | `disk.criticalFreeGb` / `STIM_DISK_CRITICAL_FREE_GB`.                        |
| `maintenance.mode` / `STIM_MAINTENANCE`                                     | `daemon.mode` / `STIM_DAEMON`. Keep the same `on`, `report`, or `off` value. |

`maintenance.idleStopHours` still applies to hosted device sessions. `stim doctor` can warn about an old `0` setting because local workspace dormancy now follows `idle.dormantDays`. Review both values if you used it to disable local cleanup.

## Update CLI automation and integrations

Every command now runs from one operation registry. A subcommand refuses an option it does not define, for example `stim pairings grant <id> --json`. The 1.40 `stim-server pair` and `stim-server devices` commands are now `stim pair` and `stim pairings` (`list`, `grant`, `revoke`), and `stim-server log` is `stim pairings log`. Remove the option from scripts that passed one.

The server and CI runner ship in `stim`. Use `stim serve` in place of `stim-server`. Use `stim pair`, `stim pairings`, `stim service`, and `stim setup` for those workflows, and replace `stim-ci` with `stim ci`. For the [GitHub Action](./ci.md#github-actions), set `version` to 2.0.0 or later, or stay on an older action ref with its supported version. If `cli-path` points into a Stim checkout, build it and use `packages/stim-cli/bin/stim.mjs`.

### Packages that stop publishing

`@stim-cli/core`, `cache`, `agent-driver`, `agent-driver-agent-device`, `metro`, `expo-build-cache`, `ci`, `transport`, `transport-tailscale`, `transport-local` and `server` are bundled into `stim` and no longer publish. Versions already on npm stay installable but get no updates, and the `stim-server` and `stim-ci` binaries are gone. `@stim-cli/cache-s3` stays published. If your code imports one of these packages, import from `stim`, `stim/ci` or `stim/plugin` instead.

- **`@stim-cli/metro`.** Remove `sharedCacheStores` and the package from `metro.config.js` and your dependencies. Stim sets Metro's shared transform store itself when it starts Metro; `optimizations.metroSharedCache` controls it.
- **`@stim-cli/expo-build-cache`.** Remove it from your dependencies and from the Expo `buildCacheProvider` config. Stim's engine no longer reads a cache it wrote. Build with `stim ios` and `stim android`.

### JavaScript and TypeScript

| 1.40                      | 2.0                                                                                                                                                                                                                                                                |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `StimOptions.buildCache`  | `buildCacheDir` for the directory passed to `createStim`; also use it in `stim/ci` options. The run/build `buildCache` boolean stays. `stim ci --build-cache <path>` sets a directory. `stim ios` and `stim android` keep `--no-build-cache` to skip a cache read. |
| Run option `wait`         | `waitSeconds` accepts a positive whole number or `false`. Omit it to use the default.                                                                                                                                                                              |
| `diagnostics({ errors })` | `diagnostics({ errorsOnly })` with the same boolean.                                                                                                                                                                                                               |
| `gc()`                    | `previewGarbage()` for a preview. Call `collectGarbage()` to apply cleanup.                                                                                                                                                                                        |

Update every call site. A temporary compatibility check (C33) refuses the old spellings with `STIM_BAD_ARG` and names the replacement. Both garbage methods take `{ pressure }` in place of `olderThan`, `cache`, `worktrees`, and `delete`. `previewGarbage()` returns the report directly, with `actions` and `blocked` describing the preview and an empty `results` array. `collectGarbage()` returns `{ report, exitCode }`. Read `report.results` for the outcomes of actions it applied. [Programmatic API](./programmatic-api.md)

`StimLogsOptions.sources` and `minLevel` now use the `LogSource` and `LogLevel` unions. Treat operation errors as rejected promises. Import supported functions from `stim` or `stim/ci`. The bundled server's `stim/internal/*` paths and APIs marked `@internal` have no public stability guarantee. Replace deep imports like `stim/api-self` and `stim/engine-state` with public operations where available. If you register cache entries with `stim/cache-manifest`, use `register(entry)` and `unregister(dir)`. The manifest readers and custom manifest path argument were removed.

### Plugins

The stable 2.x plugin contract is `cache-provider`. A provider declares the kind integer in its package manifest and exports `CacheProviderModule.apiVersion`. Make `builds.resolve` and `builds.store` return promises to satisfy the 2.0 types. Stim still awaits synchronous results at runtime.

`transport` and `agent-driver` are experimental and bundled. Use the public types, contract kits, and `loadCacheProvider` from `stim/plugin`. Replace `cacheProviderContractChecks` with `runCacheProviderContract` or `runContract`, and remove `CacheProvider.metro`. The transport and agent-driver host loaders, their internal helpers, and cache-tier utilities are gone from `stim/plugin`. [Plugin contracts and testing](./plugins.md)

## For agents

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
| `remote.buildMode`                                                                                                                                                                                                                                                                                                                                                                                           | `remote.build`: `auto` to `auto`, `force` to `remote`, `off` to `local`      | a file edit                                            |
| `daemon.enabled`                                                                                                                                                                                                                                                                                                                                                                                             | `daemon.mode`: `true` to `on`, `false` to `off`                              | a file edit                                            |
| `caches.injectMetroStore`                                                                                                                                                                                                                                                                                                                                                                                    | `optimizations.metroSharedCache`                                             | a file edit                                            |
| `devices.reclaimIdleMinutes`, `share.webrtc`                                                                                                                                                                                                                                                                                                                                                                 | none                                                                         | a file edit                                            |
| `budget.maxCommittedMemoryGb`, `budget.maxLiveWorkspaces`, `maintenance.pressureCheckMinutes`, `maintenance.sizeCheckMinutes`, `maintenance.maxLoadPerCore`, `maintenance.memoryPressureLevel`, `maintenance.memoryWarningMinutes`, `maintenance.minAvailableMemoryGb`, `maintenance.capTargetPercent`, `maintenance.idleCheckMinutes`, `maintenance.urgentFreeDiskGb`, `maintenance.pressureProtectMinutes` | none                                                                         | a file edit                                            |

- **A file edit:** `stim settings unset` refuses these names, because 2.0 no longer registers them. Remove the property from the file that `stim settings --json` reports for it: `.stim.json` for the `committed` scope, and `~/.stim/config.json` (or `$STIM_HOME/config.json`) for `machine`, under `projects["<path>"].settings` for `workspace` and `repos["<git dir>"].settings` for `repo`. **Ask first** before editing the config file, and edit it only while no Stim command runs. Remove any other unknown key the same way after asking the user what it was for.
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

**Ask first** whether to keep the 1.40 values, and apply the answer before step 4: the first `stim start` that takes the old daemon over runs cleanup under the values then in force. 2.0 cleans up sooner by default: `idle.dormantDays` 1 (was 3), `maintenance.olderThanDays` 3 (was 7), `disk.minFreeGb` 40 (was 20), `disk.criticalFreeGb` 20 (was 6), and `ios.simslim` `on` (was `off`). To keep a 1.40 value, run `stim settings set <key> <value> --scope machine`.

### 4. Old processes

Do this after steps 1 to 3: `stim start` refuses while a refusing setting or export is left, and the takeover runs cleanup under the defaults step 3 settled.

**Check:** `stim status`. It lists the live workspaces of this Stim home, and the line `Daemon: pid <n> from an older stim holds the daemon claim` means a 1.x daemon still runs.

**Migrate (ask first):** a shared home can hold other people's or other agents' active work. List the live workspaces and the old daemon to the user, and wait for an answer before you stop anything.

- With the user's go, run `stim stop` in each workspace they name that a 1.x Stim started before the upgrade.
- When the daemon line says the next command that starts stimd stops it, the next `stim start` takes the old daemon over; run it only after the user agrees. Otherwise, with the user's go, run the stop command the line prints (`kill <pid>`, or `taskkill /PID <pid> /F` on Windows).

### 5. Project files and scripts

**Check:** from the repository root, `git grep -nE '@stim-cli/|stim-server|stim-ci|stim gc|gc\(|"stim": *"'`, and review each `stim` dependency range in `package.json`.

**Migrate:**

| In 1.40                                                                        | In 2.0                                                                                                                                                                                                        |
| ------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `stim gc`, `stim gc --json` (they only previewed)                              | `stim gc --dry-run`, `stim gc --dry-run --json`. Plain `stim gc` now deletes.                                                                                                                                 |
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

- A service that a 1.x Stim installed: run `stim service install` with its existing options. `stim service status` prints the exact command on its `stale:` line when the LaunchAgent is out of date.
- A worker: `stim remote update <machine>`. A stock 1.40 worker cannot take that update. On the worker itself, install the target Stim, reinstall its service with `stim service install` and the same options, then check the connection with `stim remote list` and the next offloaded build.

### 7. First build

Expect one cold native build per fingerprint. An untracked `ios/` or `android/` that a 1.x Stim generated is prebuilt again once: **ask first** whether it holds manual edits to preserve. `stim doctor` lists the `fingerprint.config.js` options 2.0 ignores.

### 8. Verify

Run `stim doctor`, then `stim guide agent`. STATUS no longer lists leftovers.
