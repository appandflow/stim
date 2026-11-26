---
title: 'Phone app'
description: 'Pair a phone to watch Stim workspaces, devices and logs over Tailscale'
---

import StimTabs, { StimInstallTabs } from '@site/src/components/StimTabs';
import PromptBox, { PromptGrid } from '@site/src/components/PromptBox';

Stim Mobile shows your Mac's workspaces, builds, devices and logs on your phone,
so you can watch an agent's work away from your desk. With control access you can
also tap and type on the devices.

<PromptGrid>
  <PromptBox
    title="Build while you watch"
    response={`Trailhead launched on stim-trailhead (iPhone 17 / iOS 26.5).
com.appandflow.trailhead · ready · cache hit · errors clean
The workspace is running for you to view from your paired phone.`}
  >
    {`Run the app on iOS and tell me when it's ready; I'll watch from my phone.`}
  </PromptBox>
  <PromptBox title="Inspect recent errors" response={`No Trailhead app errors in the last 10 minutes.`}>
    {`Show app errors from the last 10 minutes.`}
  </PromptBox>
</PromptGrid>

## What you need

- An iPhone or iPad with Stim Mobile from TestFlight. Accept a Stim tester
  invitation in TestFlight to install it.
- A Mac running [Stim Desktop](./desktop.md), or the server from the CLI:

<StimInstallTabs />

- Tailscale on the Mac and the phone, signed in to the same tailnet. They can be
  on different networks.

In Desktop, the phone screens appear only once **Phone app** is on in
**Settings > Advanced > Feature flags**.

## Pair your phone

1. On the Mac, open **Settings > Connections > Using this machine > Add… > Pair a
   Phone…**. The wizard allows connections and sets up a private tailnet-only
   route. It never enables Funnel.
2. Choose **View Only** or **View and Control**.
3. On the phone, choose **Pair with Your Mac** and scan the QR code.

The code pairs one phone and expires after five minutes. If you cannot scan,
expand **Can't scan? Enter the endpoint and token** on the Mac and paste both
into the phone.

Without Desktop, print a pairing code on the Mac and paste it into the phone's
**Endpoint or pairing code** field:

<StimTabs code={`stim pair --json`} />

`stim pair` is read-only unless you add `--control`. It refuses while the server
serves this Mac only.

The phone checks the server's key fingerprint before it pairs, then trusts only
that key. Every connection is encrypted.

## Read and control access

| With read access                               | With control added                                 |
| ---------------------------------------------- | -------------------------------------------------- |
| Workspace status, builds and logs              | Reload an app and Stop the workspace               |
| Device screens and replay                      | Tap, swipe, pinch, type and use device buttons     |
| Changed and untracked text files in workspaces | Paste from the phone and copy the device clipboard |

Read access includes changed text files that git does not ignore, which can
include `.env` files. Pair only phones you trust.

To change access, choose **Change Access** on the phone's row in Desktop, or run
on the Mac:

<StimTabs code={`stim pairings grant <id> --control   # allow control
stim pairings grant <id> --read      # back to view only`} />

The phone cannot grant itself access. It cannot start a build, create a
worktree, edit files, set up a remote machine or approve access requests.

## Notifications

On the phone, open **Settings > Notifications** and turn them on. Every category
starts as **Silent**; choose **Alert**, **Silent** or **Off** per category.
Categories cover work starting or finishing, an agent that looks stuck, repeated
build failures, machine problems and problems that need a person.

On iPhone, the Mac can notify you while the app is closed. Delivery goes through
Expo's push service and Apple, and each notification carries the workspace path,
a title and a short cause. Android notifies only while the app is open.

## Revoke access

In Desktop, choose **Revoke Access…** on the phone's row, or run
`stim pairings revoke <id>` on the Mac. Its connections close at once, and the
phone must pair again. **Forget** on the phone only removes the Mac from the
phone; it does not revoke anything.

List pairings with `stim pairings`. Your agent finds the rest in
`stim guide settings`.
