---
title: 'Cache packages'
sidebar_position: 5
description: 'Optional npm packages for builds that run outside Stim'
---

:::note[Command examples]

Commands use `stim`. If it is not installed globally, replace `stim` with
`npx stim`.

:::

Stim supplies its own cache arguments when it runs Metro and native builds. A
project does not need these packages for `stim start`, `stim ios`, or
`stim android`.

The npm packages are useful when the same project also runs tools outside Stim.

## `@stim-cli/metro`

This package exports a shared Metro `FileStore` and the NDJSON reporter used by
Stim. Add it to a custom Metro process when that process must share transforms
with Stim-managed workspaces.

```bash
npm install --save-dev @stim-cli/metro
```

```js
const { sharedCacheStores } = require('@stim-cli/metro');

config.cacheStores = sharedCacheStores('my-app');
```

## `@stim-cli/expo-build-cache`

This package is a local Expo build-cache provider. It lets direct Expo builds
share native artifacts with Stim.
Stim and Expo CLI compute the fingerprint that keys this cache separately, and
Stim ignores two machine-local Android paths (`android/local.properties`,
`android/.idea`) that Expo CLI does not. On a machine where those exist, the
two hashes differ and each side fills its own entry. List them in the project's
`.fingerprintignore` to bring the hashes back together.

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

Expo builds a debug APK without `--all-arch` only for the ABIs of the device it
targets. The provider keys those builds on that device's primary ABI, which it
reads with `adb` (from `ANDROID_HOME`, `ANDROID_SDK_ROOT`, or `PATH`) when
exactly one device is online. With several devices online, or when `adb` does
not answer, it skips the cache for that run and logs `[build-cache] skip
android`. `--all-arch` builds have their own entry.

Both packages work without the `stim` npm package. They register their cache
directories in Stim's cache manifest when available, so `stim gc` can report and
trim them.
