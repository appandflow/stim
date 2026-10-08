# @stim-cli/ci

Build and launch an app through Stim, run your test command, retain diagnostics,
and stop the workspace. The library imports the public API from `stim`; it does
not depend on GitHub Actions, EAS, or internal Stim modules.

Requires Node.js 22.12 or newer and the native tools for the selected platform.
Install the app's dependencies before running it. Each concurrent CI run needs
its own checkout. The run stops that checkout's workspace, including resources
started before a build failure; an explicit API `run.slot` limits cleanup to
that slot. Do not point CI at a developer's active checkout.

## Command line

Without installing:

```sh
npx --yes --package @stim-cli/ci stim-ci run --platform ios --project ./app -- pnpm test:e2e
```

Or install `npm install --global @stim-cli/ci`, then:

```sh
stim-ci run --platform android --project ./app --artifacts ./test-results --timeout 1800 -- pnpm test:e2e
```

`--platform` accepts `ios`, `android`, `macos`, or `web`. `--project` defaults
to the current directory. `--home` and `--build-cache` explicitly select the
Stim home and native artifact cache; leaving them unset preserves normal Stim
configuration. The CLI uses each project's normal build settings. The library
also accepts the public API's platform-specific run options.

Everything after `--` is an argument vector. No shell is inferred. To use shell
syntax, pass a shell explicitly: `-- bash -e -o pipefail -c 'pnpm test:e2e'`.

The test process runs in the project directory. It receives the caller's
environment plus these values:

| Variable                | Value                                                        |
| ----------------------- | ------------------------------------------------------------ |
| `STIM_CI_PLATFORM`      | Selected platform                                            |
| `STIM_CI_DEVICE_ID`     | Exact simulator UDID or emulator serial; empty for macOS/web |
| `STIM_CI_APP_ID`        | App bundle/package identifier when available                 |
| `STIM_CI_METRO_PORT`    | Metro port when available                                    |
| `STIM_CI_ARTIFACTS_DIR` | Absolute results directory                                   |
| `STIM_CI_RUN_RESULT`    | Path to `run.json`, written before the command starts        |

`run.json` contains the public Stim result `{ platform, facts }`, including
platform-specific process, target, cache, launch, and log facts. Use the exact
reported target; do not select an arbitrary booted device. Tests own
app-specific readiness checks. A launch can still be `bundling` or `unverified`.

Progress and test output go to stderr. Stdout contains one JSON result. The same
result is saved as `result.json` beside `run.json`, `test.stdout.log`,
`test.stderr.log`, and `diagnostics.json`. Without `--artifacts`, results use a
fresh temporary directory. An explicit results directory must be empty; a reused
directory is refused before setup so stale evidence cannot describe a new run.
Keep results outside fingerprinted project inputs.

The result includes `version: 1`, `projectRoot`, `platform`, `artifactsDir`,
`resultPath`, `runPath`, `startedAt`, `durationMs`, `exitCode`, the native `run`,
the `test` result, optional `failure`, `diagnostics`, and `cleanup`.
If a progress callback or writing `result.json` fails, the result includes
`reportingError`. Reporter failures cannot interrupt cleanup or replace an earlier
test failure; after a passing test, they return 1.
Setup failure leaves `run` and `test` null. Diagnostics include the last 1000
structured records and their original directory; raw compiler files remain in
the Stim workspace log directory if additional artifacts are needed.

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

`CI=true` changes no coordination or ownership guarantees. The default keeps
normal Stim configuration, including configured build/device caps. Use it for
persistent runners and local reproduction.

For a disposable runner dedicated to one job, explicitly provide a fresh job
home and a job-local artifact cache:

```sh
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
