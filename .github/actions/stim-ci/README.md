# Stim CI action

This bundled TypeScript action installs and invokes `@stim-cli/ci`. The package owns
build/launch, the test process, cancellation, diagnostics and cleanup. The
action maps inputs, outputs and the GitHub job summary, and uploads diagnostics
and completed build artifacts with the official GitHub artifact toolkit.

Use a macOS or Linux runner with Bash. Windows runners are refused. The Action
uses GitHub's Node.js 24 runtime; install the app's dependencies and native tools
before using it. Self-hosted runners must support Node.js 24 JavaScript actions.
iOS and macOS require a macOS runner; Android requires
an SDK and Java. Running Android also requires an installed emulator image
and hardware virtualization. The action
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

Use separate steps when you also want the compiled app as a GitHub artifact:

```yaml
- name: Build
  uses: ./.github/actions/stim-ci
  with:
    stage: build
    cli-path: packages/ci/dist/stim-ci.mjs
    platform: ios
    project: apps/mobile
- name: Run tests
  uses: ./.github/actions/stim-ci
  with:
    stage: run
    cli-path: packages/ci/dist/stim-ci.mjs
    platform: ios
    project: apps/mobile
    command: node ../../scripts/ci/app-smoke.mjs
```

`stage` defaults to `run`. Build needs no command or device; it compiles an
APK or simulator/macOS app and leaves existing sessions alone. Run validates
and reuses the normal build cache in the same job. A build export is not a
cross-job cache: downloading it does not make a later Stim run import it.
Web supports `run` only. Project build settings apply to both stages.

Once the package and action revision are released, other repositories can
reference `appandflow/stim/.github/actions/stim-ci@<commit>` and replace
`cli-path` with `version: '<exact published version>'`. Pin both independently.
The action installs that exact npm version with lifecycle scripts disabled.

`command` is Bash source, executed in the app directory with `-e` and
`pipefail`. Treat it like a workflow `run:` step: keep untrusted PR titles,
comments and other event text out of it. Supply test inputs as environment
variables instead. All other action inputs are passed as argument values.

The `result` and `artifacts` outputs are absolute paths available within the job.
Build also returns `build-artifact`, the completed APK or tar.gz app archive.
Results default to `stim-ci-build-results` or `stim-ci-run-results`; additional
steps of the same stage need a different explicit `artifacts` directory.
By default, the Action uploads `result.json`, `run.json`, test stdout/stderr,
`diagnostics.json`, and copied diagnostic/compiler logs on success and failure.
Build adds `build.json`, archive command logs and the reported completed
`app.apk` or `app.tar.gz`. Apple archives preserve executable permissions and
symlinks when extracted with `tar -xzf app.tar.gz`. Run does not upload app
binaries. Neither stage uploads caches, arbitrary files, linked entries, or
files referenced by log records. Raw log collection requires a `@stim-cli/ci`
version containing that feature.

`artifact-id` and `artifact-url` are set only after a successful upload. The
default artifact name is unique to each invocation; a supplied `artifact-name`
must be unique within the workflow run, including matrix jobs and retries.
`retention-days: '0'` uses the repository retention setting. Set
`upload-artifacts: 'false'` to keep only local files or use another transport.
The toolkit upload service requires GitHub.com; use the opt-out on GitHub
Enterprise Server. Upload failures fail an otherwise successful Action and
preserve an earlier nonzero Stim CI exit code. The saved result continues to
describe the portable CI lifecycle; the job summary reports the final Action
exit code, including upload failure.

Run `result.json` includes the original test exit code and separate diagnostics/cleanup outcomes. Tests
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
or retained session. Test commands are required for run and refused for build.

## Repository dogfood

`.github/workflows/stim-ci.yml` builds and launches Stim Mobile on iOS and
Android and Stim Desktop on macOS. Each job first builds and uploads the app
artifact, then runs the lifecycle smoke and repeats it with warm build state. The smoke command checks the exact app process immediately and
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
