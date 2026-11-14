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

Update the phone app alongside Desktop if you use it. In-place upgrades on Windows and Linux, upgrades with paired clients, and mixed-version app and engine combinations are still being verified. [In-place upgrade checks](https://github.com/appandflow/stim/issues/5590) · [App and engine compatibility checks](https://github.com/appandflow/stim/issues/5593)

## First native build after the upgrade

- **Native cache.** The 2.0 fingerprint uses new keys. Expect one cold build per distinct native fingerprint whose only cache entry was made by 1.40. Matching 2.0 builds can reuse the new entry across worktrees. If a worktree warmed by 1.40 reports a lockfile newer than its npm install stamp, run `npm install` in the directory named by the warning so future builds can be cached. [Native artifact cache](./build-caches.md#native-artifact-cache)
- **Expo-generated native directories.** Preserve manual edits before the first native run. For an untracked `ios/` or `android/` with a readable prebuild record from an older Stim, 2.0 runs Expo prebuild once for that platform in each generated worktree. A local run prebuilds in place. An offload worker can regenerate its own copy with `--clean`. If `STIM_PREBUILD_FAILED` says the record is unreadable, preserve your edits, move only the generated directory named by the error aside, and rerun. Leave tracked and hand-maintained native directories in place. [React Native and Expo inputs](./build-caches.md#react-native-and-expo-inputs)
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
| `share.webrtc`               | Remove it and `STIM_WEBRTC_STUN`. Shared web video uses the share socket.                                                               |
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

The server and CI runner ship in `stim`. Use `stim serve` in place of `stim-server`. Use `stim pair`, `stim pairings`, `stim service`, and `stim setup` for those workflows, and replace `stim-ci` with `stim ci`. For the [GitHub Action](./ci.md#github-actions), set `version` to 2.0.0 or later, or stay on an older action ref with its supported version. If `cli-path` points into a Stim checkout, build it and use `packages/stim-cli/bin/stim.mjs`.

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
