---
title: Continuous integration
---

import Tabs from '@theme/Tabs';
import TabItem from '@theme/TabItem';

`@stim-cli/ci` builds and launches an app through Stim, runs your test command,
collects diagnostics, and stops the workspace. It supports iOS, Android, macOS,
and web through the same public API that can be imported from `stim`.

Install the app's dependencies and native tools first. Give each concurrent
run its own checkout; cleanup stops the selected workspace. Keep your
developer checkout out of CI jobs.

<Tabs groupId="installation" defaultValue="global">
<TabItem value="global" label="Global">

```sh
npm install --global @stim-cli/ci
stim-ci run --platform ios --project ./app --artifacts ./test-results --timeout 1800 -- pnpm test:e2e
```

</TabItem>
<TabItem value="npx" label="npx">

```sh
npx --yes --package @stim-cli/ci stim-ci run --platform ios --project ./app --artifacts ./test-results --timeout 1800 -- pnpm test:e2e
```

</TabItem>
</Tabs>

## Build without launching

```sh
stim-ci build --platform android --project ./app --artifacts ./build-results
```

`build` needs no test command or device. It preserves existing workspace
sessions. iOS and Android builds use the same native artifact cache as `run`; a
later `run` validates it normally, and `cacheKey` and `cacheHit` in its
`run.json` show whether it reused the build. macOS builds are not cached.
GitHub-hosted steps automatically share the job's temporary home and cache. Use
a separate results directory for each step.

Both `build` and `run` accept `--scheme` and `--configuration` for iOS and
`--variant` for Android, so a run can match a build. `build` also accepts
`--arch` (`arm64`, `x86_64`, `all`) for iOS and `--abi` (`arm64-v8a`,
`armeabi-v7a`, `x86`, `x86_64`, `all`) for Android. Without them, each project's
normal build settings apply.

Upload the results directory through your CI provider. It includes `result.json`,
`build.json`, `diagnostics.json`, and an APK or a `tar.gz` app bundle. iOS and
macOS also keep the archive command's output in `artifact.stdout.log` and
`artifact.stderr.log`. Apple bundles are
archived to preserve executable modes and symlinks across artifact transport.
iOS outputs target the simulator; distribution archives and web compilation
are outside this command. Downloaded-artifact import into a Stim run is not
provided.

```ts
import { buildCI } from '@stim-cli/ci';
const result = await buildCI({ projectRoot: '/checkout/app', build: { platform: 'ios' } });
process.exitCode = result.exitCode;
```

## Run and test

The command after `--` is an argument vector. Use an explicit shell when you
need shell syntax. Progress and test output go to stderr; stdout and
`test-results/result.json` contain the structured outcome. A failed test keeps
its exit code even if diagnostics or cleanup also fail. Timeout returns 124;
cancellation returns 130, including cancellation during cleanup when the test
has not already failed. Progress callback failures are retained in
`reportingError` and cannot interrupt cleanup. Leave at least 70 seconds between
this timeout and the provider's hard timeout for diagnostics and cleanup.
The artifacts directory must be empty; choose a new one for each run.

The command receives `STIM_CI_DEVICE_ID`, `STIM_CI_APP_ID`, and
`STIM_CI_METRO_PORT` when those facts apply, plus `STIM_CI_PLATFORM`,
`STIM_CI_ARTIFACTS_DIR`, and `STIM_CI_RUN_RESULT`. The last variable points to
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

To try it with an agent:

> Use @stim-cli/ci to run this app's existing test command on a dedicated
> checkout. Use the exact target in STIM_CI_RUN_RESULT, save result.json and
> diagnostics, and verify cleanup on both success and a deliberate test failure.
