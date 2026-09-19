# 1.6.0 benchmark campaign checklist

Preparation for a full replacement campaign on stim 1.6.0 with the Expo SDK 58
fixture. Nothing here has been dispatched, built, or recorded. Every value that
can only be produced by running something is marked **unknown until measured**
rather than guessed.

Sources: [`agent-benchmark.md`](./agent-benchmark.md) (readiness and
launch-crash contract), [`agent-benchmark-v3.md`](./agent-benchmark-v3.md)
(pins, fixed changes, order, validity), the driver contract in
[`scripts/agent-benchmark/README.md`](../scripts/agent-benchmark/README.md),
`versionChecks()` and `preflight()` in `scripts/agent-benchmark/driver.mjs`,
`parseBenchmarkTargets` in `scripts/agent-benchmark/run-guards.mjs`, and
[appandflow/stim#469](https://github.com/appandflow/stim/issues/469).

## Why a new campaign

The 16 published datasets under `website/src/data/benchmarks/` all carry
`protocolVersion: 4` and `recordedOn` 2026-09-10 or 2026-09-11, recorded on
stim `1.0.0-rc.12`. They predate device pooling, slots, named ports, and the
1.6.0 automatic Swift compilation cache. The iOS readiness stage files are
named `*-rc12` for that reason.

## Status legend

- **Satisfied** — provable from current repo or host state without running a
  build.
- **Not satisfied** — missing, drifted, or impossible today.
- **Unknown until measured** — the protocol needs a number that only a real
  untimed run produces.

## 1. Machine-local benchmark root

The driver refuses to start without `STIM_BENCH_ROOT`
(`driver.mjs:71`). The README requires this layout outside the repository:

```text
benchmark-root/
  bin/stim
  golden/
  pins.env
  targets.json
  runtime/node_modules/stim/
  results/
  state/
```

| Item                                               | Status        | Note                                                                                                                                                             |
| -------------------------------------------------- | ------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Benchmark root exists                              | Not satisfied | No `stim-bench-coordinator` or equivalent directory exists on this host, and no `STIM_BENCH_*` variable is set. The whole root must be created.                  |
| `bin/stim` shim                                    | Not satisfied | Preflight refuses a shim whose text does not contain the pinned `runtime/node_modules/stim/dist/cli.mjs` path (`driver.mjs:587`).                                |
| `runtime/node_modules/stim` at 1.6.0               | Not satisfied | Must be a real npm install of the published `stim@1.6.0` tarball so `runtime/package-lock.json` carries the integrity string preflight reads (`driver.mjs:546`). |
| `golden/`                                          | Not satisfied | See section 4.                                                                                                                                                   |
| `results/`, `state/`                               | Not satisfied | Created with the root.                                                                                                                                           |
| Single APFS volume for goldens and restore targets | Satisfied     | Only `Macintosh HD` is mounted, so the `diskutil info -plist` volume-UUID equality check in the v3 protocol is trivially met.                                    |

Environment to export before any driver command:

```bash
export STIM_BENCH_ROOT=/path/to/benchmark-root
export STIM_BENCH_FIXTURE=/path/to/clean-trailhead-checkout
export STIM_BENCH_WORKTREE_PARENT=/path/to/benchmark-worktrees
export STIM_BENCH_STIM_PACKAGE="$STIM_BENCH_ROOT/runtime/node_modules/stim"
export STIM_BENCH_CODEX_AUTH=/path/to/codex-auth.json
export STIM_BENCH_SKILLS_ROOT=/path/to/skills
export STIM_BENCH_AGENT_DEVICE_BIN=/path/to/native-compat/bin/agent-device.mjs
export STIM_BENCH_NATIVE_COMPAT_MANIFEST=/path/to/native-compat/manifest.json
```

## 2. `pins.env`

`pins.env` lives in the machine-local benchmark root, not in this repository
(`scripts/agent-benchmark/README.md`, "Machine-local layout"). It is therefore
reproduced here rather than committed. It is immutable for a block; preflight
fails on any mismatch instead of recording one.

`versionChecks()` compares exactly these 16 keys. Four more
(`IOS_DEVICE_TYPE`, `IOS_RUNTIME`, `ANDROID_SYSTEM_IMAGE`,
`NATIVE_COMPAT_SHA256`) are read elsewhere in the driver, and the v3 protocol
adds informational provenance pins.

```text
# Fixture and product
TRAILHEAD_UPSTREAM_COMMIT=5944bdfda198b92086f0ffd0e033d05db300009c
TRAILHEAD_FIXTURE_COMMIT=<unknown until `prepare` creates the fixture commit>
STIM_COMMIT=968e7fddb
STIM_VERSION=1.6.0
STIM_INTEGRITY=<unknown until stim@1.6.0 is installed into runtime/>

# Runners
CODEX_VERSION=0.153.4
CLAUDE_VERSION=2.1.266
CODEX_SERVICE_TIER=priority
CODEX_REASONING_EFFORT=high

# Host toolchain
MACOS_VERSION=27.0
MACOS_BUILD=26A428
XCODE_VERSION=27.0
XCODE_BUILD=27A266a
NODE_VERSION=<unknown; must match the node on the benchmark PATH>
COCOAPODS_VERSION=<unknown; 1.16.2 is installed, the frozen campaign pinned 1.17.0>

# Devices
IOS_DEVICE_TYPE=iPhone 17
IOS_RUNTIME=26.5
ANDROID_SDK_VERSION=<unknown; `sdkmanager --version` is not resolvable on the current PATH>
ANDROID_EMULATOR_VERSION=35.6.11.0 (build_id 13610412) (CL:N/A)
ADB_VERSION=36.0.0-13206524
ANDROID_SYSTEM_IMAGE=system-images;android-36;google_apis_playstore_ps16k;arm64-v8a

# agent-device and the #469 compatibility adapter
AGENT_DEVICE_VERSION=0.20.10
AGENT_DEVICE_SHA256=<unknown until the compatibility copy is prepared>
NATIVE_COMPAT_SHA256=<unknown until prepareNativeCompatibility writes its manifest>
```

Changes from the frozen rc12 pins, with why:

| Key                             | rc12                         | 1.6.0                           | Why                                                                                                                                                                                                                                                       |
| ------------------------------- | ---------------------------- | ------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `TRAILHEAD_UPSTREAM_COMMIT`     | `f4a4a3b7…`                  | `5944bdfd…`                     | SDK 58 preview.3 / RN 0.88.0-rc.0. That commit also dropped trailhead's committed `SWIFT_ENABLE_EXPLICIT_MODULES=NO` override, so the ExpoModulesJSI cache behaviour in section 7 is live on the fixture.                                                 |
| `STIM_VERSION`                  | `1.0.0-rc.12`                | `1.6.0`                         | The version under test.                                                                                                                                                                                                                                   |
| `MACOS_VERSION` / `MACOS_BUILD` | `26.5.2` / `25F84`           | `27.0` / `26A428`               | Host has moved; preflight compares literally.                                                                                                                                                                                                             |
| `XCODE_VERSION` / `XCODE_BUILD` | `26.6` / `17F113`            | `27.0` / `27A266a`              | **Required, not incidental.** `2ece2d34d` enables `SWIFT_ENABLE_COMPILE_CACHE=YES` only on Swift 6.4+, which ships with Xcode 27. On Xcode 26.6 the headline 1.6.0 feature never activates. `xcrun swift --version` on this host reports Apple Swift 6.4. |
| `CODEX_VERSION`                 | `0.145.0-alpha.11`           | `0.153.4`                       | Installed version.                                                                                                                                                                                                                                        |
| `CLAUDE_VERSION`                | `2.1.257`                    | `2.1.266`                       | Installed version.                                                                                                                                                                                                                                        |
| `ADB_VERSION`                   | `36.0.2-14143358`            | `36.0.0-13206524`               | The installed adb is _older_ than the frozen pin. Section 3 treats this as a blocker to resolve, not a value to accept.                                                                                                                                   |
| `ANDROID_EMULATOR_VERSION`      | `36.4.9 (build_id 14788078)` | `35.6.11.0 (build_id 13610412)` | Same: the installed emulator is older than the frozen pin.                                                                                                                                                                                                |

Values that cannot be known without running something:

- `TRAILHEAD_FIXTURE_COMMIT` — `prepare` derives it by rewriting the `AGENTS.md`
  Stim sentence and normalizing `Pods/Manifest.lock` to the pinned CocoaPods
  version, then committing. The hash exists only after that commit.
- `STIM_INTEGRITY` — read from `runtime/package-lock.json` for the installed
  `stim` package; it is the registry tarball integrity of `stim@1.6.0`.
- `AGENT_DEVICE_SHA256` — hash of the _executable the benchmark uses_. With the
  #469 adapter that is the patched copy's `bin/agent-device.mjs`, not the global
  install.
- `NATIVE_COMPAT_SHA256` — digest of the manifest `prepareNativeCompatibility`
  generates.
- `NODE_VERSION` — the frozen campaign pinned Node 26.7.0. The node on this
  shell's PATH is v22.22.1. Whichever node the benchmark PATH resolves must be
  pinned; do not copy 26.7.0 forward without checking.
- `COCOAPODS_VERSION` — `pod --version` reports 1.16.2 here versus the frozen
  1.17.0. `prepare` normalizes the fixture's `Pods/Manifest.lock` to whatever is
  pinned, so this must be decided (upgrade the gem, or pin 1.16.2) before the
  fixture commit is created.
- `ANDROID_SDK_VERSION` — `sdkmanager` is not on the current PATH.
  `versionChecks()` calls it unqualified, so the Android preflight will throw
  until the benchmark PATH exposes `cmdline-tools/latest/bin`.

## 3. `targets.json`

Also machine-local, in the benchmark root. `parseBenchmarkTargets`
(`run-guards.mjs:16`) requires `schemaVersion: 1`, a non-empty `machine`
string, and for every key `<platform>.<variant>.<arm>`:

- `screenReadySeconds` and `runTimeoutSeconds` positive, with
  `runTimeoutSeconds >= screenReadySeconds`;
- optional `platformCommandSeconds`, also `<= runTimeoutSeconds`;
- `ccacheMinHitRatePercent` only on `android.*.stim`, in `(0, 100]`.

Every dispatched cell needs its own entry, so a full campaign needs all 12 keys
(2 platforms x 3 variants x 2 arms). The machine string carries into
`preflight.timingTargets.machine` and into the exported dataset's environment
block.

The rc12 datasets record the machine as `Mac mini / Apple M4 / 16 GB`. Confirm
that is still the recording host before reusing the string; the exporter's
sanitized machine JSON must contain only `model`, `chip`, and `memory`.

`screenReadySeconds` is a reported performance signal, not a validity gate, so
the values below are set from the rc12 observations with headroom. The two
gates that _do_ invalidate — `platformCommandSeconds` and `runTimeoutSeconds` —
are set well above the rc12 maxima so a slow model is not silently discarded.

```json
{
  "schemaVersion": 1,
  "machine": "Mac mini, Apple M4, 16 GB",
  "targets": {
    "ios.javascript.stim": {
      "screenReadySeconds": 240,
      "platformCommandSeconds": 180,
      "runTimeoutSeconds": 900
    },
    "ios.javascript.control": { "screenReadySeconds": 1300, "runTimeoutSeconds": 2400 },
    "ios.native.stim": {
      "screenReadySeconds": 360,
      "platformCommandSeconds": 300,
      "runTimeoutSeconds": 1200
    },
    "ios.native.control": { "screenReadySeconds": 800, "runTimeoutSeconds": 2400 },
    "ios.launch-crash.stim": {
      "screenReadySeconds": 300,
      "platformCommandSeconds": 180,
      "runTimeoutSeconds": 1200
    },
    "ios.launch-crash.control": { "screenReadySeconds": 1100, "runTimeoutSeconds": 2400 },
    "android.javascript.stim": {
      "screenReadySeconds": 300,
      "platformCommandSeconds": 180,
      "ccacheMinHitRatePercent": 0,
      "runTimeoutSeconds": 900
    },
    "android.javascript.control": { "screenReadySeconds": 700, "runTimeoutSeconds": 1800 },
    "android.native.stim": {
      "screenReadySeconds": 300,
      "platformCommandSeconds": 240,
      "ccacheMinHitRatePercent": 0,
      "runTimeoutSeconds": 900
    },
    "android.native.control": { "screenReadySeconds": 800, "runTimeoutSeconds": 1800 },
    "android.launch-crash.stim": {
      "screenReadySeconds": 300,
      "platformCommandSeconds": 180,
      "ccacheMinHitRatePercent": 0,
      "runTimeoutSeconds": 900
    },
    "android.launch-crash.control": { "screenReadySeconds": 700, "runTimeoutSeconds": 1800 }
  }
}
```

The three `ccacheMinHitRatePercent: 0` placeholders are **invalid as written** —
`parseBenchmarkTargets` rejects a value outside `(0, 100]`. They are placeholders
because the real number is unknown until measured (section 5). Do not guess one;
`dispatch` refuses an Android native Stim cell whose target omits it
(`driver.mjs:1324`), and a threshold that is too low silently accepts a broken
cache while one that is too high fires a `CACHE ALERT` on every run.

| Item                                                   | Status                                        |
| ------------------------------------------------------ | --------------------------------------------- |
| `targets.json` file                                    | Not satisfied — no benchmark root             |
| Machine string confirmed                               | Unknown until the recording host is confirmed |
| All 12 cell keys present                               | Not satisfied                                 |
| `ccacheMinHitRatePercent` for the 3 Android Stim cells | Unknown until measured                        |

## 4. Golden state

Per-platform, prepared outside the timer, never rebuilt within a block.

**iOS golden** (`prepare`): one Stim-owned simulator created at the pinned
model/runtime, the fixed fixture warmed, the seed worktree removed, and cleanup
verified to have _parked_ the simulator. The golden must contain exactly one
available, shut-down pool record whose device name starts with `stim-parked`,
plus the matching build artifact, the pinned `compilation-cache` and
`metro-cache`, and no workspace registry or device records. Preflight resolves
exactly one current artifact key from the retained artifacts.

**Android golden** (`prepare android`): the matching APK cache warmed and one
Stim-owned AVD parked with the pinned system image and default creation
settings, retaining APK and Quick Boot state.

**Locale**: preparation and both arms pin `LANG`, `LC_ALL`, `LC_CTYPE` to
`C.UTF-8` and unset `LC_MESSAGES`. These participate in ccache keys; a golden
without matching locale provenance needs requalification. `verifyRunnerShell`
checks this for both `-lc` and `-c`.

**Android doctor**: `assertAndroidDoctorClean` (`run-guards.mjs:493`) requires a
structured `stim doctor --platform android` report with zero `cost`-level
findings, both at golden preparation and at every Android preflight. Repair with
`stim doctor --fix --platform android`, seed shared caches, and verify
cross-worktree reuse _before_ creating the golden. Preflight only inspects; it
never changes cache state during a timed cell.

| Item                                           | Status                                                                      |
| ---------------------------------------------- | --------------------------------------------------------------------------- |
| iOS golden                                     | Not satisfied — must be built fresh for 1.6.0 + Xcode 27 + SDK 58           |
| Android golden                                 | Not satisfied — same, and blocked on the system image in section 6          |
| Android doctor clean                           | Unknown until `stim doctor --platform android` is run on the SDK 58 fixture |
| Locale provenance                              | Satisfiable by construction; recorded by preparation                        |
| Goldens on same APFS volume as restore targets | Satisfied (single volume)                                                   |

Note that the #469 compatibility adapter patches the fixture's ignored
ExpoModulesJSI build script, which is a native input. Prepare the adapter
**before** the golden, or the golden must be rebuilt.

## 5. Preflight commands

Per platform, before every cell:

```bash
node scripts/agent-benchmark/driver.mjs preflight          # iOS
node scripts/agent-benchmark/driver.mjs preflight android
```

`preflight()` (`driver.mjs:575`) performs, in order: `versionChecks()` against
all 16 pins plus a clean fixture checkout; `verifyNativeCompatibility` against
`NATIVE_COMPAT_SHA256`; `benchmarkTargets()` parse; the `bin/stim` shim
pointing at the pinned CLI; `verifyRunnerShell` (isolated login shell, locale,
Stim provenance — resolved path, version, executable and CLI hashes); the
Android doctor report on Android; a refusal if any simulator is booted or any
Android emulator transport is present; a refusal if anything listens on TCP
8081-8090; `df`, `sysctl vm.loadavg`, `pmset -g therm` with a refusal on a
reported thermal warning; a free-space gate of 12 GiB on the fixture volume and
8 GiB on the benchmark root volume; golden cache verification; and parked
simulator or parked emulator verification.

Self-tests, once before the campaign:

```bash
node scripts/agent-benchmark/driver.mjs selftest-device-targeting
node scripts/agent-benchmark/driver.mjs selftest-agent-device-isolation
node scripts/agent-benchmark/driver.mjs selftest-launch-crash
node scripts/agent-benchmark/driver.mjs selftest-android
node scripts/agent-benchmark/driver.mjs selftest-runner-timeout
```

Isolation smokes, per arm, before the timed block:

```bash
node scripts/agent-benchmark/driver.mjs smoke stim
node scripts/agent-benchmark/driver.mjs smoke control
```

Also required by the protocol and not covered by a single command: a load
average at or below 3.0 for two consecutive 15-second samples (up to a 10-minute
wait), an empty `agent-device` campaign session inventory with no ownership
claim on the prepared device, and the fixture main checkout clean at the fixture
commit.

### The Android ccache probe

The README requires establishing `ccacheMinHitRatePercent` "from a verified warm
compiler-cache probe before dispatch", kept fixed across models. There is no
driver subcommand for it; it is an untimed manual probe:

1. Prepare the Android golden and seed the shared ccache.
2. Create a second worktree of the fixture and run the same `stim android`
   build the benchmark cell will run.
3. Read the reported `compilation cache <hits> hits / <misses> misses (<n>%)`
   line — the same text `ccacheMeasurements` (`run-guards.mjs:392`) parses from
   run output — or the structured equivalent.
4. Set the threshold below the observed warm hit rate with enough margin that
   normal variation does not fire `CACHE ALERT`, and freeze it for the campaign.

**Unknown until measured.** The rc12 datasets do not publish the ccache hit
rate, and this is a different stim version, a different Android toolchain, and a
different fixture, so no prior number carries over.

## 6. Prerequisites from #469 (iOS isolation, recording)

#469 is open. Its current triage states that the shipped detection and refusal
are not enough to close it: an accepted compatibility design plus **real untimed
build and recording evidence under the exact runner policy** are still required.

Established in #469 and reflected in the driver:

- The macOS kernel refuses a nested `sandbox_apply` unless the inner profile
  compiles to the same sandbox the process already runs under. SwiftPM generates
  a `(deny default)` profile per invocation, so no runner policy can host it.
  `(with no-sandbox)` on `process-exec*` permits nesting only by letting the
  child escape the boundary and read protected golden data — rejected.
- `/bin/ps` cannot be executed from any sandboxed process, even under a
  deny-free `(allow default)`. Unpatched agent-device 0.20.10 therefore fails
  `simctl recordVideo` with `did not expose a complete process identity` after
  80 retries.
- `dispatch` runs both probes untimed under the exact policy and refuses an iOS
  run without the adapter if either fails; results land in
  `preflight.isolationCompatibility`, or in `isolation-compatibility.json` when
  the run is refused.

| Prerequisite                                                                 | Status                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| ---------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Native compatibility adapter prepared via `prepareNativeCompatibility`       | Not satisfied — no adapter copy exists; it needs a new destination, the installed agent-device 0.20.10 package, an exact reviewed native-helper source commit and SHA-256, and a dedicated fixture copy                                                                                                                                                                                                                                                    |
| agent-device pinned at 0.20.10                                               | Satisfied — `agent-device --version` reports 0.20.10, which is what the adapter requires                                                                                                                                                                                                                                                                                                                                                                   |
| `STIM_BENCH_AGENT_DEVICE_BIN` / `STIM_BENCH_NATIVE_COMPAT_MANIFEST` exported | Not satisfied                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `NATIVE_COMPAT_SHA256` pinned                                                | Unknown until the adapter is prepared                                                                                                                                                                                                                                                                                                                                                                                                                      |
| Adapter base bytes still match the SDK 58 fixture                            | **Unknown and at risk.** `patchedJsiBuild` (`native-compat.mjs:68`) does a literal `replaceOnce` on `xcodebuild \` and `SWIFT_COMPILATION_MODE=wholemodule \` in `node_modules/expo-modules-jsi/apple/scripts/build-xcframework.sh`, and `prepareNativeCompatibility` refuses unknown base bytes. SDK 58 preview.3 ships a different version of that script than the campaign the adapter was written against. Verify before assuming the adapter applies. |
| Real untimed iOS build under the exact policy                                | Not satisfied — required by #469 and by the README ("This does not replace a real untimed build, recording, and cleanup test before accepting a new toolchain combination")                                                                                                                                                                                                                                                                                |
| Real untimed `agent-device` recording under the exact policy                 | Not satisfied — #469 notes the recording failure's root cause is established for the `ps` path but a real `simctl recordVideo` was never run, because no simulator was booted                                                                                                                                                                                                                                                                              |
| Real untimed cleanup test                                                    | Not satisfied                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| Campaign-scoped `AGENT_DEVICE_STATE_DIR` with empty session inventory        | Not satisfied — created with the benchmark root                                                                                                                                                                                                                                                                                                                                                                                                            |

The recording and isolation prerequisites are the campaign's single largest
unresolved dependency. They are untimed, but an iOS cell cannot be dispatched
until they pass.

## 7. Other unsatisfied prerequisites

| Item                                                                                         | Status        | Note                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| -------------------------------------------------------------------------------------------- | ------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Android system image `google_apis_playstore_ps16k;arm64-v8a`                                 | Not satisfied | `~/Library/Android/sdk/system-images/android-36/` contains only `google_apis_playstore`. Either install the pinned `ps16k` image or change the pin — and a changed device pin is a new block that cannot be pooled with anything earlier.                                                                                                                                                                                                                                                                                           |
| `sdkmanager` on the benchmark PATH                                                           | Not satisfied | `versionChecks()` invokes it unqualified; it does not resolve on this shell.                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| Android emulator and adb at or above the frozen pins                                         | Not satisfied | Installed emulator 35.6.11.0 / adb 36.0.0 are both older than the rc12 pins. Decide deliberately: update the SDK and pin the new versions, or pin the installed older ones.                                                                                                                                                                                                                                                                                                                                                         |
| CocoaPods version decision                                                                   | Not satisfied | 1.16.2 installed vs 1.17.0 frozen. `prepare` bakes the choice into the fixture commit's `Pods/Manifest.lock`.                                                                                                                                                                                                                                                                                                                                                                                                                       |
| Node version on the benchmark PATH                                                           | Not satisfied | v22.22.1 on this shell vs 26.7.0 frozen.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| Codex auth file for the isolated runner home                                                 | Unknown       | `STIM_BENCH_CODEX_AUTH` must point at a valid `codex-auth.json`; not verifiable without dispatching.                                                                                                                                                                                                                                                                                                                                                                                                                                |
| Hash-verified Stim skill copy and pinned `agent-device` skill under `STIM_BENCH_SKILLS_ROOT` | Not satisfied | Stim arm gets only the Stim skill plus `agent-device`; control gets only `agent-device` and must not resolve `stim`.                                                                                                                                                                                                                                                                                                                                                                                                                |
| Pricing table for the campaign                                                               | Not satisfied | v3 pins the Codex priority price table by date from the official model pages; the Codex rates are hardcoded in `driver.mjs:2569`. Repin on the recording date and republish the raw token vectors beside every dollar figure.                                                                                                                                                                                                                                                                                                       |
| Stage naming decision                                                                        | Not satisfied | The exporter writes `website/src/data/benchmarks/<stage>.json`, and stage files are hardcoded imports in `website/src/components/benchmarkCatalog.ts`. The iOS readiness stages are literally named `*-rc12`. Either keep those filenames (so the catalog is untouched and `stageAliases` resolves the new campaign ids, matching the protocol's "replace its arm in the canonical comparison rather than adding the new stage to the catalog") or rename and update the catalog. This is a product decision, not a mechanical one. |

## Prerequisites already satisfied

- Xcode 27.0 (27A266a) with Apple Swift 6.4 — the toolchain 1.6.0's Swift
  compilation cache requires (`2ece2d34d`). Without it the feature under test
  never activates.
- macOS 27.0 (26A428) is a consistent, recordable host state.
- agent-device 0.20.10, the exact version `prepareNativeCompatibility` accepts.
- Codex 0.153.4 and Claude 2.1.266 are installed and pinnable.
- The fixture upstream commit exists and is fetched locally:
  `appandflow/trailhead@5944bdfd` (SDK 58 preview.3, RN 0.88.0-rc.0).
- A single APFS volume, so every golden/restore volume-UUID check passes.
- Driver, protocol, audit, export, and snapshot code in this repo are current at
  `968e7fddb` and need no change for a 1.6.0 campaign.

## 8. Cells to record and time estimate

A complete campaign is exactly 48 cells: 4 models
(`gpt-5.6-sol`, `gpt-5.6-luna`, `opus`, `sonnet`) x 2 platforms x 3 scenarios
(`javascript`, `native`, `launch-crash`) x 2 arms. `campaignTimings` in
`scripts/snapshot-benchmark-times.mjs` refuses to snapshot anything less.
`gpt-5.6-terra` is a v3 screening model and is **not** part of the campaign.

Per-cell estimates are the rc12 `totalSeconds` for the same cell, in seconds,
as `stim / control`:

| Platform | Scenario     | sol        | luna      | opus      | sonnet    |
| -------- | ------------ | ---------- | --------- | --------- | --------- |
| iOS      | javascript   | 158 / 1195 | 181 / 612 | 130 / 656 | 121 / 585 |
| iOS      | native       | 254 / 500  | 282 / 649 | 248 / 464 | 248 / 649 |
| iOS      | launch-crash | 169 / 757  | 215 / 887 | 187 / 714 | 163 / 958 |
| Android  | javascript   | 247 / 546  | 154 / 525 | 130 / 309 | 133 / 498 |
| Android  | native       | 232 / 638  | 191 / 454 | 169 / 357 | 172 / 680 |
| Android  | launch-crash | 226 / 562  | 155 / 595 | 137 / 475 | 139 / 467 |

Aggregates from the same data:

| Group                | Cells  | Sum (s)    | Sum (h)  |
| -------------------- | ------ | ---------- | -------- |
| iOS                  | 24     | 10,982     | 3.05     |
| Android              | 24     | 8,192      | 2.28     |
| All Stim arms        | 24     | 4,443      | 1.23     |
| All control arms     | 24     | 14,731     | 4.09     |
| **Total agent time** | **48** | **19,175** | **5.33** |

**Total estimated agent wall-clock: about 5 hours 20 minutes.** That is the sum
of the 48 rc12 run durations, and it is a floor, not the campaign duration.

Not included, and unknown until measured:

- Per-cell `preflight`, reset, `collect`, and `cleanup`. The published datasets
  record only the agent run, so no prior number exists.
- The load-average settle wait before each dispatch, up to 10 minutes per cell.
  At the pathological maximum that alone is 8 hours; in practice it is usually
  near zero, but it is unbounded by the protocol.
- One-time golden preparation for both platforms, the native compatibility
  adapter, the ccache probe, the five self-tests, and the two isolation smokes.
- The untimed iOS build/recording/cleanup validation #469 requires.
- Invalid attempts. The protocol preserves an invalid run and reschedules the
  same cell under a new id; the rc12 campaign's own history in
  `agent-benchmark-v3.md` records repeated invalid control attempts.
- Direction of change for 1.6.0 itself. Device pooling, slots, named ports and
  Swift compilation caching should move the Stim arms down and leave the control
  arms roughly where they were, but SDK 58 and Xcode 27 change both arms' build
  work. **Unknown until measured**; do not present the rc12 numbers as a
  1.6.0 prediction.

A defensible planning figure is a full working day per platform across two
sessions, with the campaign sequential and never two cells against the same
benchmark root.

## 9. Decision: wait for expo/expo#50354 before the iOS native cell?

[expo/expo#50354](https://github.com/expo/expo/pull/50354) is **open and
unmerged** as of 2026-09-18 (`state: open`, `closed_at: null`, labelled
`contributor: external`). It keeps checkout-absolute paths out of the Swift
compilation cache key by building `ExpoModulesJSI` with
`SWIFT_SERIALIZE_DEBUGGING_OPTIONS=NO` and `SWIFT_ENABLE_EXPLICIT_MODULES=NO`,
and by dropping the `-Xfrontend` wrappers around `-load-plugin-executable`.

### Numbers for waiting

- The PR's own test plan, on an SDK 58 preview.3 / RN 0.88.0-rc.0 app under
  Xcode 27.0 across two worktrees: **2297/2546 cache hits before, 378/382
  after**, with the 4 remaining misses being the app target whose Swift file
  genuinely differs. That is 90.2% to 98.9%.
- Concretely, **141 Swift tasks recompile in every fresh worktree** without the
  fix, in every target that imports `ExpoModulesCore`.
- The iOS native Stim cell is the cell that measures exactly this. Its change
  (`window?.accessibilityIdentifier = "Trailhead <run-id>"` in
  `AppDelegate.swift`) deliberately invalidates the portable artifact
  fingerprint, so a real Xcode Swift build runs in a fresh worktree. Recording
  it now publishes 1.6.0's Swift compilation cache at 90% of its achievable
  value on a stock SDK 58 app.
- iOS native is also the campaign's narrowest Stim/control gap: 254/500,
  282/649, 248/464, 248/649 in rc12 — roughly 2.0x to 2.6x, against 3.7x to
  7.6x for iOS javascript. It is the cell with the most to gain and the least
  headroom to spare.
- The fixture commit makes this worse, not better: `5944bdfd` explicitly dropped
  trailhead's committed `SWIFT_ENABLE_EXPLICIT_MODULES=NO` override, which was a
  local workaround for the same cause. The campaign fixture is now fully exposed
  to it.

### Numbers and facts for not waiting

- The PR is unmerged with no release. `pins.env` pins the fixture by upstream
  commit and preflight compares literally. Recording against a patched
  `node_modules/expo-modules-jsi` would pin a tree that no published Expo
  version reproduces, which is exactly what the "any deliberate pin change
  starts a new named block" rule exists to prevent. A reader could not
  reproduce the result from the pins.
- There is no merge date to wait for. It was opened 2026-09-18 by an external
  contributor and has no milestone; the wait is open-ended and the other 46
  cells are ready to plan around.
- The affected surface is bounded. 44 of the 48 cells are unaffected: all
  Android cells (clang tasks already hit), all iOS JavaScript cells (no Swift
  recompile), and the iOS launch-crash cells (a JavaScript repair). Only the
  4 iOS native Stim cells sit on the fix, and their controls are unaffected
  either way — the control arm builds cold DerivedData by construction, so the
  measured ratio only understates Stim, never overstates it.
- Even with 141 Swift tasks recompiling, rc12 iOS native Stim was 248-282s
  against 464-649s control. The claim survives without the fix; it is just
  smaller than the product can actually deliver.
- The PR touches `build-xcframework.sh`, the same file the #469 compatibility
  adapter patches with a literal `replaceOnce`. Taking the PR early means
  re-deriving the adapter's base hashes against a moving upstream branch, and
  `prepareNativeCompatibility` refuses unknown base bytes. That is real
  additional preparation risk on the campaign's most fragile component.

### Recommendation

Record the full 48-cell 1.6.0 campaign now, without #50354, and treat the iOS
native Stim result as a conservative floor. Disclose in the published dataset
and in the campaign notes that `ExpoModulesJSI` forces roughly 141 Swift
recompiles per fresh worktree on stock SDK 58, citing expo/expo#50354, so the
iOS native Stim figure is known to understate the cache.

Then, once #50354 ships in a released Expo version, rerun **only the four iOS
native Stim cells** as a new named block with the updated fixture pin. The
protocol already supports this: the exporter selects the newest validated
dispatch per arm and variant within a stage, replaces that arm in the canonical
benchmark JSON, retains the other arm, and uses `stageAliases` for old links.
That costs about 17 minutes of agent time (254 + 282 + 248 + 248 = 1,032s) plus
a fresh iOS golden, instead of blocking 48 cells on an unmerged external PR.

The one condition that would flip this: if the campaign's purpose is
specifically to market the 1.6.0 Swift compilation cache rather than to refresh
the published comparison, then the iOS native cell _is_ the deliverable and
publishing it at 90% of its value is self-defeating. In that case wait, and pin
the fixture to the first Expo release containing the fix.

## 10. Dispatch order and post-campaign steps

v3 confirmatory order uses repeated balanced four-run blocks so each arm,
vendor, and predecessor position is balanced:

1. Stim/Sol, control/Sol, control/Opus, Stim/Opus
2. Control/Opus, Stim/Opus, Stim/Sol, control/Sol
3. Control/Sol, Stim/Sol, Stim/Opus, control/Opus
4. Stim/Opus, control/Opus, control/Sol, Stim/Sol

Screening cells use a pre-generated seeded order recorded before dispatch. The
launch-crash suite runs only after the four-cell readiness pilot is accepted,
with separate iOS and Android blocks.

Per cell:

```bash
node scripts/agent-benchmark/driver.mjs preflight [android]
node scripts/agent-benchmark/driver.mjs prepare [android]
node scripts/agent-benchmark/driver.mjs dispatch <model> <arm> <variant> <stage> [android]
node scripts/agent-benchmark/driver.mjs collect <run-directory>
node scripts/agent-benchmark/driver.mjs cleanup <run-directory>
node scripts/agent-benchmark/driver.mjs report <stage>
```

After the whole campaign passes the export audit:

```bash
node scripts/export-benchmark-viewer.mjs \
  /path/to/results/<stage> \
  website/src/data/benchmarks/<stage>.json \
  website/static/benchmarks/<stage> \
  /path/to/sanitized-machine.json

node scripts/snapshot-benchmark-times.mjs 1.6.0 \
  website/src/data/benchmarks docs/benchmark-history/1.6.0.json
```

The snapshot command requires all 48 cells with valid finite timings and
first-activity metadata, and refuses to overwrite an existing snapshot. Publish
the canonical datasets and proof files only after the whole replacement
campaign passes the audit, then snapshot. Do not snapshot individual retries or
partial campaigns.
