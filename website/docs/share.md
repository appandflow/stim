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
stim share ios --password '<value>'  # your own password, 8 to 128 characters
stim share ios --no-password    # no login: the link alone opens it
stim share android --control --view-password  # a second, watch-only password
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
a lost password means a new share. A password you set with `--password` is
never printed back; note that a value on the command line can land in your
shell history and in `ps` output while the command runs, so the generated one
is safer. With `--no-password` there is no login: anyone with the link can
watch, or control with `--control`. `stim share` warns about it on stderr and
`stim share list` marks the share "no password".

### A view password next to the control one

With `--control`, `--view-password` adds a second password that only watches.
`--password` (or the generated password) stays the control password, so you can
hand a client the view password and keep the control one:

```text
Shared android of /Users/me/app: view and control, view password, 0 viewers, expires 2026-11-02T19:12:00.000Z.
URL:              https://my-mac.tail1234.ts.net:10000/s/q3V...Yw/
Control password: k7mfx2rbq9tnh4ze
View password:    p2xqd8hs5nw3cvje
Anyone with the link and a password can open it from the internet until it expires. Generated passwords are shown only now.
Stop it with: stim share stop
```

Give `--view-password` a value (8 to 128 characters) to choose it, or leave the
value out to have one generated, and put it last or write
`--view-password=<value>`. It refuses without `--control`, with
`--no-password`, and when it equals `--password`. A viewer that signed in with
the view password sees "View only" in the bar and gets no device controls; the
server drops every input it sends. It can enter the control password from the
bar ("Have the control password?") to raise itself to control, and keeps its
name and place. `--json` adds `viewAuth` and, when it was generated,
`viewPassword`. A share keeps 32 signed-in sessions. A new login drops the
oldest session with the same access first, so logging in with the view password
never signs out a control session (when only control sessions are left, the
view login is refused), and a share admits 30 new view sessions in ten
minutes.

## The viewer

The viewer follows the layout of the device viewer in Stim Desktop and uses the
same colors, in light or dark to match the browser. A bar across the top shows
a status dot with the platform and Live or Waiting, the time left before the
share expires, whether the share is Control or View only, and a Fullscreen
button. The device sits below it inside its frame when Stim has artwork for it
(an iOS simulator today) and as a rounded screen otherwise, scaled to fit any
window. With `--control`, button groups under the device hold:

- **Hardware buttons** (Home and Lock on iOS; Home, Back and Apps on Android).
- **Rotate left and right**, for an owned simulator or
  emulator. A physical device rotates only in hand. On an iOS simulator the
  device turns as in Simulator.app, so a portrait-only app shows sideways in a
  turned frame. On an emulator the picture turns only when the app in front
  supports the new orientation and auto-rotate is on.

Everyone watching sees who touches the screen: a colored dot with the person's
name, a short trail while they drag, and a ripple for a tap, for every viewer
with the share open and for the host when the device is controlled from Stim
Desktop or the phone app. The login page has an optional name field; a share
without a password asks for a name when you first open it, and you can skip.
Without a name a viewer is "Guest 1", "Guest 2" and so on. Host, Agent and
Guest N belong to the server, so a viewer that chooses one of them is shown as
its own Guest N. A viewer sees only the people of its own share, even when two
share links point at the same device; every share also shows the agent's
actions and the host's touches. Names are kept only
in stim-server's memory while the share lives. A row of colored initials in the
top bar lists who is here; an eye marks the view-only ones. Presence shows where
people tap, a PIN pad included. The screen is already shared, so this adds
little, but keep it in mind when the device shows secrets.

One viewer at a time holds the touch pointer: from finger down to finger up,
or until ten seconds pass without input. A touch from another viewer in the
meantime is dropped, and that viewer sees "Name is using the screen". A share
of a hosted session shows each viewer only its own touches.

A watch-only share has no button groups. The page fits the window without
scrolling. With `--control`, click the screen to tap and type with the keyboard. While the screen has focus,
the arrow keys and Escape go to the device as well (the D-pad keys and Escape
on Android, the hardware arrow and Escape keys on iOS).

With `--control` on an iOS simulator, an Android emulator or an Android phone,
Command-V (Control-V on Windows and Linux) while the screen has focus pastes the
text on your computer's clipboard into the focused field on the device. The
"Copy device clipboard" button in the toolbar copies the device's clipboard to
your computer. Nothing syncs on its own, text only, up to 8 KiB for a paste. A
web page and a native macOS app have no clipboard action, and a share without
`--control` never reads the device clipboard.

Two-finger gestures work on iOS simulators and on Android emulators and
phones, with `--control`. On a phone or tablet, use two fingers on the screen
(pinch to zoom, two-finger drag). With a mouse, hold Option and drag: the
second finger mirrors the first through the center of the screen, so dragging
away from the center spreads the fingers and toward it pinches them. Hold
Shift and Option and drag to move both fingers together. Small circles mark
the fingers while Option is held. A web page and a native macOS app take one
finger only.

### Video and JPEG

A browser that can decode H.264 with WebCodecs (Chrome and Edge, Safari 16.4
and later on macOS and iOS, Firefox 130 and later on desktop) gets the screen
as H.264 video at up to 60 frames per second, 1280 pixels on the long edge, at
3 to 8 Mbit/s: the bitrate drops while a viewer falls behind and climbs back
once it catches up. Other browsers, and a browser whose decoder fails on the
stream, get JPEG at 10 frames per second. A viewer that falls behind skips to
the next keyframe instead of building up delay, and a viewer that joins gets a
keyframe right away. Add `#jpeg` to the link to force JPEG.

Measured on a local iOS simulator share of a full-screen animation, in Chrome
through Funnel on the same Mac:

|       | Frames per second | Bandwidth  | Capture to screen      |
| ----- | ----------------- | ---------- | ---------------------- |
| H.264 | 54                | 4.8 Mbit/s | 7 ms median, 12 ms p95 |
| JPEG  | 9                 | 4.0 Mbit/s | not measured           |

A video viewer that joins while capture already runs sees its first frame in
about 50 ms; when it starts capture, the first frame takes several seconds.

## Requirements

- **macOS or Linux.** `stim` reaches the stim-server through its local socket,
  which Windows does not have. On Windows every `stim share` action refuses at
  once with `STIM_SHARE_REFUSED` and starts no server; run `stim share` on the
  macOS or Linux host that runs the device.
- **stim-server** for this Stim home. When none runs (no Stim Desktop or
  background service), `stim share` starts one in the background as
  `stim-server --share`: loopback only, from the `@stim-cli/server` package of
  the same version installed next to `stim`, else a `stim-server` on `PATH`
  that reports that version. It prints the server's pid and log
  (`$STIM_HOME/server/share-server.log`) on stderr. That server stops on its
  own when its last share ends, or after 2 minutes without one, and removes its
  Funnel route first, and stays up retrying while that removal fails;
  `stim share stop` also stops it. If the Stim home does not answer when it
  starts, it exits at once and `stim share` reports its log. A server Stim Desktop or
  the background service runs is never stopped. Without a matching
  `@stim-cli/server`, `stim share` refuses with `STIM_SERVER_NOT_RUNNING` and
  the install command.
- **A way to reach the listener from the internet**, chosen by
  `share.exposure`:
  - **Tailscale with Funnel.** The link is served through
    [Tailscale Funnel](https://tailscale.com/kb/1223/funnel). A tailnet admin
    must allow Funnel for this Mac in the tailnet policy; Stim never changes
    tailnet settings. One of the Funnel ports the policy allows (443, 8443 or 10000) must be unused in `tailscale serve status`.
  - **Your own reverse proxy and domain**, see [Custom domain](#custom-domain).
  - `auto`, the default, uses Funnel when the `tailscale` command is installed
    and logged in, and your proxy otherwise.
- **A running device.** The workspace's owned simulator or emulator must be
  booted (run `stim ios` or `stim android` first), or, with `--device`, the
  physical device it leases. A physical iPhone is view only.
- **Or a hosted session.** A workspace whose device runs on another Mac
  (`stim ios --remote <machine>`, `stim android --remote <machine>`) is shared
  the same way, from a machine with no simulators of its own. This machine's
  stim-server serves the share and relays frames and input through its
  existing connection to that Mac's device-host; the Mac sees only the view
  and control traffic this machine's own viewers would send, and needs no new
  approval. Video viewers and JPEG viewers each share one host stream; a host
  that sends no H.264 gives video viewers JPEG at 10 frames per second. The session must be ready. The share ends when the session stops
  or is replaced, and `stim share list` does not show the Mac.

## A live share keeps its workspace up

While a share is live, the [idle stage](./dev-server-and-logs.md#idle-stop),
the [pressure ladder](./build-caches.md#disk-pressure) and the
[dormant stage](./owned-devices.md#cleanup-behavior) leave its workspace
running, whether or not anyone is watching, and the `stim-daemon` never shuts
its device down for another run waiting for a device slot; that run keeps
waiting and its progress line names the share. Automatic maintenance and
`stim gc --delete` keep the devices of its finished worktree too. Frames
streamed to viewers are not activity, so the share alone holds it. `stim status` names the share on the
workspace's stage line, and the `stim-daemon` logs it as `workspace_kept`.
Run `stim share stop`, or let the share expire, and a workspace with no
activity for `idle.minutes` goes idle on the daemon's next tick. When
stim-server cannot list its shares, Stim keeps the workspace running.

## Options

| Option                | Meaning                                                                                                                          |
| --------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `ios` / `android`     | Which of the workspace's devices to share.                                                                                       |
| `--control`           | Let viewers tap, type, rotate and press Home, Lock, Back or Apps.                                                                |
| `--expires <minutes>` | Minutes until the share ends, 1 to 480 (default 60). No "never".                                                                 |
| `--password <value>`  | Use this password, 8 to 128 characters, instead of a generated one.                                                              |
| `--no-password`       | No login: anyone with the link can open the share.                                                                               |
| `--view-password [v]` | With `--control`, a second password that only watches (generated without a value).                                               |
| `--device`            | Share the physical device the workspace leases.                                                                                  |
| `--slot <name>`       | Share the device of another [device slot](./commands.md#named-device-slots).                                                     |
| `--json`              | Print one payload: `url`, `auth`, `viewAuth`, `expiresAt`, `control`, target; `password` and `viewPassword` only when generated. |

`stim share list` lists the live shares of this Stim home with their target,
control, viewer count and expiry, never their link or password.
`stim share stop` ends every share of the current workspace. To end one share,
use **Stop** on its row in Stim Desktop's Settings > Web Shares.

Stim Desktop makes, lists and stops shares too: see [Stim Desktop](./desktop.md).

## Custom domain

Without Tailscale, for example on a cloud VM that already runs Caddy, serve
shares through your own reverse proxy and domain. Point the proxy at the
loopback port the share listener binds, and tell Stim the public address:

```bash
stim settings set share.exposure proxy
stim settings set share.publicUrl https://demo.example.com
stim settings set share.port 7790
```

```text
demo.example.com {
	reverse_proxy 127.0.0.1:7790
}
```

`share.exposure` is `auto` by default, which already picks proxy mode when the
`tailscale` command is missing or logged out; set it to `proxy` to never use
Tailscale, or to `tailscale` to always use Funnel. The three machine settings
mean:

| Setting           | Meaning                                                                                                                                                                                  |
| ----------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `share.exposure`  | `auto` (default), `tailscale` or `proxy`.                                                                                                                                                |
| `share.publicUrl` | The `https` origin your proxy serves, optionally with a path prefix. Links print under it. Without it, `stim share` prints a loopback link and warns that it works only on this machine. |
| `share.port`      | The loopback port the listener binds in proxy mode (default 7790), so the proxy config can name it. A port in use refuses the share.                                                     |

In proxy mode Stim never runs `tailscale serve` or `tailscale funnel`. The
listener binds `127.0.0.1` only, so the proxy must run on the same machine.
The password, cookie, lockout, viewer limit and capture-only-while-watched
behavior are the same as with Funnel. The proxy has to:

- end TLS, because the session cookie is `Secure`;
- forward WebSocket upgrades (Caddy's `reverse_proxy` does; nginx needs the
  `Upgrade` and `Connection` headers);
- leave a path prefix in place if `share.publicUrl` has one, such as
  `https://example.com/stim`. In Caddy use `handle /stim/*`, not
  `handle_path`.

It does not need to preserve the `Host` header or send `X-Forwarded-Host`: the
frame socket accepts exactly the origin of `share.publicUrl` and ignores
`Host` and `X-Forwarded-*`, so a request that does not come from the page at
that address is refused. A setting changed while a share is live applies to
the next listener, after the last share ends.

## Security model

- **A separate listener.** stim-server serves shares on their own listener, on
  a loopback port apart from its API. With Funnel, only `stim share` adds a
  Funnel route, and only to that listener, with
  `tailscale funnel --bg --yes --https=<port> http://127.0.0.1:<listener>`.
  Funnel never reaches stim-server's API, and `stim-server setup` and
  `service` never enable Funnel. In proxy mode nothing is added to Tailscale.
- **Three routes per share.** The viewer page, the frame stream of the one
  shared device, and, with `--control`, input to that same device. The page's
  stylesheet and script are static files under `/s/assets/`; they hold no
  share data. Anything else, including an unknown link, answers 404. No other device, log, file,
  command or stim-server method is reachable through it.
- **Secrets.** The link carries 256 random bits. The generated password is 16
  random characters (about 79 bits); one you set is 8 to 128 characters.
  Either is kept only as a SHA-256 digest and checked in constant time. With
  `--view-password` a login is compared with both digests, always both, and the
  matching one sets the session's access, kept in server memory and never in the
  cookie: the server drops every input from a view session, whatever the page
  sends. A share with `--no-password` has no login, so the link is its only secret. Ten wrong passwords in
  ten minutes lock that share's login for the rest of the window, whatever the
  source address: anyone with the link can lock it, but cannot guess their way
  in. A correct password sets an `HttpOnly`, `Secure`, `SameSite=Strict`
  cookie for that share's path that ends with the share. The frame socket
  needs that cookie and a same-origin request; without a password the link
  alone admits the page and the frame socket, still same-origin only. At most
  five viewers watch one share.
- **Nothing runs while nobody watches.** Capture starts when a signed-in viewer
  connects and stops about 10 seconds after the last one leaves. An idle share
  costs only its listener and route. A share never records anything to disk.
- **Control is the existing control path.** Input goes through the same
  control session and device lease Stim Desktop and the phone app use, limited
  to taps, two-finger gestures, text, the arrow keys and Escape, pasting your clipboard into the device and copying the device's clipboard to your computer, rotation and the hardware buttons of the shared device. A device an
  agent or another client is driving answers busy; a share never takes it over.
- **Ephemeral.** Shares live only in stim-server's memory. A share ends at its
  expiry, on `stim share stop`, `stim stop` (without `--slot`),
  `stim worktree remove`, when its device stops or changes (so `stim stop
--slot` ends a share of that slot), when the device's frames fail, and when
  stim-server stops or restarts.
  Ending closes its viewers' connections. The last share removes the Funnel
  route first and only then closes the listener.
- **Crash cleanup.** With Funnel, the route is recorded under an ownership claim in
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
