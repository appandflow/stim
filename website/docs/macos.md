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
from the workspace and signs that copy ad hoc. No signing account or
provisioning settings change.

Use `macos.resources` to copy files or directories into `Contents/Resources`.
Each key is the destination and each value is a source relative to the Swift
Package directory. `macos.assetCatalog` selects a `.xcassets` directory for a
fixed `xcrun actool` invocation. Stim adds these resources before signing:

```json
{
  "macos": {
    "product": "MyApp",
    "infoPlist": "Support/Info-Development.plist",
    "assetCatalog": "Support/Assets.xcassets",
    "resources": {
      "AppIcon.icns": "Support/AppIcon-Dev.icns",
      "branding": "../../website/static/img/branding"
    }
  }
}
```

Sources must exist and their realpaths must stay inside the git repository root,
or the Swift Package directory when there is no git root. A source directory
cannot contain symbolic links. A source can use `../`
to reach another directory in the same repository. Destinations are non-empty
relative paths without empty, `.` or `..` segments, at most 1024 characters.
They cannot overlap another declared destination, a SwiftPM resource bundle, or
`Assets.car` when an asset catalog is set. The map allows at most 256 entries.
Stim does not run packaging scripts or build extra executables. If `actool` does
not emit `Assets.car`, staging refuses. Set `LSMinimumSystemVersion` in the plist
when Xcode requires a deployment target.

<StimTabs
code={`stim macos
stim status --json
stim logs --source build
stim logs --errors
stim stop`}
/>

Each `macos` run stops the previous owned app and rebuilds using that workspace's
incremental outputs. It does not start Metro. Local `stim macos` starts the app in
the background without activating it or changing focus: it sets
`STIM_BACKGROUND_LAUNCH=1` in the app's environment, which Stim Desktop honors.
An app that activates itself at launch still takes focus. Hosted launches
(`macos --host`) do not set it. A failed build keeps the compiler
output in workspace logs and does not launch an app. Runtime stdout and stderr
are client logs, and Stim runs the app with `NSUnbufferedIO=YES` so Swift `print`
output arrives per line instead of when the app exits; unexpected exits are errors. `macos --json` prints one launch
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

`--build-machine <auto|local|name>` overrides `STIM_OFFLOAD_MACHINE` and the
machine setting `offload.machine` (default `auto`). `local` builds here. A name
requires the matching configured and paired worker, ignoring `offload.mode` and
this Mac's capacity. Any failure is `STIM_OFFLOAD_REFUSED` with the worker and
reason; no local xcodebuild, Gradle or SwiftPM compile or another machine follows. Check
`stim settings get offload.machines`. Run `stim doctor --fix` to ask for build
access if not paired; a person on the worker finds the id with
`stim-server devices` and approves it with `stim-server devices grant <id> --build`.
Invalid, unlisted or unpaired selections refuse before stopping the running app
or changing its build record. To change placement, rerun with `--build-machine auto`
or `--build-machine local`.

With `auto`, `offload.mode` also places these SwiftPM Debug builds: `auto` builds here while
this Mac has capacity, `force` uses an approved build machine when one accepts,
and `off` always builds here. Configure `offload.machines` and approve build
access as described in [settings](./settings.md). The worker needs matching Stim,
CPU architecture, Xcode and macOS SDK, and network access to fetch package
dependencies the first time. It keeps SwiftPM dependencies per client and
incremental outputs per repository; macOS artifacts are not cached. It runs no
JavaScript install, prebuild or pod install for this job. It receives the files
git lists (tracked and untracked, not ignored), so a build input that is
gitignored is missing there. Resource and asset catalog sources must be tracked
or untracked and not ignored. Offload sends the resolved source paths relative
to the repository root; the worker resolves them inside its checkout and stages
them before signing.

Stim validates the development plist and resource entries before asking a machine
and verifies the returned archive digest, bundle ID, executable, declared
resources and ad hoc signature before
replacing the bundle. With `auto`, every offload failure falls back locally, including in
`force` mode; failed staging preserves the previous bundle. The app launches
locally with the same supervisor and ownership checks. The build record carries
`buildMachine` for the selection and `builtOn` for the actual worker or `here`
(absent before a build runs), plus `errorCode` for typed failures. It retains
`offloadedTo` for a remote build or `offloadFallback` for a fallback, and build
logs show placement and its reason.

Stim Desktop offers **Build and run**, **Open app** (for an app on this Mac) and **Stop** on the
workspace's app card, with a live preview that updates itself while the app runs. The preview follows the app's front standard window, its
main window with any attached sheet, as the app opens, switches, closes or resizes
windows. It never captures another process's windows, menus or the desktop. Without
**Device Control and Data Access** permission Stim cannot tell which window is in
front, so the preview shows only an app whose one window contains the others.
A viewer does not capture its own process recursively. Capture and Open app verify the recorded PID, process start time, bundle ID
and executable. Open app rechecks the captured window, raising a pinned one, then activates
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
closes its last window the view reports a delay until another opens.

During Control, a server advertising `macos-window-select` adds a **Window** menu to
the phone's toolbar: **Follow front window**, or one of the app's windows by title.
Picking a window pins the view to it and brings it to the front of the app, so
input lands there even when another window comes forward on the Mac. The pin ends
when you choose Follow front window, when the window closes, or when Control ends
for any reason, including five idle minutes.
Stim Desktop's app card and hosted viewer show the same menu above the preview. A server advertising `macos-windows` also
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

Shortcuts for `a-z` and `0-9` use the key that types the character in the
**Mac's current keyboard layout**, using the Command layer when Command is held.
Dvorak and Dvorak-QWERTY Command are supported. On Russian and similar layouts
(Cyrillic, Greek, Hebrew, Arabic), Latin-letter shortcuts work with Command;
Control-only or Option-only letter shortcuts are refused. With Control, the
layout's Control table must also yield the requested character or, for letters,
its C0 control character; otherwise the shortcut is refused. The Mac's selected
input source is read on each key, so switching layouts takes
effect on the next key. Letters and digits available only with Shift or Option,
or through a dead key (for example digits on AZERTY), are refused with a reason
naming the layout, and Control ends. Stim does not add modifiers to reach those
characters. Ordinary typing and navigation do not depend on the layout. Symbols
such as comma remain unsupported key names.

Control posts input to the owned process without activating it or raising its
window; only choosing a window to pin raises it among the app's windows. Only when the captured window is not the app's key window (or its
attached sheet) does Stim activate the app to deliver input, waiting up to one
second for focus. The helper then sends a `controlActivated` notice, which stim-server logs.
Clicks on views that reject the first mouse, such as custom views and SwiftUI
`onTapGesture` regions, do not land while the app is in the background. Use
Desktop's **Open app** to bring the app to the front for those views.

Each action rechecks the exact owned
process and that the captured window is still the app's front standard window, or
the window you pinned. The
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

The host records the hosted app's stdout, stderr and exit like a local run.
`stim logs`, including `--errors`, `--json` and `--follow`, asks the host over the
same approved connection, copies the records it has not copied yet into the
workspace's `logs/macos-host.ndjson` and prints them with the local records.
`stim stop` copies the last ones, including the exit record, before it forgets the
placement, so the logs stay readable after stop. A host that cannot answer, because
it is unreachable or runs a `stim-server` that predates this, costs one stderr
warning (after up to 10 seconds of connecting); stdout still carries the records already copied, so `logs --json` stays
valid NDJSON. The host's unified log is not collected: `os.Logger` output that is
not written to stderr does not appear.

Phones and Stim Desktop view and control the hosted app through this Mac's
stim-server, which relays to the host. The phone sends clicks, scrolls,
text and keys; Stim Desktop's Control sends clicks, drags and typed text.

<StimTabs
code={`stim macos --host janics-mac-mini
stim macos --host janics-mac-mini --json
stim status --json
stim stop`}
/>

Hosted delivery carries the staged bundle, including declared resources and
compiled assets. When `offload.mode` built the app on the hosting Mac itself
(the same tailnet node), the host copies the files from the build it kept for
this Mac instead of receiving them again over the tailnet. It admits only bytes
that match the digests of the bundle Stim verified here, and it needs both the
build and the device-host approval for this Mac. Files the host cannot take, an
older `stim-server`, or a build fetched more than 10 minutes earlier fall back
to the upload. The copied bundle keeps its own `CFBundleIdentifier`. The host runs it as
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
A request outside the allowed commands, or a method the relay does not forward,
is refused with an agent-device `UNAUTHORIZED` error whose `details.reason` is
`STIM_AGENT_REQUEST_REFUSED` and whose message names the refused command or
method; do not retry it.

Copy this prompt:

> Run my Swift Package app on janics-mac-mini with `stim macos --host`. Confirm
> `stim status --json` reports the hosted session, then stop it with `stim stop`.
> Do not use SSH or change settings on the other Mac.

## Try Stim Desktop itself

The repository's `apps/desktop/.stim.json` launches the full `StimDesktop` app
as **Stim Development**, with its asset catalog, fonts, branding and licences.
The bespoke `sim-fold` helper is not built, so simulator folding is unavailable
in this copy. It monitors your regular Stim home alongside the
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
> Info.plist and any `macos.resources` or `macos.assetCatalog` for `stim macos`. Build and show its owned window in Stim Desktop,
> verify a source edit and readable failed-build logs, then stop only this
> workspace's app. Do not change permissions or use custom build scripts.
