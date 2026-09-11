---
title: 'Build optimizations'
description: 'Control native artifact reuse, compiler caches, PCH, and Metro caching'
---

import StimTabs from '@site/src/components/StimTabs';

Commands use `stim`. If it is not installed globally, replace `stim` with
`npx stim`.

Stim enables build optimizations by default. Use the `optimizations` settings to
disable individual layers when debugging or to opt into experimental compiler
caching. For an overview of the layers, see [build speed and caches](./build-caches.md).

## Configure optimizations

Put an `optimizations` object at the top level of `~/.stim/config.json` (or
`$STIM_HOME/config.json`) to set machine defaults without changing a project.
Merge it into the existing file, preserving project and device records. The same
object in the app's `.stim.json`, or in machine repository or project settings,
overrides individual values using the [settings layers](./settings.md#settings-layers).

These are the defaults; you only need to include values you want to change:

```json
{
  "optimizations": {
    "buildCache": true,
    "remoteBuildCache": true,
    "releaseBundleSwap": true,
    "metroSharedCache": true,
    "ios": {
      "compilationCache": true,
      "swiftCompilationCache": false,
      "prefixMapping": true
    },
    "android": {
      "compilerCache": "auto",
      "pch": "auto",
      "gradleBuildCache": true,
      "targetAbiOnly": true
    }
  }
}
```

An explicit `false` overrides a lower layer's `true`. Removing a key inherits the
next layer. Changes apply on the next build or Metro restart. These settings
control Stim's invocations; they do not edit Xcode, Gradle, CMake, or Metro source
configuration, and direct builds outside Stim keep their own settings.

## Shared options

All keys below are inside `optimizations`.

| Option              | Default | What it does                                                                                                                                                                                                                                     |
| ------------------- | ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `buildCache`        | `true`  | Reads and stores complete native build artifacts. Set to `false` to skip both local and remote artifact reads and writes. Compiler caches remain independent.                                                                                    |
| `remoteBuildCache`  | `true`  | Allows configured artifact providers. Stim ships no network provider or hosted cache. Set to `false` to skip remote lookup, upload, provider discovery, loading, and authentication while keeping the local artifact cache.                      |
| `releaseBundleSwap` | `true`  | Allows supported Release artifact hits to reuse native code with the current JavaScript and assets inserted into a copy. If swapping fails, Stim builds fresh. Set to `false` to build Release from source; fresh artifacts can still be stored. |
| `metroSharedCache`  | `true`  | Adds Stim's shared Metro transform store for Expo SDK 54+ and bare React Native. Set to `false` to stop adding it; stores configured by the project remain.                                                                                      |

Remote artifact reuse is available through [optional cache providers](./build-caches.md#optional-artifact-providers).
It does not synchronize compiler caches between machines.

The machine setting `caches.injectMetroStore` has been removed. If you used
`caches.injectMetroStore: false`, replace it with
`optimizations.metroSharedCache: false` to keep the shared Metro store disabled.

## iOS options

These keys are inside `optimizations.ios`. They apply to Xcode 26 or newer unless
`apple.ccacheEnabled` is `"true"` in `ios/Podfile.properties.json`. Older or
unrecognized Xcode versions and projects with that ccache setting retain their
own compiler settings. Custom ccache integrations using other mechanisms are
not detected by this guard.

| Option                  | Default | What it does                                                                                                                                                                           |
| ----------------------- | ------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `compilationCache`      | `true`  | Enables Xcode's compilation cache so unchanged native compilation can be reused across builds and worktrees. Set to `false` to disable the compilation cache, including Swift caching. |
| `swiftCompilationCache` | `false` | Opts into experimental Swift compilation caching. Requires `compilationCache: true`.                                                                                                   |
| `prefixMapping`         | `true`  | Maps checkout and DerivedData paths to stable Clang paths for reuse across worktrees. Set to `false` to disable Stim's prefix mapping and clear its mappings.                          |

## Android options

These keys are inside `optimizations.android`.

| Option             | Default  | What it does                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| ------------------ | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `compilerCache`    | `"auto"` | Selects `"auto"`, `"ccache"`, `"cas"`, or `"none"`. Auto uses CAS when a toolchain manifest is supplied, otherwise ccache when available. Explicit `"ccache"` keeps ccache even if a CAS manifest is configured. `"none"` disables Stim's compiler caching and inherited ccache.                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `casToolchain`     | Unset    | Absolute path to the experimental Android CAS toolchain manifest. `STIM_ANDROID_CAS_TOOLCHAIN` overrides this path. Any value that is not an absolute path, and a manifest that is missing, unreadable, or does not name an executable `clang`, `clangxx`, `lld`, `ar` and `ranlib` plus an existing `resourceDir`, degrade to the cache the selection leaves -- ccache, or none when `compilerCache` is `"none"` -- in one warning naming the setting and its file. `stim doctor` resolves the same manifest and reports what the build would warn about as a note: a path that is not there, from the setting or from the environment variable, or a manifest that is there and cannot be used. |
| `pch`              | `"auto"` | Selects `"auto"`, `"on"`, or `"off"` for precompiled headers. Auto preserves library and project policy, but defaults PCH off when Stim supplies ccache and the project has no explicit PCH argument. See the PCH behavior below.                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `gradleBuildCache` | `true`   | Passes `--build-cache` to Gradle to reuse cacheable task outputs. Set to `false` to pass Gradle's `--no-build-cache`, overriding `org.gradle.caching=true`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `targetAbiOnly`    | `true`   | Narrows Debug builds to the target device's ABI to avoid compiling unused architectures. Set to `false` to stop narrowing Debug builds. Release builds remain universal, subject to the project's ABI filters.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |

### ccache and precompiled headers

The default backend uses the Android NDK compiler with ccache when ccache is
installed and the project does not already supply its own compiler launcher.
Stim defaults PCH off in this mode because stock ccache cannot reliably reuse
these PCH builds across worktrees. This lets ordinary compiled objects stay warm.

`pch: "on"` and `pch: "off"` override Gradle's
`CMAKE_DISABLE_PRECOMPILE_HEADERS` arguments; target-level CMake settings can
still override them. `"on"` permits libraries to use PCH; it does not create PCH
targets or fix stock ccache's PCH portability. Stim does not combine its ccache
and CAS backends.

### Experimental Android CAS

CAS uses an Apple Clang toolchain to cache compilation results and PCH with
content-addressed inputs. The current integration requires macOS and a prepared
compatible toolchain. Stim does not download or build it. Follow the
[Android CAS setup and limitations](./android-cas.md)
before opting in; the Xcode compiler alone is not the complete setup.

Merge this into the machine config, replacing the path with your manifest:

```json
{
  "optimizations": {
    "android": {
      "compilerCache": "cas",
      "casToolchain": "/absolute/path/to/android-cas-toolchain.json",
      "pch": "auto"
    }
  }
}
```

CAS keeps the libraries' PCH policy under `"auto"`. Selecting `"ccache"` returns
to the NDK compiler and the default PCH-off policy even if the manifest path
remains configured. Selecting `"cas"` without a manifest warns and falls back
to ccache when available, or compiles without a compiler cache.

## Compare compiler settings

A native artifact hit skips compilation, so bypass it when comparing compiler
caches. For a single invocation, use the command for your platform:

<StimTabs code={`stim android --no-build-cache
stim ios --no-build-cache`} />

This flag skips Stim's artifact reads but still stores the fresh build. Use
`optimizations.buildCache: false` to skip both reads and writes. Gradle task
caching and existing native outputs can still avoid compilation; a fast build
alone does not prove a compiler-cache hit.

Android CAS, explicit PCH modes, and changed iOS compiler options use separate
native artifact keys. Android ccache and `"none"` share an artifact key when
their PCH mode matches, so bypass artifact reuse to exercise a backend change.
Legacy Expo cache providers cannot distinguish these custom compiler profiles
and are skipped for them; providers using Stim's cache-key contract remain usable.

Android compiler and PCH profiles also use separate generated CMake directories
under each module's `.cxx/stim-<profile>` or its custom staging root. Switching
profiles keeps previous output for reuse. These directories can accumulate;
there is no profile-pruning command. Remove obsolete generated profiles only
after all native builds have stopped, or let worktree removal reclaim them.
