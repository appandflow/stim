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
  if (result.platform === 'ios') console.log(result.facts.udid);
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
optional absolute `home` and `buildCache` paths, and an `onProgress` callback.
Omitted paths use the caller's environment captured when the client is created,
and normal Stim configuration.
Progress events contain `stream` (`stdout` or `stderr`) and `message`, an output
chunk which can contain partial lines. Without a callback the API stays silent.

Each operation runs in a separate bundled worker and invokes the same lifecycle
operations as the CLI. It does not parse Commander arguments. The importing
process keeps its working directory, environment, output and signal handlers.

The exported TypeScript contracts are `StimOptions`, `StimClient`,
`StimRunOptions`, `StimRunResult`, `StimStopOptions`, `StimStopResult`,
`StimDiagnosticsOptions`, `StimDiagnostics`, `StimProgress`, and `StimPlatform`.

## Run

`run` builds, installs and launches with the same requirements and configuration
as the corresponding CLI command. There is no build-only method yet.

| Platform  | Project              | Options                                            |
| --------- | -------------------- | -------------------------------------------------- |
| `ios`     | React Native or Expo | `configuration`, `scheme`, `deviceType`, `runtime` |
| `android` | React Native or Expo | `variant`, `systemImage`, `deviceProfile`          |
| `macos`   | SwiftPM macOS app    | `remoteBuild`                                      |
| `web`     | Existing web server  | `headed` (default `false`)                         |

The iOS and Android requests also accept `slot`, `metroCheck`, `buildCache`,
and `remoteBuild`. Project configuration still supplies defaults. A web run
requires a running server, as `stim web` does.

Results are a discriminated union `{ platform, facts }`. Narrow `platform` to
access that platform's facts. iOS includes `udid`, Android includes `serial`,
and both retain `appPath`, `bundleId`, `metroPort`, `cacheHit`, and `launched`.
macOS includes `bundle`, `bundleId`, `executable`, `pid`, `build`, and `launched`.
Web retains its browser/page launch facts.

Native `launched` can be `true`, `'bundling'`, or `'unverified'`. A successful
operation does not turn unverified launch evidence into application readiness.
Test runners should wait for their own application-specific ready state.

## Cancellation and cleanup

Every method accepts an `AbortSignal`. Cancellation interrupts its worker and
waits for it to exit. Native tools retain their existing cooperative cancellation
and ownership claims; this is not a forced-kill deadline.

Call `stop()` in cleanup even when `run()` failed partway through. Use a fresh
signal after cancellation. Stop returns `{ ok, outcomes, summary }`; inspect
`ok`, because a refused teardown is not successful cleanup. `stop({ slot })`
retains the CLI's slot-specific behavior.

Resources belong to the workspace, not to an individual JavaScript client.
`stop()` can stop resources from an earlier invocation in the same workspace.
Use a dedicated checkout/workspace for a CI job.

Stim failures reject with `StimError`, whose `code`, `message`, `remedy`, and `details`
preserve failure information. Operation errors returned by workers include the workspace log path
in `details.logs`. An exception thrown by `onProgress` cancels the worker and
is propagated unchanged.

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
