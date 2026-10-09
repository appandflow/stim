# Stim CI action

This composite action installs and invokes `@stim-cli/ci`. The package owns
build/launch, the test process, cancellation, diagnostics and cleanup. The
action maps inputs, outputs and the GitHub job summary.

Use a macOS or Linux runner. Install Node.js 22.12 or later, the app's dependencies, and its native tools
before using the action. iOS and macOS require a macOS runner; Android requires
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
- uses: actions/upload-artifact@v4
  if: always()
  with:
    name: stim-ci-results
    path: stim-ci-results
```

Once the package and action revision are released, other repositories can
reference `appandflow/stim/.github/actions/stim-ci@<commit>` and replace
`cli-path` with `version: '<exact published version>'`. Pin both independently.
The action installs that exact npm version with lifecycle scripts disabled.

`command` is Bash source, executed in the app directory with `-e` and
`pipefail`. Treat it like a workflow `run:` step: keep untrusted PR titles,
comments and other event text out of it. Supply test inputs as environment
variables instead. All other action inputs are passed as argument values.

The `result` and `artifacts` outputs are absolute paths. `result.json` includes
the original test exit code and separate diagnostics/cleanup outcomes. Tests
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

Leave at least 70 seconds between the action's timeout and the job timeout.
The action forwards cancellation to `stim-ci`; the provider can still kill
the job before cleanup completes. Upload artifacts with `if: always()`.

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
