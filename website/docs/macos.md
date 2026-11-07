---
title: 'Native macOS prototype'
description: 'Develop an owned Swift Package Debug app in Stim Desktop'
---

import StimTabs from '@site/src/components/StimTabs';

The macOS prototype builds a Swift Package executable in Debug, launches an
isolated development bundle and shows its owned window in Stim Desktop.
It uses fixed SwiftPM commands. Xcode projects, custom packaging scripts,
release distribution remain outside
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
from the workspace and signs that copy ad hoc. It also names the copy
`<product> · <label>` in `CFBundleDisplayName` and `CFBundleName`, where the label
is the workspace's worktree and app directory names (letters, digits, `.`, `_`
and `-`, at most 24 characters), so several runs of one product show different
names in the Dock and Cmd-Tab. Your plist and the app's own window titles stay
as they are. `stim macos --json` and `stim status --json` report it as
`displayName`. Hosted runs (`--remote`) get the same name. No signing account or
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

Each `macos` run validates the project settings, development plist and resource
entries before stopping the previous owned app and rebuilding using that workspace's
incremental outputs. Every process running an app bundle from the workspace's
`macos/` directory counts as the owned app, including copies opened through
LaunchServices with `open` or `agent-device open`. `stim macos`, `stim stop`,
`stim worktree remove` and `stim gc --delete` stop all of them: SIGTERM, up to
5 seconds, then SIGKILL. Stop reports success only after each copy has exited;
when one cannot be verified or does not exit, it reports the failure and removal
keeps the workspace. For a hosted session the same rule covers every app bundle the
session received, so stop and a replacement launch also end a copy that LaunchServices
started from an earlier attempt. It does not start Metro. Local `stim macos` starts the app in
the background without activating it or changing focus: it sets
`STIM_BACKGROUND_LAUNCH=1` in the app's environment, which Stim Desktop honors, including for reopen events from `open -g`.
An app that activates itself at launch or on reopen still takes focus. Hosted launches
(`macos --remote`) do not set it. A failed build keeps the compiler
output in workspace logs and does not launch an app. Runtime stdout and stderr
are client logs, and Stim runs the app with `NSUnbufferedIO=YES` so Swift `print`
output arrives per line instead of when the app exits. The app runs detached, started by the command (or by stimd
for a Desktop or phone run) with that caller's environment; its stdout and stderr go to files in the workspace logs that stimd turns into those records,
and its exit is an info record without an exit code. `macos --json` prints one launch
record on stdout, with progress on stderr. `status --json` reports
`environments[].macos`, its build and process state. This command does not
support `--slot` or `reload`.

Use `stim macos --plan --json` to validate the next build's declared configuration
without building, signing, stopping or launching an app, writing
workspace state, or claiming a build slot. Planning checks the package directory,
settings, development plist and declared resources. It does not execute
`Package.swift`, so it cannot validate the executable product or dependencies.
`--remote-build` is supported, including named-machine setup refusals, but no
worker is contacted and live worker availability remains unknown. `--remote`
is launch-only and refuses during a plan. For eligible completed artifact caching,
the JSON plan reports `fingerprint`, `cacheKey` and a verified local `cacheHit`.
Verification uses a disposable temporary copy; providers and workers are not
contacted. `cacheSkipped` is true when caching is disabled or ineligible.
`provider`, `prebuild`, `outcome` and timing fields remain null. SwiftPM determines
incremental compile work during a build; the plan predicts no duration.

## Reusing completed builds

SwiftPM reuses compilation work by default. To cache the complete app bundle, declare repeatable artifact inputs.

```json
{
  "macos": {
    "artifactInputs": {
      "complete": true,
      "ignored": [],
      "outputs": [],
      "localFiles": [],
      "environment": []
    }
  }
}
```

Opt in only with pinned dependencies, a self-contained app bundle and a complete list of extra build inputs. List exact Git-ignored input files in `ignored`, Git-ignored output directories in `outputs`, and extra private inputs in `localFiles` or `environment`. Stim hashes private inputs for its local key. For remote builds, resource and asset catalog files must be visible to Git. Declaring an ignored file for caching does not send it to the worker. The installed guide covers both contracts.

<StimTabs code="stim guide macos" />

In Desktop, the workspace's app card has **Build and Run**, **Open app** for local apps, and **Stop**. The live preview follows the app's front standard window. Use **Permissions** on the app card if capture or window selection is unavailable.

## Agent actions

Launch the app through `stim macos` first. Use its isolated `bundleId` from the
JSON launch record or `stim status --json` when opening it with agent-device.
`stim macos` waits, for up to 20 seconds, until macOS LaunchServices lists the
app, so `agent-device open` attaches to it instead of starting a second copy. If
it is still unlisted, `stim macos` warns and returns; wait before opening. A
`--remote` launch skips the wait:

```sh
agent-device open <bundleId> --platform macos --surface app --foreground
agent-device click <ref> --settle
stim logs --source agent
```

Recorded app-scoped actions and failures appear in the Desktop workspace's
agent actions panel and the phone viewer. Text stays redacted by agent-device;
timing includes its settle wait. App switches, unrecorded open/close attempts,
unknown event formats and event-log rotation clear attribution. Open again with
explicit `--surface app` to resume the feed; omitted surface can inherit a prior
desktop or menubar session. Native screenshot actions are omitted because their
surface override is absent from the recorded metadata. Generic computer-use
tools and phone Control do not populate this feed. Keep launches and stops in
Stim; manually duplicated bundles sharing its isolated identifier are unsupported.
Native app replay remains unavailable.

The feed requires agent-device to record the explicit surface in its open event.
agent-device 0.21.23 is the minimum; older versions such as 0.21.12 omit it, so
native actions remain unavailable with them. Stim does not infer the surface from
the bundle ID. Actions are attributed only while the launch is recorded as
running: after the app exits or is relaunched, earlier launches' actions are no
longer returned, and a failed open is not shown.

## Monitor from your phone

Pair your phone with this Mac, open the workspace and tap its app tile. You can see the app's front window, build status and logs. [Pair a phone](./phone-app.md)

For live capture, grant **Screen & System Audio Recording** (called **Screen Recording** on macOS 14) on the Mac doing the capture. **Permissions** on the Desktop app card opens setup. Device control also needs **Device Control and Data Access** (called **Accessibility** on macOS 26 and earlier), a control pairing and a compatible server. Tap **Control** to click, drag or type. Use the **Window** menu to select a window when supported. Native windows do not support replay.

## Run it on another Mac

Set up an approved [remote machine](./remote-machines.md) with **Run devices** access, then name it. Add `--remote-build` if you also want it to compile the app. Building there requires a separate approval.

<StimTabs
code={`stim macos --remote janics-mac-mini
stim macos --remote janics-mac-mini --remote-build janics-mac-mini
stim logs --errors
stim stop`}
/>

Use `macos.remote` for a default. A named Mac is strict and never launches locally. Use `remote-only` to allow any eligible worker and prevent a local launch. Stop the session before switching hosts. If stop cannot reach the host, retry when it is available.

The workspace shows the hosted window in Desktop. The host needs capture and control permissions. To drive it with an agent, configure `hosting.agentDriver` on the host and use the app-scoped command in `macos.host.agent` from the JSON output. The installed guide covers driver setup, build inputs and placement.

<StimTabs code="stim guide macos" />

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

For an unreleased CLI, run `pnpm run build` at the repository root first. Run
`node ../../packages/stim-cli/dist/cli.mjs macos --remote-build local` from
`apps/desktop`. This alone does not bundle a server runtime. To test private
Desktop actions with an unreleased server, follow the repository's
[`apps/desktop/README.md`](https://github.com/appandflow/stim/blob/main/apps/desktop/README.md#native-macos-development-prototype):
stage the server, add its resource, and use a private Stim home and unused port.
Restore those local settings afterward.

Copy this prompt:

> In my Swift Package app, configure the executable product and a development
> Info.plist and any `macos.resources` or `macos.assetCatalog` for `stim macos`. Build and show its owned window in Stim Desktop,
> verify a source edit and readable failed-build logs, then stop only this
> workspace's app. Do not change permissions or use custom build scripts.
