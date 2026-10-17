export default {
  summary:
    'Typed lifecycle API: createStim, build, run, reload, stop, warmWorktree, removeWorktree, diagnostics, doctor, GC, settings, stats, logs, and cancellation',
  body: () => `PROGRAMMATIC API

Install stim as a project dependency: npm install --save-dev stim.
Import { createStim, StimError } from 'stim'. Node 22.12 or later is required.

  const stim = createStim({ projectRoot: process.cwd() });
  try {
    const result = await stim.run({ platform: 'ios' });
  } finally {
    try {
      const diagnostics = await stim.diagnostics({ errors: true });
    } finally {
      const cleanup = await stim.stop();
      if (!cleanup.ok) throw new Error(cleanup.summary);
    }
  }

createStim takes projectRoot, optional absolute home and buildCache paths, an
env object (default process.env) that Stim reads its settings overrides from
and passes to its child processes, and onProgress({ stream, message }). message is an
output chunk. Without onProgress, operations write nothing to the caller's
stdout or stderr. The home is fixed when the client is created: home, else
STIM_HOME from env, else the default home. All operations run in the calling
process against the client's home and project and call the same lifecycle
operations as the CLI. None parses CLI arguments or changes the caller's
cwd/environment.

settings() returns the stim settings --json payload: every setting with its
effective value, origin and per-layer values. An invalid environment override
rejects with StimError STIM_BAD_ARG and its remedy. stats() returns the
stim stats --json payload with the last recorded agent-device and SwiftPM cache
usage instead of measuring them again.

setSetting(key, text, { scope?, signal?, beforeWrite? }) and
unsetSetting(key, { scope?, signal?, beforeWrite? }) share CLI validation and
return its masked JSON write result. beforeWrite(workspace) runs once after
resolving the target and before mutation or recording-lock waits; throwing
refuses the write. Server adapters use it to admit that exact workspace.
Later registry changes do not redirect the write or its returned setting.
Pending writes cancel. After commit, recording deletion finishes before the
promise settles, including when cancellation arrives during cleanup.

plan({ platform, slot?, signal? }) returns the configured ios/android/macos next-build
report, matching --plan --json, without building, launching or taking a device.
slot applies to ios/android. A predicted build refusal stays in the report;
a failure to produce a report rejects with StimError. Fingerprinting uses the
existing cancellable report helper. Native probes and cache downloads drain
before the report settles. Plans use the report budgets below. In-process plans
skip custom Expo buildCacheProvider plugins; use EAS or a Stim cache provider.
The CLI retains its custom Expo plugin support. Providers must settle on abort;
cleanup exceeding 35 seconds refuses with STIM_CLAIM_UNAVAILABLE and retains
the download directory rather than deleting files a provider may still write.

doctor({ platform? }) and gc({ cache?, olderThan?, worktrees? }) read reports in
process with a 60 second execution budget. They accept signal and attempt
owned cleanup before rejecting. Deadline expiry rejects with
STIM_REPORT_TIMEOUT; a caller abort rejects with STIM_CANCELLED. A thrown
onProgress callback cancels the report and is propagated unchanged.
If child identity cannot be verified after a one-second retry budget, cleanup
refuses with STIM_CLAIM_UNAVAILABLE instead of cancellation or timeout. The
child cleanup error names the launcher PID; unverifiable processes and descendants are left
untouched. On POSIX, a launcher that exited before identity capture can only finish
successfully once its process group is proven gone.
After a termination request, cleanup waits at most one second for a child to
close. Overall cleanup has a 35 second budget, including temporary-worktree
removal; unfinished cleanup returns STIM_CLAIM_UNAVAILABLE and leaves unresolved
resources in place. Credential refresh waits asynchronously and checks
cancellation before writing.
On Windows, report probes require the built-in Windows PowerShell for process-tree containment.

warmWorktree({ signal?, beforeWarm? }) copies missing ignored state from the source
checkout into the client's linked worktree in process. It returns { exitCode },
0 or 1, without changing process.exitCode. Existing entries and tracked paths
remain untouched. Copies share a source read claim and hold an exclusive target
claim. beforeWarm(workspace) admits each canonical workspace in the resolved
warming scope before registration or copying; throwing refuses warming.
Progress uses onProgress. Cancellation drains the copy child before removing
its partial entry or releasing claims. Unknown cleanup retains those claims
and returns STIM_CLAIM_UNAVAILABLE with exact recovery paths. The execution
budget is 90 minutes; cleanup still has the 35 second budget above. The API
does not refresh the source or install dependencies; use CLI worktree warm
--refresh for that.

removeWorktree({ target?, force?, signal?, beforeRemove? }) runs the CLI's worktree removal
safety checks and cleanup in process. target defaults to projectRoot; relative
paths resolve against it. It returns { removed, exitCode } without changing
process.exitCode. removed is true once a linked Git worktree is deleted, even
if later branch cleanup fails. Source checkout environment cleanup can succeed
with removed: false and exitCode: 0. force has the same destructive meaning as
CLI --force. Cancellation stops pending work and waits for owned cleanup;
completed actions remain applied. It uses the report budgets above.
beforeRemove(workspace) runs for every canonical workspace in the resolved
cleanup scope before effects, including registered descendants and pending
branch cleanup. Throwing refuses the operation.

gc() stays read-only. collectGarbage({ cache?, olderThan?, worktrees?, delete?,
idleMs?, signal? }) runs the same GC selections and actions as the CLI, including
an unscoped sweep. It returns { report, exitCode }; exitCode is 0 or 1 and does
not change process.exitCode. delete: true enables deletion. idleMs reclaims
owned devices idle for that many milliseconds, including without delete.
The existing CLI rules for cache selection, workspace safety and scoped homes apply.

A deletion or idle sweep takes this home's exclusive maintenance claim;
concurrent maintenance rejects with STIM_CLAIM_REFUSED and names the held claim.
Execution and cleanup use the report budgets above. Cancellation stops pending
lock waits and further actions; completed actions remain applied. An archive
whose history has started moving finishes publication before cancellation.
Unresolved owned cleanup rejects with STIM_CLAIM_UNAVAILABLE and retains its
actual ownership claims for recovery. Progress uses onProgress; GC does not
replace the caller's console methods.

doctor returns the doctor --json findings and metadata, with runningPath null
because the caller imports the library rather than executing a Stim CLI. It
never repairs the project. By default it does not record a check; record: true
registers a supported iOS/Android project and records the checked platforms only
after the report and owned cleanup succeed. Recording waits asynchronously for
the config lock, honors signal, and rejects unavailable state. Existing remote approval
checks can refresh their own pending credential records. gc returns the GC
JSON dry-run report; it never deletes or shuts down idle devices. Report reads
can refresh their own measured-usage caches. Supplying home or STIM_HOME retains
the CLI's scoped-home restrictions on machine-global resources.

logs({ tail, sources, minLevel, slot, since, grep, errorsOnly }) returns the raw
stim logs --json records, including native crash capture, agent actions and Expo
error context. It runs in process, with asynchronous chunked reads and bounded
record selection when tail is supplied. A new file generation gets a compact
metadata index; later queries reuse it and index only appended bytes.
Matching agent actions are also selected within tail; attribution still scans
each retained session generation to establish device ownership.
followLogs(options, onRecord) emits the requested backfill followed by new records
and returns a stop function. AbortSignal also stops the subscription.
An optional third callback, onBackfill(records), receives initial records instead
of onRecord. Its promise is awaited before reading another batch; with that
callback and no tail, the timeline is selected in batches of at most 500.
Appends still go to onRecord.
Agent attribution still retains its matching records during this initial read.
Local appends use filesystem hints with a ten-second repair scan; while a
directory watch is unavailable, attachment and reads retry every 500 ms.
Attachment also schedules one 500 ms recovery scan for watch startup.
Expo context uses a settle timer only while an error is pending. The separate
agent-action cursor and active hosted log queries keep their current sampling.

run takes platform plus its options:
  ios:     configuration, scheme, deviceType, runtime, simulatorApp
  android: variant, systemImage, deviceProfile
  macos:   remoteBuild, remote
  web:     headed (default false)
iOS and Android also accept slot, metroCheck, buildCache, remoteBuild, remote,
device, wait and easProfile. device: true auto-selects a physical device; a
string pins its UDID or serial. wait takes seconds as a string, such as '30'.
wait: false refuses a full owned-device slot immediately; on a physical device
it bypasses another workspace's lease and can replace its running app, as CLI
--no-wait does. easProfile downloads an existing compatible development build;
it never starts an EAS build. iOS simulatorApp selects the simulator viewer.
remote selects the launch host using the CLI's existing placement and approval
rules; remoteBuild independently selects where compilation runs. macOS requires
a named hosting Mac; auto, eas and proxy are not supported there.
All methods accept signal. run builds, installs and launches.
Web requires a running server, just like stim web.

build produces an artifact without acquiring a device, starting a runtime, or
stopping an existing session. Its result is inferred from platform:
  const result = await stim.build({ platform: 'ios' });
  console.log(result.facts.appPath);
  console.log(result.facts.links.workspace);

Successful builds include facts.links.workspace, an HTTPS link to this workspace
on this Stim home. Agents can share it with an already-paired phone or Desktop,
including when Desktop is not installed on the build machine. Opening it only
navigates; it does not install or launch the built app.

Build options:
  ios:     scheme, configuration, arch (arm64, x86_64, all), buildCache, remoteBuild
  android: variant, abi (arm64-v8a, armeabi-v7a, x86, x86_64, all), buildCache, remoteBuild
  macos:   remoteBuild
An iOS build targets the simulator. A Debug build defaults to the host
architecture (Android only while optimizations.android.targetAbiOnly is on, the
default); Release defaults to all. macOS builds the configured Debug SwiftPM app.
Build results retain an owned appPath (iOS), apkPath (Android) or bundle (macOS)
inside this workspace until worktree removal. Later builds keep earlier copies.
A build leaves a running app's last build record and build log untouched; it
writes its own build-artifact-<platform>.ndjson. No distribution archive or web build
pipeline is inferred. Use @stim-cli/ci's buildCI to export a portable artifact and
diagnostics for your CI provider.

Unresolved native Metro cleanup keeps error.details.cause.retainedClaimRoots and
STIM_CLAIM_UNAVAILABLE even after cancellation. Web cancellation stops pending
browser-lock and verification waits. A new browser launch is accounted for and
stopped before cancellation finishes, or refuses with retained ownership when
cleanup cannot be confirmed.

run returns { platform, facts }. iOS facts include udid; Android includes
serial; both include bundleId, appPath, metroPort, cacheHit and launched.
macOS facts include bundle, bundleId, executable, pid, build and launched.
A hosted macOS result has a null local pid and preserves true or 'unverified'
from the host's launch evidence.
Web facts contain the owned browser's existing launch and page facts.
Do not interpret 'bundling' or 'unverified' as proven application readiness.

start({ remote?, resetCache?, waitSeconds?, signal?, beforeStart? }) starts or
reuses the managed dev server, using the same settings and ownership rules as
stim start. remote requests the configured public URL or tunnel. resetCache
restarts the server with a cleared transform cache. waitSeconds is a positive
whole number, defaulting to 60. The flat result is port, supervisorPid, mode,
logsDir, agentDevice and alreadyRunning.
beforeStart(workspace) runs once with the resolved app before usage recording
or effects; throwing refuses startup. Cancellation stops pending probes and lock
waits, then accounts for new children before returning. A verified supervisor
handed off to the workspace may remain running. Unconfirmed cleanup refuses with
STIM_CLAIM_UNAVAILABLE, taking precedence over cancellation or callback failure;
follow its remedy before retrying. Startup never retries automatically.

reload({ platform?, signal?, beforeReload? }) requests a JavaScript reload in
the live iOS/Android app or reloads the owned Chrome page. It returns the flat
stim reload --json facts: platform, deviceId, deviceName, appId, metroPort,
strategy, targets and reverseRestored. Choose ios, android or web when more
than one platform is live. A request does not prove completion; verify the UI
and inspect logs. A Metro broadcast can reach other connected clients.
beforeReload(workspace) runs once after resolving the workspace and before
usage recording or dispatch; throwing refuses the action. Reload uses the
60 second execution and 35 second cleanup budgets described above, including
STIM_REPORT_TIMEOUT and STIM_CLAIM_UNAVAILABLE. Cancellation stops pending
probes and dispatch, but cannot retract a reload already sent. It never retries.

stop({ slot?, beforeStop? }) returns { ok, outcomes, summary }. It acts on the
workspace, including resources from earlier runs. Use a dedicated workspace in CI.
beforeStop(workspace) runs once with the resolved workspace before teardown;
throwing refuses the operation.
From a child directory, start and stop resolve the enclosing supported app.
Cancellation drains the operation's owned work, a read kills its child
processes, and both reject with STIM_CANCELLED. Cancelling stop while it waits
for another native operation ends that wait. Once teardown starts, stop finishes
cleanup before rejecting with STIM_CANCELLED. Its config, workspace-state, and lease lock waits are asynchronous.
Stop with a fresh signal
after cancellation or partial failure. Always inspect cleanup.ok.

diagnostics({ tail: 200, errors: false }) returns { directory, records } from
the local timeline, even before a successful run. tail: 0 returns paths only.
It does not fetch remote logs or capture new crashes. Stim failures reject with
StimError carrying code, message, remedy and details (including the log path).
An exception thrown by onProgress stops further progress and propagates
unchanged: build or run is cancelled, and stop or a read
finishes its work first.

Normal ownership, device creation, cache locks and coordination remain active.
All concurrent artifact-cache writers must share the same coordinating home.
Do not point independent Stim homes at a concurrently writable shared cache.
`,
};
