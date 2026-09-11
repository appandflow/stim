# Agent benchmark

This protocol measures rendered-screen readiness with auditable device proof.
Its timings are not comparable with the earlier process-liveness experiment,
which stopped before navigating the app.

## Question and pilot gate

The primary question is whether Stim reduces elapsed time from the first recorded agent activity
to a changed Trailhead app visibly ready on its Settings screen. JavaScript and
native changes are different workloads and are never combined into one run or
one headline number.

Each model and platform contains four sequential cells:

| Change     | Arm     | Device state                                       |
| ---------- | ------- | -------------------------------------------------- |
| JavaScript | Stim    | adopt the prepared parked simulator or Android AVD |
| JavaScript | Control | create a new simulator or AVD                      |
| Native     | Stim    | adopt the prepared parked simulator or Android AVD |
| Native     | Control | create a new simulator or AVD                      |

Results from different platforms, change kinds, models, or deliberately changed
pins remain separate. Never pool iOS and Android timings into one number.

## Pins and preparation

Pin the exact published `stim` version and package integrity, fixture
commit, runner version, model, reasoning effort, service tier, `agent-device`
version and executable hash, Node.js, host machine, and platform toolchain
before preparing the block. iOS also pins CocoaPods, Xcode, iPhone model, and
runtime. Android pins the SDK tools, emulator, adb, and system-image package.
The coordinator gives timed shells an isolated login profile, resolves `stim`
through that same shell before dispatch, and records its version plus executable
and CLI hashes. A mismatch refuses dispatch; checking only the coordinator's
own PATH is insufficient.

Preparation runs outside the timer. On iOS it creates one Stim-owned simulator,
warms the fixed fixture, removes its seed worktree, and verifies that cleanup
parked the simulator. The iOS golden contains exactly one available, shut-down
pool record whose device name starts with `stim-parked`, plus the matching build
artifact. Android preparation warms the matching APK cache and parks one
Stim-owned AVD with the pinned system image and default creation settings.
The Android Stim arm adopts that exact AVD; control creates a fresh one. Parking
retains the APK and Quick Boot state; Stim clears app data at adoption before
launch. Both scoped pool overrides are enabled explicitly for their platform.

Before each dispatch, verify the package version and integrity, fixture commit,
clean main checkout, golden build artifact, exact parked simulator identity and
state, required disk space, no benchmark-owned process from an earlier run,
and no unexpected listener on Metro ports 8081 through 8090. Wait for a
one-minute load average at or below 3.0 for two consecutive 15-second samples.
Runs are sequential.

Preparation and both agent arms pin `LANG`, `LC_ALL`, and `LC_CTYPE` to
`C.UTF-8` and unset `LC_MESSAGES`. These variables participate in ccache keys:
inheriting a different runner locale can turn a warm native build into misses.
The isolated shell restores the locale for login and non-login commands.
Preflight checks it, and preparation/run metadata records it. An older golden
without matching locale provenance needs requalification before dispatch.

Each machine has targets for every platform, change kind, and arm. The
screen-ready target is a visible performance signal, not a validity gate,
because agent reasoning time is part of what the benchmark measures. A Stim
platform-command target is a validity gate for abnormal host/build work, and a
larger run timeout terminates a runaway attempt. This separates slow model
behavior from a missing or ineffective cache.

Give the campaign its own `AGENT_DEVICE_STATE_DIR`, separate from the
operator's normal sessions, and set `AGENT_DEVICE_SESSION` to the exact run id.
The runner environment is not proof that nested shell tools inherit those
values: repeat both assignments explicitly on every `agent-device` command.
Before dispatch, require an empty session inventory and no ownership claim on
the prepared simulator. If prior campaign state cannot be proven clean, stop
the daemon with `daemon stop --clean` against that campaign state directory
before starting the timer. Never stop the operator's global daemon.

## Fixed changes

The JavaScript cell changes only the Settings Offline maps subtitle:

```diff
-subtitle="Keep map tiles for saved trails on device"
+subtitle="Keep saved trail maps available offline"
```

The iOS native cell changes only `ios/Trailhead/AppDelegate.swift`, immediately
after the existing window assignment:

```swift
window?.accessibilityIdentifier = "Trailhead <run-id>"
```

The native marker must appear as the live app window label in the
`agent-device` accessibility snapshot. This proves that the changed compiled
AppDelegate executed; searching an optimized Swift executable for an ASCII
literal is not sufficient.

The Android native cell changes only the `app_name` string in
`android/app/src/main/res/values/strings.xml` to `Trailhead <run-id>`. The live
app is opened on the exact run emulator, and the installed APK's application
label must equal that run marker. The collector preserves the label read from
the installed APK before cleanup.

## Arm isolation

Each run uses a disposable runner home and starts in the clean fixture main
checkout. The Stim profile exposes only the pinned Stim skill and the
independently pinned `agent-device` skill. The control profile exposes only
`agent-device`; the Stim binary and skill are unavailable. Both profiles have
the same model settings, filesystem authority, and app task.

The macOS coordinator launches both runners and their child processes under
the same filesystem policy. It denies coordinator configuration, golden-state
and sibling-run file contents and writes, while permitting parent-directory
listings. Each run retains its own worktree, proof, temporary files, runner
home, selected tools, and the configured shared native-cache/device state.
Coordinator metadata and transcripts remain outside those writable grants.
Before timing starts, real read/write and child-process probes must verify the
policy; an unavailable sandbox or overbroad grant refuses dispatch. Dispatch
also probes toolchain compatibility under the exact policy: the macOS kernel
refuses a nested `sandbox_apply` of any profile that differs from the one a
process already runs under, which breaks SwiftPM manifest and plugin sandboxes
under every runner policy, and it refuses to execute `/bin/ps`, which
agent-device's simulator recording needs for child process identity. An iOS
run is refused before the clock starts when either probe fails and no pinned
native compatibility adapter compensates. The policy, its digest, and the
probe results are retained with the private run metadata; a refused run keeps
its probe results in its run directory.

Recollecting after recorded worktree cleanup can retain a previously passing
compatibility check when run identity, captured evidence hashes, and the pinned
manifest are unchanged. Other audit checks and derived timings are recalculated;
missing or changed evidence does not inherit the earlier verdict.

If a later launch failure omits compiler-cache counters, collection can preserve
the workspace's per-build ccache log for one unambiguous completed Android build.
Its modification time must fall within that command, and saved hashes bind it to
the run, metadata, events, and command. Recollection and website export verify
those hashes; multiple builds, stale logs, and low hit rates still need investigation.

This boundary prevents accidental benchmark-data access, not adversarial host
access: native system services and pre-existing processes are not sandboxed by
the runner policy. Strong isolation from a malicious agent requires a separate
host or VM. The coordinator still independently verifies app/device evidence.
Historical attempts keep the policy and verdict under which they were run.

The runner starts in the source repository; the isolated run worktree does not
exist until the agent creates it after dispatch. After creation, shell calls use
that worktree through the tool's working-directory parameter when available.
Otherwise the agent keeps explicit `cd` prefixes where needed; changing one
shell's directory does not imply that later calls inherit it. Worktree creation
remains inside the timer for both arms.

The Stim agent creates its own worktree with Git after dispatch:

```text
git worktree add -b worktree-bench/<run-id> <worktree-parent>/bench-<run-id> HEAD
cd <worktree-parent>/bench-<run-id>
```

The Stim arm then runs `stim worktree warm`. The control uses branch
`bench/<run-id>` at `<worktree-parent>/<run-id>` and copies the same installed
dependencies and native outputs from the fixture main checkout using its own tools.
Both arms finish copying before starting Metro or native commands. Either arm
can use persistent shell sessions or detached processes; the benchmark does not
prescribe one process-management strategy. Shell-tool
wrappers must preserve session handles and exit status, and agents poll foreground
finite jobs to completion. Long-lived server sessions remain running after
readiness is established. The setup audit requires successful warm completion before
dependent Stim commands and rejects overlapping warm/use intervals; missing or
ambiguous ordering evidence is not accepted. Detached processes retain their
separate PID/log monitoring.

The Stim arm uses the inherited isolated `STIM_HOME` and invokes the pinned
published CLI as exactly `stim`. On iOS it requests the pinned model/runtime and
must report adoption of the prepared simulator. On Android it requests the
pinned system image and must report adoption of the exact prepared AVD.
Missing or incompatible parked state refuses dispatch rather than silently
measuring a fresh boot. The control must not inspect that home or use Stim; it
creates a new benchmark-named device with the same platform configuration.
Android control uses the same `avdmanager` default profile, 8 GiB data
partition, system image, and default Quick Boot policy as Stim.
Launch-error control may use runner-managed sessions instead of detached shell
jobs and keeps the inherited Android SDK, AVD, Gradle, and emulator-report
locations unchanged so device verification and cleanup see the same metadata.
The launch-error audit recognizes scoped setup and log capture across shell
quoting forms. Unfamiliar setup syntax produces review notes rather than an
automatic failure. Those notes are reviewed before publication. Detected source
inspection before completed error capture still invalidates the attempt, as do
failed version, isolation, device, exact-repair and screenshot/video proof checks.
Installing dependencies inside the timed interval, a failed `guide agent` or
`worktree warm`, and an Android native build without Stim's `--build-cache`
evidence invalidate the attempt.

## Settings readiness proof

App-process liveness is retained as a secondary milestone. The primary
readiness endpoint is completion of the successful Settings screenshot command
after the expected changed content is present. Copying that PNG into retained
results is a validity gate, not a later timing endpoint.

After launch, every agent must use `agent-device`. The required command
sequence is:

```text
env AGENT_DEVICE_STATE_DIR=<campaign-state> AGENT_DEVICE_SESSION=<run-id> agent-device open com.appandflow.trailhead --foreground --platform ios --udid <run-udid>
env AGENT_DEVICE_STATE_DIR=<campaign-state> AGENT_DEVICE_SESSION=<run-id> agent-device record start /tmp/<run-id>-session.mp4 --scope device --quality high --hide-touches
<handle Expo onboarding if it appears and navigate by semantic label to Settings>
env AGENT_DEVICE_STATE_DIR=<campaign-state> AGENT_DEVICE_SESSION=<run-id> agent-device wait text "<expected text>"
env AGENT_DEVICE_STATE_DIR=<campaign-state> AGENT_DEVICE_SESSION=<run-id> agent-device screenshot /tmp/<run-id>-settings.png
cp /tmp/<run-id>-settings.png <run-dir>/proof/settings.png
env AGENT_DEVICE_STATE_DIR=<campaign-state> AGENT_DEVICE_SESSION=<run-id> agent-device record stop
cp /tmp/<run-id>-session.mp4 <run-dir>/proof/session.mp4
env AGENT_DEVICE_STATE_DIR=<campaign-state> AGENT_DEVICE_SESSION=<run-id> agent-device close
```

The run-scoped MP4 captures Expo onboarding and Settings navigation for audit
and promotional use. Every arm records with the same settings so capture
overhead stays symmetric. Record each proof step as its own top-level shell command. Do not hide proof in
an interactive shell, script, chained command, or redirected background job.
Using a bare or mismatched agent-device state directory/session, or restarting
its daemon inside the timed interval, invalidates the attempt. The collector
and exporter require `open` output to name the exact run session. The isolated
`close` command must exit successfully but can be silent; export also requires
independent cleanup evidence that the campaign session inventory is empty.

The agent reads `<run-udid>` or `<run-serial>` from the platform launch output.
The explicit device identifier prevents an existing automation session from
selecting unrelated hardware; a bundle identifier alone is insufficient. The
temporary screenshot and recording paths avoid Simulator write restrictions on
external volumes. JavaScript waits for `Keep saved trail maps available offline`; native
waits for `Offline maps`.

The collector accepts the screenshot only when the targeted open command names
the same UDID recorded by the independent app watcher, all required commands
completed in order after dispatch, the PNG has a valid signature and
dimensions, its timestamps fit the run, and the copied file exists. It also
requires an integrity-bound MP4 between the recorded start and stop commands.
JavaScript runs retain an integrity-bound copy of the edited source and require
the isolated Settings-screen wait to find the changed subtitle before capturing
the screenshot and recording. No extra Metro bundle request is required; the
agent may choose any available Metro port. iOS native must expose the exact run marker in the live window
accessibility node; Android native must preserve the same marker from the
installed APK application label.
Missing proof makes the attempt invalid even when the app process is alive.

Android uses the same command sequence with `--platform android --serial
<run-serial>`. Every current run must bind proof to the independently observed
device identifier.

## Metrics and records

The website's primary metric starts at the first recorded agent message or
shell-command start and ends at completion of the validated
`agent-device screenshot` command. Apply the same origin to Stim and control. Runner init
events do not start the clock. This excludes startup and any unobserved initial
reasoning; it is not a measure of time from sending the prompt.

Post-processing shifts all milestones, messages, commands and background spans
by the same offset. Published `timingOrigin` retains the offset, source event
and dispatch-based totals so the change is auditable and idempotent. Existing
recordings and raw records are not retimed or overwritten; no rerun is needed.
Tokens and cost still cover the full turn, including work after Settings proof.

The coordinator retains `dispatchToScreenReadySeconds`,
`dispatchToAppAliveSeconds` and dispatch-based timeout/target checks. Also retain command count, raw token
fields, worktree and simulator evidence, cache and adoption/build output, and
invalid-attempt reasons.
The run record also stores its selected machine target, whether screen-ready
met that target, the longest Stim platform-command duration, timeout status,
and the timed shell's Stim provenance.

The coordinator timestamps every runner event and reconstructs every command's
start, end, duration, exit status, and output. The website's interactive
benchmark viewer provides per-run tabs, agent messages, non-overlapping command
lanes, inferred spans for detached processes that later process-inspection
commands monitor, app-alive and screen-ready milestones, terminal output
drill-down, timeline zoom and playback, a concise evidence-derived activity
summary, token usage, estimated token cost, and the proof image. A detached
span ends at the last recorded PID or PID-file
reference; it does not assert that the process exited then. Exported website
data includes only valid attempts and uses relative paths and redacted device
identifiers. Private raw results retain invalid attempts for diagnosis. The
Markdown report is the machine-readable summary; the viewer is an audit view
and does not redefine metrics.

Token and cost displays cover the full agent run for every scenario and model,
including work after the diagnosis and Settings endpoints. Missing usage stays
unavailable, not zero. The viewer uses concise command presentation: successful
literal `cd ... &&` prefixes move into expandable working-directory context,
and explicit agent-device state/session assignments are hidden from the default
command line. The original sanitized command remains expandable. Failed setup,
dynamic shell constructs, output, timing and validation evidence are unchanged;
the real commands retain their isolation assignments.

The executable coordinator and its machine-local setup contract live in
[`scripts/agent-benchmark/`](../scripts/agent-benchmark/README.md). The driver
prepares and commits launch-failure fixtures, dispatches Codex or Claude,
collects and audits proof, writes `run.json`, cleans owned resources, and
generates the private report. Credentials, pins, golden build state, and raw
transcripts remain outside the repository.

![A benchmark timeline with separate shell and monitored background-process lanes](images/benchmark-background-process.png)

![A benchmark timeline expanded to 4x with its lane labels pinned during horizontal scrolling](images/benchmark-timeline-zoom.jpg)

Export a completed block into the website with:

```bash
node scripts/export-benchmark-viewer.mjs \
  /path/to/results/<stage> \
  website/src/data/benchmarks/<stage>.json \
  website/static/benchmarks/<stage> \
  /path/to/sanitized-machine.json
```

The optional machine JSON contains only `model`, `chip`, and `memory`. The
exporter combines those fields with the recorded macOS, platform toolchain,
Node, device model, and runtime. Never include a hostname, serial number,
hardware UUID, username, device identifier, or path in that file.

The exporter refuses data that still contains a local username or an absolute
home, volume, temporary, or simulator path. It omits machine-global process,
device, storage, and branch listings, plus interactive shell transcripts whose
cursor-control output cannot be made portable. Review the generated diff before
publishing because command output can contain other project-specific data.

Publish one current result per model, platform, scenario, and arm. A newer
validated run replaces that arm in its existing canonical benchmark JSON;
retain the other arm unless it is also rerun. Do not append a second catalog
entry or choose whichever attempt is faster. Keep previous raw campaign
records privately and use `stageAliases` to resolve old shared links to the
current canonical benchmark. The replaced arm carries its full timeline,
usage, cost, proof, recording, and per-run `recordedOn` date.
The exporter selects the newest validated dispatch for each arm and variant
within a stage, keeps stable run IDs, and removes superseded public proof
files. A stage contains one model and platform; mixed stages refuse export.
When a rerun uses a different stage, replace its arm in the canonical
comparison rather than adding the new stage to the catalog.

Launch-error Stim reruns emit optional early pending and post-splash ready
logs. Existing control runs without this integration can remain: record
`appReadinessLogs` per arm and disclose the different instrumentation in the
comparison. This measures integrated Stim against the standard toolchain,
not identical startup logging. Do not imply that retained controls were rerun.

Invalid attempts are immutable audit records. Fix only a coordinator defect or
environmental prerequisite, then reschedule the same cell under a new run id.
Never relabel an invalid attempt to improve a result. Collector-only proof
logic may be corrected without rerunning when preserved live evidence already
demonstrates the intended invariant.

## Cleanup

After collection, close the exact run-scoped `agent-device` session and verify
that the campaign session inventory is empty before a simulator can be parked
or reused. If closure cannot be proven, stop and clean only the campaign-owned
daemon. Remove the temporary screenshot and terminate only benchmark-owned
processes. For Stim, run `stim stop` and `stim worktree remove --force`. On iOS,
then verify that the same simulator is shut down, renamed as parked, and is the
sole pool record. On Android, verify that the same AVD is stopped and remains
the sole compatible parked record, ready for the next sequential run. For
control, remove its worktree and branch and shut down and delete only the newly
created benchmark simulator or emulator. Do not touch unrelated physical-device
leases or automation sessions.

Before stopping a pooled Android emulator, cleanup also retires completed
agent-device recording manifests. It requires the exact owned device, the
matching run's hash-verified saved video, absent remote video chunks, and proof
that every original recording process is gone (including a different process
start time after PID reuse). It archives the manifest and removes only that
metadata; it never signals the replacement process. Unknown, incomplete, live,
or changed evidence stops cleanup. This runs after timing, not by prebooting a
parked emulator before the next agent starts.

## JavaScript launch-crash extension

A launch-crash diagnostic is a separate suite, not a fifth performance cell.
Inject a deterministic root-render JavaScript exception before the first app
screen, then give each agent the same repair task. Compare first recorded activity to the
first actionable diagnosis, commands and tokens to diagnosis, and first recorded activity to
a repaired Settings screenshot. Run separate iOS and Android blocks. The Stim
arm must preserve the matching `stim ios` or `stim android` launch
output and `stim logs --errors`; control collects the equivalent Metro and
device logs manually, using the exact emulator serial for Android `adb`
commands. The injected error text is unique per run so the
collector can prove that the reported stack and repair refer to this failure.
The unique token and source location must appear in captured runtime errors;
the earlier successful launch command does not have to print the token inline.
When that launch response already contains the runtime error and root-layout
context, its completion establishes diagnosis time rather than a later log
query. The separate successful log capture remains required for validation.
Before capture, normal guide, doctor, worktree warming, and narrowly scoped
installed-dependency resolution are setup, not application-source inspection.

The coordinator creates a per-run fixture branch, injects and commits the
exception, and checks out that fixture before dispatch, outside the timed
interval. The agent starts in the fixture checkout and creates its own isolated
run worktree from that HEAD, so worktree setup remains part of the measured
workflow. The agent must launch before inspecting source. An actionable
diagnosis contains both the run's unique error token and the root-layout source
location. A valid repair removes that token and reaches the unchanged Settings
proof on the same explicitly targeted simulator or emulator. Android launch
recovery does not require the readiness native-change task's APK-label edit.
The recovery mechanism is a
measured agent choice, not a validity condition. Report diagnosis and repair
timing separately; do not add crash-suite results to the readiness charts.

Run the crash suite only after the four-cell readiness pilot is accepted. Keep
its goldens, prompts, metrics, and report separate from the normal JS/native
speed results.
