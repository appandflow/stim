---
title: 'Android CAS'
description: 'Experimental Apple Clang CAS setup, PCH caching evidence, and limitations on Android'
---

This opt-in macOS prototype retains Android precompiled headers and reuses them
after moving to a different Git worktree. It requires a manually prepared
toolchain. The normal Stim ccache setup still disables PCH by default.

## Roles

- CMake writes the PCH input and schedules compilation. The injected project
  hook maps source/build headers in plain `PRECOMPILE_HEADERS` lists to virtual
  paths without adding any include search directories.
- Apple Clang generates the PCH and objects. Its dependency scanner records an
  include tree, and its compile-job cache restores results from a local
  content-addressable store (CAS). A VFS overlay resolves the virtual paths to
  the current source/build directories.
- Stim supplies the Gradle init script, compiler adapter, shared CAS directory,
  and compiler-specific APK cache key. No application or dependency source
  changes are required for the tested app.
- The NDK still supplies Android headers, libraries, runtime, and base CMake
  toolchain. Matching LLVM tools handle linking and archives. ccache is bypassed
  only for the opt-in CAS build.

## Toolchain prerequisites

The tested setup uses Apple Clang 21.0.0 (`clang-2100.1.1.101`), CMake 3.22.1,
NDK 27.1.12297006, and locally built LLVM 21.1.8 `ld.lld`, `llvm-ar`, and
`llvm-ranlib`. NDK Clang 18's linker cannot read this compiler's ThinLTO output.
Debug bitcode also needs the LLVM metadata support from
[LLVM #164372](https://github.com/llvm/llvm-project/pull/164372); the tested
LLVM 21 build applies the LLVM portion of its
[Swift backport](https://github.com/swiftlang/llvm-project/commit/aecf4d33146fba3cbf8c8565ad9573781d942c80).
Neither debug information nor ThinLTO is disabled.

For 32-bit Android targets, the private NDK 27 copy also applies the `1UL`
to `1ULL` header correction described in
[NDK #2082](https://github.com/android/ndk/issues/2082). The installed NDK is
unchanged. This document does not provide an automatic toolchain installer.

Create an absolute-path JSON manifest with these seven entries, substituting
the paths to your prepared tools:

```json
{
  "clang": "/Applications/Xcode.app/Contents/Developer/Toolchains/XcodeDefault.xctoolchain/usr/bin/clang",
  "clangxx": "/Applications/Xcode.app/Contents/Developer/Toolchains/XcodeDefault.xctoolchain/usr/bin/clang++",
  "lld": "/absolute/private/llvm-build/bin/ld.lld",
  "ar": "/absolute/private/llvm-build/bin/llvm-ar",
  "ranlib": "/absolute/private/llvm-build/bin/llvm-ranlib",
  "ndk": "/absolute/private/ndk27-fixed",
  "resourceDir": "/absolute/private/resource"
}
```

The resource directory contains an `include` symlink to Apple Clang's builtin
headers and a `lib` symlink to the NDK Clang resource directory's runtime
libraries. Use `clang -print-resource-dir` for each compiler to locate them.
Keep these toolchain inputs immutable during the experiment.

## Small runnable reproduction

From a [Stim source checkout](https://github.com/appandflow/stim), after
preparing that manifest:

```sh
pnpm install --frozen-lockfile
pnpm run build
export ANDROID_HOME="$HOME/Library/Android/sdk"
export STIM_ANDROID_CAS_TOOLCHAIN=/absolute/private/toolchain.json
python3 scripts/android-cas/probe.py /absolute/private/new-probe-directory
```

The output directory must not exist. The probe creates its own Git repository,
two worktrees, two generated-build paths, and a private `STIM_HOME`. It renames
A's source and build directories before configuring B. B has a different
directory depth and spaces in its paths. It compiles Android ARM64 with ThinLTO
and retains normal PCH validation. The fixture explicitly uses
`-Xclang -fno-pch-timestamp`, as the tested native libraries do.

Expected compiler activity:

| Case                            | Hits | Misses | PCH hits | PCH misses |
| ------------------------------- | ---: | -----: | -------: | ---------: |
| Cold A                          |    0 |      2 |        0 |          1 |
| Fresh B, A unavailable          |    2 |      0 |        1 |          0 |
| Changed consumer                |    0 |      1 |        0 |          0 |
| Same-size header content change |    0 |      2 |        0 |          1 |
| New earlier include candidate   |    0 |      2 |        0 |          1 |
| Changed compiler setting        |    0 |      2 |        0 |          1 |

The probe checks that B restores the exact PCH bytes, a changed consumer
compiles against them, and stale results are invalidated. Sibling headers,
private macros, an include-search decoy, generated headers, and a symlink/`..`
lookup test header selection. The newly created include candidate forces a
build because Ninja does not track previously nonexistent files. Evidence is
written to `commands.json`, `results.json`, and per-stage compiler logs;
assertion failures stop the script. All fixture data remains available.

## Application integration

After building the Stim checkout, use its CLI with a disposable React Native/Expo
worktree and a private `STIM_HOME`. Commands use `stim`; replace it with
`npx stim-cli` if it is not installed globally.

For persistent selection, merge this into `$STIM_HOME/config.json` (default
`~/.stim/config.json`). The same `optimizations` object in `.stim.json` can
override machine defaults per repository. `stim guide settings` lists the
Android, iOS, Metro, and artifact-cache switches.

```json
{
  "optimizations": {
    "android": {
      "compilerCache": "cas",
      "casToolchain": "/absolute/private/toolchain.json"
    }
  }
}
```

The environment form remains available:

```sh
export STIM_HOME=/absolute/private/stim-state
export STIM_ANDROID_CAS_TOOLCHAIN=/absolute/private/toolchain.json
cd /absolute/private/app-worktree
node /absolute/stim-checkout/packages/stim-cli/dist/cli.mjs start
node /absolute/stim-checkout/packages/stim-cli/dist/cli.mjs android
node /absolute/stim-checkout/packages/stim-cli/dist/cli.mjs android --variant release
node /absolute/stim-checkout/packages/stim-cli/dist/cli.mjs stop
```

The manifest selects the experimental backend. Compiler remarks and timings
are recorded in `compiler.jsonl` under the workspace's `android-cas/<id>`
state directory. CAS results live under `$STIM_HOME/android-cas/<id>`. The
tool binaries, manifest, NDK version, adapter, and shims contribute to the ID;
APK cache keys include it so the two compiler setups do not share APK entries.

## Measured results

One successful pair per backend on an M4 Pro Mac (14 cores, 48 GiB, internal
SSD), Expo `58.0.0-canary-20260902-26df09e`, RN 0.87.0, Reanimated 4.6.0,
and Worklets 0.12.1. Each pair has fresh source/build paths, with A's original
paths unavailable during B. Each native edit changes one consumer per library.

Full Debug ARM64 APK: seconds in Stim's Gradle build engine, with whole-APK
cache bypassed. This includes configuration, linking, Java/Kotlin, and
packaging, and excludes fixture preparation, Metro, fingerprinting, install,
and launch. Gradle's build cache is enabled.

| Backend                        |  Cold A | Warm B | Three-file native edit |
| ------------------------------ | ------: | -----: | ---------------------: |
| Apple Clang CAS, PCH on        | 103.955 | 38.873 |                 11.830 |
| NDK ccache, PCH on             | 112.865 | 50.667 |                 15.113 |
| NDK ccache, PCH off (shipping) | 129.090 | 23.669 |                 15.899 |

Only compiling expo-modules-core, Reanimated, and Worklets: seconds replaying
real compile commands with eight workers, using separate caches from the APK
test. Outputs are removed before replay. There are 207 objects and three
additional PCH compilations when enabled; configuration/linking are excluded.

| Backend                        | Cold A | Warm B | Three-file native edit |
| ------------------------------ | -----: | -----: | ---------------------: |
| Apple Clang CAS, PCH on        | 17.145 |  3.265 |                  0.674 |
| NDK ccache, PCH on             | 26.396 | 29.234 |                  1.067 |
| NDK ccache, PCH off (shipping) | 38.825 |  0.957 |                  2.131 |

Warm APK compiler activity proves actual replay, including the PCH jobs:

| Backend                        | Hits | Misses | PCH hits | PCH misses |
| ------------------------------ | ---: | -----: | -------: | ---------: |
| Apple Clang CAS, PCH on        |  369 |      0 |        3 |          0 |
| NDK ccache, PCH on             |  159 |    210 |        0 |          3 |
| NDK ccache, PCH off (shipping) |  366 |      0 |        0 |          0 |

These compare complete working setups: Apple Clang 21 versus NDK Clang 18,
with stock ccache 4.13.6. ccache uses Stim's `base_dir`, `nohashdir`,
`pch_defines,time_macros`, plus `compiler_check=content`; `depend_mode` is
false. Compiler caches start empty but dependency downloads and filesystem
pages are warm. These are single observations, not randomized repeated
estimates. An initial packaging failure and a native-edit sample affected by
manual replay's Ninja bookkeeping are excluded. The tables use successful
fresh/corrected runs. No earlier same-workspace timings are mixed in.

The Release compatibility build compiled 1,476 native jobs through the Apple
adapter, including 12 PCH jobs and 844 ThinLTO jobs, across all four Android
ABIs. ARM64 runtime testing on an owned Android 36 emulator confirmed the
Expo, Reanimated, Worklets, and app libraries loaded, with sheet expansion and
collapse working and no crash log entries. Release ran embedded JS without
Metro. Its APK SHA-256 is
`f3543ed45c20f49ad55aa6fee1c81d21ffbb6afc9f81573dd4a14a019a1905e7`.
Release packaging required a disk-space retry, so no Release timing is used.
The full-app fixture and raw APK/log artifacts remain private; the committed
probe is the independently runnable correctness evidence.

## Remaining work

- This is a pinned macOS toolchain experiment. Installation, licensing and
  distribution, upgrades, other Xcode/NDK combinations, and non-macOS hosts
  need a supported toolchain strategy. RN core and Hermes remained prebuilt;
  runtime testing covers ARM64 only.
- The CMake hook handles plain absolute source/build PCH entries. Generator
  expressions and external PCH inputs are not fully mapped. Custom CMake
  toolchains/project hooks are rejected rather than overwritten.
- The adapter assumes `-c` appears directly in the argument list and the
  working directory is the CMake build directory. Response-file-only modes
  and different build-system layouts need coverage.
- Generated CAS configurations retain adapter paths and depend on the CAS
  environment. Stim separates compiler/PCH modes under `.cxx/stim-<profile>`
  so switching back to `compilerCache: "ccache"` or `"none"` uses a different
  configuration without deleting evidence. Direct Gradle uses its own staging
  directory. Legacy unprofiled configurations need their previous cleanup flow.
- Compiler binaries are hashed, but all toolchain headers are assumed
  immutable. In-place header changes are not represented in Stim's APK key.
  Normal Clang input validation remains enabled.
- Debug/source paths use `/^src` and `/^build` and need debugger mapping.
  Existing doctor/ccache statistics do not describe CAS, and this prototype
  does not configure CAS size limits or eviction. Compiler evidence logs also
  accumulate under the workspace state directory.

For upstream work, a CMake facility for stable PCH include spelling could
replace the project hook, and Android-compatible compiler CAS distribution
could replace the manual compiler/linker setup. Neither needs the old
checkout-root include-search workaround. Stim would still select the backend,
provide per-workspace path mappings, manage cache storage, and separate APK
keys. Legacy Expo providers are skipped for CAS because they cannot represent
the compiler identity; providers implementing Stim's full key contract can
share it between worktrees using the same local toolchain. The measurements support further testing; the shipping ccache/PCH-off
setup remains faster for warm builds in this sample.
