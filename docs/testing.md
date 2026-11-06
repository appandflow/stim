# Test stages

`pnpm run test:unit` runs the fast suite with fake elapsed-time clocks enabled
before each test. Advance clocks explicitly when testing deadlines or retries;
use events and promises for readiness. The linter rejects `useRealTimers`, real
sleep imports and blocking `Atomics.wait` calls in unit tests.

`pnpm run test:integration` runs the explicit `*.integration.test.ts` and
`*.integration.test.mjs` fixtures. Use this stage when the contract needs real
processes, socket deadlines, filesystem watchers, cross-process ownership or CPU
performance budgets.
Keep each exception tied to the real interaction it verifies. These tests may
use fake clocks for policy inside the fixture, such as a child process clock.

`pnpm test` remains the complete unit and integration run. It needs Node and
Git, but no Xcode, Android SDK, signing identity, or connected phone. Vitest's
worker count and test deadlines are unchanged. The native compatibility stage
keeps its real clocks.

Linux PR jobs run the unit stage on each push. Integration runs remain required
in the merge candidate's complete `pnpm test`; main and manual CI runs also run
both stages. Existing Windows and Darwin-specific smoke selections retain
their integration coverage. Run affected integrations locally when changing
the behavior they protect, rather than waiting for merge validation.

`pnpm run test:compat` runs the explicit native tool compatibility stage. It
requires macOS, Xcode with the iOS and iOS Simulator SDKs, `codesign`, `security`,
`clang`, `openssl`, Google Chrome or Chromium, and a paired, unlocked iPhone
with Developer Mode enabled. Set `STIM_COMPAT_IOS_UDID` to the test iPhone's UDID
so the process probe targets only that phone. It also requires agent-device source
from tag `v0.21.31` (`f3d2619abed42c69e60c80cf2e2dc0f626c37284`). Set
`STIM_AGENT_DEVICE_SOURCE` to that source root, with its workspace dependencies
installed. The tag pins the internal modules imported by the hosted iOS policy probe,
which uses the real upstream parser, digest and inventory filter; it starts only a
local fixture process and does not drive a simulator. Missing source fails this
stage and never affects unit discovery. The hosted Android daemon probe requires
agent-device 0.21.30 or later installed at the host's fixed binary location
(or `STIM_AGENT_DEVICE_BIN`) and `STIM_AGENT_DEVICE_ANDROID_SERIAL` naming a
booted emulator created and owned exclusively by this validation. It starts a
private real daemon, verifies its policy digest, backend, filtered inventory and
refusals for foreign serials, unsafe commands, shutdown and batch steps. It stops
the daemon and its fixed helpers only on that serial. It does not create or
delete the emulator; retain the validation fixture record and clean it through
centralized Stim teardown. Missing binary, serial, adb or emulator fails the
explicit stage and is unavailable validation, never a compatibility pass.
The hosted command probe uses the same agent-device binary. It reads
`agent-device help commands` and `agent-device help <command>` and fails when a
command is neither a hosted device command nor refused with a reason, when a
hosted command is missing from the catalog, or when a hosted command's flags
differ from the committed classification. It starts no daemon or device.
It builds generated scratch projects, signs temporary apps ad hoc, decodes
fixture provisioning profiles, reads signing identities, and queries devices and
processes through `devicectl`. It launches the installed Chrome headless with a
temporary profile, against a local page, and closes it; it also compiles the
`stim-frames` helper and streams, taps and types that page through it. It does
not install an app, alter the keychain, create or boot a simulator, or change
an Apple Developer account.

Compatibility tests live beside the unit tests as `*.compat.test.ts`. Ordinary
unit discovery excludes them. Missing tools, no phone, a locked or disconnected
phone, and rejected argv make the explicit stage fail with evidence; they do not
count as a compatibility pass. Preserve both the command and its output when
reporting an unavailable prerequisite. A unit-only CI result is not native
compatibility evidence.

Run the stage when changing native tool calls and before a release. A focused
probe is useful while iterating, for example:

```sh
pnpm run test:compat engine-ios-device.compat.test.ts
```

The focused `ios-runtime.compat.test.ts` probe requires macOS, Xcode, access to
its download catalog and 20 GB free on the simulator volume. It runs the real
installer with the impossible iOS version `0.0`, verifies Xcode accepts the
arguments and refuses the version, and downloads no runtime. It uses a private
Stim home; it does not create, boot or delete a simulator.

The focused `native-android-cache.compat.test.ts` probe requires an installed
Android SDK platform, `aapt`, `apksigner`, and JDK `keytool`. It creates and signs
a temporary manifest-only APK with a disposable keystore, verifies cache reuse,
cancellation and corruption rejection, then removes its private cache state. It
does not require a phone or emulator.

The focused `swiftpm-peer-cache.compat.test.ts` probe needs Xcode and its macOS
SDK. It compiles and signs a temporary SwiftPM app, removes its worker checkout
and build output, fetches the completed archive while build admission is paused,
and runs the relocated executable to read its bundled resource. Reuse happens
with no package sources available and build admission paused. Additional probes
verify cancellation of the real worker's executor children and invalidation of
directory-specific compiler selection and compiler overrides behind unchanged
launchers, SDK symlink retargeting and SDK build upgrades in place.
It uses private Stim homes and removes
its owned worker areas.

`pnpm run test:e2e` covers the real CLI and cache flow without native tools.
`pnpm run test:runtime` checks the built packages at their published runtime floor.
CI also runs `test/runtime-refusal.mjs` under Node 18, below that floor, where
both built bins must refuse with `STIM_NODE_UNSUPPORTED`.
The native app workflows remain separate; see [RELEASE.md](../RELEASE.md).

## Local validation

Run the tests that protect the changed behavior while iterating and before a
commit. Use the relevant formatting, lint, build and type checks locally, then
let CI validate the full merge candidate. Source changes run the unit stage on
the pushed PR head; run affected integrations locally. A prose-only change needs
formatting. Full local runs are useful for broad regressions, shared test setup
or discovery changes, and behavior that CI cannot validate. A passing unchanged
check does not need another run unless a new failure or concern justifies it.
CI success does not replace the real native-tool and app checks above.

```sh
pnpm test packages/stim-cli/src/__tests__/engine-apk-swap.test.ts
pnpm test --changed origin/main
pnpm exec vitest related --run packages/stim-cli/src/engine/apk-swap.ts
pnpm exec vitest list --filesOnly --json --changed origin/main
```

Vitest selects affected tests from imports. Explicitly include regressions that
exercise a changed module through a generated subprocess script, built package,
or filesystem read: these dependencies can be absent from the import graph.
Inspect the selected files when the coverage is unclear. Changes to shared test
setup, configuration, dependency resolution or generated artifacts need the
full suite or a verified broader selection. A selection with no tests is not
evidence that the behavior was checked.

Collect timings during a full run that is already needed:

```sh
pnpm run test --reporter=default --reporter=json --outputFile.json=/tmp/stim-test-timings.json
```

The JSON report includes per-case durations and file start/end times. Rank both
files and cases, and inspect setup/cleanup costs before trimming. Concurrent
file durations cannot be added to predict wall time. Classify candidates under
the test-value rules in `AGENTS.md`; slow ownership, cancellation, cache identity
and protocol regressions still protect independent contracts. Preserve test
isolation and deadlines during a trimming pass.

For repeated focused runs, the installed Vitest supports a filesystem transform
cache without sharing test process state:

```sh
pnpm run test packages/stim-cli/src/__tests__/engine-gradle.test.ts --fsModuleCache
```

See [the measured test-cost review](./test-performance.md) for slow cases,
trimming dispositions and CI/tooling tradeoffs.

## CI scheduling

A pull request, the merge queue and a push to `main` run only fast Linux jobs:
the Node 22 and 24 unit and cross-platform E2E jobs, the published-runtime
check, the Mobile, Demo server and Docs checks for the paths they cover, the
Desktop token and ASCII checks, and, when Desktop files change, the Desktop
debug compile (`swift build -Xswiftc -warnings-as-errors`, about 4 minutes
plus the macOS runner queue). A push to `main` adds the integration tests.
Nothing that needs macOS or Windows, or takes more than about 10 minutes, runs
there.

The rest runs in the `Full suite` workflow (`full-suite.yml`), which calls
`ci.yml`, `desktop.yml`, `mobile.yml` and, on a dispatch, `e2e-native.yml`:

| trigger                                     | runs                                                                                                                                               |
| ------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| nightly at 04:30 UTC                        | `test (macos)`, `native process inspection` on macOS and Windows, `test (windows)`, the full Desktop job, the mobile license check, the Linux jobs |
| `workflow_dispatch` with `native` (default) | the same plus the native E2E smoke on iOS, Linux Android and Windows Android; this run gates a stable release                                      |
| the `ci-full` label on a pull request       | the same as nightly, on the pull request's merge commit; an unrelated label does not start it                                                      |

The full Windows unit suite (`windows-full.yml`) runs on its own at 04:45 UTC and
is not part of the `Full suite` or the release gate while
[#3878](https://github.com/appandflow/stim/issues/3878) is open: it failed on
most nights of the last two weeks and `Post-release validation` was red for four
of the last five releases. Native E2E keeps its own nightly loop at 07:00 UTC and its `e2e-*` pull request
labels. A failing nightly `Full suite`, `Native E2E` or `Stim CI dogfood` run
files or updates an issue titled `Nightly failure: <workflow>`
(`nightly-failures.yml`), labeled `source: nightly`.

Add `ci-full` to a pull request that changes native tool calls, Desktop Swift,
the frames helper, or code that branches on `process.platform`, and wait for
the `Full suite` run before the fresh review. For a branch without a pull
request, run `gh workflow run full-suite.yml --ref <branch>`.

A PR that only modifies existing root test files runs those changed files,
including affected integrations, on Node 22 and 24. Other changes run the fast
unit stage. Missing base history or an empty/uncertain selection also uses the
unit stage. The selector reads the checked-out PR merge commit against its first
parent; checkout retains both parents. Other PR checks remain enabled.

The merge queue always runs the full unit and integration suite on its combined
candidate before merging, on Node 22. Main pushes run the unit suite on Node 22
and 24 and the integration suite on Node 24 only; scheduled validation and
release validation retain their full suites. Focused PR selection never replaces the merge-candidate gate.

The Linux Node 22 and 24 jobs retain a `unit-test-timings-node-<version>` JSON
artifact for seven days, including failing runs that produce a report. Manual
runs also retain `integration-test-timings-node-<version>`, and main pushes
retain it for Node 24. Use these
reports to compare case and file costs on the same runner type. Required
full suites still run before merge; local affected selection does not change
that gate.

The Desktop workflow's full validation (`swift test`, the Release configuration
compile, the `stim-frames` helper compile, the hardened-runtime server start and
an ad-hoc release package) runs in the `Full suite`, or alone with
`gh workflow run desktop.yml --ref <branch>`. A stable release requires a
green `Full suite (native E2E)` run on the release commit (`RELEASE.md`).
Scheduled validation never publishes a release.

## Fixture isolation

Real listeners use port zero and obtain the assigned port only after the
listening event. Keep the listener bound for the fixture's lifetime. A mocked
process can publish readiness separately from socket allocation; never discover
a free port, close it, and assume it is still available when the mock starts.
The foreign-listener test still holds an actual occupied port, chosen by the OS.
The child-process port test reports its bound port over IPC before assertions and
awaits child exit during cleanup.

The socket inventory covers `start`, `ports`, `metro`, `status`,
`crash-diagnostics`, `metro-warmup`, `bundle-response`, `engine-reload`, and
`expo-metro-config`, plus the benchmark `metro-listeners` fixture. Numeric ports in parser inputs and mocked executor payloads
do not bind host sockets and remain deterministic constants. Process collector
fixtures already use explicit readiness and exit deadlines; real Git warm,
refresh, and remove fixtures use bounded operation and test timeouts. Keep the
short default on pure decision tests and retain longer operation-specific limits
where an integration case needs them.

To validate isolation changes, run two complete unit suites from separate Git
worktrees at the same time while an unrelated listener occupies an old fixture
port, such as 8166. Record each worktree commit, runner command, elapsed time,
worker setting, test totals, and both exit codes. Confirm that the seeded listener
still answers afterward. Run this deliberate contention check with the host's
other full-suite and native validation work paused. Do not use retries, change
the repository's worker defaults, or serialize the suites to call this proof a
pass.

The opt-in [website prompt evaluation](../scripts/prompt-eval/README.md) checks
real-agent command selection against the shipped guides without native builds.

## Optional mobile AI pilot

The [tester.army pilot](../test/mobile-e2e/README.md) prepares two mock-mobile
flows with exact assertions and optional AI actions. It is an isolated private
package outside the pnpm workspace. Root knip covers its dependencies; UI/model
runs are optional. Its documented native,
intentional-regression and model-cost gates remain unavailable until an owned
fixture and an authorized model are available. It does not replace any stage
above.
