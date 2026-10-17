# Stim

The `stim` npm package installs the `stim` command and exports a typed lifecycle API.

Stim gives coding agents fast, isolated React Native and Expo environments. Each
project or git worktree gets its own Metro port and owned device. Shared caches
keep native and JavaScript builds warm across worktrees.

## Install

Node 22.12.0 or later is required. If you previously installed `stim-cli`
globally, follow the [migration instructions](#migrating-from-stim-cli) first.

```bash
npm install --global stim
npx skills add appandflow/stim
```

Run without a global install when needed:

```bash
npx stim <command>
```

## Normal workflow

```bash
stim doctor
stim start
stim ios                  # or: stim android, or: stim web
stim logs --errors
stim stop
```

`stim doctor` never loads `fingerprint.config.js` or runs an `eas` from the
project tree. On a checkout without its own dependencies, it skips the
fingerprint parity check when Expo packages resolve from outside the app or when
the check would need `npx react-native config`, as it does for Android or a
project without an `ios` directory. Its linked-library check can
still run installed Expo packages on the main checkout, as a build does.
`worktree warm`, `start`, `ios`, and `android` run project code.

Stim builds or restores the app, installs it, launches it, and checks launch
readiness. Plain output streams progress and reports the complete result. Use
`--json` when a script needs structured data.

For native Xcode simulator builds, declared repeatable SwiftPM macOS builds,
and React Native/Expo iOS Simulator or Android development builds, a local and configured-provider miss can
reuse an exact completed artifact from an enabled paired build worker. Reuse
checks the full source, toolchain, SDK, architecture and target cache key and
verifies the downloaded archive. It needs no compilation slot. An explicit
local build and remote build mode off skip peer lookup. React Native archives
match the native fingerprint, build choices and compatible toolchain verified
around compilation; they remain reusable after the worker changes checkouts.
Release and physical device builds keep their existing cache paths. See `stim guide settings` for placement.
SwiftPM peer reuse requires `macos.artifactInputs` and a capable worker. Its
receipt verifies actual worker source and rechecks worker-private files,
environment and Swift/Xcode/SDK identity. Private values are not transferred;
worker identities are separate from local cache keys. Compiler overrides
(`SWIFT_EXEC` and `SWIFT_EXEC_MANIFEST`) are resolved and versioned separately.
Overrides and custom toolchain launchers
require the worker checkout to revalidate their selection. See `stim guide macos`.

## Native Android build workers

Native Gradle apps can use an approved build worker after declaring that
Git-visible source and exact additional ignored files are sufficient. See
`stim guide lifecycle native-android` for `android.offloadInputs`, generated output ownership,
and supported input boundaries. Workers remain uncached. Local builds can opt
into APK caching through a separate complete `android.artifactInputs` declaration.
A configured cache provider with a `files` capability can share the verified APK
and its receipt between machines. Private input files and environment values
stay local; the declaration never authorizes their transfer. Gradle
keeps its own incremental and task caches in both cases.

## Programmatic API

Install `stim` as a dependency with `npm install --save-dev stim`, then import
from the main package:

```ts
import { createStim } from 'stim';

const stim = createStim({ projectRoot: process.cwd() });
try {
  const result = await stim.run({ platform: 'ios' });
  console.log(result.facts.udid);
} finally {
  try {
    console.log(await stim.diagnostics({ errors: true }));
  } finally {
    const cleanup = await stim.stop();
    if (!cleanup.ok) throw new Error(cleanup.summary);
  }
}
```

`run` supports iOS and Android React Native/Expo apps, SwiftPM macOS apps, and
web pages with the same requirements as their CLI commands. Web runs require an
already running server. `run` builds, installs and launches.
`build({ platform: 'ios' })` returns a retained simulator app without starting
a device or runtime; Android returns an APK and macOS returns an app bundle.
Build-only preserves existing sessions and uses the same cache and build locks.
Successful builds include `result.facts.links.workspace`, an HTTPS workspace link
agents can share with an already-paired phone or Desktop, including when the
build machine has no Desktop app installed.
Each result is a separate copy kept in the workspace until `stim worktree remove`.
Run results preserve the CLI's launch evidence, including `'bundling'` and
`'unverified'` results.

`reload({ platform?: 'ios' | 'android' | 'web', signal? })` requests a JavaScript
reload in a live app or reloads the owned Chrome page, returning the flat
`stim reload --json` facts. Select a platform when more than one is live.
Dispatch does not prove completion; verify the expected UI and inspect logs.
A Metro broadcast can reach other connected clients. Reload uses a 60 second
execution budget and 35 second cleanup budget, with the report timeout and
cleanup refusals described below. Cancellation stops pending work but cannot
retract a request already sent. Reload never retries automatically.

`warmWorktree({ signal?, beforeWarm? })` copies missing ignored state from the
source checkout into the client's linked worktree in process, returning
`{ exitCode: 0 | 1 }`. It preserves existing entries and tracked files, shares
the source's read claim, and takes an exclusive claim on the target while copying.
`beforeWarm(workspace)` admits each canonical workspace in the resolved warming
scope before registration or copying; throwing refuses warming. Progress uses
`onProgress`. Cancellation drains the copy child before removing its partial
entry or releasing claims. Unverifiable cleanup retains the claims and reports
`STIM_CLAIM_UNAVAILABLE` with recovery paths. Warming has a 90 minute execution
budget and a 35 second cleanup budget. Source refresh remains available through
`stim worktree warm --refresh`; this API does not refresh or install dependencies.

`removeWorktree({ target?, force?, signal? })` uses the CLI's removal checks and
cleanup in process. The target defaults to `projectRoot`; relative paths resolve
against it. It returns `{ removed, exitCode }` without changing `process.exitCode`.
Source checkout environment cleanup can succeed with `removed: false` and
`exitCode: 0`; a linked worktree deleted before a branch-cleanup failure returns
`removed: true` and `exitCode: 1`. `force` means CLI `--force`, including discarding
unsaved work. It uses the 60 second execution and 35 second cleanup budgets below.
Cancellation stops pending actions and drains owned cleanup; completed deletions
remain applied.

`setSetting(key, text, { scope?, signal? })` and `unsetSetting(key, { scope?, signal? })`
share the CLI's validation and return its JSON write result, including masked
sensitive values. Values use CLI text syntax, including JSON for arrays and
objects. Config lock waits and device-pool probes are asynchronous. Cancellation
prevents a pending write; a committed write finishes its recording cleanup
before settling. Recording changes serialize through cleanup within the home.

All operations run in the importing process. `settings()` and `stats()`
read the `stim settings --json` and `stim stats --json` payloads. All
use the client's own home and leave the caller's cwd, environment,
output, signal handlers and exit listeners as they were. The API and CLI call
the same native lifecycle operations. Progress is silent unless `onProgress`
is provided; its `message` is an output chunk. Operations accept `signal`.
Cancellation drains the operation's owned work, and does not replace `stop()`.
Call cleanup with a fresh signal after cancellation or partial failure.
Cancelling `stop()` while it waits for another native operation ends that wait.
Once teardown starts, it finishes cleanup before rejecting with `STIM_CANCELLED`;
its config, workspace-state, and lease lock waits are asynchronous.

`plan({ platform: 'ios' | 'android' | 'macos', signal? })` predicts the next
configured native build, as the CLI's `--plan --json` reports it, without building
or launching. iOS and Android also accept `slot`; build and device selectors
come from the project's settings. Plans use the report execution and cleanup
budgets below. Fingerprinting uses the existing cancellable report helper;
native probes and cache downloads finish cleanup before the report settles.
In-process plans skip custom Expo `buildCacheProvider` plugins; use EAS or a
Stim cache provider instead. The CLI retains its custom Expo plugin support.
Cache providers must settle after cancellation. If cleanup cannot finish within
35 seconds, the plan refuses with `STIM_CLAIM_UNAVAILABLE` and retains the download
directory; it does not delete files a broken provider may still be writing.

`doctor({ platform?, record? })` and `gc({ cache?, olderThan?, worktrees? })` read their CLI
JSON reports with a 60 second execution budget and optional `signal`. Doctor
never repairs; its `stim.runningPath` is null. By default it does not record a
check. Pass `record: true` to register the supported iOS/Android project and record
its checked platforms after the report and owned cleanup succeed. Recording waits
asynchronously for the config lock, honors `signal`, and rejects unavailable state.
GC never
deletes or shuts down idle devices. Reads can refresh their own usage caches
and existing pending remote approvals. An explicit `home` or `STIM_HOME` keeps
the CLI's scoped-home restrictions. Expiry rejects with `STIM_REPORT_TIMEOUT`
after owned cleanup; a caller abort rejects with
`STIM_CANCELLED`. Throwing from report progress also cancels the read.
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

`home` and `buildCache` accept absolute paths. Omit them to use normal Stim
settings. A cache used by concurrent writers needs the same coordinating Stim
home; do not point independent homes at a concurrently writable artifact cache.
`start({ remote?, resetCache?, waitSeconds?, signal?, beforeStart? })` starts or
reuses the managed dev server and returns flat start facts.
The optional admission callback receives the resolved app before startup effects.
Cancellation accounts for newly spawned processes before returning; a verified
supervisor handed off to its workspace can remain running. Unconfirmed cleanup
reports `STIM_CLAIM_UNAVAILABLE` with the retained ownership claims' recovery remedy.

Ownership checks and cache locks remain active. `stop()` acts on this workspace,
including resources from earlier runs, so use a dedicated workspace in CI.

Stim failures are `StimError` instances with `code`, `message`, `remedy`, and
`details`. An exception thrown by `onProgress` stops further progress and is
propagated unchanged: `start()`, `build()` or `run()` is cancelled, and
`stop()` or read finishes its work first.
`logs({ tail, sources, minLevel, slot, since, grep, errorsOnly })` reads the same
merged records as `stim logs --json`, including crash capture and agent actions.
Pass `tail` to bound the returned records. `followLogs(options, onRecord)` emits
that backfill and new records, then returns a stop function; aborting its signal
also stops it. An optional third callback receives initial records instead of
`onRecord`; its promise is awaited before the next batch. With that callback and
no `tail`, timeline batches hold at most 500 records. Agent attribution still
retains its matching records during backfill. These reads run in process and yield between log chunks.
Local follow uses filesystem hints with a ten-second repair scan. While a
directory watch is unavailable, it retries and scans every 500 ms; Expo error
context uses a timer only while pending. Agent-action and active hosted log
sampling are unchanged.
Attachment schedules one 500 ms recovery scan. A moved directory on Windows can
require the ten-second repair scan.
Hosted targets join and leave the follow stream from local state notifications;
missed notifications are reconciled about every 10 seconds. Active hosts still
serve bounded log queries.
Tail selection bounds matching timeline and agent records; agent attribution
still reads each retained session generation to establish device ownership.

`diagnostics()` returns the workspace log directory and up to 200 local records,
even if no run has succeeded. It does not fetch remote logs or capture new crashes.
See [the API reference](https://stim.appandflow.com/docs/programmatic-api) or
`stim guide api` for options and result types.

## Documentation

The [documentation website](https://stim.appandflow.com/) is the full
reference:

- [Getting started](https://stim.appandflow.com/docs/getting-started): terms,
  the first run, parallel worktrees, and what to do when a run fails.
- [Native macOS prototype](https://stim.appandflow.com/docs/macos): Swift Package
  Debug apps, workspace logs and local window viewing in Stim Desktop.
- [Web in an owned Chrome](https://stim.appandflow.com/docs/web): `stim web`
  for Expo web and other web servers, page logs, and attaching browser tools.
- [Worktrees](https://stim.appandflow.com/docs/worktrees): `worktree warm`,
  `--refresh`, `worktree remove`, and `gc --worktrees` to remove finished
  worktrees in bulk.
- [Build caches](https://stim.appandflow.com/docs/build-caches): what `gc`
  reports and trims, including the build outputs of idle workspaces.
- [Devices](https://stim.appandflow.com/docs/owned-devices): owned simulators
  and emulators, physical devices, slots, and remote devices.
- [EAS development builds](https://stim.appandflow.com/docs/eas-builds).
- [Commands](https://stim.appandflow.com/docs/commands) and
  [settings](https://stim.appandflow.com/docs/settings).
- [Troubleshooting](https://stim.appandflow.com/docs/troubleshooting): every
  refusal code and its remedy.

The installed CLI contains version-matched operational guidance:

```bash
stim guide agent
stim --help
stim <command> --help
stim guide
```

## Migrating from stim-cli

Remove the old global package before installing `stim`, since both provide the
same command:

```bash
npm uninstall --global stim-cli
npm install --global stim
```

Update programmatic imports from `stim-cli/cache-manifest` to
`stim/cache-manifest`. The `@stim-cli/*` packages keep their names.

## License

MIT
