---
title: 'EAS development builds'
description: 'Download a compatible EAS build and run it with Stim'
---

import StimTabs from '@site/src/components/StimTabs';
import PromptBox from '@site/src/components/PromptBox';

:::note[Command examples]

Commands use `stim`. If it is not installed globally, replace `stim` with
`npx stim`.

:::

If your Expo project builds with EAS, Stim can download a matching development
build and run it on a simulator, emulator, or connected phone. EAS supplies the
native app; Stim manages the workspace's device, Metro port, installation,
launch checks, and logs. Matching worktrees can reuse the same build while
loading their own JavaScript from Metro.

## Ask your agent

Name the platform and target you want:

<PromptBox
title="Run an EAS development build"
response={`Trailhead launched on stim-trailhead (iPhone 17 / iOS 26.5).
com.appandflow.trailhead · ready · EAS build · errors clean`}

>

{`Run the app on an iOS simulator using an EAS build.`}
</PromptBox>

The response is illustrative. Ask for an Android emulator or connected phone to
change the target. With the Stim skill installed, the agent can inspect
`eas.json` and choose a compatible development profile. If none fits or several
remain plausible, it should ask. You can also name a profile for a specific app
variant. New cloud builds still require your authorization.

## Choose a profile

Install EAS CLI and authenticate with `eas login` or `EXPO_TOKEN`. Your Expo
project needs installed JavaScript dependencies, `expo-dev-client`, and a link
to the intended EAS project in `extra.eas.projectId`. See Expo's
[development build setup](https://docs.expo.dev/develop/development-builds/introduction/?buildenv=build-with-eas)
if these are missing.

The selected `eas.json` profile must resolve to `developmentClient: true` and
`distribution: "internal"`. For example:

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

Use `ios-simulator` for an iOS simulator and `development` for an Android
emulator or a physical device. iOS device profiles must omit `ios.simulator`
or set it to `false`.

Select EAS explicitly with `--eas-profile`. Having an `eas.json` file does not
change Stim's default local build behavior. Profile inheritance and native
fingerprinting use EAS CLI. If the profile overrides `ios.buildConfiguration`,
it must be `Debug`; an `android.gradleCommand` override must assemble a single
Debug APK, such as `:app:assembleDebug`.

## Download and run

<StimTabs
code={`stim start
stim ios --eas-profile ios-simulator
stim logs --errors`}
/>

For Android:

<StimTabs code={`stim android --eas-profile development`} />

Stim finds the latest finished build matching the EAS project, profile, native
fingerprint, platform, and target type. It downloads the `.app` or `.apk`,
installs it, and connects it to this workspace's Metro server. It skips local
native compilation. You still need the [host tools](./requirements.md) to run
the selected simulator, emulator, or phone.

Metro uses your local environment. Set any app-variant or other environment
variables before `stim start`; resolving an EAS profile does not apply its
environment to Metro.

This mode supports development builds. Release builds are not supported:
matching native inputs does not establish that a release build contains the
current workspace's JavaScript. `--scheme`, `--configuration`, `--variant`, and
`--no-build-cache` cannot be combined with `--eas-profile`.

`--eas-profile` selects where the app comes from. The separate `--remote eas`
option selects an [EAS-hosted device](./owned-devices.md#remote-devices), which
has its own session costs.

## When no build matches

Stim stops with `STIM_EAS_BUILD_MISSING` and prints the command for the selected
platform and profile, for example:

```bash
npx eas-cli build --platform ios --profile ios-simulator
```

Cloud builds may incur charges. An agent should run this command only when you
have authorized the build. After it finishes, retry the same Stim command.
Stim never starts a cloud build automatically or falls back to local compilation
in this mode. There is no build-on-miss flag.

Authentication, network, and download failures produce `STIM_EAS_UNAVAILABLE`
with the EAS command to inspect. They do not trigger a build.

## Connected devices

<StimTabs
code={`stim ios --eas-profile development --device
stim android --eas-profile development --device`}
/>

Use the command for your phone's platform. Add its UDID or serial after
`--device` to select a particular phone. The usual
[device selection and lease rules](./commands.md#device-lock-and-device-unlock)
apply.

For iOS, the app must contain a development-client URL scheme and an unexpired
provisioning profile that includes the phone's UDID. Stim installs the signed
app without re-signing it. The phone must be able to reach Metro over the LAN.

If the provisioning profile does not cover the phone, Stim points to EAS CLI:

```bash
npx eas-cli device:create
npx eas-cli build --platform ios --profile development
```

Register the phone if needed, then run the build with authorization for the
cloud build and signing changes. Run EAS interactively so it can refresh the
provisioning profile, then retry the same Stim command. Registration alone does
not update a previously built app. Expo's
[internal distribution guide](https://docs.expo.dev/build/internal-distribution/)
covers device registration and provisioning.

## Cache reuse

EAS CLI caches downloaded, extracted artifacts by project and build ID. Stim
uses that cache directly without storing another copy. Each run still contacts
EAS to find the latest matching build, including rebuilds with updated signing
profiles. Native fingerprint generation uploads fingerprint metadata to EAS;
this path requires EAS access even when the artifact is already on disk.

In JSON output, `cacheHit: "remote"` identifies the EAS build source, including
when EAS CLI reuses its local cache. Stim's `buildCache` and `remoteBuildCache`
settings do not control this cache, and `stim gc` does not clean it.

For reference text matching your installed version, run
`stim guide lifecycle eas`.
