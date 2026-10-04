---
title: 'Native macOS prototype'
description: 'Develop an owned Swift Package Debug app in Stim Desktop'
---

import StimTabs from '@site/src/components/StimTabs';

The macOS prototype builds a Swift Package executable in Debug, launches an
isolated development bundle and shows its owned window in Stim Desktop.
It uses fixed SwiftPM commands. Xcode projects, custom packaging scripts,
release distribution, shared artifact caching and remote viewing remain outside
this slice. If Stim is not installed globally, replace `stim` with `npx stim`.

Run from the directory containing `Package.swift`. Set an explicit executable
product and development plist in `.stim.json`:

```json
{
  "macos": {
    "product": "MyApp",
    "infoPlist": "Support/Info-Development.plist"
  }
}
```

The plist contains `CFBundleIdentifier` and `CFBundleExecutable`, with the latter
matching the selected product. Use development metadata without shared URL
schemes or an update feed. Optional `macos.arguments` is a string array passed
directly to the executable. Stim copies the Debug executable, built frameworks
and SwiftPM resource bundles into its runtime area, derives a unique bundle ID
from the workspace and signs that copy ad hoc. Extra application assets are not
copied, and no signing account or provisioning settings change.

<StimTabs
code={`stim macos
stim status --json
stim logs --source build
stim logs --errors
stim stop`}
/>

Each `macos` run stops the previous owned app and rebuilds using that workspace's
incremental outputs. It does not start Metro. A failed build keeps the compiler
output in workspace logs and does not launch an app. Runtime stdout and stderr
are client logs; unexpected exits are errors. `macos --json` prints one launch
record on stdout, with progress on stderr. `status --json` reports
`environments[].macos`, its build and process state. This command does not
support `--plan`, `--slot` or `reload`.

Stim Desktop offers **Build and run**, **Refresh preview**, **Open app** and **Stop** on the
workspace's app card. This prototype supports one visible main window, on the same
Mac. Contained utility windows are supported; separate app windows refuse capture.
A viewer does not capture its own process recursively. Capture and Open app verify the recorded PID, process start time, bundle ID
and executable. Open app rechecks the captured window and one standard app window, then activates
that owned app for normal native-window input. The captured view is read-only;
background mouse/keyboard relay is not included.

Capture requires existing Screen Recording permission; Open app also requires
existing Accessibility permission. Stim never requests or changes grants. If unavailable, use the normal app window and workspace logs.
Use Refresh preview after the app window opens or is resized to rebind capture. An
unverifiable owner refuses cleanup rather than signalling another app. `stop`
affects only this workspace's recorded app and supervisor.

## Try Stim Desktop itself

The repository's `apps/desktop/.stim.json` launches the full `StimDesktop` app
as **Stim Development**. It monitors your regular Stim home alongside the
installed app, with a workspace-specific bundle ID and separate preferences.
Automatic cleanup and notification alerts are disabled for this development copy. **Window > SwiftUI
Playground** still opens the in-memory production screen fixtures.

<StimTabs code={`cd apps/desktop
stim macos
stim logs --source build
stim stop`} />

For an unreleased CLI, run `pnpm run build` at the repository root first. Set
`STIM_BIN` to the absolute `packages/stim-cli/dist/cli.mjs` path and run that
executable's `macos` command from `apps/desktop`. The development app inherits
the override without changing the installed app's CLI preference or restarting
its server.

Copy this prompt:

> In my Swift Package app, configure the executable product and a development
> Info.plist for `stim macos`. Build and show its owned window in Stim Desktop,
> verify a source edit and readable failed-build logs, then stop only this
> workspace's app. Do not change permissions or use custom build scripts.
