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
A main window with contained utility windows is supported; disjoint app windows
refuse capture. The viewer never captures its own process recursively.
The captured view is read-only; background mouse/keyboard relay is not included.

Capture requires existing Screen Recording permission; Open app also requires
existing Accessibility permission. Neither asks for permission or changes grants. If unavailable, use the normal app window and
read the workspace logs. Use Refresh preview after the app window opens or is
resized to rebind capture. Phone viewing, remote relay and multiwindow selection
are not part of this prototype.

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
