---
title: 'Stim Desktop'
description: 'Download the macOS app that shows the devices Stim runs'
---

Stim Desktop is a macOS app that shows every Stim workspace with its live
simulators and emulators, build progress, logs and settings. It runs `stim`
commands for you and reads Stim's state only through the CLI, so it needs
`stim` installed as described in [Getting started](./getting-started.md).

## Download

[Download Stim.dmg](https://github.com/appandflow/stim/releases/download/desktop-latest/Stim.dmg),
open it and drag **Stim** to **Applications**. The app is a universal build for
Apple silicon and Intel Macs, signed with Developer ID and notarized by Apple.
A 404 from that link means no stable desktop release is out yet; build the app
from source with `apps/desktop/scripts/bundle.sh` in the meantime.

That link always serves the newest stable release. Desktop releases are tagged
`desktop-v<version>`, apart from the CLI's `v<version>` releases, so GitHub's
"latest release" page shows the CLI. Every desktop version, release candidates
included, is listed under
[desktop-v releases](https://github.com/appandflow/stim/releases?q=desktop-v&expanded=true),
with a `SHA256SUMS` file for its downloads.

### Homebrew

Coming soon: the `appandflow/homebrew-tap` tap does not exist yet. Once it
does, install with:

```sh
brew install --cask appandflow/tap/stim
```

## Requirements

- macOS 14 or later.
- Xcode 27 for live simulator frames and input. The app loads Xcode's
  simulator frameworks from the selected developer directory, or from
  `/Applications/Xcode.app` when the selected one has none.
- `stim` on the login shell's `PATH`, or its path set in **Stim > Settings >
  App**.

## Show devices in the app

To show owned simulators and emulators in Stim Desktop instead of their own
windows, see [Devices and cleanup](./owned-devices.md).
