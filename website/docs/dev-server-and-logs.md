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
window after bundle completion. A `pending` observed before that window closes
opts into waiting for `ready`, up to 30 seconds after bundle completion.
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
