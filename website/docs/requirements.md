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

- Node 22.12.0 or later. Node 20 is no longer supported.
- A project with `expo` or `react-native` in `package.json`.
- Git for `stim worktree` commands.
- macOS, Linux or Windows. What each host can run is listed below.

## iOS

- Local builds and simulators need macOS with Xcode. Local simulator runs also
  need an installed iOS Simulator runtime.
- A compatible Ruby and CocoaPods setup when the project uses pods. Install
  Bundler when the project pins CocoaPods in `Gemfile.lock`.
- From Linux or Windows, iOS runs through an EAS build and an EAS Simulator
  session: `stim ios --remote eas --eas-profile <profile>`. See
  [From Windows or Linux](./owned-devices.md#from-windows-or-linux).

## Android

- macOS, Linux or Windows with the Android SDK. Stim reads its location from
  `ANDROID_HOME`, then `ANDROID_SDK_ROOT`, then `~/Library/Android/sdk` (the
  macOS Android Studio default) or `%LOCALAPPDATA%\Android\Sdk` on Windows, and
  passes that path to Gradle as `ANDROID_HOME` when neither variable is set.
  On Linux, set `ANDROID_HOME`.
  With no SDK there and no `android/local.properties`, `stim doctor --platform
android` reports it and `stim android` refuses with `STIM_BUILD_FAILED`
  before Gradle runs.
- For an emulator, an installed Android system image matching the host:
  `arm64-v8a` on ARM64 or `x86_64` on x64.
- A working Java and Gradle setup for the project.
- On Windows, a project root short enough for the NDK's object paths: its
  ninja cannot open a path of 260 characters or more, and a React Native
  codegen object path only fits when CMake can shorten it. `stim doctor
--platform android` reports a root that leaves no room and `stim android`
  refuses it with `STIM_PATH_TOO_LONG` before Gradle runs; `subst X: "<root>"`
  and working from `X:\` is the usual fix. The check assumes the default native
  staging path and may also refuse a shorter custom `buildStagingDirectory`.

## Windows

The Android loop runs on Windows: owned emulators, builds, install, launch,
logs, worktrees and caches. iOS can run through `--remote eas`; there
is no local Xcode path. Requirements on top of the Android list:

- Windows 10 or 11 with PowerShell 7 or cmd.exe to run Stim. Windows PowerShell
  (`powershell.exe`) must also be on `PATH` for background processes and emulator
  cleanup. Stim resolves `.cmd` and `.bat` tools itself.
- Git for Windows. Stim passes `core.longpaths` to the git commands that need
  it; your global configuration is not changed.
- Emulator acceleration: WHPX (Windows Hypervisor Platform) or the Android
  Emulator hypervisor driver. `emulator -accel-check` reports which is active.
- JDK 17 on `JAVA_HOME` or `PATH`.
- A short project path or a `subst` drive, as described in the Android path
  requirement above.

On Windows, `stim doctor --platform android` checks path room, and `stim doctor
--platform ios` points at `--remote eas` for iOS.

Install the host tools and JavaScript dependencies before building. Stim runs
`pod install` when an iOS project's installed Pods are missing or stale. When
the project pins CocoaPods and Bundler is available, it installs missing bundled
gems and runs `bundle exec pod install`. Run `stim doctor` to check the setup.

## Web

`stim web` needs Google Chrome or Chromium. On macOS Stim looks in
`/Applications` and `~/Applications`; elsewhere it looks for `google-chrome`,
`google-chrome-stable`, `chromium` or `chromium-browser` on `PATH`, and on
Windows in Program Files. Stim never installs a browser. Expo web also needs
`react-dom`, `react-native-web` and `@expo/metro-runtime`.

## Optional remote devices

- The `proxy` backend needs an Agent Device daemon URL and token.
- The `eas` backend needs EAS CLI 21.6.0 or later, an authenticated Expo
  account, and a configured EAS project. EAS simulator use can be billable.

## EAS development builds

`--eas-profile` needs EAS CLI 18.9.0 or later, an authenticated Expo account, and a linked Expo
project with an internal development profile. It downloads an existing build
and skips local native compilation, so CocoaPods and Gradle compilation setup
are not needed for this path. Keep the host tools needed to run the selected
device: Xcode and an installed runtime for a local iOS simulator, or the Android
SDK and system image for an emulator. See [EAS development builds](./eas-builds.md)
for setup and connected-device requirements.
