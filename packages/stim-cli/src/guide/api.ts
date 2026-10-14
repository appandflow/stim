export default {
  summary: 'Typed lifecycle API: createStim, build, run, stop, diagnostics, settings, stats, logs, and cancellation',
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

logs({ tail, sources, minLevel, slot, since, grep, errorsOnly }) returns the raw
stim logs --json records, including native crash capture, agent actions and Expo
error context. It runs in process, with asynchronous chunked reads and bounded
record selection when tail is supplied. A new file generation gets a compact
metadata index; later queries reuse it and index only appended bytes.
Matching agent actions are also selected within tail; attribution still scans
each retained session generation to establish device ownership.
followLogs(options, onRecord) emits the requested backfill followed by new records
and returns a stop function. AbortSignal also stops the subscription.

run takes platform plus its options:
  ios:     configuration, scheme, deviceType, runtime
  android: variant, systemImage, deviceProfile
  macos:   remoteBuild
  web:     headed (default false)
iOS and Android also accept slot, metroCheck, buildCache, and remoteBuild.
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

run returns { platform, facts }. iOS facts include udid; Android includes
serial; both include bundleId, appPath, metroPort, cacheHit and launched.
macOS facts include bundle, bundleId, executable, pid, build and launched.
Web facts contain the owned browser's existing launch and page facts.
Do not interpret 'bundling' or 'unverified' as proven application readiness.

stop({ slot? }) returns { ok, outcomes, summary }. It acts on the workspace,
including resources from earlier runs. Use a dedicated workspace in CI.
Cancellation drains the operation's owned work, a read kills its child
processes, and both reject with STIM_CANCELLED; an aborted stop finishes its
teardown and then rejects with STIM_CANCELLED. Stop with a fresh signal
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
