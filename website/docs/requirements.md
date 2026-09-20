---
title: 'Requirements'
sidebar_position: 3
description: 'Local and optional remote requirements'
---

:::note[Command examples]

Commands use `stim`. If it is not installed globally, replace `stim` with
`npx stim`.

:::

## All projects

- Node 22.12.0 or later.
- A project with `expo` or `react-native` in `package.json`.
- Git for `stim worktree` commands.

## iOS

- macOS with Xcode. Local simulator runs also need an installed iOS Simulator
  runtime.
- A compatible Ruby and CocoaPods setup when the project uses pods. Install
  Bundler when the project pins CocoaPods in `Gemfile.lock`.

## Android

- macOS or Linux with the Android SDK.
- For an emulator, an installed Android system image matching the host:
  `arm64-v8a` on ARM64 or `x86_64` on x64.
- A working Java and Gradle setup for the project.
- On Windows, a project root short enough for the NDK's object paths: its
  ninja cannot open a path of 260 characters or more, and a React Native
  codegen object path only fits when CMake can shorten it. `stim doctor
--platform android` reports a root that leaves no room and `stim android`
  refuses it with `STIM_PATH_TOO_LONG` before Gradle runs; `subst X: <root>`
  and working from `X:\` is the usual fix. The check assumes the default native
  staging path and may also refuse a shorter custom `buildStagingDirectory`.

Install the host tools and JavaScript dependencies before building. Stim runs
`pod install` when an iOS project's installed Pods are missing or stale. When
the project pins CocoaPods and Bundler is available, it installs missing bundled
gems and runs `bundle exec pod install`. Run `stim doctor` to check the setup.

## Optional remote devices

- The `proxy` backend needs an Agent Device daemon URL and token.
- The `eas` backend needs the EAS CLI, an authenticated Expo account, and a
  configured EAS project. EAS simulator use can be billable.

## EAS development builds

`--eas-profile` needs EAS CLI, an authenticated Expo account, and a linked Expo
project with an internal development profile. It downloads an existing build
and skips local native compilation, so CocoaPods and Gradle compilation setup
are not needed for this path. Keep the host tools needed to run the selected
device: Xcode and an installed runtime for a local iOS simulator, or the Android
SDK and system image for an emulator. See [EAS development builds](./eas-builds.md)
for setup and connected-device requirements.
