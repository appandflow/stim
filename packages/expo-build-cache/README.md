# @stim-cli/expo-build-cache

A local Expo build-cache provider that shares `.app` and `.apk` artifacts across
worktrees and direct Expo builds.
Stim and Expo CLI compute the fingerprint that keys this cache separately, and
Stim ignores two machine-local Android paths (`android/local.properties`,
`android/.idea`) that Expo CLI does not. On a machine where those exist, the
two hashes differ and each side fills its own entry. List them in the project's
`.fingerprintignore` to bring the hashes back together.

If Stim is not installed globally, replace `stim` with `npx stim`.

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

Expo SDK 53 reads this value under `expo.experiments.buildCacheProvider`.

Expo builds a debug APK without `--all-arch` only for the ABI of the device it
targets. The provider keys those builds on that ABI, which it reads with `adb`
(from `ANDROID_HOME`, `ANDROID_SDK_ROOT`, the default SDK location, or `PATH`)
when exactly one device is online. With several devices online, or when `adb`
does not answer, it skips the cache for that run and logs `[build-cache] skip
android`. `--all-arch` builds have their own entry. These keys match the
per-ABI builds `stim android` makes by default; a universal debug build that
`stim android` makes with `optimizations.android.targetAbiOnly: false` is not
shared with Expo runs.

The provider works without the `stim` npm package. When Stim is available,
the provider registers its cache so `stim gc` can report and trim it.

Set `STIM_BUILD_CACHE` to override the cache location.

See the [cache package documentation](https://stim.appandflow.com/docs/cache-packages)
for current setup and cleanup guidance.
