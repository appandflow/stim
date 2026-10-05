---
title: Support
description: Get help with the Stim iPhone and iPad app
---

# Support

Stim is published by App & Flow.

## Contact

Email [janic@appandflow.com](mailto:janic@appandflow.com) for help, questions, privacy requests and anything you do not want to post publicly.

For bugs and feature requests, open an issue on [GitHub](https://github.com/appandflow/stim/issues). Issues are public: do not include pairing QR codes, tokens, private network addresses, confidential paths or source code. In the app, **About** has a **Report a bug** button that opens a new issue with the app and device versions filled in.

## What the app needs

The app shows the workspaces, builds, devices and logs that Stim manages on your Mac. It does not compile projects itself. You need Stim on a Mac and a pairing between that Mac and your phone. The [Stim Desktop](/docs/desktop) page covers the Mac side, and [Getting started](/docs/getting-started) covers the command line tool.

## Pairing

1. On the Mac, open **Pair a Phone** in Stim Desktop.
2. In the app, scan the QR code, or enter the displayed address and pairing token by hand. Manual entry works without camera access.
3. A pairing token expires after five minutes. If it expired, create a new one.

If the phone cannot reach the Mac, check that the Mac is awake, that Stim Desktop or stim-server is running, and that the Mac is serving phones. If you reach the Mac over Tailscale, check that Tailscale is connected on both devices. A saved view shows the last status the phone received, not current status, until the connection returns.

## Controlling a device

A new pairing can look at workspaces, devices and logs. To tap and type on a device, the Mac has to grant the phone Control. Open the phone's entry in Stim Desktop's Phones settings to change its permissions. Some actions depend on the device type.

## Notifications

Notifications are off until you turn them on in the app and allow them in iOS Settings. Check the categories you want and the quiet hours. An event set to Silent goes to the notification list without a sound. Remote notifications also need the Mac's push service configured and able to reach Expo's push service.

## Disconnecting a phone

Remove a Mac from the app's machine list to stop the phone connecting to it. To also remove the phone's access and its push registration on the Mac, revoke the phone in Stim Desktop's Phones settings. For details on what the app stores and sends, see the [privacy policy](/privacy).
