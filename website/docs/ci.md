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

For a disposable runner dedicated to one job, set `--home` to a fresh job
directory and `--build-cache` to a job-local cache restored by the provider.
Persist only compatible cache entries, never runtime state or device ledgers.
Independent Stim homes must not write one shared filesystem cache.

For persistent/shared runners and local reproduction, keep the normal Stim
home and its configured capacity limits. `CI=true` does not disable ownership,
locking, or cleanup checks. Capacity admission is already skipped when its
limits are unset; there is no measured reason yet to bypass the remaining
coordination.

## GitHub Actions

The repository includes a thin [Stim CI action](https://github.com/appandflow/stim/tree/main/.github/actions/stim-ci).
It maps workflow inputs to `stim-ci`, forwards cancellation, and writes the
job summary. Native tools and app dependencies must be installed first.
The action supports macOS and Linux runners with Bash and Node.js 22.12 or later.

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
- uses: actions/upload-artifact@v4
  if: always()
  with:
    name: stim-ci-results
    path: stim-ci-results
```

Once released, consumers can pin the action to a commit and supply `version`
with an exact published `@stim-cli/ci` version instead of `cli-path`. The
command input is Bash source, like a workflow `run:` step. Pass untrusted
event values through environment variables, not interpolation into `command`.

Use a new, empty artifacts directory for each invocation. Leave at least 70
seconds for cleanup after the action timeout and upload artifacts even on
failure. Hard provider termination can prevent cleanup from completing.

## EAS Workflows

The checked-in [Mobile workflow](https://github.com/appandflow/stim/blob/main/apps/mobile/.eas/workflows/stim-ci.yml)
runs the same package in an EAS custom Android job, using a runner with nested
virtualization and `eas/upload_artifact` for diagnostics. It is manually
triggered. EAS Workflows usage counts toward the Expo plan's compute allowance.

Provider configuration contains only environment preparation, invocation and
artifact upload; lifecycle and test execution remain in `@stim-cli/ci`.

## Stim app coverage

The GitHub dogfood workflow builds, launches, probes and stops Mobile on iOS
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
