export default {
  summary: 'Swift Package macOS Debug apps: owned bundle, logs, local window viewing, and --host on another Mac',
  body: () => `MACOS: SWIFT PACKAGE DEVELOPMENT PROTOTYPE

If Stim is not installed globally, replace stim with npx stim.

Run from the directory containing Package.swift. This prototype builds one
explicit executable product in Debug, creates an isolated development app,
and launches it. It does not use package scripts, Metro, simulators, Xcode
projects, release builds, provisioning, or store distribution.

Set macos.product and macos.infoPlist explicitly in .stim.json. Optional
macos.arguments is an array of arguments passed directly to the executable:

  { "macos": { "product": "MyApp", "infoPlist": "Support/Info-Development.plist" } }

The plist must contain CFBundleIdentifier and CFBundleExecutable matching the
product. Use a development plist without shared URL schemes or an update feed.
Stim gives the copied bundle a workspace-specific identifier. SwiftPM resource
bundles and frameworks in the reported build directory are copied into it;
extra app assets and custom packaging scripts are not supported.

  stim macos              # fixed SwiftPM Debug build, then launch
  stim macos --json       # one launch record; progress goes to stderr
  stim status --json      # environments[].macos and build state
  stim logs --source build
  stim logs --errors
  stim stop               # stop this workspace's owned app and supervisor

Each invocation stops its previous owned app, rebuilds and launches. SwiftPM
keeps incremental outputs in the workspace's runtime directory under STIM_HOME.
Local stim macos starts the app in the background without activating it or
changing focus: it sets STIM_BACKGROUND_LAUNCH=1 in the app's environment, which
Stim Desktop honors. An app that activates itself at launch still takes focus.
Hosted launches (macos --host) do not set it.
macOS artifacts are not cached. This prototype has no --plan, --slot, or reload command.
A failed build records its error and compiler output without launching an app.
Runtime stdout and stderr become client records; build output becomes build
records, all with platform "macos". Unexpected app exits are error records.
Stim runs the app with NSUnbufferedIO=YES, so Swift print output arrives per
line instead of when the app exits.

BUILD OFFLOAD

offload.mode places these SwiftPM Debug builds:
auto builds here while this Mac has capacity, force uses an approved build
machine when one accepts, and off always builds here. Configure offload.machines
and approve build access as described in stim guide settings. The worker needs
matching Stim, CPU architecture, Xcode and macOS SDK, plus network access to
fetch package dependencies the first time. It keeps SwiftPM dependencies in a
per-client cache and incremental outputs per repository. It runs fixed swift
build commands without JavaScript installs, prebuild or pods. It receives only
the files git lists (tracked and untracked, not ignored).

The client validates the development plist before asking a machine. It verifies
the returned archive's sha256, bundle identifier, executable and ad hoc signature
before replacing the owned bundle, then launches locally as usual. Every offload
failure falls back to the local build, including force. Failed staging preserves
the previous bundle. No failed artifact is promoted or cached. The build record
carries offloadedTo only for a remote build, and offloadFallback when an offload
attempt falls back here. Placement and failure reasons are in build logs.

OWNERSHIP AND LOCAL VIEWING

The supervisor owns a process-identity claim with the app as its child. Stop
signals only verified recorded identities. An unverifiable or malformed owner
refuses with STIM_MACOS_OWNER_UNVERIFIED; other apps remain untouched.

Stim Desktop shows this app in its workspace, with Build and run, Refresh preview,
Open app and Stop. Capture and Open app verify the recorded executable, bundle
identifier, PID and process start time. Open app rechecks that the captured window
is still the app's front window, then activates that owned app for normal native input.
The preview follows the app's front standard window, its main window with any
attached sheet, as the app opens, switches, closes or resizes windows. It never
captures another process's windows, menus or the desktop. Without Device Control
and Data Access permission (Accessibility on macOS 26 and earlier) Stim cannot
tell which window is in front, so the preview shows only an app whose one window
contains the others. The viewer never captures its own process recursively.
The captured view is read-only; background mouse/keyboard relay is not included.

Capture requires existing Screen & System Audio Recording permission (Screen
Recording on macOS 14); Open app also requires Device Control and Data Access
permission (Accessibility on macOS 26 and earlier). The first native viewer opening
shows one Desktop setup screen for both permissions, named for this Mac's macOS
version, with statuses, Request permissions, Settings and Check again. Settings
opens the matching System Settings > Privacy & Security pane. You approve normal macOS requests; Stim never resets or grants access
automatically. Permissions on the app card reopens setup. Builds never prompt.
If unavailable, use the normal app window and
read the workspace logs.

PHONE VIEWING AND CONTROL

A paired phone shows native app and build state in the workspace and home list.
Tap the app tile to view the app's front window through stim-server. The server
requires read access and its macos-window feature; it rechecks the recorded PID,
process start time, executable and bundle before capture and on every frame.
It never captures the desktop or another application, and offers no replay.
The view follows the app's front standard window like the Desktop preview. A
server advertising macos-windows also sends a macos-windows event on the frames
subscription with the captured window and the app's windows (id, title and frame
in points), after subscribing and whenever they change. Viewing starts only with
an open window; after the app closes its last one the view reports a delay until
another opens.

A server advertising macos-window-control also supports the phone's Control
mode on a control pairing. Tap/click and drag act on the displayed window;
Scroll mode turns a drag into pixel scrolling. The main toolbar offers Keyboard
and Scroll. Keyboard types printable ASCII and attaches an extra-key strip with
Tab, Escape, Backspace, arrows and labeled Select all, Undo, Save, Copy, Paste,
Cut and Find shortcuts. Shift, Control, Option and Command apply to the next
supported key, then clear; dismissing the keyboard clears them too.

A newly built phone client with Keyboard Controller is required; this native
change cannot be delivered to an older client by a JavaScript update. Servers
advertising macos-keyboard-extended accept modified a-z and 0-9 one key at a
time. Older servers retain fixed shortcuts and navigation but cannot receive
other modified letters or digits. Multi-character modified input and symbols
are not supported; ordinary typing keeps using input.text.

Letter and digit shortcuts require the Mac's selected U.S. or ABC input source.
Apple's ANSI virtual key codes represent physical U.S. positions, not logical
letters in other host layouts. The helper refuses those key events on other
layouts with a specific reason; ordinary typing and navigation remain available.
Logical shortcuts for other host layouts remain tracked in
https://github.com/appandflow/stim/issues/2422.
Control posts input to the owned process without activating it or raising its
window. Only when the captured window is not the app's key window (or its
attached sheet) does Stim activate the app to deliver input, waiting up to one
second for focus. The helper then sends a controlActivated notice, which stim-server
logs.
Clicks on views that reject the first mouse, such as custom views and SwiftUI
onTapGesture regions, do not land while the app is in the background. Use
Desktop's Open app to bring the app to the front for those views.
Control holds one exclusive server session per owned app, ends on disconnect,
revocation, takeover or five minutes without input, and does not take a CLI
simulator/device lock. Each action rechecks the exact owned process and that the
captured window is still the app's front standard window. The app's other windows
are allowed; input goes to the captured window, and a sheet attached to it takes
focus and pointer input. Input that arrives while the view moves to another
window is dropped and Control continues. A modal dialog window refuses input. A
sheet larger than the captured window is not supported. Existing Device
Control and Data Access permission (Accessibility on macOS 26 and earlier) is
required. The phone and server never request or reset it. A refusal ends Control
with its reason while viewing and logs remain usable. Older servers remain
view-only.
Native Control uses dynamically resolved private CoreGraphics input SPI in the
server helper, outside the phone and Mac App Store app binaries. A missing symbol
or incompatible macOS version refuses Control while viewing and logs remain usable.

The existing capture host needs Screen & System Audio Recording permission (Screen
Recording on macOS 14). If capture is denied,
open Permissions in Stim Desktop on the host Mac, approve its normal OS requests
and reconnect the phone viewer. The Desktop host presents setup on the first
native viewer opening, including one initiated by the phone. A server started
outside Desktop uses that launching host's permissions; granting this copy of Stim
may not apply to it. The server never requests or resets permissions. Status and logs still work. Tap the build card for
SwiftPM output or the logs card for native runtime stdout and stderr. Metro is not
used.

ON ANOTHER MAC

stim macos --host <machine> builds the Debug app on this Mac and runs it on an
approved hosting Mac over the tailnet, without SSH. The machine must be listed
in hosting.machines and approved: stim doctor --fix asks it, a person on that
Mac runs stim-server devices grant <id> --device-host, and stim doctor then
records the approval. Stim connects only to the machine's pinned tailnet node.
A refusal or an unreachable host fails the command; it never launches here
instead.

Logs: the host records the hosted app's stdout, stderr and exit like a local run.
stim logs, including --errors, --json and --follow, asks the host over the same
approved connection, copies the records it has not copied yet into the
workspace's logs/macos-host.ndjson and prints them with the local records.
stim stop copies the last ones, including the exit record, before it forgets the
placement, so the logs stay readable after stop. A host that cannot answer, because
it is unreachable or runs a stim-server that predates this, costs one stderr
warning; stdout still carries the records already copied, so logs --json stays
valid NDJSON. The host's unified log is not collected: os.Logger output that is
not written to stderr does not appear.

Phones and Stim Desktop view and control the hosted app through this Mac's
stim-server, which relays to the host. The phone sends clicks, scrolls,
text and keys; Stim Desktop's Control sends clicks, drags and typed text.

  stim macos --host mini          # build here, deliver, launch on mini
  stim macos --host mini --json   # { platform, product, launchId, build, host }
  stim status --json              # environments[].macos.state and macos.host
  stim stop                       # stop the session on mini and confirm it
  stim worktree remove <path>     # also stops it

The copy keeps the plist's own CFBundleIdentifier. The host runs it as
<id>.hosted<slot> from a fixed slot pool, so the bundle id stays the same
across rebuilds; whether macOS keeps the permissions the hosted app asks for
itself also depends on how the host signs it. Running the
command again reuses the session and delivers a new copy. macos.arguments are
passed to the hosted launch as plain arguments, without environment injection:
at most 32 arguments, 1024 characters each and 8192 characters total. Empty
strings are allowed; NUL, CR and LF are refused. Values are stored in the host's
app receipt and visible in process listings, so do not put secrets there. Older
hosts ignore them and Stim warns to update stim-server on the host.
status --json reports the host's applied arguments under
environments[].macos.arguments.
A workspace has one macOS app: a local stim macos
refuses while it runs on a host, and --host with a different machine refuses
until stim stop. When the host cannot be reached or does not confirm the stop,
the placement stays recorded; restore the connection and run stim stop again.

Viewing and controlling the hosted app from a phone needs Screen & System Audio
Recording and Device Control and Data Access (Accessibility on macOS 26 and
earlier), granted once on the host to the app that runs stim-server, not to the
hosted app. stim-server service install runs the server under the signed Stim
Host app (dev.stim.host, installed in ~/Applications) and shows
macOS's own requests on that Mac's screen; a person there approves them.
stim-server service status shows the grants, and stim doctor here reports an
approved host that lacks them. A server started by Stim Desktop uses Desktop's
grants.

status --json reports macos.host { machine, session, appSlot, appAttempt,
bundleId, agent }. For hosted placements only, status asks the host for the
session state with about a 3 s timeout per connection and request and a 10 s
cache. It reports stopped when the host says the session stopped, for example
after a stim-server restart there, and unverified when the host is unreachable
or cannot confirm. Run stim macos --host <machine> to launch a stopped app
again, or stim stop to clear or reconcile the placement. The host field stays
in status --json for cleanup.
While a placement is recorded, gc treats the workspace as in use. agent says
how a coding agent drives the app: { driver: "none", setting:
"hosting.agentDriver" } until the hosting Mac's owner sets that setting there,
or { driver: "agent-device", remoteConfig, command }. remoteConfig is a mode
0600 file in the workspace directory that holds the credential; run the command
it names and never print the file. stop, worktree remove and gc first run
agent-device close and disconnect for the connection that agent-device reports
as connected to that remote config (the default or active session), then delete
the file, so the next hosted workspace needs no manual disconnect. Any other
connection, including one under another session name, stays untouched, and a
failure or a missing agent-device is reported without blocking the stop. When
the hosted session ends, stim-server removes its agent-device session
directories under its own state directory. Start with agent-device open
<bundleId> --remote-config <path>, using macos.host.bundleId; the lease allows
open, close, snapshot, wait, find, get, is, click, fill, press, type, focus,
scroll, screenshot and batch on that app only. The agent-device on this Mac must
know the macos-app lease backend.

Agents that built, launched and drove test copies on another Mac with an SSH
script such as mini-desktop.sh use these instead:

  script command             stim
  build                      stim macos --host <mac>
  launch                     the same command; the host launches it under the
                             session's own home
  shot <out.png>             agent-device screenshot --remote-config <path>
  click, rclick, key, type   agent-device click, press or type --remote-config <path>
  quit                       stim stop (verified stop; the host frees the slot
                             and removes the app's defaults)
  clean                      stim worktree remove
  3 concurrent slots         concurrency.maxDevices on the host; one bundle id
                             slot per session

The agent-device rows work once the host's agent field names agent-device.

DESKTOP DOGFOOD

This repository's apps/desktop/.stim.json selects the full StimDesktop app and
its development plist. It monitors the regular Stim home alongside the installed
app, with a workspace-specific bundle identifier and separate preferences.
Its launch arguments disable automatic cleanup and notification alerts in this development copy.
Use Window > SwiftUI Playground for in-memory production screen fixtures.

  cd apps/desktop
  stim macos
  stim logs --source build
  stim stop

When using an unreleased CLI from this repository, build the packages first and
set STIM_BIN to the absolute packages/stim-cli/dist/cli.mjs path before running
that executable's macos command. The development app inherits this CLI override;
the installed app's CLI preference and running server remain unchanged.

Ask an agent: "In my Swift Package app, configure the executable product and a
development Info.plist for stim macos. Build and show its owned window in Stim
Desktop, verify a source edit and readable failed-build logs, then stop only
this workspace's app. Do not change permissions or use custom build scripts."
`,
};
