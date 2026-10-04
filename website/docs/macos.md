---
title: 'Native macOS prototype'
description: 'Develop an owned Swift Package Debug app in Stim Desktop'
---

import StimTabs from '@site/src/components/StimTabs';

The macOS prototype builds a Swift Package executable in Debug, launches an
isolated development bundle and shows its owned window in Stim Desktop.
It uses fixed SwiftPM commands. Xcode projects, custom packaging scripts,
release distribution and shared artifact caching remain outside
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
Mac. Capture and Open app verify the recorded PID, process start time, bundle ID
and executable. Open app rechecks the captured window and one standard app window, then activates
that owned app for normal native-window input. The captured view is read-only;
background mouse/keyboard relay is not included.

Capture requires existing Screen Recording permission; Open app also requires
existing Accessibility permission. Stim never requests or changes grants. If unavailable, use the normal app window and workspace logs.
Use Refresh preview after the app window opens or is resized to rebind capture. An
unverifiable owner refuses cleanup rather than signalling another app. `stop`
affects only this workspace's recorded app and supervisor.

## Monitor from your phone

Pair the phone with this Mac's stim-server. Native workspaces show the app, build
state and runtime state on Home and in the workspace. Tap the build card for
SwiftPM logs, or the logs card for native runtime output. Metro stays out of this
workflow.

Tap the app tile to view its one visible window. A server advertising
`macos-window` streams that window over the existing authenticated connection with
read access. It verifies the recorded PID, process start time, executable and
bundle before capture and on every frame. The view has no remote input or replay,
and never captures the desktop or another app.

The capture host requires existing Screen Recording permission. When denied, the
viewer names the existing host to allow in **System Settings → Privacy & Security →
Screen & System Audio Recording**; Stim never requests or resets permissions.
Status and logs remain available. Close and reopen the viewer after opening or
resizing the app window.

## Try Stim Desktop itself

The repository's `apps/desktop/.stim.json` selects `StimDesktop`, its development
plist and `--playground`. That Debug entry opens production screens with
in-memory fixtures, without initializing live backends:

<StimTabs code={`cd apps/desktop
stim macos
stim logs --source build
stim stop`} />

Copy this prompt:

> In my Swift Package app, configure the executable product and a development
> Info.plist for `stim macos`. Build and show its owned window in Stim Desktop,
> verify a source edit and readable failed-build logs, then stop only this
> workspace's app. Do not change permissions or use custom build scripts.
