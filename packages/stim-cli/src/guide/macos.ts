export default {
  summary: 'Swift Package macOS Debug apps: explicit product, owned bundle, logs and local window viewing',
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
This prototype has no shared artifact cache, --plan, --slot, or reload command.
A failed build records its error and compiler output without launching an app.
Runtime stdout and stderr become client records; build output becomes build
records, all with platform "macos". Unexpected app exits are error records.

OWNERSHIP AND LOCAL VIEWING

The supervisor owns a process-identity claim with the app as its child. Stop
signals only verified recorded identities. An unverifiable or malformed owner
refuses with STIM_MACOS_OWNER_UNVERIFIED; other apps remain untouched.

Stim Desktop shows this app in its workspace, with Build and run, Refresh preview,
Open app and Stop. Capture and Open app verify the recorded executable, bundle
identifier, PID and process start time. Open app rechecks the same captured window and one standard app window, then
activates that owned app for normal native input.
The captured view is read-only; background mouse/keyboard relay is not included.

Capture requires existing Screen Recording permission; Open app also requires
existing Accessibility permission. Neither asks for permission or changes grants. If unavailable, use the normal app window and
read the workspace logs. Use Refresh preview after the app window opens or is
resized to rebind capture.

PHONE MONITORING

A paired phone shows native app and build state in the workspace and home list.
Tap the app tile to view its one visible window through stim-server. The server
requires read access and its macos-window feature; it rechecks the recorded PID,
process start time, executable and bundle before capture and on every frame.
It never captures the desktop or another application, and offers no input or replay.

The existing capture host needs Screen Recording permission. If capture is denied,
the viewer explains where to allow that host in System Settings; Stim never
requests or resets permissions. Status and logs still work. Tap the build card for
SwiftPM output or the logs card for native runtime stdout and stderr. Metro is not
used. Close and reopen the viewer after opening or resizing the app window.

DESKTOP DOGFOOD

This repository's apps/desktop/.stim.json selects StimDesktop, its development
plist and --playground. The Debug-only playground opens production screen
fixtures with in-memory actions and avoids live backend initialization:

  cd apps/desktop
  stim macos
  stim logs --source build
  stim stop

Ask an agent: "In my Swift Package app, configure the executable product and a
development Info.plist for stim macos. Build and show its owned window in Stim
Desktop, verify a source edit and readable failed-build logs, then stop only
this workspace's app. Do not change permissions or use custom build scripts."
`,
};
