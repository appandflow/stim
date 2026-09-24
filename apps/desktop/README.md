# Stim Desktop

A macOS app for supervising Stim workspaces: every worktree on the machine,
grouped by project, with its Metro port, supervisor health, errors, build cache
stats, and live frames from its iOS simulators.

It reads Stim state only through `stim status --json` and `stim stats --json`.
It never reads `$STIM_HOME`, and it runs no command that changes state.

## Take over a simulator

Simulator frames are view-only until you turn on **Take over** above a booted
iOS simulator in a workspace's detail view. While it is on, the app sends that
simulator your clicks and drags as touches, trackpad scrolls as one-finger
drags, and your keys. Turn it off before an agent drives the device again.
Command-key shortcuts stay with the app's menus, and a mouse wheel without
precise deltas does not scroll. Android input is not supported yet.

## Requirements

- macOS 14 or later and Xcode 27 at `/Applications/Xcode.app`, or `DEVELOPER_DIR` set to another Xcode.
- `stim` on the login shell's `PATH`, or `STIM_BIN` set to its path.

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

- `Sources/StimKit`: models for the CLI's JSON, the CLI client, project grouping, and warning remedies. Unit-tested.
- `Sources/SimulatorFrames`: live simulator frames through CoreSimulator and input through SimulatorKit, both private Apple frameworks. Expect Xcode releases to break it.
- `Sources/StimDesktop`: the SwiftUI app and its brand theme.
