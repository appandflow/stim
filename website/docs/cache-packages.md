---
title: 'Cache packages'
sidebar_position: 5
description: 'Optional npm packages for shared caches and explicit Metro configuration'
---

:::note[Command examples]

Commands use `stim`. If it is not installed globally, replace `stim` with
`npx stim`.

:::

Stim supplies its own cache arguments when it runs Metro and native builds. A
project does not need these packages for `stim start`, `stim ios`, or
`stim android`.

Use these packages for tools outside Stim or for explicit cache configuration.

## `@stim-cli/metro`

This package exports a shared Metro `FileStore` and the NDJSON reporter used by
Stim. Add it to a custom Metro process when that process must share transforms
with Stim-managed workspaces.

```bash
npm install --save-dev @stim-cli/metro
```

Set `cacheStores` on the final merged Metro config:

```js
const { sharedCacheStores } = require('@stim-cli/metro');
const { name } = require('./package.json');

config.cacheStores = sharedCacheStores(name, { cwd: __dirname });
```

For bare React Native under Stim, this explicitly selects one shared transform
store. Stim's automatic setup preserves Metro's default `os.tmpdir()/metro-cache`
store; this assignment replaces it and any custom stores in `cacheStores`.
Using the package name lets Stim recognize the shared store without adding another.

## `@stim-cli/expo-build-cache`

This package is a local Expo build-cache provider. It lets direct Expo builds
share native artifacts with Stim.
Stim and Expo CLI compute the fingerprint that keys this cache separately, and
Stim ignores machine-local and generated paths that Expo CLI does not:
`android/local.properties`, `android/.idea`, Xcode's `*.xcodeproj/xcuserdata`,
`.git` and its contents, `.expo`, the signing files `*.keystore`, `*.jks`, `*.p12`,
`*.pfx` and `keystore.properties` (but not `debug.keystore`),
and, while a `.gitignore` pattern matches them (even when committed), the
`react-native bundle` output `ios/main.jsbundle` and `ios/assets`. On a
machine where those exist, the two hashes differ and each side fills its own
entry. List them in the project's `.fingerprintignore` to bring the hashes back
together.

Stim also counts the `ios/Podfile.lock` checksum of a podspec that names the checkout
path (the precompiled ExpoModulesCore) without that path, which Expo CLI does not,
so after `pod install` the two hashes differ and each side fills its own entry.

```bash
npm install --save-dev @stim-cli/expo-build-cache
```

For current Expo SDK versions:

```json
{
  "expo": {
    "buildCacheProvider": {
      "plugin": "@stim-cli/expo-build-cache"
    }
  }
}
```

Expo SDK 53 reads the provider under `expo.experiments.buildCacheProvider`.
Confirm the key for the project's SDK before adding it.

Expo builds a debug APK without `--all-arch` only for the ABI of the device it
targets. The provider keys those builds on that ABI, which it reads with `adb`
(from `ANDROID_HOME`, `ANDROID_SDK_ROOT`, the default SDK location, or `PATH`)
when exactly one device is online. With several devices online, or when `adb`
does not answer, it skips the cache for that run and logs `[build-cache] skip
android`. `--all-arch` builds have their own entry. These keys match the
per-ABI builds `stim android` makes by default; a universal debug build that
`stim android` makes with `optimizations.android.targetAbiOnly: false` is not
shared with Expo runs.

An iOS simulator build runs on this Mac's architecture, so the provider keys
it on `arm64` or `x86_64` in every configuration, matching `stim ios`. A Release
build that Expo compiles still contains every architecture the project lists.
`--device generic` keeps the project's architectures and the unsuffixed key.

Both packages work without the `stim` npm package. They register their cache
directories in Stim's cache manifest when available, so `stim gc` can report and
trim them.
