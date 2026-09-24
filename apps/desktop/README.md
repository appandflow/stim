# Stim Desktop

A macOS app for supervising Stim workspaces: every worktree on the machine,
grouped by project, with its Metro port, supervisor health, errors, build cache
stats, live frames from its iOS simulators and Android emulators, and its CPU
and resident memory.

It reads Stim state only through `stim status --json`, `stim stats --json`, and
the `stim gc --json` dry run, and never reads or writes `$STIM_HOME`. Its
actions run the `stim` executable with an argument list, never a shell string,
in the workspace directory:

- Needs attention: preview `stim gc --json`, then run `stim gc --delete` after a
  confirmation; `stim start` for a worktree with no environment; `stim stop` or
  `stim android` for a status warning. Each row can also copy its command.
- Workspace inspector: `stim stop`, and `stim worktree remove` after a
  confirmation that names the worktree and its branch.

Output streams into an activity sheet with the exit status, and status refreshes
when the command finishes. Each workspace runs one action at a time.

Resource usage is measured with `ps` every 3 seconds: each workspace's
supervisor and Metro process trees plus the `launchd_sim` tree of each of its
simulators (matched by UDID) and the qemu process of each emulator (matched by
AVD name or console port). Memory is the sum of resident sizes, so memory
shared between processes counts more than once. The toolbar shows free space
on the volumes holding the repositories, `$STIM_HOME`, and CoreSimulator, and
what `stim gc --delete` would reclaim; the reclaimable figure needs a Stim
version with `gc --json`.

## Take over a simulator

Simulator frames are view-only until you turn on **Take over** above a booted
iOS simulator in a workspace's detail view. While it is on, the app sends that
simulator your clicks and drags as touches, trackpad scrolls as one-finger
drags, and your keys. Turn it off before an agent drives the device again.
Command-key shortcuts stay with the app's menus, and a mouse wheel without
precise deltas does not scroll. Android input is not supported yet.

## Requirements

- macOS 14 or later and Xcode 27, selected with `xcode-select` or `DEVELOPER_DIR`. Stim Desktop falls back to `/Applications/Xcode.app` when the selected developer directory has no simulator support.
- `stim` on the login shell's `PATH`, or `STIM_BIN` set to its path. The cleanup
  preview needs a `stim` with `gc --json`.

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

- `Sources/StimKit`: models for the CLI's JSON, the CLI client, project grouping, warning remedies, the streaming runner, and process, disk and gc usage. Unit-tested.
- `Sources/SimulatorFrames`: live simulator frames through CoreSimulator and input through SimulatorKit, both private Apple frameworks. Expect Xcode releases to break it.
- `Sources/EmulatorFrames`: live emulator frames through the emulator's localhost gRPC `streamScreenshot` call, found through its discovery file. Emulators Stim booted before it passed `-grpc` show no frames until their next boot.
- `Sources/StimDesktop`: the SwiftUI app and its brand theme.
