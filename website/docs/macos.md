---
title: 'Native macOS prototype'
description: 'Develop an owned Swift Package Debug app in Stim Desktop'
---

import StimTabs from '@site/src/components/StimTabs';
import PromptBox from '@site/src/components/PromptBox';

`stim macos` builds a Swift Package executable in Debug, launches an isolated
copy of it in the background, and shows its window in Stim Desktop. Several
worktrees can run the same app side by side without sharing a bundle ID. If
Stim is not installed globally, replace `stim` with `npx stim`.

<PromptBox
title="Run a Swift Package app"
response={`MyApp built and launched as MyApp · feature-x. Window visible in Stim Desktop. A failed build showed readable compiler errors in stim logs. Stopped.`}

>

{`In my Swift Package app, configure the executable product and a development Info.plist and any macos.resources or macos.assetCatalog for stim macos. Build and show its owned window in Stim Desktop, verify a source edit and readable failed-build logs, then stop only this workspace's app. Do not change permissions or use custom build scripts.`}
</PromptBox>

## Setup

Run from the directory with `Package.swift`, and name the product and a
development plist in `.stim.json`:

```json
{
  "macos": {
    "product": "MyApp",
    "infoPlist": "Support/Info-Development.plist"
  }
}
```

The plist needs `CFBundleIdentifier` and a `CFBundleExecutable` that matches
the product. `macos.resources` and `macos.assetCatalog` add files and an asset
catalog to the bundle.

<StimTabs
code={`stim macos
stim logs --errors
stim stop`}
/>

## What to expect

- Stim signs its copy ad hoc under a bundle ID derived from the workspace. No
  signing account or provisioning setting changes.
- The app launches without taking focus, unless it activates itself.
- Each run stops the previous copy first. `stim stop` and
  `stim worktree remove` stop every copy running from the workspace.
- App output is in `stim logs`. A failed build keeps the compiler output there
  and launches nothing.
- Xcode projects, packaging scripts and release distribution are out of scope.
  `--slot` and `reload` are not supported.

## Watch and control

In Stim Desktop, the app card has **Build and Run**, **Open app** and
**Stop**, with a live preview of the app's front window. Live capture needs
**Screen & System Audio Recording** on the capturing Mac. Control also needs
**Device Control and Data Access**. A [paired phone](./phone-app.md) shows the
window, build status and logs. Native windows have no replay.

An agent can drive the app with
[agent-device](https://github.com/callstack/agent-device) 0.21.23 or later,
using the `bundleId` that `stim macos --json` prints, and its actions show in
`stim logs --source agent`.

## Run it on another Mac

With an approved [remote machine](./remote-machines.md) that has **Run
devices** access:

<StimTabs
code={`stim macos --remote <mac>
stim macos --remote <mac> --remote-build <mac>   # also build there
stim stop`}
/>

A named Mac is strict and never falls back to this one. Building there needs a
separate approval. Set `macos.remote` for a default.

For artifact caching, hosted agent control, resource rules and the
development copy of Stim Desktop itself, run `stim guide macos`.
