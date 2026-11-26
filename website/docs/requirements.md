---
title: 'Requirements'
sidebar_position: 3
description: 'What each platform needs before Stim can build and run it'
---

:::note[Command examples]

Commands use `stim`. If it is not installed globally, replace `stim` with
`npx stim`.

:::

Run `stim doctor` after installing: it checks this list for your project and
says what is missing.

## All projects

- Node 22.12.0 or later.
- A project with `expo` or `react-native` in `package.json`.
- Git, for worktrees.
- macOS, Linux or Windows. What each host can run is below.

## Projects that pin an older Node {/* #older-node-pins */}

A version manager (asdf, mise, Volta, or nvm and fnm with a `cd` hook) can make
the project's older Node run Stim. Stim then refuses with
`STIM_NODE_UNSUPPORTED`. Run that command with a supported Node:

```bash
ASDF_NODEJS_VERSION=<version> stim <command>
mise exec node@<version> -- stim <command>
volta run --node <version> stim <command>
fnm exec --using=<version> stim <command>
nvm exec --silent <version> stim <command>
```

`<version>` is 22.12.0 or later. asdf, mise, fnm and nvm keep global packages
per Node version, so use the version you installed Stim under, or install Stim
again under a supported one. The tools Stim starts inherit the override.

## iOS

- Local builds and simulators need macOS, Xcode and an installed iOS Simulator
  runtime.
- Ruby and CocoaPods when the project uses pods, and Bundler when
  `Gemfile.lock` pins CocoaPods. Stim runs `pod install` itself when Pods are
  missing or stale.
- From Linux or Windows: build and run on a paired Mac
  (`stim ios --remote <mac> --remote-build <mac>`, see
  [remote machines](./remote-machines.md)), or on an EAS build and EAS
  Simulator (`stim ios --remote eas --eas-profile <profile>`), which can be
  billable.

## Android

- macOS, Linux or Windows with the Android SDK. Stim finds it through
  `ANDROID_HOME`, `ANDROID_SDK_ROOT` or Android Studio's default location.
- A working Java and Gradle setup for the project.
- An emulator system image for the host (`arm64-v8a` or `x86_64`). When none is
  installed, `stim android` installs one with `sdkmanager`, which needs the SDK
  licenses accepted (`sdkmanager --licenses`) and 8 GB free.
- Without a JDK or SDK here, build and run on a paired machine:
  `stim android --remote <machine> --remote-build <machine>`.

## Windows

The Android loop runs on Windows. iOS runs only through `--remote eas` or a
paired Mac. On top of the Android list:

- Windows 10 or 11, PowerShell 7 or cmd.exe, and Windows PowerShell
  (`powershell.exe`) on `PATH`.
- Git for Windows.
- Emulator acceleration: WHPX or the Android Emulator hypervisor driver.
- JDK 17 on `JAVA_HOME` or `PATH`.
- A short project path such as `C:\src\<name>`. The NDK cannot open paths of
  260 characters or more, so a long root fails. `stim doctor --platform android`
  checks it and `stim android` refuses with `STIM_PATH_TOO_LONG`. A `subst`
  drive does not help.

## Web

`stim web` needs Google Chrome or Chromium. Stim never installs a browser.
Expo web also needs `react-dom`, `react-native-web` and `@expo/metro-runtime`.

## Optional remote devices and EAS

- The `proxy` backend needs an Agent Device daemon URL and token.
- The `eas` backend needs EAS CLI 21.6.0 or later (22.2.0 for
  `stim ios --device-type`), a signed-in Expo account and a configured EAS
  project. EAS Simulator sessions can be billable.
- `--eas-profile` needs EAS CLI 18.9.0 or later, a signed-in Expo account and a
  linked project with an internal development profile. It downloads a build, so
  CocoaPods and Gradle setup are not needed, but you still need the simulator or
  emulator tools. See [EAS development builds](./eas-builds.md).
