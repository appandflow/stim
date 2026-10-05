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
Mac. Contained utility windows are supported; separate app windows refuse capture.
A viewer does not capture its own process recursively. Capture and Open app verify the recorded PID, process start time, bundle ID
and executable. Open app rechecks the captured window and one standard app window, then activates
that owned app for normal native-window input. The captured view is read-only;
background mouse/keyboard relay is not included.

Capture requires existing Screen Recording permission; Open app also requires
Accessibility permission. The first native viewer opening shows one Desktop setup screen for both permissions, with status, **Request permissions**, **Settings** and **Check again**. Approve the normal macOS requests; Stim never resets or automatically grants access. **Permissions** on the app card reopens setup. Builds never prompt. If unavailable, use the normal app window and workspace logs.
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
bundle before capture and on every frame. The view has no replay and never captures the desktop or another app.

The capture host requires existing Screen Recording permission. When denied, the
viewer names the existing host to allow in **System Settings → Privacy & Security →
Screen & System Audio Recording**. Open **Permissions** in Stim Desktop on that Mac to request both grants, then reconnect the phone viewer. A phone-first native view asks the running Desktop host to show the same setup. A server started outside Desktop uses that launching host's permissions, so granting this copy of Stim may not apply to it. The phone and server never request or reset permissions.
Status and logs remain available. Close and reopen the viewer after opening or
resizing the app window.

With `macos-window-control` and a control pairing, tap **Control** for clicks,
drags, printable ASCII typing and Tab, Escape, Select all, Undo and Save.
Toggle **Scroll** to scroll with a drag. Each action rechecks the exact owned
process and the same single standard window; modal or disjoint windows, changed
capture or resize refuse input. Contained nonmodal auxiliaries are allowed; only
the focused captured main receives input. The server holds one exclusive session per app, ending
on disconnect, revocation, takeover or five idle minutes, without a CLI device
lock. Existing **Accessibility** permission is required. Stim never requests
or resets permissions. An input refusal ends Control with its reason while
viewing and logs remain usable; older servers stay view-only.

Native Control uses dynamically resolved private CoreGraphics input SPI in the
server helper, outside the phone and Mac App Store app binaries. macOS updates
can make it unavailable; then Control refuses while viewing and logs remain
available.

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
