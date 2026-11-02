---
title: 'Share a running app'
description: 'Give anyone a public, password-protected web link to watch, and optionally control, an app running in Stim'
---

import StimTabs from '@site/src/components/StimTabs';

:::note[Command examples]

Commands use `stim`. If it is not installed globally, replace `stim` with
`npx stim`.

:::

`stim share` gives someone outside your tailnet a link to watch the app
running on this workspace's Stim-owned simulator or emulator, or on the
physical device it leases, in any browser. With `--control` they can also tap,
type and press the hardware buttons. The link and its password stop working
when the share expires, when you stop it, or when stim-server stops.

<StimTabs
code={`stim share ios                  # watch only, for 60 minutes
stim share android --control    # viewers can tap, type and press buttons
stim share ios --expires 15     # 1 to 480 minutes; every share expires
stim share list                 # live shares
stim share stop                 # end this workspace's shares now`}
/>

It prints the link and a generated password once:

```text
Shared ios of /Users/me/app: view only, 0 viewers, expires 2026-11-02T19:12:00.000Z.
URL:      https://my-mac.tail1234.ts.net:10000/s/q3V...Yw/
Password: k7mfx2rbq9tnh4ze
Anyone with both can open it from the internet until it expires. The password is shown only now.
Stop it with: stim share stop
```

Send the link and the password over different channels. Neither is stored, so
a lost password means a new share.

## Requirements

- **stim-server running** for this Stim home. Stim Desktop runs one; without
  Desktop, install the background server with `stim-server service install`.
  `stim share` refuses with `STIM_SERVER_NOT_RUNNING` otherwise.
- **Tailscale with Funnel.** The link is served through
  [Tailscale Funnel](https://tailscale.com/kb/1223/funnel). A tailnet admin
  must allow Funnel for this Mac in the tailnet policy; Stim never changes
  tailnet settings. One of the Funnel ports the policy allows (443, 8443 or 10000) must be unused in `tailscale serve status`.
- **A running device.** The workspace's owned simulator or emulator must be
  booted (run `stim ios` or `stim android` first), or, with `--device`, the
  physical device it leases. A physical iPhone is view only.

## Options

| Option                | Meaning                                                                      |
| --------------------- | ---------------------------------------------------------------------------- |
| `ios` / `android`     | Which of the workspace's devices to share.                                   |
| `--control`           | Let viewers tap, type and press Home, Lock, Back or Apps.                    |
| `--expires <minutes>` | Minutes until the share ends, 1 to 480 (default 60). No "never".             |
| `--device`            | Share the physical device the workspace leases.                              |
| `--slot <name>`       | Share the device of another [device slot](./commands.md#named-device-slots). |
| `--json`              | Print one payload: `url`, `password`, `expiresAt`, `control`, target.        |

`stim share list` lists the live shares of this Stim home with their target,
control, viewer count and expiry, never their link or password.
`stim share stop` ends every share of the current workspace.

## Security model

- **A separate listener.** stim-server serves shares on their own listener, on
  a loopback port apart from its API. Only `stim share` adds a Funnel route,
  and only to that listener, with
  `tailscale funnel --bg --yes --https=<port> http://127.0.0.1:<listener>`.
  Funnel never reaches stim-server's API, and `stim-server setup` and
  `service` never enable Funnel.
- **Three routes per share.** The viewer page, the frame stream of the one
  shared device, and, with `--control`, input to that same device. Anything
  else, including an unknown link, answers 404. No other device, log, file,
  command or stim-server method is reachable through it.
- **Secrets.** The link carries 256 random bits. The password is 16 random
  characters (about 79 bits), checked in constant time. Ten wrong passwords in
  ten minutes lock that share's login for the rest of the window, whatever the
  source address: anyone with the link can lock it, but cannot guess their way
  in. A correct password sets an `HttpOnly`, `Secure`, `SameSite=Strict`
  cookie for that share's path that ends with the share. The frame socket
  needs that cookie and a same-origin request. At most five viewers watch one
  share.
- **Nothing runs while nobody watches.** Capture starts when a signed-in viewer
  connects and stops about 10 seconds after the last one leaves. An idle share
  costs only its listener and route. A share never records anything to disk.
- **Control is the existing control path.** Input goes through the same
  control session and device lease Stim Desktop and the phone app use, limited
  to taps, text and the hardware buttons of the shared device. A device an
  agent or another client is driving answers busy; a share never takes it over.
- **Ephemeral.** Shares live only in stim-server's memory. A share ends at its
  expiry, on `stim share stop`, `stim stop` (without `--slot`),
  `stim worktree remove`, when its device stops or changes (so `stim stop
--slot` ends a share of that slot), and when stim-server stops or restarts.
  Ending closes its viewers' connections. The last share removes the Funnel
  route first and only then closes the listener.
- **Crash cleanup.** The route is recorded under an ownership claim in
  `$STIM_HOME/server/share-route`. When stim-server crashes, the next one
  removes the route on start, and only while the serve config still holds
  exactly that route. Until then, a route left by a crash stays public and
  points at a free loopback port.

## Try it with an agent

```text
Share the app running in this workspace's iOS simulator with a public link I can
send to a client, watch only, for 30 minutes. Print the link and the password,
then stop the share when I tell you the demo is over.
```
