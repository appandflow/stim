---
title: 'Phone app'
description: 'Pair a phone to watch Stim workspaces, devices and logs over Tailscale'
---

import StimTabs, { StimInstallTabs } from '@site/src/components/StimTabs';
import Tabs from '@theme/Tabs';
import TabItem from '@theme/TabItem';
import PromptBox, { PromptGrid } from '@site/src/components/PromptBox';

Stim Mobile connects to a Mac running Stim Desktop or `stim-server`. It shows
workspaces, builds, devices and logs. Pairings are read-only by default;
you can allow a phone to control devices and run Reload and Stop from the Mac.
It can keep connections to several paired Macs.

## Install

The repository documents iOS distribution through TestFlight. Install
TestFlight on your iPhone or iPad, then accept a Stim tester invitation.
External builds become installable only after Apple's Beta App Review.
The repository also contains App Store listing metadata and a manual release
configuration; that does not confirm a live App Store listing. See the
[mobile release notes for contributors](https://github.com/appandflow/stim/blob/main/apps/mobile/README.md#ship-to-testflight)
for the distribution process.

For CLI commands on the Mac, install Stim globally or run it with npx:

<StimInstallTabs />

The app also supports Android, but the documented production distribution
flow is iOS TestFlight. Contributors can build the app from
[apps/mobile](https://github.com/appandflow/stim/blob/main/apps/mobile/README.md#develop).

## What you need

- A Mac running [Stim Desktop](./desktop.md), or the server from
  `@stim-cli/server`.
- Tailscale running on the Mac and phone, signed in to the same tailnet.
- **Serve to phones** enabled in Desktop, with a verified private route.
  A standalone server needs the equivalent Tailscale Serve route.

Install Tailscale on the phone, sign in and turn its connection on. Both
devices can be on different networks as long as they can reach each other
through Tailscale.

On the first launch without a saved Mac, the welcome screen lists these
requirements. **Get Tailscale** opens the phone's store; **Pair with your Mac**
opens the scanner. **Not now** dismisses the welcome screen for later launches.
After pairing, the app opens its workspace list. Forgetting a Mac does not
bring back a welcome screen you have already dismissed or completed.

## Serve to phones

On the Mac, open **Stim > Settings > Phones** and turn on **Serve to phones**.
Desktop runs the server while it is open, or uses one already running.
Choose **Set up connection** when a private route is missing. If Tailscale
asks to enable HTTPS, approve its browser setup and retry. Pairing remains
unavailable until the route is verified.

The route is private to the tailnet. Setup preserves existing routes and
never enables Funnel. Do not put this server behind a Funneled port: that
makes its handlers public, and pairing refuses.

For a standalone server, use the
[server's Tailscale instructions](https://github.com/appandflow/stim/blob/main/packages/server/README.md#tailscale)
to configure the route. Keeping the Mac's server running is required for live
viewing and server-delivered notifications.

## Pair your phone

1. In Desktop's **Settings > Phones**, choose **Pair a Phone...**.
2. In the phone app, choose **Pair with your Mac** from the welcome screen,
   or **Pair a machine** from Machines. Allow the camera and scan the QR code.
3. Name the machine and choose **Save** to open the workspace list.

The code pairs one phone and expires after five minutes. It is consumed once;
a second phone needs a new code. If scanning fails or camera access is denied,
choose **Enter the endpoint and token instead** and copy the **Endpoint** and **Token** from
Desktop into the phone's fields. Manual entry uses the same single-use code.
Choose **New Code** on the Mac when it expires, and **Retry** on the phone
when a failed scan needs another attempt.

A standalone server can print the same pairing payload:

<Tabs groupId="stim-invocation" defaultValue="global">
<TabItem value="global" label="Global">

```bash
stim-server pair --json
```

</TabItem>
<TabItem value="npx" label="npx">

```bash
npx --yes --package @stim-cli/server@1.16.0 stim-server pair --json
```

</TabItem>
</Tabs>

Use its endpoint and pairing token for manual entry. The server binds the
resulting device token to the phone's tailnet node; the token alone does not
permit a connection from another node.

### Read and control access

A read-only phone can see workspace status, builds, logs, device screens and
replay. With workspace diff support, it can also read changed and untracked
text files in registered workspaces, including non-ignored `.env` files.

To allow input, turn on **Allow control** for the phone in Desktop's
**Settings > Phones**, or run `stim-server devices grant <id> --control` on
the Mac. Use `--read` to take control away while retaining viewing access.
The server's npx prefix is shown above. The phone's **Allow control** action
explains this Mac-side change; it cannot grant itself access. **Reconnect**
picks up a new grant. Revoked control ends active control sessions and the
phone reconnects with its current scope.

## Notifications

Open **Settings > Notifications** on the phone and turn notifications on.
The app requests system permission at that point, not on launch. Every
category defaults to **Silent**. Choose **Alert** for a banner and sound,
**Silent** for Notification Center only, or **Off** for no delivery. Quiet
hours suppress delivery; problems that still hold afterward can notify then,
while work events during quiet hours are dropped.

Categories cover work starting or finishing, an agent that looks stuck,
repeated build failures, machine problems, device takeovers and problems that
need a person. A single failed build or new log error stays in **Needs
attention** rather than notifying by itself.

On a production iPhone build with working push credentials, a push-capable
Mac server can deliver notifications while the app is open, backgrounded or
closed. The Mac must be running and the phone must have network access.
Delivery uses Expo's push service and Apple; payloads include the workspace
path, title and a short cause. A Mac going offline is detected only while
the phone app is open. Android and builds without push support notify only
while the app is open. The notification inbox shows history from paired
servers that support it.

## Revoke access

In Desktop's **Settings > Phones**, choose **Revoke** for the phone, or run
`stim-server devices revoke <id>` on the Mac. Revocation closes its active
connections; the server checks registrations on changes and once a second.
The phone must pair again to reconnect.

**Forget** on the phone removes the saved Mac and its local status. To revoke
the server's authorization, use the Mac-side action above.

## What the phone can do

| With read access                                                | With control added                                                  |
| --------------------------------------------------------------- | ------------------------------------------------------------------- |
| Watch builds and workspace status.                              | Reload the app and Stop the workspace.                              |
| Read captured logs, build diagnostics and supported text diffs. | Tap, swipe, type and use supported buttons on controllable devices. |
| View device screens and supported replay.                       | Control a leased Android phone while its lease is valid.            |

The build sheet shows build and device slot waits alongside the current phase,
with the number of slots in use and a live elapsed wait timer. A device slot
wait can overlap compilation. Older CLIs omit this information.

A leased iPhone connected over USB is view-only and must be unlocked and trust
the Mac; over Wi-Fi it has no screen stream. Hosted iOS simulators can be viewed
and controlled through the main Mac's relay, with **Serve to phones** enabled.
See [remote machines](./remote-machines.md) for host setup.

The phone cannot start a build, create a worktree, edit or stage source files,
set up a build machine, or approve access requests. Have your coding agent run
the app on the Mac, then watch it from the phone. It does not run your project's
native app on the phone itself.

## Ask your agent

These prompts are for the coding agent working in your app's checkout.
Responses are illustrative.

<PromptGrid>
  <PromptBox
    title="Build while you watch"
    response={`Trailhead launched on stim-trailhead (iPhone 17 / iOS 26.5).
com.appandflow.trailhead · ready · cache hit · errors clean
The workspace is running for you to view from your paired phone.`}
  >
    {`Run the app on iOS and tell me when it's ready; I'll watch from my phone.`}
  </PromptBox>
  <PromptBox
    title="Inspect recent errors"
    response={`No Trailhead app errors in the last 10 minutes.`}
  >
    {`Show app errors from the last 10 minutes.`}
  </PromptBox>
</PromptGrid>

The agent can inspect the environment and recent errors with:

<StimTabs
code={`stim status --json
stim logs --errors --since 10m`}
/>
