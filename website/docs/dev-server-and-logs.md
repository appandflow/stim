---
title: 'Dev server and logs'
sidebar_position: 4
description: 'A supervised Metro server and a queryable launch timeline'
---

import StimTabs from '@site/src/components/StimTabs';

Commands use `stim`. If it is not installed globally, replace `stim` with
`npx stim-cli`.

`stim start` reserves a port for the workspace and starts its React Native or
Expo dev server under a detached supervisor. The command exits only after the
server answers and Stim verifies its project identity.

Bare React Native runs Metro in the supervisor. Expo runs the project's Expo CLI
as a supervised child. A healthy server that another process started for the
same project can be reused, but Stim cannot capture its full output.

## Launch readiness

`stim ios` and `stim android` open the installed app, then check launch
evidence. Debug runs observe Metro; when bundling finishes within the wait
window, Stim also observes three seconds of launch logs. The summary can report
that bundling is still in progress or that launch is unverified. Release runs
check process liveness without Metro.

Stim reports bundle, red-screen, and fatal launch errors when those signals are
available. These checks do not prove that a screen rendered correctly.

A nonfatal error still appears as launch evidence. The agent can read the error
and decide whether the change caused it.

The human launch summary and `logs --errors` show up to **10 frames per error,
component, or native stack**. App-source frames take priority over dependencies;
selected frames remain in captured order, followed by the omitted-frame count.
Error stacks describe the call path; component stacks describe the React parent
tree. They are labeled separately. Full captured detail remains available through
`stim logs --source all`; add `--json` for raw records.

Symbolication is best effort. In development, Stim asks the verified workspace's
Metro `/symbolicate` endpoint to resolve captured JavaScript coordinates, with a
short timeout and the original coordinates as fallback. Resolved launch context
is saved separately so it remains readable after Metro stops. Expo's printed source
excerpt and Call Stack are included when available. Uncorrelated bare React Native
symbolication events remain explicitly separate context. Shortened bundle locations
are labeled **unsymbolicated**, and a component stack is never used
to invent a missing error stack. OS logging can truncate text before Stim captures
it; “full” means the records actually captured, not a recovered original stack.

Copies from different sources are combined only when their error title, stack
location, platform compatibility, and timing match. Raw copies remain available
with `--json`; repeated errors from the same source are not suppressed.
Human queries can add a correlated device component stack to a selected Metro
error; unrelated device errors are never added as context.

#### Native crashes

On iOS simulators, Stim attaches stdout/stderr on a cold launch and passes Expo's
initial project URL directly, so
an early Swift fatal error or uncaught exception can appear in the launch result.
Console redirection uses the app's writable cache, including when `STIM_HOME` is
on an external volume; captured crash evidence is retained in the workspace logs.
OS crash reports can arrive later: rerunning `stim logs --errors` collects them.
Reports are matched to the app, simulator, and launch time. Existing source locations
and symbol names are retained, and app addresses are resolved with
`atos` only when the local binary's UUID matches the report. Android reads the
crash logcat buffer, including reports emitted outside the dead app's PID. Java
exceptions retain their stack; C/C++ frames use matching local ELF build IDs and
NDK tools where available. Unavailable symbols remain explicitly unresolved.
Android can keep a crashed Java process alive behind its system crash dialog.
Stim treats the crash report as failure even when the PID exists. Follow the
printed app-scoped force-stop command after fixing the error, then rerun `stim android`.

Confirmed app-crash reports are included in default `stim logs --errors` without
including general OS error noise. Use `stim logs --source device --json` for full
captured reports. A missing report is not proof that the app did not crash: OS
reports can be delayed, physical iPhone capture is console-only, and stripped or
remote builds may not have matching local debug symbols. This does not download
symbols or replace Xcode/Android Studio's full crash-analysis tooling.

For delayed reports, rerun `stim logs --errors` before stopping or releasing the
device. Collection requires the workspace's current launch and device ownership
or lease; after release, already-captured reports remain available without
collecting another workspace's crashes.

Non-follow human queries enrich errors; `--follow` streams captured records and
does not continuously poll OS crash reports. `--json` preserves raw evidence.
Stim does not resymbolicate an older error after a recorded Metro rebuild.
Historical unsymbolicated JS coordinates require
the matching bundle/source maps, not an unrelated rebuilt Metro bundle.

### Optional app-declared readiness

No package or monitoring SDK is required. In a debug app, emit this once at
startup, before initialization that can block the first screen:

```ts
if (__DEV__) console.info('[stim:readiness] pending');
```

Emit the second line when essential initialization succeeds, usable content is
rendered, and the splash screen is hidden:

```ts
if (__DEV__) console.info('[stim:readiness] ready');
```

For example, in an Expo root layout with an existing `isReady` state:

```tsx
import { useEffect } from 'react';
import * as SplashScreen from 'expo-splash-screen';

if (__DEV__) console.info('[stim:readiness] pending');

// Inside the root component:
useEffect(() => {
  if (!isReady) return;
  let active = true;
  SplashScreen.hideAsync()
    .then(() => {
      if (active && __DEV__) console.info('[stim:readiness] ready');
    })
    .catch(console.error);
  return () => {
    active = false;
  };
}, [isReady]);
```

Use the app's real readiness condition, not an arbitrary timer or merely a
mounted root. Cover login, onboarding, and deep-link destinations. Never emit
`ready` from a failure handler or a `finally` block.

Static imports run before module-scope statements. To cover initialization in
imported modules, emit `pending` from an earlier app entry module before loading
that work. An error before `pending` still uses the default check.

Without an observed `pending`, Stim keeps its default three-second stability
window after bundle delivery. Managed Metro servers report when the native
bundle response finishes; build-complete output alone does not close an observed
request. Without response capture, Stim falls back to the build-complete marker.
When Android reports queued JavaScript loading, Stim waits for device JavaScript
activity before starting stability, bounded by the bundle timeout.
A `pending` observed before that window closes opts into waiting for `ready`, up
to 30 seconds after the same completion signal.
Repeated `pending` logs do not extend the deadline. A matching `ready` can end
the wait early; an app error or process exit interrupts it. A missing `ready`
prints **readiness not confirmed**, not success or an inferred crash.

Stim reads exact standalone messages from this app's platform-specific device
log, after the current launch. Stale, other-platform, error-level, and embedded
example messages are ignored. Unlabelled shared Metro output cannot identify
which platform is ready. If device-log capture is unavailable or `pending` is
not captured in time, the default check applies. Release runs and
`--no-metro-check` do not use this debug-only integration.

This is the app declaring readiness, not visual verification. It does not alter
the `launched` JSON field: bundle/process evidence remains separate. Continue
checking the expected UI and `stim logs --errors`. For agent implementation
instructions, run `stim guide lifecycle readiness`.

#### Ask your agent to add it

Copy this prompt into your coding agent:

```text
Add optional Stim app-readiness logs to this app. Read `stim guide agent`,
then follow `stim guide lifecycle readiness` from the installed CLI. If Stim
is not installed globally, use `npx stim-cli` instead of `stim`.

Use the app's existing initialization and splash-screen lifecycle without
adding a package or monitoring SDK. Cover its real startup destinations,
including login, onboarding, and deep links; never report ready after failure.

Verify a normal launch, a slow successful launch, a missing ready signal, and
a startup error on the supported platforms. Remove temporary test delays and
errors afterward. Report the changes, observed readiness output, and any
validation you could not complete.
```

## Query the timeline

<StimTabs
code={`stim logs --errors
stim logs --source client --since 5m
stim logs --follow --level warn
stim logs --errors --json`}
/>

The merged timeline includes Metro, client, device, and build records. Logs live
in the global workspace directory under `$STIM_HOME/workspaces`, not in the
project checkout.

Exit code 0 means the query succeeded, including when it prints errors. A clean
`stim logs --errors` check requires exit code 0 and no matching errors in the
captured logs. Human mode prints `No matching log records` on stderr for zero
matches; JSON mode writes NDJSON and writes zero bytes for zero matches. An
empty result does not prove launch or log capture succeeded: a workspace with
no log directory also returns an empty result.

`stim stop` ends the supervisor and log collectors. It also frees the reserved
port and shuts down the owned local device.
