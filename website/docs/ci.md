---
title: Continuous integration
---

import Tabs from '@theme/Tabs';
import TabItem from '@theme/TabItem';
import PromptBox from '@site/src/components/PromptBox';

`stim ci` builds your app once, installs and launches it on a clean owned
simulator or emulator, runs your test command, and cleans up. It works for
iOS, Android, macOS and web.

<PromptBox
title="Run tests in CI"
response={`Added a CI job: stim ci build, then stim ci run with pnpm test:e2e.
A deliberate failure kept its exit code; result.json and diagnostics were saved and the device was cleaned up.`}

>

{`Use stim ci to run this app's existing e2e test command in CI. Build with stim ci build, then run with stim ci run and an artifacts directory. Use the exact target in STIM_CI_RUN_RESULT, and check cleanup on both success and a deliberate test failure.`}
</PromptBox>

## Build, then run

Install the app's dependencies and native tools first.

<Tabs groupId="installation" defaultValue="global">
<TabItem value="global" label="Global">

```sh
npm install --global stim
stim ci build --platform ios --project ./app
stim ci run --platform ios --project ./app --artifacts ./test-results --timeout 1800 -- pnpm test:e2e
```

</TabItem>
<TabItem value="npx" label="npx">

```sh
npx --yes stim ci build --platform ios --project ./app
npx --yes stim ci run --platform ios --project ./app --artifacts ./test-results --timeout 1800 -- pnpm test:e2e
```

</TabItem>
</Tabs>

- `stim ci build` is the only step that compiles. It records the app; add
  `--export <path>` to also write an APK or a `tar.gz`.
- On iOS and Android, `stim ci run` installs the last recorded build and never
  builds. With no recorded build it refuses and prints the build command to
  run. On macOS, `run` builds its app itself.
- The command after `--` gets the device and app in `STIM_CI_*` variables,
  including `STIM_CI_RUN_RESULT`, the exact target to test.
- stdout holds one JSON result. With `--artifacts`, results and diagnostics
  are also saved to that directory, which must be empty.
- A failed test keeps its exit code. A timeout exits 124, a cancellation 130.
  Leave at least 70 seconds between `--timeout` and your provider's hard
  timeout so cleanup can finish.

## What a run deletes

Every local iOS and Android `run` starts the app from clean state on the
workspace's own simulator or emulator. Before it installs, it uninstalls every
other user app on that device except XCUITest runners, clears the app's data,
and on iOS resets the simulator keychain. It refuses a simulator or emulator
Stim does not own, and refuses a physical device. A run that `ios.remote` or
`android.remote` places on another machine or on EAS is not cleaned.

## Isolation

- Give each concurrent job its own checkout and its own Stim home. Keep your
  developer checkout out of CI jobs.
- On GitHub-hosted runners the home and build cache are job-local
  automatically. Elsewhere, pass the same `--home` to `build` and `run`.
- Persist only build cache entries between jobs, never the Stim home.
  Independent Stim homes must not write one shared filesystem cache.
- `build` targets this machine's architecture. When `run` can land on another
  machine or on EAS, build with `--arch all` (iOS) or `--abi all` (Android).

## GitHub Actions

The repository ships a [Stim CI action](https://github.com/appandflow/stim/tree/main/.github/actions/stim-ci)
that runs `ci build` and `ci run` in one step, uploads results and writes the
job summary. It runs on macOS and Linux runners, not Windows. Pin it to a
commit and pass an exact published `stim` version:

```yaml
- uses: appandflow/stim/.github/actions/stim-ci@<commit>
  with:
    version: <stim version>
    platform: ios
    project: apps/mobile
    command: pnpm test:e2e
    artifacts: stim-ci-results
    timeout: '1800'
```

`command` is Bash source, like a `run:` step. Pass untrusted event values
through environment variables, never by interpolating them into `command`.

Build only, without a device or test:

```yaml
- uses: appandflow/stim/.github/actions/stim-ci@<commit>
  with:
    version: <stim version>
    platform: android
    project: apps/mobile
    build-only: 'true'
    export: out/app.apk
```

The action sets outputs such as `app-path`, `export-path`, `cache-hit`,
`device-id` and `exit-code`. Its README lists every input and output.

## EAS Workflows

The [Mobile workflow](https://github.com/appandflow/stim/blob/main/apps/mobile/.eas/workflows/stim-ci.yml)
in this repository runs `stim ci` in an EAS custom Android job and uploads
diagnostics with `eas/upload_artifact`. Copy it as a starting point. EAS
Workflows usage counts toward your Expo plan's compute allowance.

## JavaScript

The same flow is available as `buildCI` and `runCI` from `stim/ci`:

```ts
import { runCI } from 'stim/ci';

const result = await runCI({
  projectRoot: '/checkout/app',
  run: { platform: 'android' },
  command: ['pnpm', 'test:e2e'],
  artifactsDir: '/job/results',
  timeoutMs: 30 * 60 * 1000,
});
process.exitCode = result.exitCode;
```

The [package README](https://github.com/appandflow/stim/tree/main/packages/ci)
documents the result schema, artifacts and cache rules. `stim ci run --help`
lists every flag, and `stim guide errors ci` lists the failure codes.
