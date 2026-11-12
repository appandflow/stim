# LLP 0014: Native build invocations, artifacts, and signing

**Type:** Decision
**Status:** Active
**Systems:** Builds, Exact, Devices, Metro, EAS, Signing
**Author:** Codex
**Date:** 2026-11-12
**Related:** LLP 0009, LLP 0013

## Use fixed invocations

Do not infer and rebuild commands from project scripts. Bare React Native hosts
Metro from the project's dependencies. Expo runs its fixed start command. iOS
and Android use fixed `xcodebuild` and Gradle arguments. An Exact app builds
with its own `./exact.mjs ios --no-install` (plus `--release` for
`--configuration Release`), with `EXACT_SIM` naming the
workspace's owned simulator, started only once Stim has booted that simulator,
so Exact never boots or shuts it down. Build-only runs, build workers and runs whose
simulator is hosted on another Mac use the same command with no `EXACT_SIM`,
and only for an app whose
`app.json` declares no native modules, because Exact may run code on a
simulator during the build to read an app's native modules.

Stim owns port and device selection, build selectors, and lifecycle cleanup. Fixed calls keep those choices explicit. Exact needs the owned simulator only for a native-module roster read, so it can build without booting a device when the manifest declares no modules. [Exact iOS recipe](https://github.com/appandflow/stim/pull/5397), [Exact build-only support](https://github.com/appandflow/stim/pull/5451).

## Consume an existing EAS build

The explicit `ios|android --eas-profile <name>` path downloads a compatible
completed EAS development build instead of compiling locally. Delegate profile
resolution, fingerprinting and artifact caching to fixed EAS CLI invocations.
Coordinate downloads by EAS project and build ID. A miss prints the EAS build
command; Stim never starts a cloud build. Physical devices use the existing
lease and iOS provisioning gates. EAS device failures print EAS registration
and rebuild remedies; they never register devices or change signing accounts.
Preserve Stim device ownership, Metro and launch semantics.

EAS knows the profile, its resolved environment and the fingerprint of the artifact. Delegating matching to EAS keeps Stim on the same compatibility rules and leaves cloud build creation to the person or pipeline that requested it. [EAS development builds](https://github.com/appandflow/stim/pull/760).

## Select the build and its target

The supported build selectors are `ios --scheme <name>`, `ios --configuration <name>`, and
`android --variant <name>`. `ios --device-type <name>`, `ios --runtime
<version>`, `android --system-image <id>`, and `android --device-profile <id>`
select the model and version of the owned simulator or emulator for one
invocation, overriding `ios.deviceType`, `ios.runtime`, `android.systemImage`,
and `android.deviceProfile`; a name that is not installed refuses with
`STIM_BAD_ARG` and prints the installed names.
`android --device [serial]` and
`ios --device [udid]` select a connected physical device, and take
`--wait <seconds>` or `--no-wait` for the lease on it. Non-Debug iOS
configurations and Android variants ending in `Release` skip Metro.

Target overrides apply to one invocation so a build or simulator selection
does not change the workspace's defaults.

## Release cache hits use current JavaScript

A release
cache hit must inject the current JS into a copy of the artifact. A swap
failure must run a full build; it must never install stale JS. Android swaps
require an emitted-asset manifest match, then `zipalign` before `apksigner`.

A release app has no Metro to supply new JS. Native reuse is only valid if Stim can replace the bundle and assets in a copy and produce an installable artifact. [Android release cache](https://github.com/appandflow/stim/commit/69e8493e389b00e6c084b571cf881f55388fe172).

## Provisioning is an explicit operation

An iOS device build is always signed, Debug included. Before Stim installs or
re-seals a device app, the signing gate reads the bundle's own
`embedded.mobileprovision` and refuses one that is missing, expired, carries
no `ProvisionedDevices` list (App Store and enterprise profiles), or does not
name the target UDID. Stim re-signs only copies it makes, with an identity
present in the keychain: the one the profile's certificate names, or the one
`ios.signingIdentity` pins. A build never passes signing flags to `xcodebuild`,
in particular never `-allowProvisioningUpdates`, because a build must not mutate
an Apple Developer account. Only `stim device provision ios` passes it, after it
lists the account changes and they are confirmed at a prompt or with `--yes`; no
other command calls it. Stim installs only onto a device it drives in this
run: an owned simulator or emulator, a physical device named by `--device`, or
the remote device `--remote` targets. Do not add distribution flows: no store
upload, no TestFlight, no over-the-air install page, no reconstruction of the
project's own delivery pipeline. Archives, `.ipa` export, store signing, and
distribution remain out of scope.

An ordinary build must not create profiles or register devices in an Apple Developer account. The install gate verifies the exact app and hardware, and the separate provisioning command shows account changes before applying them. [Device signing design](../docs/specs/2026-09-01-ios-device-release-design.md), [Explicit provisioning](https://github.com/appandflow/stim/pull/3841).

## Code

- [Exact invocation](../packages/stim-cli/src/integrations/exact-ios.ts), [EAS build selection](../packages/stim-cli/src/engine/eas-build.ts), and [iOS profile validation](../packages/stim-cli/src/engine/ios-profile.ts).
- [Provisioning command](../packages/stim-cli/src/commands/device-provision.ts), [Android artifact path](../packages/stim-cli/src/commands/android/artifact.ts), and [iOS artifact path](../packages/stim-cli/src/commands/ios/artifact.ts).
