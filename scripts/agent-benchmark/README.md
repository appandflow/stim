# Agent benchmark driver

This is the executable coordinator used by the published agent benchmarks. It
keeps machine-local pins, credentials, build artifacts, raw transcripts, and
device identifiers outside the repository while keeping fixture preparation,
dispatch, evidence collection, audit, cleanup, and reporting reviewable.

The driver runs the iOS and Android readiness suites plus the JavaScript
launch-failure suite described in [`../../docs/agent-benchmark.md`](../../docs/agent-benchmark.md).
Runs are sequential. Never dispatch two cells against the same benchmark root.

## Machine-local layout

Create a benchmark root outside the repository with these entries:

```text
benchmark-root/
  bin/stim
  golden/
  pins.env
  targets.json
  runtime/node_modules/stim-cli/
  results/
  state/
```

`bin/stim` is an executable shim for the pinned `stim-cli` in `runtime`.
`pins.env` contains the exact fixture, CLI, agent-device, OS, Xcode, Node, and
CocoaPods values checked by `preflight`; use the keys read by `versionChecks`
in `driver.mjs`. `targets.json` defines this machine's timing expectations for
each platform, change, and arm:

```json
{
  "schemaVersion": 1,
  "machine": "Mac mini, Apple M4, 16 GB",
  "targets": {
    "android.native.stim": {
      "screenReadySeconds": 300,
      "platformCommandSeconds": 180,
      "ccacheMinHitRatePercent": 50,
      "runTimeoutSeconds": 600
    },
    "android.native.control": {
      "screenReadySeconds": 600,
      "runTimeoutSeconds": 900
    }
  }
}
```

Every dispatched cell needs an entry. `screenReadySeconds` is reported as a
performance target but does not invalidate a slow model. A Stim platform
command over `platformCommandSeconds` is an invalid machine/build result.
`runTimeoutSeconds` terminates and invalidates a runaway agent. Keep
authentication and raw evidence out of Git.

Android native Stim cells also require `ccacheMinHitRatePercent`. Establish this
machine/scenario threshold from a verified warm compiler-cache probe before
dispatch; the example value is illustrative. Keep it fixed across models.
Collection records actual hits and misses, accepts proven artifact hits without
C++ compilation, and flags missing or below-target compiler-cache evidence.
Completed tool output triggers an immediate `CACHE ALERT` and preserves
`cache-alerts.json`. A flagged attempt stays available for investigation and is
excluded from published comparisons; investigate the cause before retrying.

Android golden preparation and every preflight require a structured doctor
report without cost findings. Repair the fixture with
`stim doctor --fix --platform android`, seed its shared caches, and verify
cross-worktree reuse before creating the golden. Preflight only inspects the
fixture; it never changes cache state during a timed cell.

Set the machine-local paths explicitly:

```bash
export STIM_BENCH_ROOT=/path/to/benchmark-root
export STIM_BENCH_FIXTURE=/path/to/clean-trailhead-checkout
export STIM_BENCH_WORKTREE_PARENT=/path/to/benchmark-worktrees
export STIM_BENCH_STIM_PACKAGE="$STIM_BENCH_ROOT/runtime/node_modules/stim-cli"
export STIM_BENCH_CODEX_AUTH=/path/to/codex-auth.json
export STIM_BENCH_SKILLS_ROOT=/path/to/skills
```

`STIM_BENCH_CODEX_BIN`, `STIM_BENCH_CLAUDE_BIN`, and
`STIM_BENCH_AGENT_DEVICE_BIN` can pin non-default executable paths.

Preflight runs the pinned Stim shim through the same isolated login-shell
startup used by timed commands. Dispatch refuses a Stim version, executable,
or CLI digest mismatch and refuses a control shell that can resolve Stim.
Golden cache validation hashes the fixture with the pinned CLI's fingerprint
dependency, not the fixture's potentially different version.

Both arms preserve shell exit status and running-session handles when using code
wrappers, then poll finite jobs to completion before dependent commands. Long-lived
server sessions stay running and require readiness evidence, not an exit status. A
wrapper returning is not proof its shell process exited. Collection rejects Stim
start, platform, or dependency-install commands that overlap worktree warm or lack
proof of an earlier successful warm. Explicitly detached control processes retain
their separate PID/log monitoring.
Unfinished shell commands remain in the audit with unknown completion. Claude
background-task submission is not command completion: a correlated terminal
TaskOutput result must provide the shell exit status before the audit accepts it.
The result fields follow the [Claude Agent SDK task-output schema](https://code.claude.com/docs/en/agent-sdk/python#taskoutput).

Both runners are launched through macOS `sandbox-exec` with a verified,
run-scoped policy. Configuration, golden files, coordinator evidence and
sibling worktrees/results cannot be read or written by the runner process tree.
Parent-directory listing is permitted. The current worktree, proof, temporary
files, runner home, selected tool runtime and configured shared Gradle/AVD/device
state remain accessible. Configured tool/cache paths cannot overlap golden,
results, coordinator state or worktree directories, including through symlinks.
Only the coordinator's selected run paths receive scoped exceptions. Dispatch
also refuses a policy that exposes the protected coordinator probes.

`smoke stim` and `smoke control` verify real filesystem denials and the Codex
skill profile without running a model task. Timed dispatch repeats the same
checks before starting the clock and records the policy digest. This is a
macOS benchmark-data boundary, not a security sandbox for hostile code or
already-running native services. Unsupported hosts fail closed.

### iOS sandbox compatibility

For the pinned agent-device 0.20.10 / ExpoModulesJSI fixture affected by
sandboxed process inspection and nested SwiftPM sandboxes, prepare an explicit
local compatibility copy with `prepareNativeCompatibility` from
`native-compat.mjs`. Supply a new destination, the installed package, an exact
reviewed native-helper source commit and SHA-256, and a dedicated fixture copy.
The adapter refuses unknown base bytes. It does not update a global install.
It patches the copied package and the selected fixture's ignored JSI build
script; prepare fresh golden state afterward because native inputs changed.

Set `STIM_BENCH_AGENT_DEVICE_BIN` to the copied `bin/agent-device.mjs`,
`STIM_BENCH_NATIVE_COMPAT_MANIFEST` to the generated manifest, and pin its digest
as `NATIVE_COMPAT_SHA256` in the new campaign's `pins.env`. Both arms receive
the same package and Xcode wrapper. Do not retrofit frozen campaign pins.
The package tree, native helper source, bridge, and Xcode/JSI changes are
hash-bound, including executable permissions and internal symlinks. The bridge
adds a Node process for each process query in both arms. Preflight repeats the
process-identity and Xcode-resolution smoke inside the run's exact isolation
profile before starting the clock; collection rejects changed compatibility
bytes. This does not replace a real untimed build, recording, and cleanup test
before accepting a new toolchain combination.

Android launch-error control preparation carries dependencies and native outputs
but leaves out the root `android/build` directory. Its generated autolinking cache
contains absolute source-checkout paths and package checksums that survive a copy.
The control prompt also requires excluding `android/build/generated/autolinking`
when the agent creates its run worktree. Gradle regenerates this metadata locally;
`android/app/build` remains available for native output reuse. Verify the generated
project and dependency roots belong to the run worktree before accepting a pilot.

## Run a cell

Prepare the platform golden, then dispatch, collect, and clean one cell:

```bash
node scripts/agent-benchmark/driver.mjs preflight
node scripts/agent-benchmark/driver.mjs prepare
node scripts/agent-benchmark/driver.mjs dispatch gpt-5.6-sol stim launch-crash sol-launch-crash
node scripts/agent-benchmark/driver.mjs collect /path/to/run-directory
node scripts/agent-benchmark/driver.mjs cleanup /path/to/run-directory
node scripts/agent-benchmark/driver.mjs report sol-launch-crash
```

Android is selected explicitly and remains a separate result block:

```bash
node scripts/agent-benchmark/driver.mjs preflight android
node scripts/agent-benchmark/driver.mjs prepare android
node scripts/agent-benchmark/driver.mjs dispatch gpt-5.6-sol stim javascript sol-android android
node scripts/agent-benchmark/driver.mjs dispatch gpt-5.6-sol stim launch-crash sol-android-crash android
```

Launch-error recovery uses the same injected JavaScript exception on both
platforms. Android control creates a fresh AVD from the pinned arm64 system
image and uses its exact serial for launch and log capture. The watcher records
the app process without requiring the native-change task's APK-label mutation;
validation still requires runtime error evidence before source inspection,
the exact repair, and Settings-screen screenshot/video proof.

Launch-error control can use runner-managed sessions for Metro, emulators, and
native commands; it does not have to daemonize shell jobs. It keeps per-run logs
for the separate completed error query and preserves the inherited Android SDK,
AVD, Gradle, and emulator-report locations so observation and cleanup use the
same metadata as the agent.

The pre-capture audit decodes shell quoting without executing it and recognizes
scoped setup operations, including local SDK tools, managed log pipelines, and
the assigned AVD's configuration edit. Collection reports every rejected command
in `diagnosis.violations`, retaining the first rejection in `commandId`. Unknown
commands and source inspection still invalidate the attempt; this is not a
replacement for the runner's filesystem isolation.
Build/launch pipelines ending in `tee` must enable `set -o pipefail` in the same
shell command. Without it, zero exit status proves only the log writer finished,
so the command cannot establish initial launch success.

A launch can finish before the JavaScript error reaches its log. Both arms must
repeat standalone foreground log queries, without separate sleep or wait commands,
until a completed query prints the error and source location before inspecting or
editing source. An empty successful query or a redbox visible
only through device automation does not satisfy this log-first diagnosis measure.

`dispatch` creates and commits the broken fixture before the timed turn, gives
the agent the fixture checkout as its starting directory, and requires the
agent to create the measured run worktree itself. `collect` rejects source
inspection before launch/error capture, a missing exact repair, a missing
mismatched device, missing Settings-screen proof, failed Stim guide or warm
setup, dependency installation inside the timer, missing Gradle cache injection,
or exceeded machine phase target. The recovery mechanism is measured, not
prescribed.

Run the self-tests before a campaign:

```bash
node scripts/agent-benchmark/driver.mjs selftest-device-targeting
node scripts/agent-benchmark/driver.mjs selftest-agent-device-isolation
node scripts/agent-benchmark/driver.mjs selftest-launch-crash
node scripts/agent-benchmark/driver.mjs selftest-android
node scripts/agent-benchmark/driver.mjs selftest-runner-timeout
```

## Export reviewed evidence

`scripts/export-benchmark-viewer.mjs` verifies the retained transcript, app proof,
Settings screenshot, recording, and cleanup before creating portable website
artifacts. It does not modify coordinator records.
Directory and worktree inventories are omitted from public command output;
the command and its timing remain visible.

A reviewed executable-lookup session correction can be supplied beside a run as
`lookup-audit-correction.json`. It binds the run ID, original record hash,
command-log hash and count, and the corrected `run-guards.mjs` source hash using
`schemaVersion`, `runId`, `originalRecordSha256`, `commandsSha256`, `commandCount`,
and `correctionSourceSha256`. Export matches every command against the retained
events and reruns the current session audit. It can clear only the sole
`agent-device-run-session-not-applied` reason; every evidence check still applies.
Keep the original verdict and correction provenance private, outside Git.
