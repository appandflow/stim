# End-to-end tests and CI

Per-workspace runtime state and logs live outside the project tree under
`$STIM_HOME/workspaces/<readable-project-slug>--<16hex-path-digest>/` (by
default `~/.stim/workspaces/...`). Stim does not create a project
`.gitignore` entry for this state.

Stim has three test layers. The unit suite (`pnpm test`, Vitest, more than
2,000 cases across five packages) is the bulk of the coverage. On top of it sit
two end-to-end layers that exercise the _published loop_ rather than individual
functions. The separately built runtime-floor job loads every published ESM
entry point on Node 22.12.0.

## The fast cross-platform e2e

`test/e2e/cache-flow.e2e.js`, run with:

```bash
pnpm run test:e2e
```

Published packages support Node 22.12.0 or later. Repository development,
including this suite, uses Node 22.18 or later. CI runs the suite on Node 22 and
24; the separate runtime-floor job loads every published entry point under
exactly Node 22.12.0. Git is also required.
The suite needs **no Xcode or Android SDK**.
It drives the real CLI and the real cache library end to end under a throwaway
`STIM_HOME` and a throwaway temp repo, so it never touches the machine's real
caches, registry, or checkouts. What it proves:

1. Git creates real linked worktrees at one commit. `stim worktree warm`
   copies missing ignored state from the source checkout, preserves existing entries and the
   branch, and keeps stdout empty.
2. Two worktrees of one commit **fingerprint identically when scoped to a
   platform** (the cross-worktree cache premise) -- and diverge under `ios/`
   when a worktree-local path leaks in, which is exactly why the hash is scoped.
3. A build stored under wt1's key **resolves from wt2's key**: a cross-worktree
   cache hit with no compiler. Change a native input in wt2 and the key changes
   and the hit becomes a miss.
4. Two real node processes racing the single-flight build lock: **exactly one
   builds**, the other waits and resolves the artifact the first one stored.
5. `stim worktree remove` refuses a dirty tree, then removes a clean linked
   worktree, warmed or not, without requiring a Stim registry entry. It leaves
   no workspace directories or config entries and retains Git-created branches.

The one non-real piece is the leaf hash function: the real CLI has a direct `@expo/fingerprint` dependency, while this fast suite injects a deterministic platform-scoping stub (`test/e2e/fixtures/fingerprint-stub.mjs`) through the `load` seam. Everything else -- `buildCacheKey`, `storeBuild`, `resolveBuild`, `acquireBuildLock`, the worktree CLI -- is the real library.

## The native e2e

There are four native suites and one shared harness
(`test/e2e/native/harness.mjs`, which owns the fixture creation, the process
wrappers, the cleanup checks and the diagnostics dump so all drivers build and
tear down the same app the same way):

| suite      | driver                       | proves                                                  | platforms           | when                                        |
| ---------- | ---------------------------- | ------------------------------------------------------- | ------------------- | ------------------------------------------- |
| **smoke**  | `run-native-e2e.mjs --smoke` | one worktree builds, launches and stops                 | iOS, Linux, Windows | every push to `main`, `e2e-smoke`, dispatch |
| **loop**   | `run-native-e2e.mjs`         | the dev loop works end to end                           | iOS, Linux, Windows | nightly, `e2e-loop`, dispatch               |
| **caches** | `run-cache-e2e.mjs`          | each individual cache is engaged, storing and reused    | iOS, Linux          | `e2e-caches`, dispatch                      |
| **pool**   | `run-pool-e2e.mjs`           | iOS simulators are parked, evicted, adopted, and reaped | iOS                 | `e2e-pool`, dispatch                        |

The `e2e-*` names are pull-request labels; the `e2e-all` label is loop, caches
and pool together. See [CI](#ci) for the gate.

### The loop suite

`test/e2e/native/run-native-e2e.mjs` codifies `docs/field-test-protocol.md` as
an executable. It creates a real app, runs the real `start` -> `ios|android`
loop against a real simulator/emulator with a real compiler, and proves the
cache actually engages on a second worktree. It is a 2x2 matrix:

```
framework in {bare, expo}   x   platform in {ios, android}
```

bare and expo are not cosmetic variants: bare hosts Metro **in-process**
(`start` mode `bare-inproc`); expo spawns `expo start` as a **child** (mode `expo-child`) and
prebuilds first. The driver asserts the start mode explicitly per variant --
this is the `detectIsExpo` path a field test caught misfiring on a wrapper-less
`app.json`. Per variant it asserts: correct start mode; a cold build produces a
real artifact; the second worktree hits the local cache with **no compile**
(proven from the build log, not just the JSON); and the protocol's five cleanup
checks pass.

It is **slow and occasionally flaky by nature**, so it is not run on every push.
Run one variant by hand:

```bash
node test/e2e/native/run-native-e2e.mjs --framework bare --platform ios
node test/e2e/native/run-native-e2e.mjs --framework expo --platform android
# safe, no device/build: create the fixture then stop
node test/e2e/native/run-native-e2e.mjs --framework expo --platform ios --fixture-only
# print the plan, no side effects
node test/e2e/native/run-native-e2e.mjs --framework bare --platform android --dry-run
# the smoke subset: fixture, one worktree, stim start, cold build, launch, stop, cleanup
node test/e2e/native/run-native-e2e.mjs --framework bare --platform android --smoke
```

`--smoke` stops after the first worktree has been built, launched, verified and
stopped: no second-worktree cache proof, no named slots. CI restores the
cross-run build cache before it, so a run whose native fingerprint matches an
earlier loop or smoke installs from cache. Observed on the `e2e-smoke` run of
#905: iOS 17 minutes and Linux Android 3 minutes with the cache warm (the iOS
time is fixture creation, `pod install` and simulator boot; the build phase
was 86 and 52 seconds), Windows Android 17.5 minutes cold, of which the Gradle
build was 13.5. A run that changes the fingerprint pays the cold build on
every platform.

The fixture-creation commands are version-sensitive; each is overridable with an
env var (`STIM_E2E_BARE_INIT`, `STIM_E2E_EXPO_INIT`) so a runner can adjust
them without touching assertion logic.

Native runners check their environment before preparing the fixture. Android
requires `ANDROID_HOME` or `ANDROID_SDK_ROOT` pointing to an existing SDK
directory, even when the app has `android/local.properties`. iOS requires a
UTF-8 locale; set `LANG=en_US.UTF-8` and `LC_ALL=en_US.UTF-8` when needed.
Its preflight also checks CoreSimulator inventory with a five-minute deadline
before fixture setup. This read-only check initializes the service without
booting devices; a failure identifies the command before any app build starts.
The cache runner performs these checks before seeding its disposable Gradle
home. Worktree names include a digest of the run directory, so separate runs
use different device names and do not recover a previous run's AVD by name.

Generated iOS fixtures use the committed
[`simslim-profile.json`](../test/e2e/native/simslim-profile.json) to reduce
background services while running several simulators. Install the prerequisite
with `brew install mobai-app/tap/simslim`; CI does this automatically. The profile
keeps App Store/push/media, web/universal links, connectivity, diagnostics, and
miscellaneous system services. It disables widgets, Siri, search, account sync,
PIM, family, health, photos, bundled apps, and messaging, which these blank-app
scenarios do not exercise. Review the profile when adding feature-specific QA.
Supplied `--app-dir` projects retain their own settings. Stock simulator boot
and memory behavior require a separate run against a project without a profile.

### The simulator pool suite

`test/e2e/native/run-pool-e2e.mjs` runs on iOS. With a pool bound of one, it
creates two workspace simulators, proves the first is parked and then evicted,
proves a third workspace adopts the survivor, and finishes by proving
`gc --delete` empties the pool. Run it by hand with:

```bash
node test/e2e/native/run-pool-e2e.mjs --framework expo
node test/e2e/native/run-pool-e2e.mjs --framework bare --dry-run
```

### The cache suite

`test/e2e/native/run-cache-e2e.mjs` is the executable replacement for the
hand-written cache field passes. Those kept drifting in coverage: one Android
pass never checked Gradle caching at all, a zero-config pass ran iOS-only and
left `--build-cache` unproven, and a broken Expo Metro store shipped through green CI
(#73) because nothing measured the directory it was supposed to be filling.

**The three-part rule.** For every cache it proves three separate things, and
refuses to take one as evidence of another:

- **ENGAGED** -- the flag / setting / record is really there, read back off the
  REAL argv or the REAL log, never re-derived from the suite's idea of what
  Stim should have done.
- **STORES** -- the cache directory actually GREW. A file count before and a
  file count after. **This is the one that matters**: an engaged cache that
  stores nothing looks identical to a working one from every other angle, and
  that is exactly the shape of the old loader-hook bug.
- **REUSED** -- a SECOND workspace got the stored work back.

**The eight checks.**

| id                  | what it proves                                                                          | how                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| ------------------- | --------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `zero-config`       | Stim writes no runtime state into the repo; global workspace state needs no ignore rule | `git status --porcelain` before and after; a change to `metro.config.js` / `Podfile` / `gradle.properties` is a CRITICAL failure; every worktree is removed WITHOUT `--force` and no project `.gitignore` mutation is expected                                                                                                                                                                                                                                                                                                                                                                                    |
| `metro-store`       | the shared transform store is engaged per dev-server mode, stores, and is reused        | the `cache_store_added` record in the global workspace `logs/metro.ndjson` (Expo SDK 54+: the config adapter's confirmation from inside the child; bare: the in-process append), the absence of a "could not share" warning, one store root for both workspaces, then a file count around each workspace's build+launch                                                                                                                                                                                                                                                                                           |
| `xcode-cas`         | Xcode compilation caching, clang always and Swift when the gate allows                  | each expected build setting found on the real `build_start` argv in `build-ios.ndjson` -- with the Swift ones expected `YES` or `NO` from the same two-part gate the product applies, `xcrun swift` 6.4+ AND the fixture's `react-native` 0.87+, and `SWIFT_OTHER_PREFIX_MAPPINGS` asserted ABSENT when Swift is off; the two `*_OTHER_PREFIX_MAPPINGS` values are matched by their `<worktree>=/^src` half only, so the DerivedData half the product appends is not checked -- plus CAS directory growth across the cold compile, and near-zero growth when a never-compiled workspace compiles the same sources |
| `gradle-cache`      | the Gradle build cache                                                                  | `--build-cache` read off the `build_start` record in `build-android.ndjson` (added in #78 so this need not race `ps`), growth of `<gradle user home>/caches/build-cache-1`, and `FROM-CACHE` tasks in a second worktree forced to run gradle with `stim android --no-build-cache`                                                                                                                                                                                                                                                                                                                                 |
| `fingerprint-cache` | the entry is complete and under the right key                                           | the entry holds the artifact AND `fingerprint-sources.json` (and, for an Android release entry, `assets-manifest.json`); a second run in the SAME tree must HIT what the first stored, which is what proves the entry landed under the POST-mutation key that prebuild and `pod install` shift it to                                                                                                                                                                                                                                                                                                              |
| `pods-reuse`        | carried Pods skip `pod install`                                                         | the racing worktrees warm ignored state from the source checkout, whose installed Pods match their tracked Podfile.lock; the one that takes the BUILD path must print no `pods` phase line at all                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `single-flight`     | two workspaces racing one uncached fingerprint compile once                             | both racers point at an EMPTY build-cache root (so the fingerprint is identical to the one already stored and misses only because that root is empty, which keeps the check about the lock and nothing else) while the build lock stays shared through `STIM_HOME`; exactly one compiles, the other reports `waited ... -> installed from cache` with `waitedForBuild` in its payload                                                                                                                                                                                                                             |
| `gc-view`           | `gc` can see every cache                                                                | a bare `gc` must list each live cache directory with a size under "Shared build caches (N) - alive, not garbage"                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |

**Honesty rules.** Every assertion prints the evidence it checked -- numbers, and
quoted lines. A check that cannot run SKIPS with the reason spelled out ("no
Android SDK on this runner", "compilation caching needs Xcode 26+, this runner
reports ..."), and a skip is never a pass. A check that finishes without
reporting a verdict is a failure. Every human line goes to stderr; **stdout
carries exactly one line**, the machine-readable summary:

```json
{"suite":"caches","variant":"expo-ios","ok":true,"counts":{"pass":6,"skip":2,"fail":0},"checks":[...]}
```

Each `checks[]` entry carries its `id`, `status`, `reason` and the full
`evidence` array, so a CI job can fail on one cache without a human reading the
log.

**Cache roots are forced, not inherited.** Unlike the loop suite -- which lets
CI persist `STIM_BUILD_CACHE` across runs on purpose, and has
`STIM_E2E_WARM_CACHE` to relax its cold-miss assertion -- the cache suite
overrides `STIM_BUILD_CACHE` and `STIM_METRO_CACHE` into its own throwaway
home. Every number it reports is a before/after around a COLD compile, and an
inherited warm cache turns "the CAS gained 4,000 files" into a measurement of
nothing.

Android cache runs also own a disposable Gradle home. Cleanup runs each cached
Gradle version's `--stop` against that home and waits for its recorded daemons
to exit before removal. A shutdown failure fails the run and preserves its
state for diagnosis. The same check protects cleanup of an earlier run whose
owner has exited. Symlink homes and homes with missing ownership records or
linked daemon registries are preserved. `--keep` retains the home without stopping its daemons.

Run it by hand:

```bash
# the full suite (two cold compiles plus two cache-hit builds; 20-60 minutes)
node test/e2e/native/run-cache-e2e.mjs --framework expo --platform ios
node test/e2e/native/run-cache-e2e.mjs --framework bare --platform android

# skip the single-flight race (saves one cold compile; that check reports SKIP)
node test/e2e/native/run-cache-e2e.mjs --framework expo --platform ios --skip-race

# warm-cache parity: use a previously built disposable source checkout with matching Pods
node test/e2e/native/run-cache-e2e.mjs --framework expo --platform ios \
  --app-dir /tmp/my-app-fixture --summary /tmp/cache-summary.json

# print the plan, no side effects
node test/e2e/native/run-cache-e2e.mjs --framework bare --platform ios --dry-run
```

See the [source-fixture preparation requirements](./field-test-protocol.md#use-a-fixture-that-looks-like-a-real-repo).

On CI it runs on `workflow_dispatch` (**Actions -> Native E2E -> Run workflow ->
suite: `caches`**, or `all` for loop, caches and pool) or on a pull request
labeled `e2e-caches`. The dispatch default stays `loop`.

#### What its first run found

Recorded so that the contracts behind the suite are not mysterious. First full local run,
2026-08-27, `expo-ios`, Expo SDK 57 / RN 0.86 / Xcode 26.6, 769s:
`xcode-cas`, `fingerprint-cache`, `single-flight` and `pods-reuse` PASS,
`gradle-cache` SKIP (iOS), and two checks exposed product bugs that are now
fixed:

- **`metro-store` (fixed)** -- the old Expo implementation intercepted Node's
  module loader and missed Expo's vendored Metro path. Expo SDK 54+'s
  `EXPO_OVERRIDE_METRO_CONFIG` now loads a small adapter instead, so the project
  config is composed through an explicit config seam and no module interception
  remains. SDK 53 and older intentionally use Expo's normal Metro cache.
- **`gc-view` (fixed)** -- the Xcode compilation cache and Gradle build cache
  are detected and reported with their ownership-safe cleanup policies.

## CI

The CI workflows under `.github/workflows/` share two composite actions under
`.github/actions/`: `setup-stim` (pnpm and Node from the lockfile, the frozen
install, the tsdown build) and `windows-android-sdk` (JDK 17 plus the system
image the `windows-latest` image lacks, with platform-tools and the emulator on
PATH).

- **`ci.yml`** -- fast and **blocking** on every push to `main` and every pull request. The
  repository build matrix uses Node 22 and 24, runs frozen pnpm install, lint,
  format check, ESM build, typecheck, knip, Vitest, and the cross-platform E2E.
  A separate job builds on Node 22.18 and then runs `test/runtime-floor.mjs`
  under exactly Node 22.12.0, the published floor. Repository development needs
  Node 22.18 or later because tsdown has the higher floor. A Windows lane,
  `test (windows)`, repeats install, build, typecheck and the unit suite on
  `windows-latest`.

- **`windows-debug.yml`** -- dispatch only: prepares a `windows-latest` runner
  like the Android lane and holds it open behind Tailscale SSH or tmate.

- **`e2e-native.yml`** -- the native matrix, every native gate in one
  workflow. Nothing native runs on an unlabeled pull request; what runs is:

  | event               | suites                                                                                              |
  | ------------------- | --------------------------------------------------------------------------------------------------- |
  | push to `main`      | smoke on iOS, Linux Android and Windows Android                                                     |
  | nightly schedule    | loop on every platform                                                                              |
  | `workflow_dispatch` | the `suite` input (`smoke` \| `loop` \| `caches` \| `pool` \| `all`, default `loop`)                |
  | pull request        | the union of its labels `e2e-smoke`, `e2e-loop`, `e2e-caches`, `e2e-pool`, `e2e-all`; none, nothing |

  `all` and `e2e-all` are loop, caches and pool. Adding a label re-triggers the
  workflow through the `labeled` event; several labels union. A `plan` job runs
  `scripts/e2e-plan.mjs` (unit-tested in `scripts/e2e-plan.test.mjs`), which
  turns event, labels and input into one suite list per platform, filtered by
  what the platform supports: iOS smoke, loop, caches, pool; Linux Android
  smoke, loop, caches; Windows Android smoke, loop. Each platform job reads its
  list as the `suite` matrix axis and is skipped when the list is empty. The
  smoke is one framework per platform: Expo on iOS and Linux, bare on Windows.
  The `caches` selection raises the job timeout to 120 minutes (per
  variant it pays one more cold compile than the loop suite -- the single-flight
  race -- plus two cache-hit builds, and on Android one forced `gradlew` run)
  and uploads its machine-readable summary
  as an artifact with `if: always()` -- a FAILING cache run is exactly when the
  per-check evidence is worth reading. iOS runs on the `xcode-27` image, which
  ships Xcode 27 and its Swift 6.4 toolchain as the only Xcode; the job selects
  `/Applications/Xcode_27.0.app` and fails if the toolchain is below Swift 6.4.
  Linux Android runs on a KVM host via
  `reactivecircus/android-emulator-runner`; Windows Android runs bare on
  `windows-latest` with a WHPX-accelerated emulator, its fixture under `D:\e`
  to stay under the 260-character path cap. Framework and suite are matrix
  axes, so variants run as parallel, isolated jobs. Linux Android runs both
  frameworks; **iOS runs `expo` only** -- a matrix `exclude` drops the bare
  variant, whose template cannot launch on iOS 27. `~/.stim`'s shared build cache
  (`STIM_BUILD_CACHE`) is persisted across runs with `actions/cache` for the
  smoke and loop suites on every platform, so the cross-run cache path is
  itself exercised and a smoke whose native fingerprint is unchanged installs
  from cache; build logs (`build-*.ndjson`) are uploaded as artifacts on
  failure.

### Assumptions a reviewer must confirm

- `xcode-27` is a GitHub **preview** image (actions/runner-images#14404). It can
  queue longer and break sooner than a GA image, and `xcode-27-xlarge` is the
  only other size. The iOS lane is worth that because Swift compilation caching
  cannot be exercised anywhere else: the `macos-26` images top out at Xcode 26.6.
- The image's Xcode still has to suit the RN/Expo template the fixture creates,
  and this is now the likelier failure: `xcode-27` ships only the iOS 27 SDK and
  the iOS 27 simulator runtimes, with no older runtime to fall back to. A
  template that does not build against, or launch on, iOS 27 fails the lane.
- The `@react-native-community/cli` and `create-expo-app` flag surfaces in the
  driver's `FIXTURE_COMMANDS` match the versions the runners fetch (override via
  the env vars above if not).
- **The iOS job pins the Expo fixture to Expo SDK 58**, through
  `STIM_E2E_EXPO_INIT`, because the SDK 57 template it would otherwise create
  generates no `SceneDelegate` and cannot launch on iOS 27. SDK 58 is a preview
  (`expo ~58.0.0-preview.3`), so the pin lives in that one job and neither the
  harness default nor the Android lane moves. It also carries
  `react-native 0.88.0-rc.0`, above the 0.87 floor, so the Expo variant reaches
  the Swift branch.
- **The bare iOS variant is excluded from the matrix**, so the iOS lane has no
  bare job at all. Swift caching needs the fixture's `react-native` to be 0.87 or
  newer as well as the Swift 6.4 toolchain, and `@react-native-community/cli@latest init`
  satisfies that -- its build does report `Swift on`. Its template does not adopt
  the UIScene lifecycle, though: `@react-native-community/template` 0.88.0-rc.1
  still has no `SceneDelegate` and no `UIApplicationSceneManifest`, so the app
  builds and then traps at launch on iOS 27. Excluding it keeps the nightly
  honest rather than permanently red. Remove the `exclude` when the React Native
  template adopts scenes; that restores bare iOS coverage, including the
  `bare-inproc` Metro path, which only Android exercises until then.
- `xcode-cas` prints which half of the Swift gate decided, in its evidence and
  its PASS message. A PASS with `Swift caching OFF` is not Swift coverage.
- The Android job's `api-level` / `target` / `arch` have a matching system image
  available to `android-emulator-runner`.
- **Disk, for the `caches` suite only.** It stands up FOUR worktrees, each with
  its own global workspace DerivedData / Gradle build dir under `STIM_HOME`, and
  `--keep` leaves them for the artifact step. A hosted runner's free space is
  the thing most likely to end that run early; if it does, `--skip-race` drops
  it to two worktrees at the cost of the `single-flight` and `pods-reuse`
  checks (both of which then report SKIP with that reason).

### Android emulator recycling

After `pnpm run build`, run the pool smoke test against an existing debuggable APK:

```bash
node --experimental-strip-types test/e2e/native/run-android-pool-e2e.mjs /absolute/path/app-debug.apk
```

It creates an owned emulator in a temporary Stim home, records fresh and adopted
setup timings, seeds and clears app data, verifies an unchanged APK skips
installation, and checks that GC deletes the parked AVD. It uses separate launch
and cleanup processes, like the CLI. The test removes its own devices and prints
the temporary directory containing `result.json` and emulator logs.

### Sequential iOS simulator preparation

When an iOS fixture declares a SimSlim profile, the loop and cache suites
prepare their required simulator assignments one at a time before starting
the workload. Preparation creates or reuses an owned simulator, waits for boot
and profile reconciliation, then shuts it down through Stim. It does not start
Metro, build the app, or populate the native artifact cache. Stock fixtures
and Android do not take this preparation path.

The loop still asserts three distinct simulators are booted simultaneously.
Cache suites still require a cold artifact miss and race two commands against
one empty cache. The preparation reduces overlapping first-boot work; it does
not establish that host memory caused earlier failures or guarantee enough
capacity for the eventual concurrent workload. Runner sizes are unchanged.

If preparation or its shutdown fails, the suite preserves its temporary
worktrees and `STIM_HOME` and prints the state location. Inspect the failure
and use Stim with that home to clean up; do not erase ownership records while
their simulators still exist.
