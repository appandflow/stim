---
title: 'Native macOS prototype'
description: 'Develop an owned Swift Package Debug app in Stim Desktop'
---

import StimTabs from '@site/src/components/StimTabs';

The macOS prototype builds a Swift Package executable in Debug, launches an
isolated development bundle and shows its owned window in Stim Desktop.
It uses fixed SwiftPM commands. Xcode projects, custom packaging scripts,
release distribution and artifact caching remain outside
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

SwiftPM scratch outputs and dependencies in `macos/build`, the staged
`macos/<Product>.app` and interrupted-build `macos/staging-*` directories can
use substantial disk space under `$STIM_HOME/workspaces/<id>/`. Clear them
with `stim gc --delete --cache workspaces` after stopping the app. Running,
building, unverified and hosted macOS apps keep their workspace untouched.
Runtime locks, state, logs and the project's own `.build` stay; the next
`stim macos` performs a full Swift build and restages the app.

`offload.mode` also places these SwiftPM Debug builds: `auto` builds here while
this Mac has capacity, `force` uses an approved build machine when one accepts,
and `off` always builds here. Configure `offload.machines` and approve build
access as described in [settings](./settings.md). The worker needs matching Stim,
CPU architecture, Xcode and macOS SDK, and network access to fetch package
dependencies the first time. It keeps SwiftPM dependencies per client and
incremental outputs per repository; macOS artifacts are not cached. It runs no
JavaScript install, prebuild or pod install for this job. It receives the files
git lists (tracked and untracked, not ignored), so a build input that is
gitignored is missing there.

Stim validates the development plist before asking a machine and verifies the
returned archive digest, bundle ID, executable and ad hoc signature before
replacing the bundle. Every offload failure falls back locally, including in
`force` mode; failed staging preserves the previous bundle. The app launches
locally with the same supervisor and ownership checks. The build record carries
`offloadedTo` for a remote build or `offloadFallback` for a fallback, and build
logs show placement and its reason.

Stim Desktop offers **Build and run**, **Refresh preview**, **Open app** and **Stop** on the
workspace's app card. The preview follows the app's front standard window, its
main window with any attached sheet, as the app opens, switches, closes or resizes
windows. It never captures another process's windows, menus or the desktop. Without
**Device Control and Data Access** permission Stim cannot tell which window is in
front, so the preview shows only an app whose one window contains the others.
A viewer does not capture its own process recursively. Capture and Open app verify the recorded PID, process start time, bundle ID
and executable. Open app rechecks that the captured window is still the app's front window, then activates
that owned app for normal native-window input. The captured view is read-only;
background mouse/keyboard relay is not included.

Capture requires existing **Screen & System Audio Recording** permission (**Screen Recording** on macOS 14);
Open app also requires **Device Control and Data Access** permission (**Accessibility** on macOS 26 and earlier).
The first native viewer opening shows one Desktop setup screen for both permissions, named for your macOS version, with status, **Request permissions**, **Settings** and **Check again**. Approve the normal macOS requests; Stim never resets or automatically grants access. **Permissions** on the app card reopens setup. Builds never prompt. If unavailable, use the normal app window and workspace logs.
An
unverifiable owner refuses cleanup rather than signalling another app. `stop`
affects only this workspace's recorded app and supervisor.

## Monitor from your phone

Pair the phone with this Mac's stim-server. Native workspaces show the app, build
state and runtime state on Home and in the workspace. Tap the build card for
SwiftPM logs, or the logs card for native runtime output. Metro stays out of this
workflow.

Tap the app tile to view the app's front window. A server advertising
`macos-window` streams that window over the existing authenticated connection with
read access. It verifies the recorded PID, process start time, executable and
bundle before capture and on every frame. The view has no replay and never captures the desktop or another app.
It follows the app's front standard window like the Desktop preview. After the app
closes its last window the view reports a delay until another opens. A server advertising `macos-windows` also
names the captured window and the app's other windows.

The capture host requires existing **Screen & System Audio Recording** permission
(**Screen Recording** on macOS 14). When denied, the viewer names the existing host
to allow in **System Settings → Privacy & Security → Screen & System Audio Recording**. Open **Permissions** in Stim Desktop on that Mac to request both grants, then reconnect the phone viewer. A phone-first native view asks the running Desktop host to show the same setup. A server started outside Desktop uses that launching host's permissions, so granting this copy of Stim may not apply to it. The phone and server never request or reset permissions.
Status and logs remain available.

With `macos-window-control` and a control pairing, tap **Control** for clicks,
drags and printable ASCII typing. The main bar offers **Keyboard** and **Scroll**;
Scroll turns a drag into scrolling. Keyboard attaches one compact scrolling row
with modifier glyphs, navigation keys and shortcut icons over an iOS material
backdrop, with a translucent fallback elsewhere. Every control keeps its accessible name.
Shift, Control, Option and Command apply to the next supported key and then
clear; dismissing the keyboard also clears them.

This requires a newly built phone client with Keyboard Controller, rather than
an update to an older binary. A server advertising `macos-keyboard-extended`
accepts modified letters `a-z` and digits `0-9` one at a time. Older servers keep
fixed shortcuts and navigation; the phone explains when a server update is
needed. Modified multi-character input and symbols are unsupported.

Letter and digit shortcuts require the **owned app's U.S. or ABC keyboard layout**.
Stim focuses that app and waits up to one second for activation before checking
the layout. If it does not activate, the shortcut is refused.
Native virtual key codes identify physical U.S. positions; another host layout
could turn a shortcut into a different command. The helper refuses letter and
digit key events on other layouts; ordinary typing and navigation still work.
[#2422](https://github.com/appandflow/stim/issues/2422) tracks logical shortcuts for other host layouts.

Each action rechecks the exact owned
process and that the captured window is still the app's front standard window. The
app's other windows are allowed; input goes to the captured window, and a sheet
attached to it takes focus and pointer input. Input that arrives while the view
moves to another window is dropped and Control continues. A modal dialog window
refuses input. A sheet larger than the captured window is not supported.
The server holds one exclusive session per app, ending
on disconnect, revocation, takeover or five idle minutes, without a CLI device
lock. Existing **Device Control and Data Access** permission (**Accessibility** on
macOS 26 and earlier) is required. Stim never requests
or resets permissions. An input refusal ends Control with its reason while
viewing and logs remain usable; older servers stay view-only.

Native Control uses dynamically resolved private CoreGraphics input SPI in the
server helper, outside the phone and Mac App Store app binaries. macOS updates
can make it unavailable; then Control refuses while viewing and logs remain
available.

## Run it on another Mac

`stim macos --host <machine>` builds the Debug app on this Mac and runs it on
another Mac over your tailnet, without SSH. List that Mac in
[`hosting.machines`](./settings.md#machine-settings) and run `stim doctor --fix`;
a person on that Mac approves the request with
`stim-server devices grant <id> --device-host`, then run `stim doctor` once more.
Stim connects only to the Mac's pinned tailnet node. If the host refuses or is
unreachable, the command fails; it never launches the app locally instead.

Phones and Stim Desktop view and control the hosted app through this Mac's
stim-server, which relays to the host. The phone sends clicks, scrolls,
text and keys; Stim Desktop's Control sends clicks, drags and typed text.

<StimTabs
code={`stim macos --host janics-mac-mini
stim macos --host janics-mac-mini --json
stim status --json
stim stop`}
/>

The copied bundle keeps its own `CFBundleIdentifier`. The host runs it as
`<id>.hosted<slot>` from a fixed pool of slots, so its bundle ID stays the same
across rebuilds. Whether macOS keeps the permissions the hosted app asks for itself
also depends on how the host signs it.
Running the command again reuses the session and delivers a new copy.
`macos.arguments` are passed to the hosted launch as plain arguments, without
environment injection: at most 32 arguments, 1024 characters each and 8192
characters total. Empty strings are allowed; NUL, CR and LF are refused. Values
are stored in the host's app receipt and visible in process listings, so do not
put secrets there. Older hosts ignore them and Stim warns to update `stim-server`
on the host. `status --json` reports the host's applied arguments under
`environments[].macos.arguments`.

While the app runs on a host, a local `stim macos` refuses, and so does `--host`
with another machine, until
`stim stop`. `stim stop` and `stim worktree remove` stop the session on the host and
wait for it to confirm. When the host cannot be reached, the placement stays
recorded so a later `stim stop` can finish.

To view or control the hosted app from a phone, grant Screen & System Audio Recording
and Device Control and Data Access (**Accessibility** on macOS 26 and earlier) once to
the app that runs stim-server on the host, not to the hosted app.
`stim-server service install` runs the server under the Stim Host app and shows
macOS's own requests on that Mac's screen, one at a time. Stim Host keeps
running after install returns, asks for Device Control and Data Access once the
Screen & System Audio Recording request is answered, and opens that pane with
Stim Host listed when macOS shows no request for it. A person there approves
them. If a request does not appear, turn the app on in **System Settings →
Privacy & Security** in both panes; Stim never changes these settings itself.
`stim-server service status` shows the grants, and `stim doctor` on this Mac
reports an approved host that lacks them. A server started by Stim Desktop uses
Desktop's grants.

Install downloads the signed, notarized **Stim Host** release this version of
Stim pins, checks its SHA-256 and App & Flow's Developer ID signature, and
installs it as `~/Applications/Stim Host.app` (`dev.stim.host`), so macOS keeps
its approvals across Stim and Node updates. A Mac that ran the earlier
**Stim Host Dev** keeps that app in `~/Applications`; delete it and its System
Settings entries when you no longer need them.

`macos --json` prints `{ platform, product, launchId, build, host }`, and
`status --json` reports the same `host` under `environments[].macos`: the
machine, session, app slot, app attempt, hosted bundle ID and `agent`. Status
asks the host for the session state only for hosted placements, with about a
3 s timeout per connection and request and a 10 s cache. It reports `stopped`
when the host says the session stopped, for example after a stim-server restart
there, and `unverified` when the host is unreachable or cannot confirm. The
`host` field stays recorded for cleanup. Run `stim macos --host <machine>` to
launch a stopped app again, or `stim stop` to clear or reconcile the placement.
`agent` is
`{ "driver": "none", "setting": "hosting.agentDriver" }` until the hosting Mac's
owner turns on a driver with that setting. With `agent-device`, it names a
`remoteConfig` file (mode 0600, in the workspace directory) and the `command` to
run, such as `agent-device screenshot --remote-config <path>`. The credential stays
in that file and never appears in command output. `stop`, `worktree remove` and
`gc` first run `agent-device close` and `disconnect` for the connection that
agent-device reports as connected to that remote config (the default or active
session), then delete the file, so the next hosted workspace needs no manual
disconnect. Any other connection, including one under another session name, stays
untouched, and a failure or a missing agent-device is reported without blocking
the stop. When the hosted session ends, stim-server removes its agent-device
session directories under its own state directory. Start with
`agent-device open <host bundleId> --remote-config <path>`; the lease allows only
commands that drive that one app (`snapshot`, `click`, `fill`, `type`, `press`,
`scroll`, `screenshot` and similar), and the agent-device on the client needs the
`macos-app` lease backend. On the hosting Mac, `stim-server service install --env
STIM_AGENT_DEVICE_BIN=<path>` points stim-server at a specific agent-device.

Copy this prompt:

> Run my Swift Package app on janics-mac-mini with `stim macos --host`. Confirm
> `stim status --json` reports the hosted session, then stop it with `stim stop`.
> Do not use SSH or change settings on the other Mac.

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
