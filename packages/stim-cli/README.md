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

For native Xcode simulator builds, a local and configured-provider miss can
reuse an exact completed artifact from an enabled paired build worker. Reuse
checks the full source, toolchain, SDK, architecture and target cache key and
verifies the downloaded archive. It needs no compilation slot. An explicit
local build and remote build mode off skip peer lookup; other project types
keep their existing cache paths. See `stim guide settings` for placement.

## Native Android build workers

Native Gradle apps can use an approved build worker after declaring that
Git-visible source and exact additional ignored files are sufficient. See
`stim guide lifecycle native-android` for `android.offloadInputs`, generated
output ownership, and supported input boundaries. Stim does not invent an artifact-cache key for
arbitrary Gradle inputs; Gradle keeps its own incremental and task caches.

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

All operations run in the importing process. `settings()` and `stats()`
which read the `stim settings --json` and `stim stats --json` payloads. All
use the client's own home and leave the caller's cwd, environment,
output, signal handlers and exit listeners as they were. The API and CLI call
the same native lifecycle operations. Progress is silent unless `onProgress`
is provided; its `message` is an output chunk. Operations accept `signal`.
Cancellation drains the operation's owned work, and does not replace `stop()`.
Call cleanup with a fresh signal after cancellation or partial failure.

`doctor({ platform? })` and `gc({ cache?, olderThan?, worktrees? })` read their CLI
JSON reports with a 60 second aggregate budget and optional `signal`. Doctor
never repairs or records a CLI run; its `stim.runningPath` is null. GC never
deletes or shuts down idle devices. Reads can refresh their own usage caches
and existing pending remote approvals. An explicit `home` or `STIM_HOME` keeps
the CLI's scoped-home restrictions. Expiry rejects with `STIM_REPORT_TIMEOUT`
after owned children and connections close; a caller abort rejects with
`STIM_CANCELLED`. Throwing from report progress also cancels the read.
If child identity cannot be verified after a one-second retry budget, cleanup
refuses with `STIM_CLAIM_UNAVAILABLE` instead of a cancellation or timeout
error. The error names the launcher PID; unverifiable processes and descendants
are left untouched. On POSIX, a launcher that exited before identity capture can only
finish successfully once its process group is proven gone.
On Windows, report probes require the built-in Windows PowerShell for process-tree containment.

`home` and `buildCache` accept absolute paths. Omit them to use normal Stim
settings. A cache used by concurrent writers needs the same coordinating Stim
home; do not point independent homes at a concurrently writable artifact cache.
Ownership checks and cache locks remain active. `stop()` acts on this workspace,
including resources from earlier runs, so use a dedicated workspace in CI.

Stim failures are `StimError` instances with `code`, `message`, `remedy`, and
`details`. An exception thrown by `onProgress` stops further progress and is
propagated unchanged: `build()` or `run()` is cancelled, and
`stop()` or read finishes its work first.
`logs({ tail, sources, minLevel, slot, since, grep, errorsOnly })` reads the same
merged records as `stim logs --json`, including crash capture and agent actions.
Pass `tail` to bound the returned records. `followLogs(options, onRecord)` emits
that backfill and new records, then returns a stop function; aborting its signal
also stops it. These reads run in process and yield between log chunks.
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
