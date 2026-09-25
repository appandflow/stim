---
title: 'Build speed and caches'
sidebar_position: 1
description: 'How Stim keeps worktree builds warm'
---

import StimTabs from '@site/src/components/StimTabs';

:::note[Command examples]

Commands use `stim`. If it is not installed globally, replace `stim` with
`npx stim`.

:::

Stim shares four types of work across projects and git worktrees:

| Layer                    | What it avoids                                            |
| ------------------------ | --------------------------------------------------------- |
| Native artifact cache    | A complete iOS or Android build when native inputs match  |
| Xcode compilation cache  | Recompiling unchanged native units on an artifact miss    |
| Gradle caches and output | Repeating Android dependency and task work                |
| Metro transform cache    | Transforming the same JavaScript modules in each worktree |

See [build optimizations](./build-optimizations.md) for switches, defaults, and
tradeoffs for each layer, including Android ccache, PCH, and experimental CAS.

## Native artifact cache

Stim uses `@expo/fingerprint` to identify native inputs in both Expo and bare
React Native projects. The cache key also includes the platform, target, and
build configuration or variant.

`stim ios` and `stim android` first check the machine-wide artifact cache. A hit
installs the saved `.app` or `.apk`. A miss runs the native build and stores the
result. Two matching misses use one build through a single-flight lock.

To find out before a run whether it will hit, and how long it should take, run
`stim ios --plan` or `stim android --plan`. See
[Predict the next build](./commands.md#predict-the-next-build).

In an Expo project that gitignores `ios/` or `android/` (Continuous Native
Generation), the fingerprint hashes the app config instead of the native
directory. Stim records the fingerprint of each prebuild it runs. When a native
build is needed and the existing directory was not generated from the current
fingerprint, for example after a config plugin change, Stim regenerates it with
`expo prebuild --clean` before building. This discards hand edits in the
gitignored directory, so keep native settings such as the signing team in the
app config or a config plugin. A committed native directory is part of the key
and is never regenerated.

Stim only knows about prebuilds it ran. If you run `expo prebuild` yourself with
a different config, delete the native directory or run
`expo prebuild --clean` before the next `stim ios` or `stim android`.

Release configurations use separate keys. On a cache hit for an iOS simulator
or Android target, Stim regenerates the current workspace's JavaScript and
assets in a copy of the artifact. If that swap fails, it builds fresh. iOS
physical-device Release runs always build fresh.

### Generated dependency output and cache misses

If identical worktrees build instead of reusing an artifact, compare their
fingerprint sources before adding exclusions. A project-level
`.fingerprintignore` can exclude generated output that does not affect native
inputs. Never ignore an entire native dependency, its build scripts, or source
files to force a cache hit.

React Native Test App can put checkout-specific generated Android files under
`node_modules/react-native-test-app/android/support/build`. When the differences
are confined to that directory, add these entries to the app root's
`.fingerprintignore`:

```gitignore
node_modules/react-native-test-app/android/support/build
node_modules/react-native-test-app/android/support/build/**/*
```

Use the dependency path shown in the fingerprint sources; hoisted or linked
layouts may differ. Keep `android/support/build.gradle` and native sources
included. Verify that built worktrees agree and that changing a real native
input still changes the fingerprint. Stim does not add these exclusions by
default.

A prompt to investigate a miss:

> Investigate why these two worktrees do not share Stim's Android artifact
> cache. Compare their fingerprint sources. If only React Native Test App's
> generated support/build output differs, add a narrowly scoped
> .fingerprintignore entry at the app root. Verify fingerprint parity and that
> a real native input change still invalidates the cache. Do not ignore the
> package, build scripts, or native sources. Report the evidence.

### EAS development builds

With `--eas-profile <name>`, Stim downloads a compatible EAS development build
and uses EAS CLI's artifact cache directly. It does not add another Stim cache
copy or compile locally on a miss. See [EAS development builds](./eas-builds.md)
for profile selection, device support, and cache behavior.

### Optional artifact providers

The provider integration is implemented, but Stim ships no network provider
or hosted cache service. Without a configured provider, artifacts stay on the
local machine.

Projects can supply a module through `cache.provider` using the
[`@stim-cli/cache` contract](https://github.com/appandflow/stim/tree/main/packages/cache),
or use a configured Expo `buildCacheProvider`, such as `eas`.
`optimizations.remoteBuildCache` controls whether Stim uses those providers.
Provider and build-profile restrictions still apply; see
[build optimizations](./build-optimizations.md#compare-compiler-settings).
This caches app artifacts; ccache and Clang CAS use separate compiler caches.

## Keep the source checkout warm

Run `stim doctor` before native worktree work. It checks whether the source
checkout has current dependencies and CocoaPods state. On a checkout without
installed dependencies, it also checks whether a fresh worktree produces the
same native fingerprint.

When several native tasks are coming, build the source checkout once:

<StimTabs
code={`stim start
stim ios                  # or: stim android
stim stop`}
/>

Later worktrees can reuse that cache entry. In an existing linked worktree,
`stim worktree warm` copies missing ignored state from the source checkout
without replacing existing entries. This includes installed dependencies, Pods,
and native output. See [worktree isolation](./worktrees.md) for its full scope.

## Inspect and clean caches

<StimTabs
code={`stim gc
stim gc --delete --older-than 30
stim gc --delete --cache all`}
/>

The first command only reports sizes. Age-based cleanup removes unused entries.
`--cache all` empties managed caches and makes future builds cold; it reaps
nothing, so `gc --delete` on its own remains the way to prune stale entries.
`--cache "compilation cache"` empties one cache instead of every one.

### Workspace build outputs

Each workspace keeps its own `derived-data/`, `gradle-build/`, `android-cas/`
and `cache-provider/` under `$STIM_HOME/workspaces/<name>/`. They usually take
most of the disk Stim uses. `gc` reports them as one cache, "Workspace build
outputs", with the size, last use and verdict of each workspace.

<StimTabs
code={`stim gc --delete
stim gc --delete --older-than 7
stim gc --delete --cache workspaces`}
/>

Plain `gc --delete` clears the build outputs of every workspace that is not in
use. A workspace is in use while its dev server runs, a `stim ios` or
`stim android` run holds it, a build names it, or a tunnel or remote lock is
held. `--older-than <days>` clears only workspaces no Stim command has used for
that many days. `--cache workspaces` clears the outputs and nothing else, and
`--cache all` includes them. The workspace keeps its `workspace.json`,
`state.json`, logs, devices and ports.

The next build of an unchanged app installs from the shared build cache. After
a native change, the Xcode compilation cache speeds up the rebuild. On React
Native 0.86, Swift does not use that cache because explicit modules are off,
so the first iOS build after a native change recompiles Swift.

Set `STIM_BUILD_CACHE` or `STIM_METRO_CACHE` to an absolute path to place the
shared caches on a different volume. The same values can live in the machine config under
`caches.buildCache` and `caches.metroCache`.
