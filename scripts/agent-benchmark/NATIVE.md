# Standalone native campaign

The native suite is a separate cohort from the Trailhead React Native suite. It
compares a small SwiftUI iOS app, a Jetpack Compose Android app, and a SwiftUI
macOS Swift package. Both arms create a fresh worktree, change one visible
revision, build and launch Debug, click Increment once, and verify the new
revision and `Count: 1`. Stim uses its installed skill; control uses platform
tools. Preparation runs outside the timer, including dependency resolution and
one build with each toolchain. Runs remain sequential.

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

Repeat with `control`, `android`, and `macos`. Preparation refuses partial or
existing goldens so failed native tool calls can be inspected before recovery.
Dispatch requires two load samples at or below 3, version-matched preparation,
isolated runner skills, a verified filesystem boundary, and a current process
identity adapter. Both arms receive the same SwiftPM sandbox compensation under
the outer benchmark sandbox. The adapter and wrapper hashes are retained. The macOS runner uses a narrow
process-list adapter because macOS denies the system `ps` binary inside this
sandbox. It reads same-user executable paths with native APIs and checks
process identity before and after each read; the real-tool test covers paths
with spaces under the sandbox. Each frozen coordinator gets its own tools
directory, and collection rejects changed adapter bytes.

Collection rejects failed or timed-out runners, missing evidence, incorrect
source changes, and changed coordinator or compatibility-tool hashes. A run
that passes those checks remains `pending-independent-ui-and-command-audit`;
an agent's success message does not certify it. Before accepting a
result, inspect the complete command evidence, verify the exact source change,
confirm the recorded app process is still alive, attach to the same run-scoped
agent-device session without relaunching, verify both texts and capture an
independent screenshot. Bind that review to the transcript and screenshot
hashes. Reject wrong devices, source changes that fake the counter, missing
proof, incomplete builds, process replacement, and failed or timed-out runners.
Retain invalid attempts; never overwrite their evidence with a retry.

Stop and remove Stim worktrees through the pinned CLI with their exact
`STIM_HOME`. For control, stop only the recorded app process and delete only
the exact simulator or AVD created for that run, after checking its identity
against the before-run inventory. Close the run's agent-device session. Record
cleanup before publishing results.

Report task elapsed time and token use separately for each native backend.
These times include the complete turn and evidence collection; they are not
the Trailhead screenshot-ready metric. A tiny sample supports a pilot
comparison, not a broad performance claim. Native Xcode projects can benefit
from Stim's reusable artifacts and compiler cache. Native Gradle and macOS
SwiftPM do not have reusable Stim artifact caching; measure any benefit in
workspace/device preparation, incremental compilation, launch, and verification.
