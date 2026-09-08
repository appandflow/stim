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

### Optional app-declared readiness

If your app already uses Sentry or Expo Observe, use its readiness API to
record when the initial screen becomes usable. Neither SDK is required by
Stim, and no additional Stim package is needed.

**Current Stim support:** these APIs report readiness to their SDK, not to Stim. Stim does not currently
consume their readiness metrics or extend its launch wait when either SDK is
installed. Keep verifying the expected UI on the reported device; a successful
launch summary is not a full-render guarantee.

**Expo Observe:** after configuring the SDK and wrapping your root with
`ObserveRoot`, call `markInteractive()` from `useObserve()` when the screen is
ready (SDK 56 and later):

```tsx
const { markInteractive } = useObserve();

useEffect(() => {
  if (isReady) markInteractive();
}, [isReady, markInteractive]);
```

Import `useObserve` from `expo-observe` and `useEffect` from `react`. Follow
the [Expo Observe setup guide](https://docs.expo.dev/eas/observe/get-started/)
for SDK 55's API and the complete integration. Metrics are not dispatched from
debug builds by default; use Expo's development configuration when validating
SDK reporting, rather than interpreting missing metrics as a launch failure.

**Sentry:** with your existing tracing and navigation integration configured,
render its full-display marker in the screen:

```tsx
<Sentry.TimeToFullDisplay record={isReady} />
```

Import Sentry with `import * as Sentry from '@sentry/react-native'`. SDK
versions that expose `Sentry.reportFullyDisplayed()` also support an imperative
call. Follow [Sentry's Time to Display guide](https://docs.sentry.io/platforms/react-native/tracing/instrumentation/time-to-display/)
for the required instrumentation and version-specific API.

Choose `isReady` based on usable content, completed essential initialization,
and a dismissed splash screen, not just a mounted root or a live native
process. Cover each launch destination, including login, onboarding, and deep
links. Do not report success from a cleanup or `finally` block after a startup
error.

On Android, the platform's first-frame signal is not the same as
[`reportFullyDrawn()`](https://developer.android.com/topic/performance/vitals/launch-time),
which needs an explicit call. Do not assume a similarly named SDK API emits
that Android signal. On iOS, Apple's standard launch measurement ends at the
first frame; later preparation can use
[custom signposts](https://developer.apple.com/documentation/xcode/reducing-your-app-s-launch-time).
Neither first-frame measurement proves that React content is interactive.

An app can fail before sending a readiness marker while its native process
remains alive. Inspect captured errors independently. An absent marker can
also mean disabled instrumentation or a reporting deadline, so absence alone
does not establish a crash or a successful launch.

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
