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
macOS artifacts are not cached. This prototype has no --plan, --slot, or reload command.
A failed build records its error and compiler output without launching an app.
Runtime stdout and stderr become client records; build output becomes build
records, all with platform "macos". Unexpected app exits are error records.

BUILD OFFLOAD

offload.mode places these SwiftPM Debug builds:
auto builds here while this Mac has capacity, force uses an approved build
machine when one accepts, and off always builds here. Configure offload.machines
and approve build access as described in stim guide settings. The worker needs
matching Stim, CPU architecture, Xcode and macOS SDK, plus network access to
fetch package dependencies the first time. It keeps SwiftPM dependencies in a
per-client cache and incremental outputs per repository. It runs fixed swift
build commands without JavaScript installs, prebuild or pods.

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
identifier, PID and process start time. Open app rechecks the same captured window and one standard app window, then
activates that owned app for normal native input.
A main window with contained utility windows is supported; disjoint app windows
refuse capture. The viewer never captures its own process recursively.
The captured view is read-only; background mouse/keyboard relay is not included.

Capture requires existing Screen Recording permission; Open app also requires
Accessibility permission. The first native viewer opening shows one Desktop setup
screen for both permissions (Accessibility is named Device Control and Data Access
on macOS 27), with statuses, Request permissions, Settings and
Check again. You approve normal macOS requests; Stim never resets or grants access
automatically. Permissions on the app card reopens setup. Builds never prompt.
If unavailable, use the normal app window and
read the workspace logs. Use Refresh preview after the app window opens or is
resized to rebind capture.

PHONE VIEWING AND CONTROL

A paired phone shows native app and build state in the workspace and home list.
Tap the app tile to view its one visible window through stim-server. The server
requires read access and its macos-window feature; it rechecks the recorded PID,
process start time, executable and bundle before capture and on every frame.
It never captures the desktop or another application, and offers no replay.

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

Letter and digit shortcuts require the owned app's selected U.S. or ABC input source.
The helper focuses that app and waits up to one second for activation before
checking the layout; an app that does not activate refuses the shortcut.
Apple's ANSI virtual key codes represent physical U.S. positions, not logical
letters in other host layouts. The helper refuses those key events on other
layouts with a specific reason; ordinary typing and navigation remain available.
Logical shortcuts for other host layouts remain tracked in
https://github.com/appandflow/stim/issues/2422.
Control holds one exclusive server session per owned app, ends on disconnect,
revocation, takeover or five minutes without input, and does not take a CLI
simulator/device lock. Each action rechecks the exact owned process and the
same single standard app window. Modal or disjoint windows, changed capture or
resize refuse input until the viewer reconnects. Contained nonmodal auxiliaries
are allowed; only the focused captured main receives input. Existing Accessibility permission is required;
The phone and server never request or reset it. A refusal ends Control with its reason while
viewing and logs remain usable. Older servers remain view-only.
Native Control uses dynamically resolved private CoreGraphics input SPI in the
server helper, outside the phone and Mac App Store app binaries. A missing symbol
or incompatible macOS version refuses Control while viewing and logs remain usable.

The existing capture host needs Screen Recording permission. If capture is denied,
open Permissions in Stim Desktop on the host Mac, approve its normal OS requests
and reconnect the phone viewer. The Desktop host presents setup on the first
native viewer opening, including one initiated by the phone. A server started
outside Desktop uses that launching host's permissions; granting this copy of Stim
may not apply to it. The server never requests or resets permissions. Status and logs still work. Tap the build card for
SwiftPM output or the logs card for native runtime stdout and stderr. Metro is not
used. Close and reopen the viewer after opening or resizing the app window.

ON ANOTHER MAC

stim macos --host <machine> builds the Debug app on this Mac and runs it on an
approved hosting Mac over the tailnet, without SSH. The machine must be listed
in hosting.machines and approved: stim doctor --fix asks it, a person on that
Mac runs stim-server devices grant <id> --device-host, and stim doctor then
records the approval. Stim connects only to the machine's pinned tailnet node.
A refusal or an unreachable host fails the command; it never launches here
instead.

  stim macos --host mini          # build here, deliver, launch on mini
  stim macos --host mini --json   # { platform, product, launchId, build, host }
  stim status --json              # environments[].macos.host
  stim stop                       # stop the session on mini and confirm it
  stim worktree remove <path>     # also stops it

The copy keeps the plist's own CFBundleIdentifier. The host runs it as
<id>.hosted<slot> from a fixed slot pool, so the bundle id stays the same
across rebuilds; whether macOS keeps permission approvals for it also depends
on how the host signs it. Running the
command again reuses the session and delivers a new copy. macos.arguments are
not passed to a hosted app. A workspace has one macOS app: a local stim macos
refuses while it runs on a host, and --host with a different machine refuses
until stim stop. When the host cannot be reached or does not confirm the stop,
the placement stays recorded; restore the connection and run stim stop again.

status --json reports macos.host { machine, session, appSlot, appAttempt,
bundleId, agent }. state is running when the host reported a live app and
unverified when it could not confirm one; status does not contact the host.
While a placement is recorded, gc treats the workspace as in use. agent says
how a coding agent drives the app: { driver: "none", setting:
"hosting.agentDriver" } until the hosting Mac's owner sets that setting there,
or { driver: "agent-device", remoteConfig, command }. remoteConfig is a mode
0600 file in the workspace directory that holds the credential; run the command
it names and never print the file. stop deletes it.

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
