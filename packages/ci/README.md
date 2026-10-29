# @stim-cli/ci

Build an app once, then install and launch it through Stim, run your test
command and stop the workspace. The library imports the public API from `stim`;
it does not depend on GitHub Actions, EAS, or internal Stim modules.

Requires Node.js 22.12 or newer and the native tools for the selected platform.
Install the app's dependencies before running it. Each concurrent CI run needs
its own checkout. The run stops that checkout's workspace, including resources
started before a build failure; an explicit API `run.slot` limits cleanup to
that slot. Do not point CI at a developer's active checkout.

## Build, then run

`stim-ci build` is the only step that compiles. `stim-ci run` never compiles:

```sh
npx --yes --package @stim-cli/ci stim-ci build --platform ios --project ./app
npx --yes --package @stim-cli/ci stim-ci run --platform ios --project ./app -- pnpm test:e2e
```

`build` compiles or restores the app from the native artifact cache, without
starting a simulator, emulator, Metro server, or app, and without stopping an
existing workspace session. It records the resulting app in the checkout's Stim
state (the workspace state under the Stim home) for the platform and selectors:
iOS scheme and configuration, Android variant. A later `build` with the same
selectors replaces the record. Architecture and ABI are build-only; the last build
for the selectors wins whatever its architecture.

`run` installs and launches the recorded app exactly as built, then runs the
test. It does not fingerprint, consult the cache, build or replace the app's JS:
it trusts the recorded build, so rebuild after changing the project. A Debug app
loads its JS from Metro, which `run` starts as before. With no recorded build for
the selectors (or after its app was removed), `run` refuses before touching a
device with `STIM_NO_RECORDED_BUILD`, and the failure's `remedy` names the command
to run first, such as `stim-ci build --platform ios --scheme App`. `build` and
`run` must use the same Stim home: pass the same `--home`, or keep the default.

Every iOS and Android `run` starts the app from clean state on the workspace's
own simulator or emulator, including when the device already has this build.
Before it installs, `run` uninstalls every other user app. On iOS it also clears
the app's defaults and data container and resets the simulator keychain; on
Android it runs `pm clear` on the app. Simulator-wide settings such as privacy
grants are kept. A run that `ios.remote` or `android.remote` would place on a
remote host refuses with `STIM_BAD_ARG` instead of skipping the cleanup.

`--eas-profile <name>` (iOS and Android, build only) downloads a completed EAS
development build instead of compiling, as `stim ios --eas-profile` does; `run`
then installs it. Stim never starts an EAS build.

macOS and web are unchanged: `run --platform macos` builds its app itself and web
has no native build. iOS builds target the simulator; archives, device
distribution and web compilation are not supported.

`build` exports nothing by default. `--export <path>` also writes the app there:
`app.apk` for Android, a tar.gz for iOS and macOS that preserves executable
permissions and symlinks (extract with `tar -xzf`). On a cache hit the archive is
the slowest part of `build`, so export only when something consumes the file.

The build result has `stage: "build"`, `build`, `buildPath`, and `artifactPath`
(the export, or null). With `--artifacts` the directory also contains
`build.json`, `result.json` and `diagnostics.json`.

The library exports `buildCI({ projectRoot, build: { platform: "ios" }, exportPath, ... })`
and `runCI`. `runCI`'s `run` option takes the selectors of the build to run; build-only
options such as `easProfile` belong to `buildCI`. Build cancellation waits for the
owned build operation to finish cleanup and retains diagnostics; it never calls
workspace `stop()`. A cancel or timeout after the export is written does not fail
the build stage.

## Command line

Or install `npm install --global @stim-cli/ci`, then:

```sh
stim-ci build --platform android --project ./app
stim-ci run --platform android --project ./app --artifacts ./test-results --timeout 1800 -- pnpm test:e2e
```

`--platform` accepts `ios`, `android`, `macos`, or `web`. `--project` defaults
to the current directory. `--home` and `--build-cache` explicitly select the
Stim home and native artifact cache; leaving them unset preserves normal Stim
configuration.

Without selectors, the CLI uses each project's normal build settings. `run`
must use the selectors its `build` used to find the recorded app:

| Option                   | Platform     | Stage      | Selects                                                 |
| ------------------------ | ------------ | ---------- | ------------------------------------------------------- |
| `--scheme <name>`        | iOS          | build, run | Xcode scheme                                            |
| `--configuration <name>` | iOS          | build, run | Xcode configuration                                     |
| `--variant <name>`       | Android      | build, run | Gradle variant                                          |
| `--arch <name>`          | iOS          | build      | Architecture: `arm64`, `x86_64`, `all`                  |
| `--abi <name>`           | Android      | build      | ABI: `arm64-v8a`, `armeabi-v7a`, `x86`, `x86_64`, `all` |
| `--eas-profile <name>`   | iOS, Android | build      | Download this EAS profile's development build           |
| `--export <path>`        | all native   | build      | Also write the app (APK or tar.gz) to this path         |

The library also accepts the public API's other platform-specific build options, and
run options other than those that build.

Everything after `--` is an argument vector. No shell is inferred. To use shell
syntax, pass a shell explicitly: `-- bash -e -o pipefail -c 'pnpm test:e2e'`.

The test process runs in the project directory. It receives the caller's
environment plus these values:

| Variable                | Value                                                                     |
| ----------------------- | ------------------------------------------------------------------------- |
| `STIM_CI_PLATFORM`      | Selected platform                                                         |
| `STIM_CI_DEVICE_ID`     | Exact simulator UDID or emulator serial; empty for macOS/web              |
| `STIM_CI_APP_ID`        | App bundle/package identifier when available                              |
| `STIM_CI_METRO_PORT`    | Metro port when available                                                 |
| `STIM_CI_ARTIFACTS_DIR` | Absolute results directory; empty without `--artifacts`                   |
| `STIM_CI_RUN_RESULT`    | Path to `run.json` before the command starts; empty without `--artifacts` |

`run.json` contains the public Stim result `{ platform, facts }`, including
platform-specific process, target, launch, and log facts; `appPath` is the stable
path of the installed app. Use the exact
reported target; do not select an arbitrary booted device. Tests own
app-specific readiness checks. A launch can still be `bundling` or `unverified`.

Progress and test output go to stderr. Stdout contains one JSON result. With
`--artifacts <dir>` the same result is saved as `result.json` beside `run.json`,
`test.stdout.log`, `test.stderr.log`, and `diagnostics.json`. Without it no result,
test or diagnostic file is written, no logs are copied, and the result's
`artifactsDir`, `resultPath` and `runPath` are null. An explicit results directory
must be empty; a reused directory is refused before setup so stale evidence cannot
describe a new run.
Keep results outside fingerprinted project inputs.

The result includes `version: 1`, `projectRoot`, `platform`, `artifactsDir`,
`resultPath`, `runPath`, `startedAt`, `durationMs`, `exitCode`, the native `run`,
the `test` result, optional `failure`, `diagnostics`, and `cleanup`.
If a progress callback or writing `result.json` fails, the result includes
`reportingError`. Reporter failures cannot interrupt cleanup or replace an earlier
test failure; after a passing test, they return 1.
Setup failure leaves `run` and `test` null. Diagnostics include the last 1000
structured records and their original directory. After cleanup, regular `.log`
and `.ndjson` files (including `.1` rotated copies) directly inside that directory
are copied into `logs/` and listed in `diagnostics.files`. This retains raw
compiler and process output even when setup fails. These persisted files can
include earlier records from the same workspace. Collection does not follow
symlinks, nested directories, or paths referenced by log records. It does not
copy build binaries or caches. Collection failures appear in `diagnostics.error`
without replacing the setup or test exit code.

Providers can import `diagnosticArtifactFiles` from `@stim-cli/ci/artifacts` to
list the regular result, run, test and diagnostic files for upload. The helper
only selects those known files and the copied logs; custom test outputs need
the provider's own explicit upload configuration.

## Library

```ts
import { runCI } from '@stim-cli/ci';

const result = await runCI({
  projectRoot: '/checkout/app',
  run: { platform: 'ios', configuration: 'Debug' },
  command: ['pnpm', 'test:e2e'],
  artifactsDir: '/job/results',
  timeoutMs: 30 * 60 * 1000,
  signal: controller.signal,
  onProgress: ({ message }) => process.stderr.write(message),
});

process.exitCode = result.exitCode;
```

The library does not change `process.cwd()`, `process.env`, process signal
handlers, or the caller's exit code. Invalid arguments throw before native
setup. Setup, test, diagnostics, and cleanup outcomes are returned in the
result. The CLI alone handles SIGINT/SIGTERM and sets its exit code.

## Failure and cancellation

A failing command preserves its exit code even when diagnostics or cleanup
also fail. A passing command followed by incomplete cleanup returns 1. The
result records both failures when relevant. Diagnostics failures are recorded
without replacing the setup or test result.

`timeoutMs` / `--timeout` covers setup and the test command; there is no timeout
by default. Timeout returns 124. Cancellation returns 130. Cancellation during
cleanup is also recorded, preserving an already completed test failure. Cancellation stops
the test process tree and aborts the native operation, then uses fresh signals
to stop the workspace (up to 60 seconds) and collect its persisted diagnostics
(up to 10 seconds). On macOS/Linux, the test command gets its own process group; children
that deliberately detach from it are outside that group. On Windows, tree
termination uses `taskkill`; commands must not leave background children after
their parent exits. Keep test resources inside the command's process tree.

Cleanup cannot run after SIGKILL, runner loss, or a provider's hard timeout.
Leave room between the package timeout and the job timeout. The result reports
incomplete cleanup; use normal Stim recovery for a persistent runner. `stop`
shuts down owned devices; it does not delete them.

## Disposable and shared runners

GitHub-hosted jobs need no home or cache configuration. When `GITHUB_ACTIONS=true`,
`RUNNER_ENVIRONMENT=github-hosted` and `RUNNER_TEMP` is set, the package defaults to
`$RUNNER_TEMP/stim-ci/home` and `$RUNNER_TEMP/stim-ci/build-cache`. Repeated steps
in the same job reuse these paths. The public API and test command receive the
same paths without changing the caller's environment.

An explicit `home` / `--home` or `STIM_HOME` retains the caller's home and normal
cache configuration. An explicit `buildCache` / `--build-cache` or
`STIM_BUILD_CACHE` overrides the automatic cache path. Self-hosted runners,
other providers and local runs keep normal Stim configuration and configured
build/device caps. `CI=true` alone changes no defaults or coordination guarantees.

For another disposable runner dedicated to one job, explicitly provide a fresh
job home and a job-local artifact cache:

```sh
stim-ci build --platform ios --project ./app \
  --home "$RUNNER_TEMP/stim-home" \
  --build-cache "$RUNNER_TEMP/stim-build-cache"
stim-ci run --platform ios --project ./app \
  --home "$RUNNER_TEMP/stim-home" \
  --build-cache "$RUNNER_TEMP/stim-build-cache" \
  --artifacts "$RUNNER_TEMP/stim-results" \
  --timeout 1800 -- pnpm test:e2e
```

Restore and save only the artifact cache through the provider. Never restore
workspace state, process records, claims, device ledgers, or pairings. Use cache
names that separate OS, architecture and platform; Stim still validates its
native fingerprint/configuration keys. Keep provider fallback keys within
compatible toolchains. Save complete entries, not staging directories, after
the runner finishes. Cache service failure should fall back to a build.

Do not point independent homes at a shared writable filesystem cache. Build
single-flight claims are scoped to the Stim home. Job-local restored copies
have no cross-job writers; persistent shared runners should use their normal
shared Stim home and coordination.

Current code already skips capacity admission when `concurrency.maxBuilds` and
`concurrency.maxDevices` are 0, their defaults. An explicit `STIM_HOME` defaults
device parking to 0. These are existing fast paths, not a new unsafe mode.
Ownership ledgers, atomic writes, process identity, cache publication, and
workspace claims still run. No timing study has established that this
bookkeeping is a material CI cost.

One concrete setup waste in Stim's existing Android fixture workflow is booting
an emulator through another action and immediately killing it before Stim
boots its own. SDK-only setup can avoid that extra boot without adopting an
external device. External simulator/emulator adoption is not part of this API.

Before adding coordination shortcuts, compare cold and warm runs by phase:
dependency setup, fingerprint/cache lookup, native build, device boot, install,
Metro, test, diagnostics, cleanup, and capacity waits. Validate a fresh-home
warm-cache run actually skips compilation, a deliberate test failure retains
its logs/exit code, cancellation leaves no live owned processes, and a shared
runner's unrelated workspace remains running. Native timings and cross-provider
acceptance require real tool runs; unit tests are not that evidence.
