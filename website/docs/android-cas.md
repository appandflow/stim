---
title: 'Android CAS'
description: 'Experimental Apple Clang CAS for Android builds: setup, evidence, and limits'
---

:::note[Command examples]

Commands use `stim`. If it is not installed globally, replace `stim` with
`npx stim`.

:::

Android CAS is an opt-in macOS experiment. It compiles Android native code with
Apple Clang and its content-addressed compile cache, so precompiled headers and
objects are reused after you move to another worktree. You prepare the
toolchain by hand; Stim does not download or build it. The default ccache
backend, with PCH off, stays the recommended setup: it was faster for warm
builds in the measurements below.

## How it works

- CMake schedules compilation. A Stim project hook maps the paths in plain
  `PRECOMPILE_HEADERS` lists to virtual paths.
- Apple Clang builds the PCH and objects and restores cached results from a
  local CAS. A VFS overlay resolves the virtual paths to the current worktree.
- Stim supplies the Gradle init script, compiler adapter, shared CAS directory
  and a separate APK cache key. The tested app needed no source changes.
- The NDK still supplies Android headers, libraries and runtime. Matching LLVM
  tools link and archive. ccache is bypassed for CAS builds.

## Toolchain prerequisites

The tested setup is Apple Clang 21.0.0 (`clang-2100.1.1.101`), CMake 3.22.1,
NDK 27.1.12297006, and locally built LLVM 21.1.8 `ld.lld`, `llvm-ar` and
`llvm-ranlib`. NDK Clang 18's linker cannot read this compiler's ThinLTO
output. Debug bitcode also needs the metadata support from
[LLVM #164372](https://github.com/llvm/llvm-project/pull/164372); the tested
build applies the LLVM part of its
[Swift backport](https://github.com/swiftlang/llvm-project/commit/aecf4d33146fba3cbf8c8565ad9573781d942c80).
For 32-bit targets, a private NDK 27 copy applies the `1UL` to `1ULL` header
fix from [NDK #2082](https://github.com/android/ndk/issues/2082).

Create a manifest with absolute paths to your prepared tools:

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

`resourceDir` holds an `include` link to Apple Clang's builtin headers and a
`lib` link to the NDK Clang runtime libraries. Find both with
`clang -print-resource-dir` for each compiler. Do not change these tools during
the experiment.

## Check the toolchain

From a [Stim source checkout](https://github.com/appandflow/stim), with the
manifest ready:

```sh
pnpm install --frozen-lockfile
pnpm run build
export ANDROID_HOME="$HOME/Library/Android/sdk"
export STIM_ANDROID_CAS_TOOLCHAIN=/absolute/private/toolchain.json
python3 scripts/android-cas/probe.py /absolute/private/new-probe-directory
```

The output directory must not exist yet. The probe builds a small fixture in
two worktrees with different paths and checks that the second restores the
exact PCH bytes from the first, and that header, include and compiler-setting
changes invalidate it. It writes `commands.json`, `results.json` and compiler
logs, and stops on the first failed assertion.

## Turn it on

Merge this into the machine config, `~/.stim/config.json`, or into an app's
`.stim.json`:

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

`STIM_ANDROID_CAS_TOOLCHAIN` overrides `casToolchain`. Then run `stim android`
as usual. If the path is not absolute, or the manifest is missing, unreadable
or invalid, the build warns once and falls back to ccache, or to no compiler
cache when `compilerCache` is `"none"`. `stim doctor` reports the same problem
as a note. Validation checks the tools, resource directory and NDK version; it
does not prove the app compiles.

CAS results live under `$STIM_HOME/android-cas/<id>`, and compiler logs under
the workspace's `android-cas/<id>` directory. The toolchain is part of the ID
and the APK cache key, so CAS and ccache builds never share APKs.

## Measured results

One run per backend on an M4 Pro Mac, Expo SDK 58 canary, React Native 0.87,
Reanimated 4.6 and Worklets 0.12. Full Debug ARM64 APK in seconds, whole-APK
cache bypassed, Gradle build cache on. B is a fresh worktree after A.

| Backend                        | Cold A | Warm B | Three-file native edit |
| ------------------------------ | -----: | -----: | ---------------------: |
| Apple Clang CAS, PCH on        |  104.0 |   38.9 |                   11.8 |
| NDK ccache, PCH on             |  112.9 |   50.7 |                   15.1 |
| NDK ccache, PCH off (shipping) |  129.1 |   23.7 |                   15.9 |

CAS replayed every warm compile job, all 369, including the 3 PCH jobs; ccache
with PCH on missed 210. A Release build compiled all four ABIs through the
adapter and ran on an ARM64 emulator without crashes. These are single
observations, not repeated measurements.

## Limits

- One pinned macOS toolchain. Installing, upgrading, other Xcode or NDK
  versions and non-macOS hosts are not supported. Runtime testing covered
  ARM64 only.
- The CMake hook maps plain absolute PCH entries. Generator expressions and
  external PCH inputs are not fully mapped. Custom CMake toolchains or project
  hooks are refused rather than overwritten.
- The adapter expects `-c` in the argument list and the CMake build directory
  as working directory.
- Toolchain headers are assumed immutable; editing them in place does not
  change the APK key.
- Debug paths appear as `/^src` and `/^build` and need debugger mapping.
- No CAS size limit or eviction. CAS and compiler logs accumulate.
- Each compiler profile gets its own `.cxx/stim-<profile>` directory
  (`.cxx/<first 4 profile characters>` on Windows), so switching back to
  ccache keeps the CAS output. Nothing prunes old profiles.
- Legacy Expo cache providers are skipped for CAS builds.
