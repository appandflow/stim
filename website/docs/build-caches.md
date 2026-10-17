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
normally. Off mode, an explicit local build and disabled remote artifact reads
skip peer lookup. The returned offload fingerprint remains `null`; a worker key
is never published under the caller's identity.

`optimizations.buildCache=false` disables artifact reads and writes.
`--no-build-cache` skips reads and shared-build waits but stores the fresh build. `--plan` performs the same read-only local check.

### React Native and Expo inputs

Stim uses `@expo/fingerprint` to identify native inputs in both Expo and bare
React Native projects. The cache key also includes the platform, target, and
build configuration or variant. A build for one CPU architecture adds it: an
Android Debug build for a known ABI ends in that ABI (`-arm64-v8a`), and an iOS
Debug simulator build or a `--remote` build ends in its architecture (`-arm64`
or `-x86-64`). A local iOS Release simulator build compiles every architecture
the project lists and has no suffix.

`stim ios` and `stim android` first check the machine-wide artifact cache. A hit
installs the saved `.app` or `.apk`. A miss runs the native build and stores the
result. Two matching misses use one build through a single-flight lock.

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
fingerprint, for example after a config plugin change, Stim regenerates it with
`expo prebuild --clean` before building. This discards hand edits in the
gitignored directory, so keep native settings such as the signing team in the
app config or a config plugin. A committed native directory is part of the key
and is never regenerated.

Stim only knows about prebuilds it ran. If you run `expo prebuild` yourself with
a different config, delete the native directory or run
`expo prebuild --clean` before the next `stim ios` or `stim android`.

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
JavaScript. If that swap fails, it builds fresh. iOS physical-device Release
runs always build fresh.

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

`@stim-cli/cache-s3` is a separate provider for S3-compatible storage,
including Cloudflare R2. Without a configured provider, artifacts stay on the
local machine. Its AWS SDK and archive dependencies are installed only when
you install that provider. Stim does not run a hosted cache service.

Projects can supply a module through `cache.provider` using the
[`@stim-cli/cache` contract](https://github.com/appandflow/stim/tree/main/packages/cache),
or use a configured Expo `buildCacheProvider`, such as `eas`.
Custom Expo provider modules run in isolated workers with the workspace environment.
Inspection and lookup have 30-second request budgets; upload has a 60-second
budget, followed by verified worker cleanup. Plugin output appears in build logs.
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

The first command only reports sizes. Age-based cleanup removes unused entries.
`--cache all` empties managed caches and makes future builds cold; it reaps
nothing, so `gc --delete` on its own remains the way to prune stale entries.
`--cache "compilation cache"` empties one cache instead of every one.

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

Each iOS build holds a shared claim on the compilation cache while xcodebuild
runs, in a `compilation-cache.claims` directory beside it. `gc --delete
--cache`, automatic maintenance and the corruption check empty the cache only
after taking that claim exclusively, so none of them can empty it under a
running xcodebuild. Xcode builds you run outside Stim take no claim.

### Workspace build outputs

Each workspace keeps its own `derived-data/`, `gradle-build/`, `android-cas/`,
`cache-provider/`, SwiftPM scratch directory `macos/build`, staged
`macos/<Product>.app` and interrupted-build `macos/staging-*` directories under
`$STIM_HOME/workspaces/<name>/`. They usually take most of the disk Stim uses. `gc` reports them as one cache, "Workspace build
outputs", with the size, last use and verdict of each workspace.

<StimTabs
code={`stim gc --delete
stim gc --delete --older-than 7
stim gc --delete --cache workspaces`}
/>

Plain `gc --delete` clears the build outputs of every workspace that is not in
use. A workspace is in use while its dev server runs, a `stim ios` or
`stim android` run holds it, a build names it, or a tunnel or remote lock is
held. A running, building, unverified or hosted macOS app also keeps its
workspace untouched. `--older-than <days>` clears only workspaces no Stim
command has used for that many days. `--cache workspaces` clears the outputs and nothing else, and
`--cache all` includes them. `--cache parked` is the one reserved name that
`all` leaves out: it erases parked simulators and emulators (see
[owned devices](./owned-devices.md)). The workspace keeps its `workspace.json`,
`state.json`, logs, devices and ports, along with `macos/` itself,
`macos/runtime.lock`, its claim set and other macOS files. The project's own
`.build` stays.

The next build of an unchanged app installs from the shared build cache. After
a native change, the Xcode compilation cache speeds up the rebuild. On React
Native 0.86, Swift does not use that cache because explicit modules are off,
so the first iOS build after a native change recompiles Swift. The next
`stim macos` recreates its scratch directory with a full Swift build and
restages the app.

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

CLI commands, `status --watch` and every running dev server supervisor start a
detached maintenance pass when a check is due, so the disk check runs each
minute while a dev server or Stim Desktop is running even when no command does. In the default `on` mode a pass removes what `stim gc --delete`
would remove, under the caps and floors in
[settings](./settings.md#automatic-maintenance). In `report` mode it only
measures, plans and logs.
Disk and memory pressure are checked every minute, Stim-owned directory sizes
every hour, finished worktrees every 15 minutes and the age sweep once a day.
On macOS the memory signal is the sysctl pressure level, with no signal when
sysctl fails. Only other platforms use `os.freemem()`. Memory pressure is
recorded; below disk pressure level 3 a pass never shuts down idle devices or
dev servers or stops helpers.
Removing a finished worktree or orphaned directory does tear down that
workspace's own dev server, owned devices and Chrome profile, as `gc --delete` does.
Size, worktree and sweep checks defer under high host load. The size scan covers
workspace build outputs, native build and Metro caches, ccache, Swift
compilation cache, and other registered Stim caches. It also records the disk of
each owned and parked simulator and emulator, which `stim status` reports as
`owned devices`. Other tools' caches are not managed by this feature.

In `on` mode a pass works through these steps, cheapest to rebuild first, and
stops the disk-driven ones once free space is back above the floor:

1. Orphaned workspace directories whose project is gone, and registered caches
   whose directory no longer exists.
2. Build outputs of idle workspaces: over `maintenance.workspaceOutputsMaxGb`,
   below the free-disk floor, or unused for `maintenance.olderThanDays`.
3. Native build and Metro cache entries, least recently used first, down to
   `maintenance.capTargetPercent` of their caps, plus entries unused for
   `maintenance.olderThanDays`.
4. The Swift compilation cache, emptied whole, only below
   `budget.hardFloorDiskGb`. It is kept while an iOS build holds its claim on
   the cache, or while that claim is unresolved. The cache is LLVM's
   on-disk content store, whose entries live inside shared database files, so
   Stim cannot remove only the entries a running build does not need.
5. Linked worktrees whose branch or pull request finished, by the same rules as
   `stim gc --delete` and `gc.worktreeGraceMinutes`.
6. Owned simulators and emulators of a finished worktree that is kept, such as
   a dirty one, once idle for `gc.worktreeGraceMinutes`, and of any workspace
   idle for `maintenance.deviceIdleDays` (3 days) in the daily sweep. Idle
   means no dev server, native run, build, lease, managed lock, driven or busy
   device, and no recorded use. The next run recreates them.

A pass keeps a workspace that is in use, holds a lock, was used within
`maintenance.protectRecentHours`, or is the workspace of the command that
started the pass. It keeps cache entries used within that window, entries named
by a project's last builds, a parked device or a running build, and Metro
entries of a project with a running dev server. Anything it cannot verify is
kept. Pin a workspace against all of this with `maintenance.keep`. ccache
limits itself through `caches.ccacheMaxGb`. The first build after a clear
rebuilds what was removed.

### Disk pressure levels

When free disk keeps falling, maintenance escalates:

| Level | When                                                                                           | What a pass adds                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| ----- | ---------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1     | Under `budget.minFreeDiskGb` (20 GB)                                                           | The steps above.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| 2     | Under `maintenance.urgentFreeDiskGb` (12 GB), or level 1 could not get back above the floor    | Build outputs of workspaces unused for `maintenance.pressureProtectMinutes` (10 minutes) instead of `protectRecentHours`; parked simulators and emulators; build directories of idle worktrees (`ios/build`, `android/app/build`, `android/build`, `android/.gradle`, SwiftPM `.build`, at the worktree root, a project root, or `apps/*` and `packages/*`); owned simulators and emulators of workspaces idle for the short window; Stim temp directories and xctrace recordings in TMPDIR unmodified for 24 hours, with the checks of `stim gc --delete`.                                                                                                                                                                                                                                              |
| 3     | Under `maintenance.criticalFreeDiskGb` (6 GB) or `budget.hardFloorDiskGb`, where builds refuse | The Swift compilation cache; finished worktrees, and clean, pushed worktrees with no commits of their own beyond the default branch, with the short window as their grace period, unless `maintenance.removeFinishedWorktrees` is false; workspaces whose dev server runs but that are otherwise inactive for the short window, whose dev server stops and whose owned simulators and emulators are deleted; `node_modules` and `ios/Pods` of idle linked worktrees, never the source checkout; idle Gradle and Kotlin daemons, as `gc --delete --cache gradle-daemons` stops them, only when they are all that keeps an unpinned Gradle version, and then Gradle version caches and wrapper distributions no registered project pins, once unmodified for `maintenance.gradleVersionIdleDays` (7) days. |

Each step re-measures free disk first and stops once it is back above its
level's floor: the budget floor for levels 1 and 2, the level 3 floor for level 3. A directory is cleared only when it is a real directory inside its worktree,
git tracks nothing in it, its worktree is not in use, locked, building or
pinned, and nothing under it, nor the worktree's git index, HEAD or Stim state,
changed within the short window. A dirty or unpushed worktree can still be
stopped and have these directories cleared; only its removal is refused. Caches
owned by other tools, such as the pnpm and npm stores, CocoaPods, SwiftPM and
the shared Gradle caches, are never deleted; at level 3 only the version
caches and wrapper distributions of Gradle versions no registered project pins
go, with the checks of `stim gc --cache gradle-versions`.

`stim status` shows the current level. At level 3 the last pass names the
shortfall in `stim status`. When a build keeps the Swift compilation cache, it
also names the cache's size and that build. While the last check, at most 10
minutes old, measured level 3, every Stim command prints one warning on stderr.

`stim status` shows the last plan and any running pass. `stim gc` previews the
next pass using live pressure and cached sizes; it does not rescan sizes for
that preview. `stim gc --json` carries the preview in a top-level `maintenance`
key; `sections` remains arrays of entries. With `--cache`, the preview excludes
device actions. `stim logs --source maintenance` shows this workspace's records;
add `--errors` for failures after the latest launch marker.
The machine log is `$STIM_HOME/maintenance/maintenance.ndjson`; `stim doctor`
prints its path. It rotates at 1 MiB by default, retains the rotated generation
for 30 days, and logs debug checks only with `maintenance.logChecks` enabled.
In report mode actions and explaining skips are logged only when newly planned.
In on mode every action taken, failure and explaining skip is logged with its
size, and pass records carry the bytes freed. Removed worktrees and orphaned
directories appear in the machine log only.
The hook skips every `stim gc` invocation, and live or unresolved claims.
`stim gc` without `--delete` prints the maintenance plan itself. Failed attempts
back off for at least one minute; child crash logs are truncated above 64 KiB.
`status` and `doctor` report unresolved claims with a removal command to run
only after confirming the holder is gone. Invalid maintenance settings appear
in `invalid` and disable passes; an invalid cache cap falls back to its own
default and is reported there.
A pass and `gc --delete` share an exclusive claim; a held claim makes gc refuse
with the holder and recovery guidance.
Each pass keeps a 1 MiB file, `maintenance/disk-reserve`. When taking its claim
fails because the disk or quota is full, the pass deletes that file and tries
once more, so it starts at zero free disk as long as an earlier pass left the
reserve. It writes the file again when it ends.

The default mode is `on`, or `off` under `STIM_HOME` or `CI` unless
`STIM_MAINTENANCE` is explicit. Passes delete by default. Turn them off, or
keep only the plan and the log, with:

<StimTabs code="stim settings set maintenance.mode off" />

<StimTabs code="stim settings set maintenance.mode report" />

Pin one workspace with `stim settings set maintenance.keep true` in its project.

Copy this agent prompt:

```text
Run stim status and stim gc. Show me the automatic maintenance plan and any
blocked targets, then read stim logs --source maintenance in this workspace.
```
