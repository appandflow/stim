# Standalone native campaign

The native suite is a separate cohort from the Trailhead React Native suite. It
compares a small SwiftUI iOS app, a Jetpack Compose Android app, and a SwiftUI
macOS Swift package. Both arms create a fresh worktree, change one visible
revision, build and launch Debug, click Increment once, and verify the new
revision and `Count: 1`. Stim uses its installed skill; control uses platform
tools. Preparation runs outside the timer, including dependency resolution and
one build with each toolchain. Runs remain sequential. Android preparation starts its dedicated ADB server on
port 5051 and uses campaign-scoped AVD and Gradle directories.

Generate fixtures with `native-fixtures.mjs <platform> <new-directory>`; Android
also needs the path to a pinned Gradle wrapper project. Commit each generated
fixture and save the returned metadata plus `fixtureDirectory` and
`fixtureCommit` in `$STIM_BENCH_ROOT/native/<platform>/fixture.json`. The main
campaign environment and pins also apply here. Keep credentials, device IDs,
artifacts and transcripts outside Git.

```sh
node scripts/agent-benchmark/native-driver.mjs prepare ios
node scripts/agent-benchmark/native-driver.mjs dispatch ios stim gpt-5.6-luna
node scripts/agent-benchmark/native-driver.mjs collect ios /absolute/run-directory
```

Repeat with `control`, `android`, and `macos`. A fifth argument selects the task:
`standalone` (app launch, the default) or `launch-crash` (error fix: the
coordinator commits a native startup crash to a fixture checkout, see
[`docs/benchmark-fixtures.md`](../../docs/benchmark-fixtures.md)). `exact-ios`
replaces the platform for the Exact fixture, which has its own root entry
`native/exact-ios`. Models whose id starts with `claude-` run through Claude's
print mode with the arm's skills as appended guidance; other models run through
Codex. The Claude path of this driver follows the Trailhead driver's flags but
has not been run. Preparation refuses partial or
existing goldens so failed native tool calls can be inspected before recovery.
Dispatch requires two load samples at or below 3, version-matched preparation,
isolated runner skills, and a verified filesystem boundary. Both arms receive
the same SwiftPM sandbox flags under the outer benchmark sandbox. Each frozen
coordinator gets its own tools directory, and collection verifies the Swift
wrapper's hash. Process continuity evidence remains required; capture the
native process start time without relying on a benchmark-provided helper.

## Android emulator lifetime

The standalone native task keeps its app and device alive for independent
coordinator verification after the model turn. Android protocol
`standalone-native-v2` tells both arms to launch any manually started emulator
headlessly in a separate OS session, with stdin closed and output in a run-local
log. A foreground exec session ends with the runner; `nohup` alone does not
separate its process group. This guidance changes the protocol: requalify both
arms and compare only matching cohorts and coordinator bytes. Do not pair a v2
control with a previously accepted v1 Stim run or revise old run verdicts.

Keep source, build, process continuity, and visual checks intact. A device that
vanishes before independent verification still lacks that evidence. Cleanup
uses the exact retained run-owned device identity, never a device selected only
by its serial or a broad emulator shutdown.

Collection rejects failed or timed-out runners, missing evidence, incorrect
source changes, and changed coordinator or Swift-wrapper hashes. A run
that passes those checks remains `pending-independent-ui-and-command-audit`;
an agent's success message does not certify it. Before accepting a
result, inspect the complete command evidence, verify the exact source change,
check the PID/start identity captured before the final verification sequence in `target.json` against its original
command output, confirm that exact process identity is still alive, and attach to the same run-scoped
agent-device session without relaunching, verify both texts and capture an
independent screenshot. Bind that review to the transcript and screenshot
hashes. Reject wrong devices, source changes that fake the counter, missing
proof, incomplete builds, process replacement, and failed or timed-out runners.
Keep failed attempts and relaunches in the timed transcript. Recovery before the
final verification is allowed; if the process changes during verification,
restart the whole verification sequence. Its final identity must remain live
through coordinator verification. Retain invalid runs; never overwrite their
evidence with a retry.

Stop and remove Stim worktrees through the pinned CLI with their exact
`STIM_HOME`. For control, stop only the recorded app process and delete only
the exact simulator or AVD created for that run, after checking its identity
against the before-run inventory. Close the run's agent-device session. Record
cleanup before publishing results.

Report task elapsed time and token use separately for each native backend.
The run record also reports `interactionSeconds` from dispatch through the
standalone interaction or follow-up snapshot that first confirms `Count: 1`.
The screenshot and other evidence run separately.
Total elapsed time includes the complete turn and evidence collection; they are not
the Trailhead screenshot-ready metric. A tiny sample supports a pilot
comparison, not a broad performance claim. Native Xcode projects can benefit
from Stim's reusable artifacts and compiler cache. Native Gradle and macOS
SwiftPM do not have reusable Stim artifact caching; measure any benefit in
workspace/device preparation, incremental compilation, launch, and verification.

## Website publication

Publish only paired runs with accepted independent audits and completed cleanup:

```bash
node scripts/export-native-benchmarks.mjs "$STIM_BENCH_ROOT" website/src/data/benchmarks/native-luna-1.20.2.json website/static/benchmarks/native-luna-1.20.2
```

Each platform's `comparison.json` selects its Stim and control run IDs. The
exporter verifies matching cohort and coordinator hashes within each pair,
fixture, release, model, and environment metadata;
turn timestamps; required audit checks; and all retained evidence hashes. A
platform without a comparison is omitted. A selected rejected or incomplete
pair refuses publication before writing output. Review every exported proof
image for private content before committing it.

The benchmark overview displays these pilots separately as total task time,
including retries and evidence capture. Keep the one-pair limitation visible.
Native Android joins that section only after an accepted comparison is exported.

## Matrix mapping

In the published matrix the standalone task is the app-launch scenario for
macOS, native iOS and native Android: it builds, launches and verifies the app.
The error-fix scenario there is a native launch crash the logs surface; no
fixture variant exists, so `matrix.mjs` marks those cells not-yet-runnable.
Dispatch takes the model first-class, as before, and refuses one outside the
campaign model list.
