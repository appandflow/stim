# Stim CI action

This bundled TypeScript action installs and invokes `@stim-cli/ci`. It runs
`stim-ci build` and then `stim-ci run` in one step: build is the only step that
compiles, and run installs and launches the app that build recorded, then runs the
test when `command` is set. The package owns the build, the test process, cancellation and cleanup. The
action maps inputs, outputs and the GitHub job summary, and uploads diagnostic
evidence with the official GitHub artifact toolkit when `artifacts` is set. iOS and
Android always build first. macOS builds first only with `export`, and web never
builds; `stim-ci run` builds a macOS app itself.

Use a macOS or Linux runner with Bash. Windows runners are refused. The Action
uses GitHub's Node.js 24 runtime; install the app's dependencies and native tools
before using it. Self-hosted runners must support Node.js 24 JavaScript actions.
iOS and macOS require a macOS runner; Android requires
an SDK, an installed emulator image, and hardware virtualization. The action
does not install Xcode or an Android SDK.

When testing this repository, use the built checkout:

```yaml
- uses: actions/checkout@v4
- uses: ./.github/actions/setup-stim
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

Once the package and action revision are released, other repositories can
reference `appandflow/stim/.github/actions/stim-ci@<commit>` and replace
`cli-path` with `version: '<exact published version>'`. Pin both independently.
The action installs that exact npm version once per runner, with lifecycle scripts disabled,
into a version-keyed directory under the runner tool cache (or the runner temp directory),
and invokes the installed script for both build and run. A later step or job on the same
runner reuses it without another `npm install`. `cli-path` skips the install.

`command` is optional. Without it the action builds, installs and launches the app
from clean state, then stops it and succeeds, setting the same outputs, so a later step
can drive the app. That needs a `@stim-cli/ci` version newer than 1.37.0; 1.37.0 and
earlier refuse with `Separate the test command with --.`

`command` is Bash source, executed in the app directory with `-e` and
`pipefail`. Treat it like a workflow `run:` step: keep untrusted PR titles,
comments and other event text out of it. Supply test inputs as environment
variables instead. All other action inputs are passed as argument values.

The build step writes no result or diagnostic files, so a failed build is reported only in the job log and the step exits without upload or summary. Nothing is collected unless `artifacts` is set. Without it the action writes no result,
test or diagnostic file, copies no logs and uploads nothing, and the `result` and
`artifacts` outputs are not set; the build and run results still print to the job log.
`export` also writes the built app to the given path, an APK for Android or a tar.gz for
iOS and macOS; without it build only records the app for run. Export is never uploaded.

`scheme`, `configuration` (iOS) and `variant` (Android) select the build and are passed
to both build and run, so run installs the build that build recorded. `arch`, `abi` and
`eas-profile` go to build only, and the action refuses them when it does not build (web, or
macOS without `export`). Empty inputs keep the project's normal build settings, and
`stim-ci` refuses a selector that does not apply to the platform.

Whether or not `artifacts` is set, the action reads the results `stim-ci` prints and sets
`app-id`, `app-path`, `export-path`, `cache-hit`, `device-id`, `device-name` and `exit-code`
as step outputs, leaving out any that do not apply. A later step can then use the app or the
device without parsing the job log. The device is shut down, not deleted, when the step ends: a
simulator can be booted again by `device-id`, while an Android emulator is gone.

With `artifacts`, the `result` and `artifacts` outputs are absolute paths available within the job.
The Action uploads `result.json`, `run.json`, test stdout/stderr,
`diagnostics.json`, and copied diagnostic/compiler logs on success and failure.
It never uploads app bundles, APKs, caches, arbitrary test files, symlinks, or
files referenced by log records. Raw log collection requires a `@stim-cli/ci`
version containing that feature.

`artifact-id` and `artifact-url` are set only after a successful upload. The
default artifact name is unique to each invocation; a supplied `artifact-name`
must be unique within the workflow run, including matrix jobs and retries.
`retention-days: '0'` uses the repository retention setting. Set
`upload-artifacts: 'false'` to keep only local files or use another transport; it applies only
when `artifacts` is set.
The toolkit upload service requires GitHub.com; use the opt-out on GitHub
Enterprise Server. Upload failures fail an otherwise successful Action and
preserve an earlier nonzero Stim CI exit code. The saved result continues to
describe the portable CI lifecycle; the job summary reports the final Action
exit code, including upload failure.

`result.json` includes the original test exit code and separate diagnostics/cleanup outcomes. Tests
receive `STIM_CI_RUN_RESULT` and the exact owned target's identifiers. They
must implement their own UI readiness checks; a live native process alone
does not prove that a screen rendered or a test passed.

Use a unique checkout per concurrent run and an empty artifacts directory for
every invocation, including sequential retries. Existing reports are preserved
and reusing their directory is refused. A fresh
`home` is appropriate for a disposable runner. Persistent or shared workers
should keep their normal Stim home and its capacity settings. If the workflow
restores `build-cache`, restore it into a job-local directory. Independent
homes cannot coordinate concurrent writes to one shared filesystem cache.

Leave at least 70 seconds for cleanup after the Action timeout, plus time for
artifact upload before the job timeout.
The action forwards cancellation to `stim-ci`; the provider can still kill
the job before cleanup or upload completes. There is no post-job cleanup hook
or retained session.

## Repository dogfood

`.github/workflows/stim-ci.yml` builds and launches Stim Mobile on iOS and
Android and Stim Desktop on macOS. Each job repeats after cleanup with warm
build state. The smoke command checks the exact app process immediately and
again after five seconds. This is native lifecycle coverage, not UI E2E.

It runs on relevant pushes to `main`, manual dispatch, and relevant pull
requests carrying `e2e-smoke`. Existing app unit tests stay in their workflows.

`apps/mobile/.eas/workflows/stim-ci.yml` invokes the same executable from an
EAS custom Android job with nested virtualization and uploads its artifacts.
It is manually triggered and does not submit or distribute builds. Its local
schema check does not replace EAS server-side validation or a real hosted run.

## Development

The private Action workspace uses the repository's `tsdown` to bundle TypeScript
and toolkit dependencies into committed `dist/main.mjs`. Run `pnpm run build`
after source changes and commit the resulting bundle. CI rejects a bundle
that differs from a fresh build. The root formatting,
lint, typecheck, unit and unused-code checks include the Action sources.

The adapter follows GitHub's [JavaScript Action runtime guidance](https://docs.github.com/en/actions/tutorials/create-actions/create-a-javascript-action)
and the official [artifact toolkit API](https://github.com/actions/toolkit/tree/main/packages/artifact).
