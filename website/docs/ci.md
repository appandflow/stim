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
cancellation returns 130. Leave at least 70 seconds between this timeout and
the provider's hard timeout for diagnostics and cleanup.
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

To try it with an agent:

> Use @stim-cli/ci to run this app's existing test command on a dedicated
> checkout. Use the exact target in STIM_CI_RUN_RESULT, save result.json and
> diagnostics, and verify cleanup on both success and a deliberate test failure.
