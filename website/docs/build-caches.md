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

### Native Gradle artifact inputs

Native Android projects can opt into APK reuse in `.stim.json`:

```json
{
  "android": {
    "artifactInputs": {
      "complete": true,
      "ignored": [],
      "outputs": ["build", "app/build"],
      "localFiles": ["../signing/release.keystore"],
      "environment": ["SIGNING_PASSWORD"]
    }
  }
}
```

`complete` is the project's promise that Git-visible source, listed ignored files,
local files and environment variables fully determine a repeatable build with
pinned dependencies. Stim does not infer this from arbitrary Gradle code.
Declare every signing file, external configuration and environment input. Mutable
dependencies, undeclared files, network responses, time and other changing inputs
do not meet this contract. Leave the declaration unset to build without Stim
artifact caching; Gradle's own caches remain available.

`ignored` lists exact repository-relative files and `outputs` lists generated
repository-relative directories. Source cannot overlap outputs. `localFiles`
lists exact regular files, absolute or relative to the project; `environment`
lists variable names. Missing files and unset variables contribute an absence
marker. Private bytes and values contribute only hashes and are not persisted in
cache receipts. This declaration adds no files or values to worker transfers;
the independent `android.offloadInputs` contract still governs Git-visible and
explicitly authorized ignored source. Never authorize private signing files for
worker transfer.

The identity also includes the wrapper JDK release, installed SDK version
metadata, variant, ABI, build options, `local.properties`, user
`gradle.properties`, and ordinary debug keystores, including their absence.
Declare alternate JDK/toolchain release files and custom JVM `user.home` or
signing locations explicitly. For publication, AGP's SDK must match
`ANDROID_HOME`; the SDK directory location alone does not change the key.
`local.properties` needs plain unescaped keys and single-line values; Java
Properties escapes in `sdk.dir` values are supported. Unsupported syntax leaves
the build uncached. Other properties still contribute to the identity.
Changed inputs during compilation prevent storage. Native
Release hits reuse the original signed APK; signature, package, ABI and receipt
bytes are checked before reuse.

A [configured cache provider](./cache-packages.md) with a `files` capability,
including the S3-compatible provider, can share the completed APK and its
verification receipt. Stim checks the local cache first, then downloads and
verifies a shared entry before filling the local cache. Invalid entries are
cache misses. Providers without `files` are skipped for native Gradle artifacts.
Only the APK and receipt are shared; private input files, signing keys and
environment values stay local. A build worker can reuse verified APKs when the
transferred project declares complete `android.artifactInputs`. It keys them from
its actual worker inputs, including the worker's toolchain, signing files and
environment; it does not use the caller's key. Without that declaration, worker
builds remain uncached. After a local and configured-provider miss, Stim can ask
enabled paired workers for a completed APK matching the declared source and
resolved variant, ABI and build options. Each worker rechecks its current private
inputs against the saved build receipt, again before download. A hit skips source
upload and compilation even while that worker is busy. A miss uses normal build
placement. This requires `native-gradle-peer-cache`; older workers still build
normally. When the client has a JDK, lookup also requires `native-gradle-peer-jdk`
and rechecks inputs on that exact installed JDK major; older workers use normal
build placement. Off mode, an explicit local build and disabled remote artifact reads
skip peer lookup. The returned offload fingerprint remains `null`; a worker key
is never published under the caller's identity.

`optimizations.buildCache=false` disables artifact reads and writes.
`--no-build-cache` skips reads and shared-build waits but stores the fresh build. `--plan` performs the same read-only local check.

### React Native and Expo inputs

Stim computes its own native fingerprint for both Expo and bare React Native projects. The cache key also includes the platform, target, and
build configuration or variant. A build for one CPU architecture adds it: an
Android Debug build for a known ABI ends in that ABI (`-arm64-v8a`), and an iOS
simulator build ends in the architecture it runs on (`-arm64` or `-x86-64`):
this Mac's for a local build in any configuration, the remote host's for a
`--remote` build. A build of every architecture the project lists
(`stim build --arch all`, `stim ci build --arch all`) has no suffix. An app
built on Apple silicon therefore no longer runs on an Intel Mac's simulator;
build it with `--arch all` for that.

The fingerprint includes the evaluated app config and autolinking, native build
scripts and their relevant environment, tracked native directories, patches,
and native files of linked, local, git and file dependencies. Registry packages
are identified by their package identity; edits made directly inside them are
not detected. Version fields, EAS configuration and Metro-bundled JavaScript
are excluded. A Release cache hit keeps the version it was built with.

Stim reads `extraSources` from `fingerprint.config.js` unless
`cache.fingerprintInputs` is explicitly set. The latter is an array of paths
relative to the app; even an empty array overrides `extraSources`. Other
`fingerprint.config.js` options no longer change the key. Run `stim doctor`
to see unsupported options. Doctor runs project config and autolinking in an isolated child to check determinism and worktree parity; run it only in a checkout whose project code you trust.

### Inputs read only in a plugin callback

Expo's `getConfig` does not run the callbacks a config plugin registers on mods
(`withDangerousMod`, `withXcodeProject` and similar). An environment variable
or file that a plugin reads only inside such a callback, at prebuild time, is
not traced, so changing it does not change the key. Values and files read in
the plugin function itself, outside a callback, are traced without any
declaration. Declare the callback-only inputs yourself:

```js title="fingerprint.config.js"
module.exports = {
  extraSources: [
    { type: 'file', filePath: 'certs/push.pem' },
    { type: 'contents', id: 'push-env', contents: process.env.PUSH_ENV ?? '' },
  ],
};
```

`file` and `dir` entries key the contents of the path. A `contents` entry that
reads `process.env` when the config loads keys that value. If you set
`cache.fingerprintInputs`, list the paths there instead; it replaces
`extraSources`, and it takes paths only.

If embedded config or a dependency reads a private Stim credential, or project
config enumerates an environment containing one, Stim runs the build without
the cache. Remove that credential from the build environment to retry caching.
The private workspace replay record keeps `STIM_HOME` and `STIM_RUN_ID`; neither
is sent to a build worker as a fingerprint input.

The first build with this fingerprint definition misses older build-cache
entries. For an existing generated Expo native directory with an older Stim
prebuild record, align the project and global Stim versions, preserve any local
changes, then move or remove the generated `ios/` or `android/` directory and
retry. Stim generates it again. Tracked native directories are not removed.
The workspace native-run lock serializes Stim builds in the same Stim home;
separate Stim homes do not share that lock.

A build worker receives the values of environment names included in the key,
including values read by build scripts. They are sent only to the approved
worker and used for install, prebuild and compilation. Project build tools may
print their own environment in build logs. Stim removes its own access and setup
credentials from the worker's build environment. A path or package instance that
cannot be mapped safely to the worker prevents offload. If a config only
probes or lists Git-ignored entries, the worker may not reproduce them and
Stim falls back to a local build. List needed files or directories in
`cache.fingerprintInputs` to include their contents in the key and transfer.

For `patch-package` postinstalls, Stim can cache a direct apply invocation with
a literal patch directory and supported error flags. Wrappers, compound commands
and other modes make the fingerprint uncertain. Use a direct apply invocation
to enable caching and offload.
On Windows, use a double-quoted literal path without environment expansion.

:::warning[Edits inside node_modules]

Stim does not see an edit you make directly to a dependency's files, such as
`node_modules/<package>/ios/*.m`, a podspec or `build.gradle`. The key stays the
same, so the next run installs the cached app without your change. Make the
change a patch with `patch-package` or `pnpm patch`; Stim hashes patches. To try
an edit before you make it a patch, build it fresh on this machine:

<StimTabs
code={`stim ios --no-build-cache --remote-build local
stim android --no-build-cache --remote-build local`}
/>

`--no-build-cache` alone can place the build on a paired build machine. That
machine installs dependencies from the lockfile, so its build does not include
your edit. The fresh build is stored under the same key in the machine-wide
cache, and handed to a configured cache provider, so every worktree reuses it,
edit included, until the dependency's version or patches change. Undo the edit
with another `--no-build-cache` build.

:::

`stim ios` and `stim android` first check the machine-wide artifact cache. A hit
installs the saved `.app` or `.apk`. A miss runs the native build and stores the
result. Two matching misses use one build through a single-flight lock.

Computing the fingerprint evaluates app config and autolinking in child processes.
Stim stores reusable observations in `$STIM_HOME/fingerprint` (`~/.stim`
by default). A run reuses a part only when its recorded inputs and environment
still match. Opaque parts are evaluated again. A run that uses the index checks
its result in the background; if the check disagrees, Stim drops the record and
warns. At the end of a run, Stim cancels a check still running after three
seconds and waits for its subprocess cleanup to finish.
Cleanup proof covers evaluator process groups. Project-created detached
sessions require project-managed cleanup.

With `daemon.mode` on, Stim can precompute fingerprints for active workspaces
in low-priority child processes when their HEAD, lockfile or install stamp
changes. A changed input or environment still invalidates the reused parts.
Doctor and post-prebuild checks compute without the index.

After local and configured-provider misses, development builds can reuse an
exact completed archive from an enabled paired build worker with
`react-native-peer-cache`. The query includes the post-prebuild/pod-install
fingerprint, native options and compatible toolchain. The worker retains the
completed archive even after changing or removing its checkout. A hit needs no
source upload or compilation slot. Missing or corrupt archives use normal build
placement. Remote mode off, an explicit local build, and disabled remote
artifact reads skip this lookup. Release and physical-device builds keep their
existing paths.

To find out before a run whether it will hit, and how long it should take, run
`stim ios --plan` or `stim android --plan`. See
[Predict the next build](./commands.md#predict-the-next-build). Stim Desktop
and the phone app run the same check when a workspace opens and show the
result on its build row.

A bare app whose Xcode project is not in `ios/` sets `ios.projectPath` to its
directory, relative to the app. A subdirectory is hashed the way `ios/` is. When
the project sits in the app directory itself (`"."`), Stim cannot tell the
native sources from the JavaScript beside them, so it hashes every top-level
entry except `node_modules`, `Pods`, `build`, `android`, `.stim.json` and
anything git ignores: a JavaScript edit
then misses the cache and rebuilds incrementally rather than reusing a build
that might be stale.

```json
{ "ios": { "projectPath": "." } }
```

In an Expo project that gitignores `ios/` or `android/` (Continuous Native
Generation), the fingerprint hashes the app config instead of the native
directory. Stim records the fingerprint of each prebuild it runs. When a native
build is needed and the existing directory was not generated from the current
fingerprint, for example after a config plugin change, Stim updates it in place
with `expo prebuild --no-clean` before building (plain `expo prebuild` before
Expo SDK 57, whose CLI keeps the directory by default). On iOS it then runs
`pod install` against the existing `ios/Pods`, so only changed pods are
reinstalled. A build offloaded to another machine still regenerates that
machine's copy with `--clean`, because deleting your local directory does not
reach it. A committed native directory is part of the key and is never
regenerated.

An in-place prebuild reapplies the current app config over the existing
directory but does not undo what earlier config wrote. Delete the gitignored
`ios/` or `android/` before the next `stim ios` or `stim android` after a
change that has to remove something or needs a fresh template:

- removing a config plugin, or an app config entry that a plugin turned into a
  native setting such as a permission, entitlement, URL scheme or extra target
- upgrading the Expo SDK or React Native, because Expo copies its native
  template only into a missing directory
- renaming the app, when the Xcode project and target names should follow
- a config plugin that fails or duplicates its edit when it runs twice

Stim then generates the directory from scratch and runs a full `pod install`.
If you already built after such a change, that build is cached under the
current fingerprint, which deleting the directory does not change. Pass
`--no-build-cache` on the next build so it compiles from the fresh directory.
Hand edits in a gitignored directory survive an in-place update unless a plugin
rewrites them, and are lost when it is deleted, so keep native settings such as
the signing team in the app config or a config plugin.

Stim only knows about prebuilds it ran. If you run `expo prebuild` yourself with
a different config, delete the native directory before the next `stim ios` or
`stim android`.

### Inputs edited during a build

Stim fingerprints the project again after the compile, so it never stores an
artifact under a key its inputs no longer match. Changes the build makes to
files under `node_modules/` or the native directory, such as a Gradle plugin
rewriting a library manifest, move the key and the artifact is stored under
the new one. Stim cannot tell your own edits in those directories during the
compile apart from the build's. An edit to the app config or a config plugin
at any point during the run, or to any other input during the compile, means
the artifact may not match. The only config change Stim accepts is the
`ios.bundleIdentifier` or `android.package` that `expo prebuild` adds to a
static `app.json` that lacks one. Otherwise Stim installs the artifact for the
current run, and skips the local cache, the cache provider, and remote uploads:

```text
  fingerprint expoConfig changed while the build ran, so the artifact may not match its key; the build will be installed but not cached
```

The next run regenerates a gitignored native directory from the edited config
and builds it.

Release configurations use separate keys. On a cache hit for an iOS simulator
or Android target, Stim regenerates the current workspace's JavaScript and
assets in a copy of the artifact. In an app with `expo-updates`, the copy's
embedded update also gets a new id and the current time, as a full build
would, so an update the app downloaded earlier cannot launch instead of your
JavaScript. The swap points Metro's default cache at a directory private to
the workspace, emptied whenever the `EXPO_PUBLIC_` values, `EXPO_NO_DOTENV`,
`NODE_ENV` or the project's `.env` files change, so it does not inline values
from another build on the same machine. A `metro.config.js` that sets its own
`cacheStores` keeps that cache location.
If that swap fails, it builds fresh. iOS physical-device Release
runs always build fresh.

When a native Release build executes its bundling task on Expo SDK 54–57,
Stim replaces all Metro transform stores with a fresh build-private store,
then removes it when the build ends. Project Metro configuration still loads,
including an existing `EXPO_OVERRIDE_METRO_CONFIG`; native tools keep their
ambient `TMPDIR`. This prevents stale `EXPO_PUBLIC_` transforms in CI. SDK 53
and earlier lack Expo's config override and are not isolated; SDK 58 and later
include Expo's transform cache fix. This does not fix Gradle skipping its bundle
task when environment values change ([upstream PR](https://github.com/expo/expo/pull/49839)).

SDK 53 projects can opt in to a different Metro transform key when public
environment values change. Add this after creating and merging your existing
`config` in `metro.config.js`, before exporting it:

```js
const { createHash } = require('node:crypto');
const publicEnv = Object.entries(process.env)
  .filter(([name]) => name.startsWith('EXPO_PUBLIC_'))
  .sort(([a], [b]) => a.localeCompare(b));
const publicEnvKey = createHash('sha256').update(JSON.stringify(publicEnv)).digest('hex');
config.cacheVersion = `${config.cacheVersion ?? ''}:${publicEnvKey}`;
```

This preserves the existing `cacheVersion` and `cacheStores`. It varies the key
for effective `EXPO_PUBLIC_` values; it does not make Gradle execute a skipped
bundle task.

### Generated dependency output and cache misses

A build that misses the cache says why before it compiles:

```text
  cache       miss: native dependency added: expo-clipboard (+2 more)
```

Stim compares the build's fingerprint sources with the last build of the same
platform in this workspace, or else with the newest build of the same project
in another worktree. `stim status --json` reports the reason as
`build.missReason` while the build runs (as soon as the first lookup misses,
with `build.missProvisional` until a prebuild or pod install has been followed
by a second lookup) and keeps it under
`lastBuilds.<platform>.missReason`, and Stim Desktop and the phone app show it
on the workspace's build row. `builds.<platform>` keeps the same facts for the
last 10 runs, so you can see which run turned a hit into a miss. `stim ios --plan` and `stim android --plan` give
the same reason before a build, and the apps show it under "Next build".

If a remote iOS pod install changes the key, Stim stores the artifact under the worker’s returned key. The worker does not return verified input rows for that new key, so that entry cannot serve as a detailed miss-explanation baseline.

If identical worktrees build instead of reusing an artifact, compare their
fingerprint sources before adding exclusions. A project-level
`.fingerprintignore` can exclude generated output that does not affect native
inputs. Never ignore an entire native dependency, its build scripts, or source
files to force a cache hit.

Use the input names reported by Stim to identify an unnecessary generated file.
Keep native source, build scripts and configuration in the key, and verify that
a real native input change still invalidates it.

### EAS development builds

With `--eas-profile <name>`, Stim downloads a compatible EAS development build
and uses EAS CLI's artifact cache directly. It does not add another Stim cache
copy or compile locally on a miss. See [EAS development builds](./eas-builds.md)
for profile selection, device support, and cache behavior.

### Optional artifact providers

`@stim-cli/cache-s3` is a separate provider for S3-compatible storage,
including Cloudflare R2. Without a configured provider, artifacts stay on the
local machine. Its AWS SDK and archive dependencies are installed only when
you install that provider. Stim does not run a hosted cache service.

Projects can supply a module through `cache.provider` using the
[`stim/plugin` cache contract](https://github.com/appandflow/stim/tree/main/packages/cache),
or use a configured Expo `buildCacheProvider`, such as `eas`.
Cache providers declare `"stimPlugin": { "kinds": { "cache-provider": 1 } }`
in package.json; Stim checks it before importing the module. A provider's
`metro` capability is ignored; Metro uses its local filesystem store.
Custom Expo provider modules run in isolated workers with the workspace environment.
Inspection and lookup have 30-second request budgets; upload has a 60-second
budget, followed by verified worker cleanup. Plugin output appears in build logs.
Each request loads a fresh module; module globals are not shared between phases.
Legacy uploads finish before Stim installs or exports the built app.
`optimizations.remoteBuildCache` controls whether Stim uses those providers.
Provider and build-profile restrictions still apply; see
[build optimizations](./build-optimizations.md#compare-compiler-settings).
This caches app artifacts; ccache and Clang CAS use separate compiler caches.

Expo's `eas` tier needs `eas-build-cache-provider` in the app and an installed
`eas-cli` in the app or on `PATH`. Stim runs fixed EAS CLI commands without
loading the provider SDK into the caller. Fingerprint generation uploads
fingerprint metadata to EAS. Fingerprint and transfer commands share one deadline
within each resolve/upload phase; timeout or cancellation stops the CLI process
before returning. Stim never
installs `eas-cli` during cache lookup. Custom Windows batch launchers need a
project `eas-cli` installation so Stim can stop the Node process directly.

Install `@stim-cli/cache-s3` in the app and select the S3 provider in `.stim.json`:

```json
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

Use a private R2 bucket and an R2 token scoped to Object Read & Write on that
bucket. Save the credentials through the AWS SDK's standard credential chain;
for a named profile, set `cache.options.profile` to `stim-r2` or run
`AWS_PROFILE=stim-r2 stim ios`. An explicit cache profile overrides the ambient
AWS profile. Keep secrets out of
committed settings. See [Cloudflare's setup guide](https://developers.cloudflare.com/r2/get-started/s3/).
For AWS S3, omit `endpoint` and use the bucket's region. Other compatible
services may require `forcePathStyle: true`.

The same transport shares Metro values and complete native artifacts, with
local caches checked first, digest verification and cancellable transfers.
Use matching native toolchains for the initial test: the provider uses Stim's
existing keys and does not add a toolchain partition. It does not synchronize
dependency directories or compiler caches. Bucket lifecycle rules own remote
retention; local GC never deletes shared objects. Single-object PUT uploads are
limited to 5 GiB per entry. Connection resets retry the completed file with a
fresh stream, up to three PUT attempts with cancellable delays. Conditional
writes preserve an existing entry even if an upload committed but its reply
was lost.

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

The first command only reports sizes, what the
[pressure ladder](#disk-pressure) would free now at high and at critical, and
each workspace's stage. Age-based cleanup removes unused entries.
`gc --delete` without `--cache` also runs the pressure ladder to its end at
high, whatever the machine measures. `--cache all` empties managed caches and
makes future builds cold, and with `--delete` runs the ladder at critical
instead; it prunes no stale entries, so `gc --delete` on its own remains the
way to do that.
`--cache "compilation cache"` empties one cache instead of every one.

The one exception to leaving caches alone is the Swift compilation cache. When
it is over `caches.swiftCompilationCacheMaxGb` (default 0, no cap), a plain
`stim gc --delete` empties it whole, as automatic maintenance does. It cannot be
trimmed by age without corrupting its index. The cache is kept, with the build
named, while an iOS build holds its claim on it.

A full disk or a killed build can leave a damaged object in the Xcode
compilation cache. When an iOS build that used it fails with the compiler's
own corruption error, such as `OnDiskCAS: corrupt internal reference` or
`CAS operation failed`, Stim empties the cache the same way and fails with
`STIM_COMPILATION_CACHE_CORRUPT`. Run the command again; that build is a cold
one. Stim leaves the cache alone while another build is compiling with it, and
the error says so. The emptying is recorded in the maintenance log. A build
worker does the same for its own cache. A build sent there with
`--remote-build <machine>` fails with that code; one placed there
automatically builds here instead.

A cached iOS simulator app can be damaged without failing to build. If a
cache-hit app is killed at launch because dyld cannot bind a symbol that one
part of the app needs from another part of the same app, Stim removes that
entry from the shared cache and fails with `STIM_LAUNCH_FAILED` naming it. Run
the command again to build the app fresh. A crash that the app's own bytes did
not cause, such as a missing system library, leaves the entry alone, and so
does an app built by the same run. A cache provider keeps its own copy of an
entry; add `--no-build-cache` to skip it.

Each iOS build holds a shared claim on the compilation cache while xcodebuild
runs, in a `compilation-cache.claims` directory beside it. `gc --delete
--cache`, automatic maintenance, the pressure ladder and the corruption check empty the cache only
after taking that claim exclusively, so none of them can empty it under a
running xcodebuild. Xcode builds you run outside Stim take no claim.

### Workspace build outputs

Each workspace keeps its own `derived-data/`, `gradle-build/`, `android-cas/`,
`cache-provider/`, the Release swap's Metro cache `js-swap-tmp/`, SwiftPM scratch directory `macos/build`, staged
`macos/<Product>.app` and interrupted-build `macos/staging-*` directories under
`$STIM_HOME/workspaces/<name>/`. They usually take most of the disk Stim uses. `gc` reports them as one cache, "Workspace build
outputs", with the size, last use and verdict of each workspace.

<StimTabs
code={`stim gc --delete
stim gc --delete --cache workspaces
stim gc --delete --cache workspaces --older-than 7`}
/>

`gc --delete --cache workspaces` clears the outputs of every workspace that is
not building and did not run `stim ios`, `stim android` or `stim macos` in the
last 15 minutes, and prints the bytes it freed for each. Plain `gc --delete`
clears them only through the [pressure ladder](#disk-pressure): for a workspace
with nothing running idle 2 minutes or more, and in the idle stage of a running
one. A workspace whose worktree is locked with `git worktree lock` keeps its
outputs at any disk pressure level, and so does a workspace whose worktree git
cannot list. A running dev server, a booted or hosted simulator or emulator, or
a tunnel does not keep the outputs. They stay while a `stim ios` or
`stim android` run holds the workspace, a build names it, or its macOS app or
build runs or cannot be verified. Clearing them also clears the
project's own `android/app/build`, `android/build`, `android/.gradle`, `.build`,
the CMake directories `android/.cxx` and `android/<module>/.cxx`, a `.dd`
directory laid out as Xcode DerivedData (a `Build/` directory beside
`ModuleCache.noindex` or `Logs/`), and an Exact app's Cargo `target/` (kept while
another process, such as a shell or an `exact.mjs` command, runs from or works in
the app, and on Windows) when git ignores every file in the
directory and tracks none.
`ios/build` stays, because React Native's `pod install` writes files there that
only `pod install` recreates. The shared build cache, the Xcode compilation cache, the Gradle caches
and the Metro cache are never touched. With `--cache workspaces`,
`--older-than <days>` clears only workspaces no Stim command has used for that
many days. `--cache workspaces` clears the outputs and nothing else, and
`--cache all` includes them.
`--cache parked` is the one reserved name that `all` leaves out: it erases
parked simulators and emulators (see [owned devices](./owned-devices.md)). The
workspace keeps its `workspace.json`, `state.json`, logs, devices, ports and
running dev server, along with `macos/` itself, `macos/runtime.lock`, its claim
set and other macOS files.

The next build of an unchanged app installs from the shared build cache. After
a native change, the Xcode compilation cache speeds up the rebuild. On React
Native 0.86, Swift does not use that cache because explicit modules are off,
so the first iOS build after a native change recompiles Swift. The next
`stim macos` recreates its scratch directory with a full Swift build and
restages the app.

### Worktree dependencies

At critical, the [pressure ladder](#disk-pressure) deletes the `node_modules`
and `ios/Pods` of idle linked worktrees that have a Stim workspace, never the
source checkout's. The `stim-daemon` does this at critical disk pressure, and
`gc --delete --cache all` runs the ladder at critical whatever the machine
measures. A worktree locked with `git worktree lock` always keeps them, so a
rollback checkout stays runnable. Otherwise a worktree keeps them while its dev
server runs or a native run or build holds it, for 2 minutes after its last
git or Stim activity or a write at its top level, while git tracks a file in
them, and while a stim service, the `stim` on your PATH or a running
process (by command line or working directory) uses the worktree.
It also keeps them when `stim worktree warm` could not restore the same
versions: the source checkout lacks the directory, or the worktree's lockfile
differs from the source checkout's. Stim records what it deleted, and the next
`stim start`, `stim ios` or `stim android` in that worktree runs
`stim worktree warm` first to restore it. If that warm fails or leaves a
directory missing, the command refuses with `STIM_DEPS_FAILED`. Other commands,
such as a test run, find the directory missing until then. `.pnpm-store`
stays, because it is all clones and deleting it frees nothing.

### Device recordings

`stim-server` records owned simulators, emulators and the Stim-owned Chrome
page while an agent or automation tool drives them, or while the phone app
watches them. The phone app uses these recordings to scrub back through what
happened. They live in `recordings/` in each workspace directory. `stim-server`
keeps the last 15 minutes of footage per device and at most 1 GiB across the
Stim home, deleting the oldest footage first. Idle time and time after
`stim stop` do not age footage out, so a stopped workspace stays replayable.

<StimTabs
code={`stim gc
stim gc --delete --cache recordings
stim gc --delete --older-than 7`}
/>

`gc` lists each workspace's recordings and their size. Plain `gc --delete`
deletes only the recordings of dead or orphaned workspaces, with their
workspace directory, and keeps them when it cannot prove the project is gone.
`--cache recordings` deletes every workspace's recordings and nothing else, and
`--cache all` includes them. `--older-than <days>` deletes footage recorded
before then. `stim worktree remove` deletes the workspace's recordings with its
directory. To stop recording altogether, see
[Device recordings](./settings.md#device-recordings).

Set `STIM_BUILD_CACHE` or `STIM_METRO_CACHE` to an absolute path to place the
shared caches on a different volume. The same values can live in the machine config under
`caches.buildCache` and `caches.metroCache`.

## Automatic maintenance

Stim automatically trims its own caches, idle build outputs and parked devices, and can remove [finished worktrees](./worktrees.md#remove-finished-worktrees-in-bulk). Run `stim gc` to preview cleanup and `stim logs --source maintenance` to see the workspace's recent cleanup activity.

Set `daemon.mode` to `report` to see plans without automatic deletion, or `off` to disable automatic maintenance. It defaults to `on` outside CI. Use `maintenance.keep` to protect a workspace from maintenance cleanup. [Maintenance settings](./settings.md#automatic-maintenance)

<StimTabs code="stim settings set daemon.mode report --scope machine" />

### Disk pressure

Pressure is the `stim-daemon`'s, not a maintenance check. Each tick classifies
the machine **normal**, **high** (free disk under `disk.minFreeGb`, 20 GB,
on any volume Stim writes to; macOS memory pressure warning for 10 minutes; or
under 10% of RAM available) or **critical** (under `disk.criticalFreeGb`, 6 GB,
or under `disk.hardFloorGb` when that is higher; or critical memory pressure),
and above normal runs one ladder top-down until the level clears:

| Rung | High                                                                                                               | Critical                                                                                                                |
| ---- | ------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------- |
| 1    | The idle stage for every workspace idle 2 minutes; build outputs of workspaces with nothing running                | Same                                                                                                                    |
| 2    | Parked simulators and emulators, oldest first, until the level clears                                              | All parked devices                                                                                                      |
| 3    | Build and Metro caches trimmed, least recently used first, to half their caps                                      | Metro and Swift compilation caches emptied; build cache trimmed to the entries a workspace, parked device or build uses |
| 4    | The dormant stage for workspaces idle 10 minutes                                                                   | The dormant stage for every idle workspace                                                                              |
| 5    | Nothing                                                                                                            | `node_modules` and `ios/Pods` of idle linked worktrees holding 256 MB of their own, restored by `stim worktree warm`    |
| 6    | Idle Gradle and Kotlin daemons, an unused watchman, unpinned Gradle versions, TMPDIR leftovers, the worktree trash | Same                                                                                                                    |

Cleanup protects active builds, leases, live shares and pinned workspaces. At critical disk pressure it can remove dependencies from idle linked worktrees. Run `stim worktree warm` to restore missing copies from the source checkout. The source checkout's dependencies stay in place.

Run `stim gc` to preview high and critical cleanup. `stim gc --delete` runs the high ladder, and `stim gc --delete --cache all` runs the critical ladder, regardless of the current pressure. Use `stim status` to see the measured level and `stim logs --source gc` to see what cleanup removed.

If a run reports `STIM_LOW_DISK`, free disk space and retry. See the installed reference for the full cleanup rules and recovery options.

<StimTabs code="stim guide cleanup" />
