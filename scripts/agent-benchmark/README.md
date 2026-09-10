# Agent benchmark driver

This is the executable coordinator used by the published agent benchmarks. It
keeps machine-local pins, credentials, build artifacts, raw transcripts, and
device identifiers outside the repository while keeping fixture preparation,
dispatch, evidence collection, audit, cleanup, and reporting reviewable.

The driver runs the iOS and Android readiness suites plus the JavaScript
launch-failure suite described in [`../../docs/agent-benchmark.md`](../../docs/agent-benchmark.md).
Runs are sequential. Never dispatch two cells against the same benchmark root.

JavaScript proof combines the retained source edit with the isolated Settings
screen proof, not a second bundle request. A legacy bundle-watcher timeout is
retained as a warning only when independently observed app liveness and both
proofs succeed. Other watcher failures still invalidate the run. Control cleanup
discovers listening ports and stops only a verified Metro endpoint whose process
working directory is exactly the canonical run worktree.

## Machine-local layout

Create a benchmark root outside the repository with these entries:

```text
benchmark-root/
  bin/stim
  golden/
  pins.env
  targets.json
  runtime/node_modules/stim/
  results/
  state/
```

`bin/stim` is an executable shim for the pinned `stim` in `runtime`.
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
C++ compilation, and flags missing or below-target compiler-cache evidence. A
`stim android` invocation that exits 1 with a `STIM_NO_METRO` refusal and no
build phase output stays in the timeline but does not count as missing
compiler-cache evidence; another `stim android` invocation must still carry
compiler statistics or a proven artifact hit, and a failed, interrupted, or
crashed command that could have compiled still fails closed.
Completed tool output triggers an immediate `CACHE ALERT` and preserves
`cache-alerts.json`. A flagged attempt stays available for investigation and is
excluded from published comparisons; investigate the cause before retrying.
When a completed build fails later during launch, collection can retain the
owned workspace's timestamped compiler statistics. A literal `cd` to that
worktree followed by `&& stim android ...; echo "EXIT=$?"` is also eligible;
additional commands, a different directory, or ambiguous status reports are not.

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
export STIM_BENCH_STIM_PACKAGE="$STIM_BENCH_ROOT/runtime/node_modules/stim"
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

Both arms may use persistent shell sessions or detached processes. Neither arm
is required to background its native build. Both preserve shell exit status and running-session handles when using code
wrappers, then poll finite jobs to completion before dependent commands. Long-lived
server sessions stay running and require readiness evidence, not an exit status. A
wrapper returning is not proof its shell process exited. Collection rejects Stim
start, platform, or dependency-install commands that overlap worktree warm or lack
proof of an earlier successful warm. Explicitly detached control processes retain
their separate PID/log monitoring.
Claude runs in one-shot print mode, which the coordinator does not resume after
a scheduled wakeup. Both arms set `CLAUDE_CODE_DISABLE_BACKGROUND_TASKS=1` and
`CLAUDE_CODE_DISABLE_CRON=1` so finite shell work stays in the active turn rather
than depending on a later notification. The available tools are restricted with
`--tools` to the same set as `--allowedTools`; auto-approval alone does not remove
scheduling tools. The environment settings are recorded in each run's profile.
Explicit shell detachment for servers remains available; agents
must check readiness and keep working in the current turn. See the
[Claude environment-variable reference](https://code.claude.com/docs/en/env-vars).

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

Dispatch also runs two untimed compatibility probes under the run's exact
policy and refuses an iOS run without the adapter when either fails: a nested
`sandbox-exec` applying
`(deny default)(import "system.sb")(allow file-read*)(allow process*)`, the
head of the profile SwiftPM applies to manifests and plugins, and `/bin/ps -p
<pid> -o lstart=`, the process identity agent-device reads for `simctl
recordVideo`. The macOS kernel refuses a nested
`sandbox_apply` unless the inner profile compiles to the same sandbox the
process already runs under (identical, reordered, duplicated, or redundant
rules all nest, at any depth); any other profile is refused in both
directions, even one that only adds a rule with no effect. SwiftPM generates
its profile per invocation from `(deny default)` with its own write grants, so
no runner policy compiles to the same sandbox, and `(with no-sandbox)` on `process-exec*` permits
nesting only by letting the child escape the boundary, which exposes protected
data. No `sandbox-exec` policy hosts SwiftPM's sandbox, so the adapter's
`-IDEPackageSupportDisableManifestSandbox=1`,
`-IDEPackageSupportDisablePluginExecutionSandbox=1`, and `-disable-sandbox`
flags remain the compensation. Both probe results are recorded in the run's
`preflight.isolationCompatibility`; a refused run has no `meta.json`, so
dispatch writes them to `isolation-compatibility.json` in the run directory
before failing.

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
the assigned AVD's configuration edit. Unrecognized setup syntax is retained in
`diagnosis.setupWarnings` for review, not automatically treated as a failed task.
Review these commands before publication; a warning is not a safety approval.
Detected source inspection before completed log capture remains a hard failure,
with every offending command in `diagnosis.violations` and the first in `commandId`.
Version, isolation, warm ordering, device, exact repair, timing, screenshot and
recording gates remain unchanged. This heuristic audit does not prove arbitrary
shell programs are safe or replace the runner's filesystem isolation.
Build/launch pipelines ending in `tee` must enable `set -o pipefail` in the same
shell command. Without it, zero exit status proves only the log writer finished,
so the command cannot establish initial launch success.
The pipeline may follow `cd <worktree> && set -o pipefail && ...`. If it ends
with `; echo "PIPELINE_EXIT=$?"`, the captured output must contain exactly one
`PIPELINE_EXIT=0` line: the echo's own zero exit does not prove build success.
Retained launch-evidence rejections can be reviewed only when re-derived commands
prove successful launch, separate error capture, repair and Settings proof.
Ordinary commands may also append `; echo "EXIT=$?"`. The audit uses the single
captured status line, not the echo's exit code; missing or ambiguous reports do
not prove success. A retained warm-status rejection requires re-derived setup
checks, including warm completion before start or build, before publication.

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

Literal unscoped screenshot/snapshot attempts that report `SESSION_NOT_FOUND`
without reaching a device remain visible in timing but do not fail isolation.
Successful unscoped reads, explicit device/session overrides and ambiguous
multi-command results still fail the audit.

For launch-error runs, `launch-error-audit-review.json` records a review of each
unrecognized setup command. It contains `schemaVersion: 1`, `runId`,
`originalRecordSha256`, `metaSha256`, `policySha256` (the launch-crash audit source),
`shellParserSha256` (run-guards), and ordered `commands` entries with `commandId`,
the exact `command`, and a nonempty `assessment`. Export re-derives diagnosis,
recovery and diagnosis-time usage from hash-verified retained evidence. A review
can clear setup-syntax rejection and its missing-diagnosis/usage consequences.
Persisted tool output counts as runtime evidence only when a prior successful
log command names the exact file subsequently read. Diagnosis uses the later
read's timestamp, not the truncated preview. A masked Android Expo pipeline can
use a subsequent read of its exact build log as launch confirmation only when
that output reports both build success and opening the app.
Read-only agent-device help does not need a session. An auxiliary diagnostic
session must use the exact run namespace and state directory, open the assigned
device, and close successfully before the pinned proof session opens. Its
`auxiliarySessions` review entries name each `session` and a nonempty `assessment`.
Default or foreign sessions, device overrides, missing closure and daemon
interference remain failures.

An iOS `Podfile.lock` update is reviewable only when every difference is a valid
`SPEC CHECKSUMS` value for an existing pod. Dependency versions and all other
content must match. Collection retains base/final lockfiles and the exact repaired
source under `raw/`, with hashes in `auxiliary-audit-evidence.json`. A review's
`sourceChanges` contains that file's `evidenceSha256` and an `assessment`; export
checks every retained hash, the original source hash and checksum-only semantics.
It cannot clear other source changes, dependency changes or source-before-capture
violations. Valid runs with setup or auxiliary warnings also require review before publication. The original
`run.json` is never rewritten, and review records stay private.

The coordinator may adjudicate source-inspection false positives with
`diagnosticCommands` entries containing the exact `commandId`, `command`, and
an `assessment`. Read the captured command and output before approving one:
log search patterns and error-response files are diagnostics, but actual app
source access before runtime capture remains invalid. This is an explicit
manual classification, not a claim that the shell heuristic proves safety.
Reviews are bound to the original record, metadata and current audit code;
each diagnostic entry must also appear in the reviewed setup command set.

A runner timeout after completed task evidence can be reviewed with a
`completion.assessment`. The original deadline does not move: repair, Settings
proof, recording copy, session close and every captured command must finish
before it. A missing or late proof, a running command, or a different runner
failure still rejects the run. The final conversational response is not a task
completion requirement; its timeout remains recorded in the private evidence.
