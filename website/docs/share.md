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
when the share expires, when you stop it, or when stim-server stops. They keep
working while you rebuild or relaunch the app: see
[When the device goes away](#when-the-device-goes-away).

<StimTabs
code={`stim share ios                  # watch only, for 60 minutes
stim share android --control    # viewers can tap, type and press buttons
stim share ios --expires 15     # 1 to 480 minutes; every share expires
stim share ios --password '<value>'  # your own password, 8 to 128 characters
stim share ios --no-password    # no login: the link alone opens it
stim share ios --slug pokedex   # a readable link, /s/pokedex/
stim share android --control --view-password  # a second, watch-only password
stim share list                 # shares, live or waiting
stim share stop                 # end this workspace's shares now
stim share ios --reuse          # start the stopped share again, same link and password
stim share stop --forget        # stop, and forget the saved links`}
/>

It prints the link and a generated password:

```text
Shared ios of /Users/me/app: view only, 0 viewers, expires 2026-11-02T19:12:00.000Z.
URL:      https://my-mac.tail1234.ts.net:10000/s/q3V...Yw/
Password: k7mfx2rbq9tnh4ze
Anyone with both can open it from the internet until it expires. The password is shown now and saved for --reuse.
Stop it with: stim share stop (add --forget to make the link unusable)
```

Send the link and the password over different channels. Stim saves the link and
the passwords on this machine so that [`--reuse`](#start-a-stopped-share-again)
can start the same share again, so a lost generated password is printed again
by `--reuse`, not lost. A password you set with `--password` is
never printed back; note that a value on the command line can land in your
shell history and in `ps` output while the command runs, so the generated one
is safer. With `--no-password` there is no login: anyone with the link can
watch, or control with `--control`. `stim share` warns about it on stderr and
`stim share list` marks the share "no password".

### A readable link

`--slug <name>` puts a name you choose in the link instead of the random token,
for a demo link someone can type or read aloud:

```text
Shared ios of /Users/me/app: view only, link /s/pokedex/, 0 viewers, expires 2026-11-02T19:12:00.000Z.
URL:      https://demo.example.com/s/pokedex/
Password: k7mfx2rbq9tnh4ze
Anyone with both can open it from the internet until it expires. The password is shown only now.
The link uses a chosen slug, so anyone can guess it: only the password keeps the share private.
Stop it with: stim share stop
```

A slug is 3 to 32 lowercase letters, digits and hyphens, starting and ending
with a letter or digit; `assets` is reserved. Because anyone can guess a slug,
the password becomes the share's only secret: `--slug` refuses with
`--no-password`, so keep the generated password or set a long one. Anyone who
knows the link reaches the login page and can use up the share's wrong-password
budget (see [Security model](#security-model)), which locks new logins for a while but
never signs out a viewer. While a share uses a slug, another `stim share
--slug` with the same name refuses with `STIM_SHARE_REFUSED` and names that
share; stopping it or its expiry frees the slug. `stim share list` and `--json`
show the slug. The stim-server must be as new as `stim`.

Prompt to try it:

```text
Share the iOS app of this workspace with stim share ios --slug <a short name for the app>, and send me the link and the password.
```

### A view password next to the control one

With `--control`, `--view-password` adds a second password that only watches.
`--password` (or the generated password) stays the control password, so you can
hand a client the view password and keep the control one:

```text
Shared android of /Users/me/app: view and control, view password, 0 viewers, expires 2026-11-02T19:12:00.000Z.
URL:              https://my-mac.tail1234.ts.net:10000/s/q3V...Yw/
Control password: k7mfx2rbq9tnh4ze
View password:    p2xqd8hs5nw3cvje
Anyone with the link and a password can open it from the internet until it expires. Generated passwords are shown now and saved for --reuse.
Stop it with: stim share stop (add --forget to make the link unusable)
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
button. The browser tab is titled with the app and the device, for example
"Pokedex Demo · iPhone 18 Pro · Stim", and never with the project or branch name.
The device sits below it inside its frame when Stim has artwork for it
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
actions, whether it drives the device with `stim agent-device` or, on an owned
simulator or emulator, with agent-device directly, and the host's touches. Names are kept only
in stim-server's memory while the share lives. A row of colored initials in the
top bar lists who is here; an eye marks the view-only ones. Click it to open a
People list with each person's role (controlling, can control or view only), the
host and the agent when they are on the device, and a Change name action on your own row.
Presence shows where
people tap, a PIN pad included. The screen is already shared, so this adds
little, but keep it in mind when the device shows secrets.

One viewer at a time holds the touch pointer: from finger down to finger up,
or until ten seconds pass without input. A touch from another viewer in the
meantime is dropped, and that viewer sees "Name is using the screen". A share
of a hosted session works the same, and also shows what an agent does on the
hosted device with `stim agent-device`: its command as "Agent", a ripple where
it tapped or swiped and an outline of the element it pressed. The outline
needs a `snapshot` of that session first.

A watch-only share has no button groups. The page fits the window without
scrolling. With `--control`, click the screen to tap and type with the keyboard. While the screen has focus,
the arrow keys and Escape go to the device as well (the D-pad keys and Escape
on Android, the hardware arrow and Escape keys on iOS). On an iOS simulator or an
Android emulator whose stim-server advertises `device-keyboard`, Shift with an arrow
and shortcuts go to the device too: Command on a Mac (Control on Windows and Linux)
is the shortcut key, and Option and, on a Mac, Control go with it, as in Command-A,
Command-Z and Option-Left. On Android, Command acts as Control. Command-V keeps
pasting your clipboard. While the screen has focus the page keeps these shortcuts
from the browser, such as Command-R and Command-L; click outside the screen to use
them. Keys do not reach the device while the focus is in a field of the page, such as the password or rename boxes.

With `--control` on an iOS simulator, an Android emulator or an Android phone,
Command-V (Control-V on Windows and Linux) while the screen has focus pastes the
text on your browser's clipboard into the focused field on the device. On an iOS
simulator, printable ASCII, line breaks and tabs are typed into the field (about 35
characters a second, with the field's own smart quotes and dashes), so no paste prompt
appears; other text is pasted with Command-V, which lands without a prompt in an
app Stim installed on an owned simulator (Stim allows its paste permission) and
can show an iOS prompt in any other app, where the page says to tap the paste
suggestion on the device. The options menu in the top bar has a "Sync clipboard" switch, on by default and
remembered by your browser. While the page is focused it copies new text from
the device to your browser's clipboard (a "Copy from device" chip appears when
the browser refuses), and in Chrome and Edge, after a one-time permission
prompt, it sends text you copied to the device when you return
to the page. In other desktop browsers press Command-V on the device screen. On a
phone or tablet (a touch-first browser) there is no automatic sync, because a
browser lets a page read or write the clipboard only inside a tap, and the menu has
two buttons instead. "Paste to device" sends your clipboard to the device: iOS Safari
shows its own small Paste button to confirm the read, and Android Chrome asks for
clipboard permission once. A denied or empty read shows a short note, and the text
goes to the device the same way as Command-V. "Copy from device" fetches the device
clipboard and writes it to your clipboard inside the same tap; when the browser still
refuses, the text appears in a field to select and copy by hand. On desktop the menu's
"Copy from device" button copies once. Sending your copied text to the device counts as input and starts the share's
control session like a paste. Syncing from the device starts once
a viewer that can control has connected, and does not keep an idle share's control
session alive. Everyone who controls the share with sync on shares the device
clipboard, so text one of them copies reaches the others. Text only, up to 8 KiB
sent to the device. A web page and a native macOS app have no clipboard action, and a share
without `--control` never reads the device clipboard.

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
once it catches up. A hosted session's video climbs to 4.5 Mbit/s at most.
Other browsers, and a browser whose decoder fails on the stream, get JPEG at 10
frames per second. A viewer that falls behind skips to the next keyframe
instead of building up delay, and a viewer that joins gets a keyframe right
away. Add `#jpeg` to the link to force JPEG.

Measured on a local iOS simulator share of a full-screen animation, in Chrome
through Funnel on the same Mac:

|       | Frames per second | Bandwidth  | Capture to screen      |
| ----- | ----------------- | ---------- | ---------------------- |
| H.264 | 54                | 4.8 Mbit/s | 7 ms median, 12 ms p95 |
| JPEG  | 9                 | 4.0 Mbit/s | not measured           |

A video viewer that joins while capture already runs sees its first frame in
about 50 ms; when it starts capture, the first frame takes several seconds.

## Start a stopped share again

`stim share stop` ends a share: its link stops working at once. Stim saves the
link and the passwords of every share that `stim share ios|android` starts, so
a share you stopped can come back with the same link and the same passwords
until it expires (a share that stim-server's restart ended comes back by itself,
see below):

<StimTabs
code={`stim share android --control --expires 120   # first start
stim share stop                              # the link stops working
stim share android --reuse                   # the same link and passwords, same expiry
stim share android --reuse --expires 60      # the same link, ending 60 minutes from now
stim share stop --forget                     # stop, and make the saved links unusable`}
/>

- `--reuse` takes the target from `ios|android`, `--device` and `--slot` as
  usual and starts that target's saved link. Whether it has control, whether it
  has a view-only password and which passwords it uses all come from the saved
  share, so `--control`, `--password`, `--no-password` and `--view-password`
  with `--reuse` fail with `STIM_BAD_ARG`. A generated password is printed again; a password you
  set is not.
- The expiry stays what it was: a share restarted with 10 minutes left still ends
  in 10 minutes. `--expires <minutes>` replaces it with that many minutes from now
  (1 to 480), so it can extend or shorten it, and the saved expiry follows.
  A share that expired cannot be reused.
- With no saved link for the target (no share was started for it, it expired, or
  it was forgotten) `--reuse` fails with `STIM_SHARE_NOTHING_TO_REUSE` and starts
  nothing. It never falls back to a new share, so it never prints a link nobody
  has. A link that is live or waiting now is refused.
- `--json` prints the usual payload plus `reused: true`, with `password` and
  `viewPassword` when they were generated. The link keeps its token; its address
  is the one the listener has now, and Stim says so when that differs from the
  saved one.
- `stim share stop` keeps the saved links and says so, with the platform and
  expiry (`reusable` in `--json`, never a secret). `stim share stop --forget`
  also deletes them, also when no stim-server runs.

The saved links live in `share-links.json` in the workspace's directory under
`$STIM_HOME/workspaces/`, readable only by you (mode 0600), written when a share
starts and removed with the workspace (`stim worktree remove`), by `--forget`, and
when `stim share` starts a share, reuses one or stops and finds them expired. They hold the link's 256-bit token
and the passwords in clear, so anyone who can read your Stim home can start the
share again until it expires. Each saved link also records whether its share is
running or was stopped on purpose. A stim-server restart or crash does not change
that: when a stim-server starts (the full server, not the one `stim share` starts for
a single share), it starts every saved share that is still running and has not
expired again, retrying for about two minutes while Tailscale is not up yet, with the same link, passwords and expiry, without `--reuse`; one
whose device is not there yet waits for it like any waiting share. Stopping a share,
including with Stim Desktop's Stop, marks it stopped so it does not come back.
A share started from Stim Desktop is not saved, so it does not come back.

## When the device goes away

A share follows its workspace's device in its slot, not one particular run of
the app. When that device goes away on its own (`stim ios` or `stim android`
reinstalls the app on a hosted session and closes its capture, the simulator or
emulator shuts down or is replaced, or its frame stream fails) the share does
not end. It **waits**:

- Viewers stay connected and signed in and see the last frame dimmed with
  "Waiting for the device...", and the bar says so.
- The link, the passwords, the signed-in browsers and the expiry stay as they
  were. A waiting share still expires at its expiry; there is no second timer.
- Control is released, and capture and the recording exemption stop. A new
  viewer can sign in and open the page while it waits.
- When the slot's device is back (a booted simulator or running emulator, or a
  ready hosted session) the share **resumes** on the same page: frames return
  with no reload and no new password, and control starts again for the viewers
  that can control. If the slot now runs another simulator or emulator, for example after
  `--device` picked another model, the share resumes on that one. After a
  failed stream the share tries again every few seconds, waiting longer after
  each failure, up to 30 seconds.

A viewer whose own connection drops, because stim-server restarted or updated,
the network changed or a phone slept, rejoins without a reload. The page keeps
the dimmed last frame and says "Reconnecting...", retries after a second and
then every few seconds (up to 15), and tries at once when the browser is back
online or the page is shown again. If the server no longer knows the sign-in,
for example after a restart, the page shows the login for the same link. If the
link is not found, it keeps checking every 30 seconds for 10 minutes, so a
share that comes back under the same link is joined again. When stim-server
itself stops, viewers are not told the share ended; their pages reconnect the
same way. "This share has ended." from a stop or an expiry is final.

`stim share list` shows `waiting for the device` on such a share, and `--json`
gives each share a `state` of `live` or `waiting`. A waiting share still counts
as a share: it keeps the workspace out of the idle stage, the Funnel route and a
`stim share`-started stim-server up.

Only an explicit stop ends a share before its expiry: `stim share stop`,
`stim stop` (the workspace, or one slot with `--slot <slot>`),
`stim worktree remove`, **Stop** in Stim Desktop, or stim-server stopping.

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
  that sends no H.264 gives video viewers JPEG at 10 frames per second. The session must be ready to start a share. When the session stops, is
  replaced or has its capture closed for an app install, the share waits (see
  [When the device goes away](#when-the-device-goes-away)) and resumes when a
  ready session of that slot is back. `stim share list` does not show the Mac.

## A live or waiting share keeps its workspace up

While a share is live or waiting, the [idle stage](./dev-server-and-logs.md#idle-stop),
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

Starting a share, and starting a saved share again when `stim-server` restarts,
holds the workspace's `native-run.lock` while Stim reads the device and registers
the share. An automatic shutdown or device deletion therefore runs before or
after the start, never in between. The start waits up to 30 seconds for a
`stim ios`, `stim android` or `stim stop` run or an automatic shutdown that holds
the claim, then fails with `STIM_SHARE_REFUSED` naming it; run `stim share` again
once it ends. A saved share retries on its own. `stim stop` waits for the few
seconds a start holds the claim.

## Options

| Option                | Meaning                                                                                                                                  |
| --------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `ios` / `android`     | Which of the workspace's devices to share.                                                                                               |
| `--control`           | Let viewers tap, type, rotate and press Home, Lock, Back or Apps.                                                                        |
| `--expires <minutes>` | Minutes until the share ends, 1 to 480 (default 60; with `--reuse`, the saved expiry). No "never".                                       |
| `--reuse`             | Start this target's saved link and passwords again, until it expires.                                                                    |
| `--forget`            | With `stop`, delete the workspace's saved links.                                                                                         |
| `--password <value>`  | Use this password, 8 to 128 characters, instead of a generated one.                                                                      |
| `--no-password`       | No login: anyone with the link can open the share.                                                                                       |
| `--view-password [v]` | With `--control`, a second password that only watches (generated without a value).                                                       |
| `--slug <name>`       | Use `/s/<name>/` as the link instead of a random token; needs a password.                                                                |
| `--device`            | Share the physical device the workspace leases.                                                                                          |
| `--slot <name>`       | Share the device of another [device slot](./commands.md#named-device-slots).                                                             |
| `--json`              | Print one payload: `url`, `auth`, `viewAuth`, `slug`, `expiresAt`, `control`, target; `password` and `viewPassword` only when generated. |

`stim share list` lists the shares of this Stim home with their target,
control, whether one waits for its device, viewer count and expiry, never their
link or password.
`stim share stop` ends every share of the current workspace. To end one share,
use **Stop** on its row in Stim Desktop's Settings > Connections > Using this machine > Share links.

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
the next listener, after the last share ends. With the background service and
`share.publicUrl` set, the listener stays bound (see below), so a changed
setting applies when the next share starts or the service restarts.

### Links that ended or never existed

When stim-server runs as the background service (`stim-server service install`)
and `share.publicUrl` is set in proxy mode, the share listener binds
`share.port` when the service starts and stays bound with no share live.
Without that, a visitor to an expired link would reach a closed port and see
your proxy's own empty 502 page. The listener answers every request that does
not belong to a live share, whatever the path and method, with a "This share
has ended or the link is wrong" page in the viewer's design and status 404.
A link that ended and one that never existed get the same answer: the server
keeps nothing about a share after it ends, not even the link's digest. The page
carries no share data and no list of shares, and sets `Cache-Control: no-store`
and a strict Content-Security-Policy.

Nothing else changes. The listener still binds `127.0.0.1` only, takes no
Tailscale route and no `server/share-route` claim, and closes when the service
stops. The on-demand `stim-server --share` that `stim share` starts still exits
after its last share, and Tailscale exposure is unchanged, so neither keeps a
listener. A port that is already taken is logged once in the server log, and
the next `stim share` refuses with the usual message that names `share.port`.

### When stim-server is not running

With nothing running, the proxy has no upstream to ask, so give it a page of its
own. `@stim-cli/server` ships `dist/share-viewer/not-running.html`: one file in
the same design, with its stylesheet inlined, no script and no link to the
listener. Copy it next to your proxy config. This takes it from the package on
a machine that has npm:

```bash
cd "$(mktemp -d)" && npm pack @stim-cli/server
tar -xzf stim-cli-server-*.tgz package/dist/share-viewer/not-running.html
sudo install -D -m 644 package/dist/share-viewer/not-running.html /var/www/stim-share/not-running.html
```

Answer 503, not 404: the demo is down for now and the same link works again
once Stim runs, which is what 503 means to browsers, monitors and search
engines. 404 is for a link that is gone, and the listener answers that itself.
The proxy replaces only its own failures (502, 503 and 504, which Caddy and
nginx produce when the upstream refuses the connection or times out), so the
listener's 404 page passes through untouched.

Caddy, with a `handle_errors` block:

```text
demo.example.com {
	reverse_proxy 127.0.0.1:7790

	handle_errors {
		@down expression {http.error.status_code} in [502, 503, 504]
		handle @down {
			rewrite * /not-running.html
			file_server {
				root /var/www/stim-share
				status 503
			}
		}
	}
}
```

`file_server` answers 200 unless `status` says otherwise. nginx, with
`proxy_intercept_errors` so an upstream error response is replaced too; only the
codes named in `error_page` are, so the listener's own 404 passes through:

```text
location / {
	proxy_pass http://127.0.0.1:7790;
	proxy_http_version 1.1;
	proxy_set_header Upgrade $http_upgrade;
	proxy_set_header Connection $connection_upgrade;
	proxy_intercept_errors on;
	error_page 502 503 504 =503 /not-running.html;
}

location = /not-running.html {
	internal;
	root /var/www/stim-share;
}
```

`$connection_upgrade` comes from the usual `map $http_upgrade $connection_upgrade`
block in the `http` context. Run `caddy validate` or `nginx -t` before you
reload.

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
  share data. Anything else, including an unknown or expired link, answers 404. No other device, log, file,
  command or stim-server method is reachable through it.
- **Secrets.** The link carries 256 random bits, unless `--slug` chose it; then the password is the only secret. The generated password is 16
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
  control session and device lease Stim Desktop and the phone app use. A viewer
  that can control starts the session, and so takes the device lease, when it
  connects; it ends after 5 minutes without input or when the last viewer leaves. Input is limited
  to taps, two-finger gestures, text, the arrow keys, Escape and keyboard shortcuts, pasting and syncing the clipboard with your browser, rotation and the hardware buttons of the shared device. A device an
  agent or another client is driving answers busy; a share never takes it over.
- **Saved link.** A share lives in stim-server's memory, but `stim share` also
  writes its URL token and passwords to `share-links.json` in the workspace's
  Stim state, mode 0600, for `--reuse`: see [Start a stopped share
  again](#start-a-stopped-share-again). `stim share stop` therefore pauses a link
  until it expires; `stim share stop --forget` makes it unusable. Nothing about a
  waiting share is saved beyond that.
- **Ephemeral.** Shares live only in stim-server's memory. A share ends at its
  expiry, on `stim share stop`, `stim stop` (the workspace, or one slot with
  `--slot`), `stim worktree remove`, Stop in Stim Desktop, and while stim-server
  is stopped; the next stim-server starts the saved, unexpired ones again. A device that goes away does not end it: the share waits
  and keeps its link, passwords and signed-in browsers; waiting itself is not
  written to disk.
  Ending closes its viewers' connections. The last share removes the Funnel
  route first and only then closes the listener; the listener a background
  service keeps in proxy mode stays bound until the service stops.
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
