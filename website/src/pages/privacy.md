---
title: Privacy policy
description: What the Stim iPhone and iPad app collects, who receives it, and how to remove it
---

# Privacy policy

Last updated: October 5, 2026.

This policy covers the Stim app for iPhone and iPad ("the app"), published by App & Flow ("we"). Questions and requests go to [janic@appandflow.com](mailto:janic@appandflow.com).

## Summary

- The app has no account, no advertising, no analytics and no tracking. We do not sell data.
- The app shows development work from your own Mac. It connects only to the Stim servers you pair it with. We do not run a server that your workspaces, logs, device screens or input pass through.
- Three outside services receive data: Expo (app updates, and push notifications if you turn them on), Apple (push delivery), and Sentry (crash reports). They are described below.

## What stays between your phone and your Macs

Pairing sends a short-lived pairing code, the phone's name and the app's name and version to the Mac you are pairing with. The Mac returns a token that the phone stores in the iOS Keychain, with the Mac's name and address, so it can reconnect.

After pairing, your Mac sends the phone what the app displays: workspace and project names and paths, branches, build status, simulator and emulator information, machine usage, logs, and live device screens. When your Mac grants the phone Control, taps, key presses and typed text go to the Mac. Logs and screens can contain whatever your own apps and tools print or show.

These connections use `wss://`. The app accepts plain `ws://` only for an address on the phone itself. Remote reachability is up to your own network setup, for example Tailscale. The app does not include Tailscale or any other network provider's code.

The Mac's Stim server keeps a record of each paired phone: its name, a hash of its token, its network identity, its permissions and when it connected. If you turn on push notifications, it also keeps the phone's push token and notification settings. It can keep device screen recordings for replay and a short notification history on that Mac. This data stays on your Mac, and App & Flow cannot access it.

## What the phone stores

- In the iOS Keychain: the list of paired Macs and each Mac's token.
- In app storage: the last workspace status for each Mac, so the app has something to show while reconnecting, your notification and display settings, which notifications you have read, and the push token if you enabled push.
- In memory only: live status, streamed logs, device video, and the notification inbox.

The camera is used only to read the pairing QR code on the phone. The image is not stored or sent anywhere. You can type the pairing details instead. The app does not use the microphone, your location, your contacts or your photos, and it does not request permission for tracking.

## What third parties receive

**Expo (app updates).** The app checks Expo's update service, on launch and when it returns to the foreground, for newer app code. A request includes the app's project and release channel, platform and runtime version, the IDs of the running update, a random client ID that Expo's update library creates for this installation, and the network address of the request. If an update fails to start, the next request can include a short error message. Expo's [privacy policy](https://expo.dev/privacy) applies.

**Expo and Apple (push notifications, only if you turn them on).** Notifications are off until you enable them. When you do, the app registers with Apple and Expo, which receive the phone's push token, a random installation ID and the app's identifiers. The app sends the resulting Expo push token and your notification settings to your paired Macs. To notify you, a Mac sends the notification text and its navigation data to Expo, which passes it to Apple's push service. That text can include your Mac's name, workspace paths and device names. If you turn notifications off, the app asks each connected Mac to remove its registration. Notifications can also appear on your lock screen, depending on your iOS settings. Expo's and Apple's privacy policies apply.

**Sentry (crash reports).** Builds of the app that include a Sentry key send crash and error reports to Sentry. A report can include the error message, stack trace, device model and iOS version, app version and build, the running update's ID and channel, a short trail of recent app events, and a random ID that Sentry's library creates for this installation. The app turns off screenshots, view hierarchy, network request logging and session tracking, and does not send usage analytics. Before a JavaScript error leaves the phone, the app replaces URLs, IP addresses, `.ts.net` and `.local` host names, push tokens, long token-like strings and `/Users/<name>` folders in it. Crash reports built by the iOS native layer are not run through that step, so error text in them can contain more. Sentry's [privacy policy](https://sentry.io/privacy/) applies.

We use this data to run the app, deliver updates and notifications, and find and fix crashes. We do not use it for advertising or to build profiles, and we do not link it with data from other companies.

When you share or copy a log, or open a link from the app, the app or website you choose receives what you picked. Links open in your browser.

## Control and deletion

- To disconnect a Mac, remove it from the app's machine list. This deletes its token and cached status from the phone and asks the Mac to remove the phone's push registration when the Mac is reachable.
- Removing a Mac in the app does not revoke the phone on that Mac. To remove the phone's access and its push registration, revoke the phone in Stim Desktop's Phones settings. If you removed a Mac while it was offline, its push registration stays until you revoke the phone there.
- To stop recording device screens on a Mac, turn off recording in its Stim settings.
- Deleting the app removes the phone's local app data. iOS can keep Keychain items after an app is deleted, so remove each Mac in the app first if you want its token gone.
- You can turn off notifications in the app and in iOS Settings, and camera access in iOS Settings.

For crash reports and update requests, which are held by Sentry and Expo, email us to ask what is held about your device or to request deletion, and we will pass the request on to them. These records contain random installation IDs and no name or email address, so we may not be able to find yours unless you can give us an ID.

## Children

The app is a developer tool and is not directed at children. We do not knowingly collect data from children.

## Changes

If we change this policy, we post the new version here with a new date. If a change affects what the app collects, we will also update the app's App Store privacy details.

## Contact

App & Flow, [janic@appandflow.com](mailto:janic@appandflow.com). For help with the app, see [Support](/support).
