---
title: 'Settings reference'
sidebar_position: 2
description: 'Project, repository, machine, and environment settings'
---

:::note[Command examples]

Commands use `stim`. If it is not installed globally, replace `stim` with
`npx stim`.

:::

Most projects need no settings. Use `stim guide settings` for descriptions that
match the installed version.

## Settings layers

Stim reads the first value found in this order:

1. Project settings in `~/.stim/config.json`, keyed by absolute path.
2. Repository settings in the same machine file, keyed by the git common dir.
3. Committed `.stim.json` beside the app's `package.json`.
4. Machine defaults under top-level `optimizations` in `~/.stim/config.json` (for
   optimization settings only).
5. The Stim default.

Nested objects merge by key. Arrays replace lower-precedence arrays. Unknown
keys produce a warning. Every key below takes one type: a string, an array of
strings, a number, a boolean, or an object such as `android.avdConfig`,
`cache.options`, and the nested `optimizations` settings.
`ios.remote`, `android.remote`, `metro.tunnel`,
`optimizations.android.compilerCache` and `optimizations.android.pch` take only
their listed choices. A value of the wrong type or outside those choices is
refused by name on every command that resolves settings, `stim ios` included,
so a wrong shape never falls back to a default silently. `stim doctor`
reports it as a finding instead of refusing. The exception is
`optimizations.android.casToolchain`: an invalid value warns and falls back to
ccache, or no compiler cache when `compilerCache` is `none`. `doctor` also
reports the invalid setting.

## Committed settings

Each monorepo app reads its own `.stim.json`; it does not inherit an ancestor's
runtime configuration. Single-app repositories still use their root file.
When upgrading, move runtime settings to each relevant app and make profile,
AVD-fragment and committed-provider paths relative to that app directory.
Explicit machine project/repository overrides keep their existing precedence.

`.stim.json` supports these keys:

| Key                           | Purpose                                                              |
| ----------------------------- | -------------------------------------------------------------------- |
| `ios.deviceType`              | iOS Simulator device type                                            |
| `ios.runtime`                 | iOS Simulator runtime                                                |
| `ios.configuration`           | Xcode configuration, such as `Debug` or `Release`                    |
| `ios.remote`                  | Default remote backend, `proxy` or `eas`                             |
| `ios.simslimProfile`          | SimSlim profile for local iOS devices                                |
| `ios.signingIdentity`         | Keychain identity used to re-seal a device build                     |
| `ios.signingIdentitySha1`     | SHA-1 of that identity, when two share a name                        |
| `ios.lanHost`                 | Address a phone uses to reach this workspace's Metro                 |
| `android.systemImage`         | Android SDK system image                                             |
| `android.dataPartitionSizeGb` | AVD data partition size                                              |
| `android.avdConfigFile`       | Additional AVD config file                                           |
| `android.avdConfig`           | Validated AVD config values                                          |
| `android.variant`             | Gradle build variant                                                 |
| `android.keystore`            | Release keystore path                                                |
| `android.keystorePassword`    | Release keystore password source                                     |
| `android.remote`              | Default remote backend, `proxy` or `eas`                             |
| `metro.tunnel`                | Remote tunnel mode: `auto`, `off`, `expo`, `cloudflared`, or `ngrok` |
| `metro.ngrokUrl`              | Existing ngrok URL                                                   |
| `metro.publicUrl`             | Existing public Metro URL                                            |
| `metro.warmupUrl.ios`         | Bundle URL `stim ios` prefetches to warm Metro                       |
| `metro.warmupUrl.android`     | Bundle URL `stim android` prefetches to warm Metro                   |
| `worktree.exclude`            | Ignored paths skipped by `worktree warm`                             |
| `worktree.defaultBranch`      | Branch `worktree warm --refresh` expects the source checkout on      |
| `cache.provider`              | Optional second-tier cache provider module                           |
| `cache.options`               | Options passed to that provider                                      |
| `optimizations`               | [Build optimization switches and defaults](./build-optimizations.md) |

`worktree warm` reads repository-wide copy settings from the source checkout's
root `.stim.json`, not individual app files. Keep `worktree.exclude` and
`worktree.defaultBranch` there. `worktree.defaultBranch` is read only by
`worktree warm --refresh`, which warns when the source checkout sits on
another branch; unset, it uses the branch `origin/HEAD` names. A nonempty
`.worktreeexclude` in the source checkout replaces its resolved
`worktree.exclude` setting; an empty or absent file uses the setting.

Do not put secrets in a committed `.stim.json`. Keep secrets in ignored files
and carry those files into a worktree.

`cache.provider` names a module that Stim executes in every worktree of the
app. Review a committed value the way you review a build script, and
keep provider credentials in the environment or in machine settings.
`cache.options` merges by key from the layer that selects the provider,
higher-precedence layers that name no provider, and lower-precedence layers
that name the same provider resolved from the same directory. A machine layer can therefore override one option
of a committed provider, but options written for a different provider, or added
by a lower layer that names no provider, are ignored. Stim reads
the module for `stim ios` and `stim android`; Metro uses it only when the
project's own `metro.config.js` calls `sharedCacheStores()` from
`@stim-cli/metro`.

`metro.warmupUrl.ios` and `metro.warmupUrl.android` replace the bundle URL that
`ios` and `android` prefetch while the native build runs. Unset, Stim uses
Expo's manifest or the bare React Native default. Give an HTTP(S) URL or a path
ending in `.bundle` with the app's full query, including a matching `platform`.
Stim keeps the path and query but always requests this workspace's Metro port.
The setting only changes the prefetch, not the app. Setting
`optimizations.metroWarmup` to `false` turns the prefetch off. Run
`stim guide settings` for the full rules.

```json
{ "metro": { "warmupUrl": { "ios": "/src/main.bundle?platform=ios&dev=true&lazy=true" } } }
```

### Android AVD overrides

New owned AVDs use the Pixel 6 hardware profile (1080 × 2400 pixels at 420 dpi).
Existing AVDs keep their display settings. Parked AVDs created with the old generic
profile are not adopted by new workspaces.

`android.avdConfigFile` reads an Android `config.ini` file. `android.avdConfig`
provides the same safe keys as JSON. Stim applies these values only when it
creates a new owned AVD. It never rewrites an existing AVD or changes generated
identity and storage paths.

The validated keys cover CPU count, RAM, heap size, screen density, graphics,
orientation, network conditions, and common hardware switches. On displayless Linux,
Stim also launches the emulator with `-no-window -noaudio -no-boot-anim`.
Run `stim guide settings` for the complete key and value list.

## Machine settings

`~/.stim/config.json` also supports:

```json
{
  "concurrency": { "maxBuilds": 2, "maxDevices": 3 },
  "iosSimulatorApp": "xcode",
  "tempDir": "/Volumes/SSD/stim-tmp",
  "pool": { "iosParkedMax": 3, "androidParkedMax": 3 },
  "caches": {
    "buildCache": "/Volumes/Cache/stim/build-cache",
    "metroCache": "/Volumes/Cache/stim/metro-cache"
  }
}
```

`iosSimulatorApp` chooses the macOS app that displays an owned iOS simulator after
Stim boots it. `"xcode"` (the default) opens the selected Xcode's Device Hub on
Xcode 27 or Simulator on older Xcode. Set `"siniulator"` to use an installed
[Siniulator](https://github.com/kmagiera/Siniulator) instead. This is a
machine-wide preference, not a project setting; Stim still creates, boots, and
owns the simulator. An invalid value refuses before boot. Opening the chosen
app is best effort, so install Siniulator before selecting it.

Override it for one launch with `stim ios --simulator-app siniulator` or
`stim ios --simulator-app xcode`. The flag also opens an already running owned
simulator without rebooting it and leaves the saved preference unchanged. It
only applies to local simulators.

`pool.iosParkedMax` bounds the simulators `worktree remove` parks for a later
workspace to adopt. Absent means 3; `0` turns parking and adoption off. When
`STIM_HOME` is set, parking is off unless `STIM_POOL_IOS_PARKED_MAX` is set too.
`pool.androidParkedMax` and `STIM_POOL_ANDROID_PARKED_MAX` apply the same rules
to Android emulators. See [owned devices](/docs/owned-devices) for adoption cleanup.

`caches.buildCache` and `caches.metroCache` move the shared build cache and the
Metro transform cache to other absolute paths. `caches` is a machine-file key
only: a `caches` key in `.stim.json` is not read and produces the unknown-key
warning.

`tempDir` moves the large temporary copies Stim makes for iOS app preparation,
release JavaScript and APK swaps, and the `doctor` fingerprint checkout. Unset,
Stim picks a writable directory on the same volume as the files it copies. The
value must be an absolute directory outside Git working trees; a missing
directory is created. `STIM_TMPDIR` overrides it. `stim doctor` reports
cross-volume copy costs and invalid values.

Use a top-level [`optimizations` object](./build-optimizations.md) in this file to
control build optimizations on this machine without changing project files.

## Environment variables

| Variable                       | Purpose                                                                                                  |
| ------------------------------ | -------------------------------------------------------------------------------------------------------- |
| `STIM_HOME`                    | Runtime state root. Default: `~/.stim`                                                                   |
| `STIM_BUILD_CACHE`             | Native artifact cache root                                                                               |
| `STIM_METRO_CACHE`             | Metro transform cache root                                                                               |
| `STIM_TMPDIR`                  | Directory for large temporary copies; overrides the machine `tempDir`                                    |
| `STIM_MAX_BUILDS`              | Maximum concurrent native builds                                                                         |
| `STIM_MAX_DEVICES`             | Maximum booted owned devices                                                                             |
| `STIM_POOL_ANDROID_PARKED_MAX` | Maximum parked Android emulators; 0 disables parking and adoption                                        |
| `STIM_POOL_IOS_PARKED_MAX`     | Maximum parked simulators                                                                                |
| `STIM_METRO_PUBLIC_URL`        | Public Metro URL for remote use                                                                          |
| `STIM_ANDROID_CAS_TOOLCHAIN`   | Absolute path to the [Android CAS toolchain manifest](./build-optimizations.md#experimental-android-cas) |
| `STIM_NO_UPDATE_CHECK`         | Set to disable the daily check for a newer Stim release in `stim guide`                                  |

`STIM_HOME`, `STIM_BUILD_CACHE`, and `STIM_METRO_CACHE` must be absolute paths.
A relative value would resolve against each process's working directory, so
the CLI, Metro, and the Expo build-cache provider would use different stores.
Every `stim` command refuses a relative value with `STIM_RELATIVE_PATH`. Metro
and the Expo build-cache provider cannot refuse without breaking the bundler,
so they print a warning and ignore the value, falling back to the config file
or the default.

Proxy remote devices also use `AGENT_DEVICE_DAEMON_BASE_URL` and
`AGENT_DEVICE_DAEMON_AUTH_TOKEN`. Those variables belong to the optional proxy
service, not to Stim.
