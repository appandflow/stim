---
title: 'EAS development builds'
description: 'Download a matching EAS development build and run it with Stim'
---

import StimTabs from '@site/src/components/StimTabs';
import PromptBox from '@site/src/components/PromptBox';

:::note[Command examples]

Commands use `stim`. If it is not installed globally, replace `stim` with
`npx stim`.

:::

If your Expo project builds with EAS, Stim downloads a matching development
build and runs it on a simulator, emulator or connected phone. Nothing compiles
on your machine. Each worktree still loads its own JavaScript from its own
Metro.

<PromptBox
title="Run an EAS development build"
response={`Trailhead launched on stim-trailhead (iPhone 17 / iOS 26.5).
com.appandflow.trailhead · ready · EAS build · errors clean`}

>

{`Run the app on an iOS simulator using an EAS build.`}
</PromptBox>

Ask for an Android emulator or a connected phone to change the target. The
agent reads `eas.json` and picks a compatible development profile, or asks you
when none fits or several do. Name a profile yourself for a specific app
variant.

## Cost

- Downloading an existing build costs nothing extra.
- When no build matches, Stim stops with `STIM_EAS_BUILD_MISSING` and prints
  the build command, for example
  `npx eas-cli build --platform ios --profile ios-simulator`. A cloud build may
  be billed. Stim never starts one itself and never falls back to a local
  build. The agent runs that command only when you authorize it.
- `--remote eas` is a different feature: it runs the app on an
  [EAS-hosted simulator](./owned-devices.md). That session is
  billable while it runs. EAS stops it after `remote.easMaxDurationMinutes`
  (30 by default), and `stim stop`, `stim worktree remove` and `stim gc` end
  sessions Stim created. `stim status` lists each running session.

## Set up the project

You need EAS CLI 18.9.0 or later, logged in with `eas login` or `EXPO_TOKEN`,
`expo-dev-client`, and the app linked to its EAS project
(`extra.eas.projectId`). See Expo's
[development build setup](https://docs.expo.dev/develop/development-builds/introduction/?buildenv=build-with-eas).

The profile must resolve to `developmentClient: true` and
`distribution: "internal"`. iOS simulator profiles set `ios.simulator: true`;
device profiles omit it:

```json title="eas.json"
{
  "build": {
    "development": {
      "developmentClient": true,
      "distribution": "internal"
    },
    "ios-simulator": {
      "extends": "development",
      "ios": { "simulator": true }
    }
  }
}
```

Having `eas.json` does not change anything. Stim uses EAS only when the command
names a profile:

<StimTabs
code={`stim ios --eas-profile ios-simulator
stim android --eas-profile development
stim ios --eas-profile development --device`}
/>

## Limits

- Development builds only. Release builds are not supported.
- `--scheme`, `--configuration`, `--variant` and `--no-build-cache` cannot be
  combined with `--eas-profile`.
- Metro uses your local environment, not the profile's. Set app-variant
  variables before `stim start`.
- Every run contacts EAS to find the latest matching build, so it needs
  network access even when the artifact is already downloaded. Fingerprinting
  uploads fingerprint metadata to EAS.
- EAS CLI keeps its own download cache. Stim's cache settings and `stim gc` do
  not touch it.
- On an iPhone, the build's provisioning profile must include the phone. If it
  does not, the remedy points to `npx eas-cli device:create` and a new build.
  See Expo's [internal distribution guide](https://docs.expo.dev/build/internal-distribution/).

The agent gets the full profile rules and remedies from
`stim guide lifecycle eas`.
