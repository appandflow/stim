---
title: 'Build speed and caches'
sidebar_position: 1
description: 'What Stim caches, how to see the savings, and how to clean up'
---

import StimTabs from '@site/src/components/StimTabs';
import PromptBox from '@site/src/components/PromptBox';

:::note[Command examples]

Commands use `stim`. If it is not installed globally, replace `stim` with
`npx stim`.

:::

A native build that already ran once, in any worktree of the project, installs
from cache in seconds. You do not configure anything: every optimization is on
by default.

<PromptBox
title="Check the cache"
response={`iOS · 12 runs · 83% cache hits · cached average 41s · estimated savings ~1h 20m
Next build: cache hit expected.`}

>

{`Show how much the build cache saved, and tell me whether the next iOS build will hit the cache.`}
</PromptBox>

## What Stim caches

| Layer                    | What it avoids                                            |
| ------------------------ | --------------------------------------------------------- |
| Native artifact cache    | A whole iOS or Android build when the native inputs match |
| Xcode compilation cache  | Recompiling unchanged native code after an artifact miss  |
| Gradle caches and ccache | Repeating Android dependency, task and C++ compile work   |
| Metro transform cache    | Transforming the same JavaScript again in each worktree   |

The artifact cache key is a native fingerprint: app config, autolinking, native
directories, patches and native dependency files, plus platform, configuration
and CPU architecture. JavaScript edits do not change it. A build that misses
says why before it compiles:

```text
  cache       miss: native dependency added: expo-clipboard (+2 more)
```

<StimTabs
code={`stim stats            # hit rate and estimated time saved
stim ios --plan       # predict the next build without building
stim android --plan`}
/>

Build the source checkout once before parallel work, so later worktrees start
warm:

<StimTabs
code={`stim ios      # or: stim android
stim stop`}
/>

:::warning[Edits inside node_modules]

Stim does not see an edit you make directly to a dependency's files, such as
`node_modules/<package>/ios/*.m`. The next run installs the cached app without
your change. Make the change a patch with `patch-package` or `pnpm patch`;
Stim hashes patches. To try an edit first, build fresh on this machine:

<StimTabs
code={`stim ios --no-build-cache --remote-build local
stim android --no-build-cache --remote-build local`}
/>

That fresh build replaces the cache entry, so every worktree reuses it until
the dependency or its patches change. Undo it with another `--no-build-cache`
build.

:::

In an Expo project that gitignores `ios/` or `android/`, Stim regenerates the
native directory in place when the app config changes. Delete the gitignored
directory yourself after removing a config plugin, upgrading the Expo SDK or
React Native, or renaming the app, then build once with `--no-build-cache`.

## Build optimizations {/* #build-optimizations */}

Everything is on by default. Turn a layer off only to debug it. Put an
`optimizations` object in the machine config (`~/.stim/config.json`) or the
app's `.stim.json`, with only the keys you change:

```json
{
  "optimizations": {
    "buildCache": true,
    "remoteBuildCache": true,
    "releaseBundleSwap": true,
    "metroSharedCache": true,
    "metroWarmup": true,
    "ios": { "compilationCache": true, "prefixMapping": true },
    "android": {
      "compilerCache": "auto",
      "pch": "auto",
      "gradleBuildCache": true,
      "targetAbiOnly": true
    }
  }
}
```

- `buildCache: false` skips native artifact reads and writes.
- `remoteBuildCache: false` keeps the local cache and skips configured providers.
- `android.compilerCache` is `"auto"`, `"ccache"`, `"cas"` or `"none"`. Auto
  uses ccache when it is installed. `"cas"` is the experimental
  [Android CAS](./android-cas.md), macOS only.

Changes apply on the next build or Metro restart. For every key and its
details, run `stim guide settings` or see the [settings reference](./settings.md).

## Compare compiler settings {/* #compare-compiler-settings */}

An artifact hit skips compilation, so bypass it when you compare compiler
caches:

<StimTabs code={`stim ios --no-build-cache
stim android --no-build-cache`} />

`--no-build-cache` skips artifact reads but still stores the fresh build.
Gradle task caching and existing outputs can still avoid compilation, so a fast
build alone does not prove a compiler-cache hit.

## Share builds across machines {/* #s3-compatible-artifact-storage */}

Without a provider, artifacts stay on this machine. Stim runs no hosted cache
service. To share artifacts with your team or CI, install `@stim-cli/cache-s3`
in the app and point it at an S3-compatible bucket, such as Cloudflare R2:

```json title=".stim.json"
{
  "cache": {
    "provider": "@stim-cli/cache-s3",
    "options": {
      "bucket": "stim-cache",
      "endpoint": "https://YOUR_ACCOUNT_ID.r2.cloudflarestorage.com",
      "region": "auto",
      "prefix": "team/cache-v1"
    }
  }
}
```

- Use a private bucket and a token scoped to Object Read & Write on it. See
  [Cloudflare's setup guide](https://developers.cloudflare.com/r2/get-started/s3/).
- Credentials come from the AWS SDK's standard credential chain. For a named
  profile, set `cache.options.profile` or run `AWS_PROFILE=stim-r2 stim ios`.
  Keep secrets out of committed settings.
- For AWS S3, omit `endpoint` and use the bucket's region. Other services may
  need `forcePathStyle: true`.
- Bucket lifecycle rules own remote retention. Local `gc` never deletes shared
  objects. One entry uploads at most 5 GiB.
- Machines that share a bucket should use matching native toolchains.

Only complete app artifacts and Metro values are shared, never compiler caches
or `node_modules`. Expo's `buildCacheProvider`, such as `eas`, also works.
`@stim-cli/expo-build-cache` is retired: remove it from the project.

[EAS development builds](./eas-builds.md) use EAS CLI's own cache instead.

## Clean up

<PromptBox title="Free disk space" response={`stim gc would free 38 GB: idle build outputs, 2 stale simulators, caches over their caps. Nothing in use. Run it?`}>
{`Run stim gc --dry-run, summarize what it would delete and how much space that frees, and ask me before you run stim gc.`}
</PromptBox>

<StimTabs
code={`stim gc --dry-run           # what would be deleted, with sizes; deletes nothing
stim gc                     # one maintenance pass now
stim gc --pressure critical # free everything; the next builds are cold`}
/>

`stim gc` deletes what can be rebuilt, never touches a workspace in use, and
removes finished worktrees. [How cleanup works](./maintenance.md) lists what it
and the daemon delete, when, and the exceptions. Use plain `stim gc` for routine cleanup.

To put the shared caches on another volume, set `STIM_BUILD_CACHE` and
`STIM_METRO_CACHE`, or `caches.buildCache` and `caches.metroCache` in the
machine config, to absolute paths.

## Automatic maintenance {/* #automatic-maintenance */}

The Stim daemon trims caches, idle build outputs and parked devices on its own,
cleans harder when free disk drops under 40 GB, and removes finished
worktrees. It is on by default outside CI. To see what it would do first:

<StimTabs code="stim settings set daemon.mode report --scope machine" />

[How cleanup works](./maintenance.md) has the phases, the disk pressure levels,
what automatic cleanup deletes at each and the settings that change it. Run
`stim logs --source gc` to see what cleanup removed.

The agent gets the full cache, fingerprint and cleanup rules from
`stim guide lifecycle builds`, `stim guide lifecycle budget` and
`stim guide cleanup`.
