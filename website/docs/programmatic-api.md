---
title: Programmatic API
---

Install the main package as a project dependency:

```bash
npm install --save-dev stim
```

Node 22.12 or later is required. The package exports the API and also installs
the `stim` executable. Command examples use `stim`; replace it with `npx stim`
when it is not installed globally.

```ts
import { createStim } from 'stim';

const stim = createStim({
  projectRoot: process.cwd(),
  onProgress: ({ message }) => process.stderr.write(message),
});

try {
  const result = await stim.run({ platform: 'ios' });
  console.log(result.facts.udid);
} finally {
  try {
    const diagnostics = await stim.diagnostics({ errors: true });
    console.log(diagnostics.directory, diagnostics.records);
  } finally {
    const cleanup = await stim.stop();
    if (!cleanup.ok) throw new Error(cleanup.summary);
  }
}
```

## Client context

`createStim` resolves `projectRoot` to its canonical path once. It accepts
optional absolute `home` and `buildCache` paths, an `env` object, and an
`onProgress` callback. `env` defaults to the caller's `process.env`; Stim reads
its settings overrides from it and passes it to its child processes. Omitted paths use
that environment, captured when the client is created, and normal Stim
configuration. The client's home is fixed at creation.
Progress events contain `stream` (`stdout` or `stderr`) and `message`, an output
chunk which can contain partial lines. Without a callback the API stays silent.

All operations run in the importing process against the client's home and
project and invoke the same lifecycle operations as the CLI, so clients for
different homes can share a process. None parses Commander arguments. The
importing process keeps its working directory, environment, output and signal
handlers.

The exported TypeScript contracts are `StimOptions`, `StimClient`,
`StimBuildOptions`, `StimBuildResult`, `StimRunOptions`, `StimRunResult`,
`StimStopOptions`, `StimStopResult`, `StimDiagnosticsOptions`,
`StimDiagnostics`, `StimLogsOptions`, `StimReadOptions`, `StimSettings`,
`StimStats`, `StimProgress`, and `StimPlatform`.

## Build only

```ts
const result = await stim.build({ platform: 'ios', configuration: 'Debug' });
console.log(result.facts.appPath);
console.log(result.facts.links.workspace);
```

`build` uses the selected project's compiler recipe and normal build/cache
coordination. It does not create or boot a device, launch an app, start Metro,
or stop a session. Results are inferred from `platform`, just like `run`.

| Platform  | Options                                                                                            | Returned artifact                        |
| --------- | -------------------------------------------------------------------------------------------------- | ---------------------------------------- |
| `ios`     | `scheme`, `configuration`, `arch` (`arm64`, `x86_64`, `all`), `buildCache`, `remoteBuild`          | `facts.appPath`, a simulator app         |
| `android` | `variant`, `abi` (`arm64-v8a`, `armeabi-v7a`, `x86`, `x86_64`, `all`), `buildCache`, `remoteBuild` | `facts.apkPath`                          |
| `macos`   | `remoteBuild`                                                                                      | `facts.bundle`, the configured Debug app |

A Debug build targets the host architecture by default; on Android only while
`optimizations.android.targetAbiOnly` is on, which is the default. Release uses
all architectures. Each result points to a separate owned copy retained until
`stim worktree remove` removes this workspace; a later build does not overwrite
it. A build does not replace a running app's last build record or build log; it
writes its own `build-artifact-<platform>.ndjson`. Build-only does not export
distribution archives or infer a web compilation pipeline.
Use `buildCI` from `@stim-cli/ci` to export the app and diagnostics for CI artifacts.

Successful builds also return `facts.links.workspace`, the machine-aware HTTPS
workspace link agents can share with an already-paired phone or Desktop.
It is available when the build machine has no Desktop installed. Opening it
only navigates to the workspace; it does not install or launch the built app.

## Run

`run` builds, installs and launches with the same requirements and configuration
as the corresponding CLI command.

| Platform  | Project              | Options                                            |
| --------- | -------------------- | -------------------------------------------------- |
| `ios`     | React Native or Expo | `configuration`, `scheme`, `deviceType`, `runtime` |
| `android` | React Native or Expo | `variant`, `systemImage`, `deviceProfile`          |
| `macos`   | SwiftPM macOS app    | `remoteBuild`                                      |
| `web`     | Existing web server  | `headed` (default `false`)                         |

The iOS and Android requests also accept `slot`, `metroCheck`, `buildCache`,
and `remoteBuild`. Project configuration still supplies defaults. A web run
requires a running server, as `stim web` does.

Results are `{ platform, facts }`, inferred from the requested platform.
For example, `run({ platform: 'ios' })` returns iOS facts directly. If the input
platform is a union, narrow the result's `platform` to access platform-specific
facts. iOS includes `udid`, Android includes `serial`,
and both retain `appPath`, `bundleId`, `metroPort`, `cacheHit`, and `launched`.
macOS includes `bundle`, `bundleId`, `executable`, `pid`, `build`, and `launched`.
Web retains its browser/page launch facts.

Native `launched` can be `true`, `'bundling'`, or `'unverified'`. A successful
operation does not turn unverified launch evidence into application readiness.
Test runners should wait for their own application-specific ready state.

## Cancellation and cleanup

Every method accepts an `AbortSignal`. Cancellation interrupts the operation and
waits for its owned work to settle; a read stops its child processes and rejects with
`STIM_CANCELLED`. Cancelling `stop()` while it waits for another native operation
ends that wait. Once teardown starts, it finishes cleanup before rejecting with
`STIM_CANCELLED`; its config, workspace-state, and lease lock waits are asynchronous. Native tools retain their existing cooperative cancellation
and ownership claims; this is not a forced-kill deadline.

Call `stop()` in cleanup even when `run()` failed partway through. Use a fresh
signal after cancellation. Stop returns `{ ok, outcomes, summary }`; inspect
`ok`, because a refused teardown is not successful cleanup. `stop({ slot })`
retains the CLI's slot-specific behavior.

Resources belong to the workspace, not to an individual JavaScript client.
`stop()` can stop resources from an earlier invocation in the same workspace.
Use a dedicated checkout/workspace for a CI job.

Stim failures reject with `StimError`, whose `code`, `message`, `remedy`, and `details`
preserve failure information. Operation errors include the workspace log path
in `details.logs`. An exception thrown by `onProgress` stops further progress
and is propagated unchanged: `build()`, `run()`, `doctor()` and `gc()` cancel
their owned work; `stop()` and other reads finish their work first.

## Doctor and GC reports

```ts
const doctor = await stim.doctor({ platform: 'ios', signal });
const garbage = await stim.gc({ cache: 'workspaces', signal });
console.log(doctor.findings, garbage.sections);
```

`doctor({ platform?, record? })` reads the `stim doctor --json` report without repairing
project files. By default it does not record a check. Pass `record: true` to
register a supported iOS/Android project and record its checked platforms after the
report and owned cleanup succeed. Recording waits asynchronously for the config
lock, honors `signal`, and rejects unavailable state. `stim.runningPath` is null because
you imported the library rather than running the executable. Existing remote
approval checks can refresh their own pending credential records.

`gc({ cache?, olderThan?, worktrees? })` returns the GC JSON dry-run report.
It never deletes resources or shuts down idle devices. `olderThan` is a whole
number of days, and `cache` and `worktrees` have the CLI's scope semantics.
Invalid scopes reject with `StimError` and their remedy. Reports can refresh
their own measured-usage caches. An explicit `home` or `STIM_HOME` preserves
the CLI's scoped-home restrictions on machine-global resources.

Both reads have a 60 second execution budget. They attempt owned cleanup
before rejecting with `STIM_REPORT_TIMEOUT` on
expiry or `STIM_CANCELLED` on a caller abort. Throwing from `onProgress` cancels
the report and propagates that exception unchanged. Other clients keep running.
If child identity cannot be verified after a one-second retry budget, cleanup
refuses with `STIM_CLAIM_UNAVAILABLE` instead of a cancellation or timeout
error. Child cleanup errors name the launcher PID; unverifiable processes and descendants
are left untouched. On POSIX, a launcher that exited before identity capture can only
finish successfully once its process group is proven gone.
After a termination request, cleanup waits at most one second for a child to
close. Overall cleanup has a 35 second budget, including temporary-worktree
removal; unfinished cleanup returns `STIM_CLAIM_UNAVAILABLE` and leaves
unresolved resources in place. Credential refresh waits asynchronously and
checks cancellation before writing.
On Windows, report probes require the built-in Windows PowerShell for process-tree containment.

## Settings

`settings()` returns every setting with its effective value, origin and
per-layer values for the client's project, the same payload as
`stim settings --json`. It reads in the importing process and starts no Stim
worker. An invalid environment override rejects with a `StimError` carrying
`STIM_BAD_ARG` and its remedy.

`setSetting(key, text, { scope?, signal? })` and
`unsetSetting(key, { scope?, signal? })` return the same JSON result as
`stim settings set/unset --json`: the file, scope, changed flag and updated
setting entry. Sensitive values remain masked. Pass CLI text values, including
JSON strings for array and object settings:

```ts
await stim.setSetting('ios.runtime', '26.4', { scope: 'workspace' });
await stim.unsetSetting('ios.runtime', { scope: 'workspace' });
```

Validation, layer precedence and committed-file handling are shared with the
CLI. Lock acquisition and device-pool probes do not block the event loop.
Cancellation prevents a write that has not committed. Once committed, disabling
recording finishes deleting the affected recordings before the promise settles,
even when cancellation arrives during cleanup. Recording changes within one
home serialize through that cleanup, so a later enable cannot overtake deletion.

Both methods accept `beforeWrite(workspace)`, a synchronous callback invoked once
after resolving the target and before mutation or recording-lock waits. Throwing
refuses the write. Server adapters can use it to admit the exact workspace being
changed; later registry changes do not redirect the write or its returned setting.

## Stats

`stats()` returns run and build-cache counts for the client's project and the
machine, build placement, and the agent-device and SwiftPM cache usage Stim
last recorded, the same payload as `stim stats --json` except that it does not
measure those usage figures again. It reads in the importing process.

## Logs

`logs({ tail, sources, minLevel, slot, since, grep, errorsOnly, signal })`
returns the same merged records as `stim logs --json`, including hosted logs,
native crash capture, agent actions and Expo error context. It requires logs
from a previous workspace run. Pass `tail` to bound the returned records;
omitting it returns every matching record. `tail: 0` returns no records.
`sources` is a list of log sources, `grep` is a regular expression string, and
`since` accepts a duration such as `30s`, `5m` or `2h`.

```ts
const records = await stim.logs({ tail: 2000, errorsOnly: true });
const stopLogs = await stim.followLogs({ tail: 200 }, (record) => {
  console.log(record);
});
stopLogs();
```

`followLogs(options, onRecord)` emits matching backfill followed by appended
records and resolves to a stop function. Its backfill is bounded when `tail`
is supplied. Aborting its signal also stops the subscription; cancellation
before setup finishes rejects with `STIM_CANCELLED`.

Local follow uses filesystem change hints with a ten-second repair scan for
missed events or a replaced directory. Until a directory watch is available,
attachment and reads retry every 500 ms. Expo error context uses a settle timer
only while pending. Agent-action and active hosted query sampling are unchanged.
Attachment also schedules one 500 ms recovery scan. On Windows a moved log
directory can require the ten-second repair scan.

Hosted targets join and leave the follow stream from local state notifications.
Missed notifications are reconciled about every 10 seconds; active hosts still
serve bounded log queries.

An optional third callback, `onBackfill(records)`, receives the initial records
instead of `onRecord`. Its promise is awaited before the next batch, allowing a
consumer to apply backpressure. With that callback and no `tail`, timeline
selection uses batches of at most 500 records. Appended records still go to
`onRecord`. Agent attribution still retains its matching records during the initial read.

These operations run in the importing process, read files asynchronously and
yield between parsing chunks. A cold file generation is scanned for timestamp
bounds, markers and launches; later reads reuse that index and scan appended
complete lines. Tail selection bounds matching timeline and agent records.
Agent attribution still scans each retained session generation to establish
device ownership, so transient parsing buffers depend on those file sizes.
Caller context and process settings remain unchanged.

## Diagnostics and CI state

`diagnostics({ tail: 200, errors: false })` reads the existing local timeline
and returns `{ directory, records }`. `tail: 0` returns paths without records.
The directory is returned even before a run creates logs. This method does not
fetch remote logs or capture new native crashes.

Ownership validation, artifact compatibility and coordination stay active.
For a disposable CI job, use its own checkout and state/cache directories.
If concurrent runs write the same artifact cache, they must share its
coordinating Stim home. Separate homes pointed at one writable artifact cache
do not share build locks.
