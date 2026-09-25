# Stim Desktop

A macOS app for supervising Stim workspaces: every worktree on the machine,
grouped by project, with its Metro port, supervisor health, errors, build cache
stats, live frames from its iOS simulators and Android emulators, and its CPU
and resident memory.

It reads Stim state only through `stim status --watch --json`, `stim status --json`, `stim stats --json`,
`stim logs --json`, `stim settings --json`, and the `stim gc --json` dry run, and never reads or writes `$STIM_HOME`. Its
actions run the `stim` executable with an argument list, never a shell string,
in the workspace directory:

- Needs attention: preview `stim gc --json`, then run `stim gc --delete` after a
  confirmation; `stim stop` or `stim android` for a status warning. Each row can
  also copy its command.
- Workspace inspector: `stim stop`, and `stim worktree remove` after a
  confirmation that names the worktree and its branch.

A linked worktree Stim has not registered yet, listed in `unprovisionedWorktrees`
of `stim status --json`, appears under Idle in the sidebar with its project and
is marked "no environment". It has no action. Selecting it shows its path and
branch and the `stim start`, `stim ios` and `stim android` commands that create
its environment, each with a Copy button.

Output streams into an activity sheet with the exit status, and status refreshes
when the command finishes. Each workspace runs one action at a time.

Status stays current through one long-running `stim status --watch --json`,
which prints a payload each time the state changes, and the toolbar shows
`live` while it runs. If it exits, the app restarts it after a delay that
doubles from 1 to 30 seconds. A `stim` without `--watch` makes the app run
`stim status --json` every 10 seconds instead.

Resource usage is measured with `ps` every 3 seconds while the app is active
and its window is on screen: each workspace's
supervisor and Metro process trees plus the `launchd_sim` tree of each of its
simulators (matched by UDID) and the qemu process of each emulator (matched by
AVD name or console port). Memory is the sum of resident sizes, so memory
shared between processes counts more than once. The toolbar shows free space
on the volumes holding the repositories, `$STIM_HOME`, and CoreSimulator, and
what `stim gc --delete` would reclaim; the reclaimable figure needs a Stim
version with `gc --json`.

## Logs

A workspace's detail view has a **Logs** tab next to its device, and the error
count on the device wall and in the inspector opens it with **Errors only** on.
The tab runs `stim logs --json --follow --tail 5000` in the workspace and adds
the filters you pick: the Metro, App (`client`), Native (`device`) and Build
sources, a slot, a minimum level, a regular expression search (`--grep`), and
`--errors`. With every source selected no `--source` is passed, so **Errors
only** keeps the CLI's default scope, which leaves general device logs out.
Changing a filter or the workspace restarts the command; leaving the tab or
quitting the app terminates it.

The list keeps the newest 50,000 records and drops the oldest past that. It
follows new records until you scroll up, and **Jump to latest** resumes. Each
row shows a record's first line; select one to read its whole message and
stack. Command-C or **Copy** copies the selected records, or every loaded
record when none is selected. **Reveal log folder** opens the workspace's log
directory from `stim status`.

## Build progress

While `stim ios` or `stim android` runs in a workspace, its header on the wall
and the tile of the device it targets show a progress bar with the build phase,
the elapsed time against the median of that project's comparable runs, and
"about N min left". With no finished run to compare against, the bar is
indeterminate. The figures come from the `build` field of `stim status --json`,
which needs a Stim version that reports it.

## Take over a device

Device frames are view-only until you turn on **Take over** above a booted iOS
simulator or a running owned Android emulator in a workspace's detail view.
While it is on, the app sends that device your clicks and drags as touches,
trackpad scrolls as one-finger drags, and your keys. Turn it off before an agent
drives the device again. Command-key shortcuts stay with the app's menus, and a
mouse wheel without precise deltas does not scroll.

A simulator with more than one display, such as the iPhone Duo, shows every
display side by side, and touches go to the display you click. Only the
display the posture lights shows content; the other stays black. While Take
over is on, **Fold / Unfold** sweeps the simulated hinge to the other posture.
It runs the bundled `sim-fold` helper inside the simulator with `xcrun simctl
spawn`. The helper calls SpringBoard's private display tool service, so the
button appears only in the bundled app, and an iOS release can break it.

Android input goes through the emulator's gRPC `sendMouse` and `sendKey` calls.
Printable ASCII is sent as text; other keys, such as Delete, Return, Tab and the
arrows, are sent as key presses. Control shortcuts are not sent, and an
emulator without a gRPC endpoint cannot be taken over.

## Remote sessions

A workspace with a recorded EAS Simulator session from `stim ios --remote eas`
or `stim android --remote eas` shows a tile with a blue ring. The tile loads the
session's `webPreviewUrl` from `stim status --json` in a web view and marks the
session as billable. Its **Stop** button runs `stim stop` in the workspace after
a confirmation, which ends the session. A session with no recorded preview URL
shows a message instead of the page.

## Settings

**Stim > Settings** (Command-comma) edits Stim settings and the app's own
preferences.

The **Machine**, **Repository**, **Workspace** and **.stim.json** tabs are
generated from `settings.schema.json`, which the `stim` package ships beside
`dist/cli.mjs`; the app reads the one next to the resolved `stim` executable,
or `packages/stim-cli/dist` under `swift run`. Choices are pickers, booleans
toggles, numbers steppers, paths file pickers, string lists token fields, and
objects JSON fields. Values come from `stim settings --json` run in the chosen
workspace: each row shows the effective value and its layer, the lower layer a
value there overrides, an environment override when one is set, and a
**Reset** that unsets the layer. Edits run
`stim settings set|unset <key> --scope <layer> --json`, and a refusal shows
under the field. `android.keystorePassword` is never shown. Keys Stim does not
read are listed read-only.

The **App** tab holds preferences kept in `UserDefaults`, never in Stim's
config: appearance (Auto, Light, Dark), showing idle workspaces, opening to all
devices or the last project, device tile size, a live frame rate cap, pausing
frames while the window is hidden, the editor and terminal the workspace
inspector opens, notifications, a menu bar extra with the live workspace count
and quick open, launch at login, and a `stim` executable override that applies
at the next launch. Notifications and launch at login need the bundled app.

## Requirements

- macOS 14 or later and Xcode 27, selected with `xcode-select` or `DEVELOPER_DIR`. Stim Desktop falls back to `/Applications/Xcode.app` when the selected developer directory has no simulator support.
- `stim` on the login shell's `PATH`, `STIM_BIN` set to its path, or the override in Settings. The cleanup
  preview needs a `stim` with `gc --json`. At launch the app reads the
  environment of `zsh -lic` once and runs every `stim` command with it, so
  commands see the same `PATH` and variables such as `ANDROID_HOME` as a
  terminal.

## Develop

```bash
cd apps/desktop
swift run
swift test
```

## Build the app

```bash
apps/desktop/scripts/bundle.sh
open apps/desktop/build/Stim.app
```

The bundle copies Inter, JetBrains Mono, and the brand artwork from `website/`.

## Layout

- `Sources/StimKit`: models for the CLI's JSON, the login shell environment, the CLI client, project grouping, warning remedies, the streaming runner, `stim logs` records and the follow runner, and process, disk and gc usage. Unit-tested.
- `Sources/SimulatorFrames`: live simulator frames through CoreSimulator and input through SimulatorKit, both private Apple frameworks. Expect Xcode releases to break it.
- `Support/SimFold`: the `sim-fold` helper, an iOS Simulator executable that `scripts/bundle.sh` builds into the app's resources.
- `Sources/EmulatorFrames`: live emulator frames through the emulator's localhost gRPC `streamScreenshot` call, found through its discovery file, and input through the same endpoint. Emulators Stim booted before it passed `-grpc` show no frames until their next boot.
- `Sources/StimDesktop`: the SwiftUI app and its brand theme.
