---
title: Continuous integration
---

import Tabs from '@theme/Tabs';
import TabItem from '@theme/TabItem';

`@stim-cli/ci` builds an app once, then installs and launches it through Stim,
runs your test command if you give one, and stops the workspace. It supports iOS, Android, macOS,
and web through the same public API that can be imported from `stim`.

Install the app's dependencies and native tools first. Give each concurrent
run its own checkout; cleanup stops the selected workspace. Keep your
developer checkout out of CI jobs.

<Tabs groupId="installation" defaultValue="global">
<TabItem value="global" label="Global">

```sh
npm install --global @stim-cli/ci
stim-ci build --platform ios --project ./app
stim-ci run --platform ios --project ./app --artifacts ./test-results --timeout 1800 -- pnpm test:e2e
```

</TabItem>
<TabItem value="npx" label="npx">

```sh
npx --yes --package @stim-cli/ci stim-ci build --platform ios --project ./app
npx --yes --package @stim-cli/ci stim-ci run --platform ios --project ./app --artifacts ./test-results --timeout 1800 -- pnpm test:e2e
```

</TabItem>
</Tabs>

## Build

`stim-ci build` is the only step that compiles. It needs no test command or
device and preserves existing workspace sessions. It compiles the app, or
restores it from the native artifact cache, and records it for this checkout,
platform and selectors (iOS scheme and configuration, Android variant) in
Stim's workspace state. Nothing else is written: `build` exports no file and
collects no logs unless you ask.

```sh
stim-ci build --platform android --project ./app
stim-ci build --platform ios --project ./app --export ./app.tar.gz
```

`--export <path>` also writes the app: an APK for Android, a `tar.gz` that
preserves executable modes and symlinks for iOS and macOS. Archiving takes
several seconds even on a cache hit, so export only what something consumes.
`--artifacts <dir>` adds `result.json`, `build.json` and `diagnostics.json`.
`--eas-profile <name>` (iOS and Android) downloads a completed EAS development
build instead of compiling; Stim never starts an EAS build.

Both `build` and `run` accept `--scheme` and `--configuration` for iOS and
`--variant` for Android; `run` finds the recorded app by them. `build` also
accepts `--arch` (`arm64`, `x86_64`, `all`) for iOS and `--abi` (`arm64-v8a`,
`armeabi-v7a`, `x86`, `x86_64`, `all`) for Android; the last build for the
selectors is the one `run` installs. Without selectors, each project's normal
build settings apply. GitHub-hosted steps automatically share the job's
temporary home and cache. Pass the same `--home` to `build` and `run` elsewhere.
iOS outputs target the simulator; distribution archives and web compilation
are outside this command.

```ts
import { buildCI } from '@stim-cli/ci';
const result = await buildCI({ projectRoot: '/checkout/app', build: { platform: 'ios' } });
process.exitCode = result.exitCode;
```

## Run and test

`stim-ci run` never builds or replaces the app's JavaScript. It installs and
launches the app the last matching `build` recorded and trusts it, so rebuild
after changing the project. A Debug app still gets Metro from `run`. With no
recorded build, `run` refuses with `STIM_NO_RECORDED_BUILD` before touching a
device, and the failure's `remedy` names the `stim-ci build ...` command to run
first. macOS and web are unchanged: macOS `run` builds its app itself.

Every iOS and Android `run` on this machine starts the app from clean state on
the workspace's own simulator or emulator, including when the device already
has this build.
Before it installs, `run` uninstalls every other user app except XCUITest
runner apps, such as the ones agent-device installs, so test tools do not
reinstall them on each run. On iOS it also clears the app's defaults and data
container and resets the simulator keychain; on Android it runs `pm clear` on
the app. Simulator-wide settings such as privacy grants are kept. A local
simulator or emulator Stim does not own refuses with `STIM_BAD_ARG` instead of
skipping the cleanup. A run that `ios.remote` or `android.remote` places on
another machine or on EAS is not cleaned, and a physical device is refused.
`build` always compiles on this machine and ignores `remote.build`. By default
it compiles an iOS app, and an Android Debug app, for this machine's
architecture only, so when `run` can
land on another machine or on EAS, build for that device too with `--arch all`
(iOS) or `--abi all` (Android). Plain `stim ios` and `stim android` keep app data between
runs and clean only a simulator or emulator they adopt from the parked pool.

The command after `--` is an argument vector. Use an explicit shell when you
need shell syntax. Without `--`, `run` installs and launches the app, writes the
same `run` facts, then stops the workspace with exit code 0 and `test: null`, so a
later step can drive the app on that device after booting it again. An explicit
`--` with nothing after it is refused. Progress and test output go to stderr; stdout contains the
structured outcome, also saved as `result.json` when `--artifacts` is set. A failed test keeps
its exit code even if diagnostics or cleanup also fail. Timeout returns 124;
cancellation returns 130, including cancellation during cleanup when the test
has not already failed. Progress callback failures are retained in
`reportingError` and cannot interrupt cleanup. Leave at least 70 seconds between
this timeout and the provider's hard timeout for diagnostics and cleanup.
Without `--artifacts` no result, test or diagnostic file is written and no logs
are copied. An artifacts directory must be empty; choose a new one for each run.

The command receives `STIM_CI_DEVICE_ID`, `STIM_CI_APP_ID`, and
`STIM_CI_METRO_PORT` when those facts apply, plus `STIM_CI_PLATFORM`,
`STIM_CI_ARTIFACTS_DIR`, and `STIM_CI_RUN_RESULT`. The last two are empty without
`--artifacts`; otherwise `STIM_CI_RUN_RESULT` points to
`run.json`, written before tests start, with exact `{ platform, facts }` from
Stim. Tests must use that exact target and implement app-specific readiness;
`launched` can be `bundling` or `unverified`.

The [package reference](https://github.com/appandflow/stim/tree/main/packages/ci)
documents the library, result schema, artifacts, cancellation, and cache rules.

```ts
import { runCI } from '@stim-cli/ci';

const result = await runCI({
  projectRoot: '/checkout/app',
  run: { platform: 'android' },
  command: ['pnpm', 'test:e2e'],
  artifactsDir: '/job/results',
  timeoutMs: 30 * 60 * 1000,
});

process.exitCode = result.exitCode;
```

On GitHub-hosted runners, home and cache paths are automatic:
`$RUNNER_TEMP/stim-ci/home` and `$RUNNER_TEMP/stim-ci/build-cache`. Repeated steps
reuse the job's paths. Detection requires `GITHUB_ACTIONS=true`,
`RUNNER_ENVIRONMENT=github-hosted` and `RUNNER_TEMP`.

An explicit `--home` or `STIM_HOME` keeps the selected home and normal cache
configuration; `--build-cache` or `STIM_BUILD_CACHE` overrides the cache path.
Self-hosted runners and local runs retain their normal Stim home and capacity
limits. For other disposable providers, set job-local paths explicitly.
Persist only compatible cache entries, never runtime state or device ledgers.
Independent Stim homes must not write one shared filesystem cache.

`CI=true` does not disable ownership, locking, or cleanup checks. Capacity
admission is already skipped when its limits are unset; there is no measured
reason yet to bypass the remaining coordination.

## GitHub Actions

The repository includes a thin [Stim CI action](https://github.com/appandflow/stim/tree/main/.github/actions/stim-ci).
It maps workflow inputs to `stim-ci`, runs `build` and then `run` in one step
(iOS and Android always build; macOS only with `export`; web never), forwards
cancellation, and writes the job summary. It installs the pinned `@stim-cli/ci`
once per runner and version and reuses it for both commands. Native tools and app dependencies must be installed first.
The bundled TypeScript action uses GitHub's Node.js 24 runtime and supports
macOS and Linux runners with Bash. Windows is refused; self-hosted runners
need support for Node.js 24 JavaScript actions.

For dogfood against a built Stim checkout:

```yaml
- uses: ./.github/actions/stim-ci
  with:
    cli-path: packages/ci/dist/stim-ci.mjs
    platform: ios
    project: apps/mobile
    command: node ../../scripts/ci/app-smoke.mjs
    home: ${{ runner.temp }}/stim-home
    artifacts: stim-ci-results
    timeout: '1800'
    artifact-name: stim-ci-ios
    retention-days: '7'
```

Once released, consumers can pin the action to a commit and supply `version`
with an exact published `@stim-cli/ci` version instead of `cli-path`. The
command input is Bash source, like a workflow `run:` step. Pass untrusted
event values through environment variables, not interpolation into `command`.
Leave `command` out to only build, install and launch the app from clean state,
then stop it; a later step can drive it with the outputs below. That needs a
`@stim-cli/ci` version newer than 1.37.0, which refuses a run without a command.

The `scheme`, `configuration` and `variant` inputs select the build and go to both
commands; `arch`, `abi` and `eas-profile` go to `build` only. For example,
`configuration: Release` builds and runs a Release simulator app.

The action also sets step outputs from the results: `app-id`, `app-path`, `export-path`,
`cache-hit`, `device-id`, `device-name` and `exit-code`. A later step can use the exported
app (`export-path`), or boot the same iOS simulator again by `device-id`; the step shuts
devices down when it ends, and an Android emulator does not outlive it.

Nothing is collected or uploaded unless `artifacts` is set; `export` writes the built
app to a path. With `artifacts`, use a new, empty directory for each invocation. Leave at least 70
seconds for cleanup after the action timeout, plus time for artifact upload.
With `artifacts`, the Action uploads result, test and diagnostic/compiler logs on
success and failure. It exposes `artifact-id` and `artifact-url` after upload,
while `result` and `artifacts` remain local paths for later steps in the job.
A custom `artifact-name` must be unique across invocations in the workflow run.
`upload-artifacts` applies only when `artifacts` is set; set it to `'false'` to opt out or use another transport, including
on GitHub Enterprise Server where the toolkit service is unavailable. An
upload failure preserves an earlier nonzero CI exit code, otherwise it fails
the Action. Uploads exclude app binaries, caches, symlinks and arbitrary test
files. Raw log copying depends on the selected package version.
Hard provider termination can prevent cleanup and uploads from completing.

## EAS Workflows

The checked-in [Mobile workflow](https://github.com/appandflow/stim/blob/main/apps/mobile/.eas/workflows/stim-ci.yml)
runs the same package in an EAS custom Android job, using a runner with nested
virtualization and `eas/upload_artifact` for diagnostics. It is manually
triggered. EAS Workflows usage counts toward the Expo plan's compute allowance.

Provider configuration contains only environment preparation, invocation and
artifact upload; lifecycle and test execution remain in `@stim-cli/ci`.

## Stim app coverage

The GitHub dogfood workflow builds once, then installs, launches, probes and stops Mobile on iOS
and Android and Desktop on macOS. It then repeats with the job's warm build
state. It runs for relevant changes on `main`, manual dispatches, and relevant
pull requests carrying the `e2e-smoke` label.

These checks prove that the exact installed native app process stays alive
for five seconds. They do not assert screen rendering, navigation, or a
successful server connection. App unit tests and the broader native fixture
tests remain separate.

To try it with an agent:

> Use @stim-cli/ci to run this app's existing test command on a dedicated
> checkout. Use the exact target in STIM_CI_RUN_RESULT, save result.json and
> diagnostics, and verify cleanup on both success and a deliberate test failure.
