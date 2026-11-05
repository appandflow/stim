---
title: 'Share a running app'
description: 'Give anyone a public, password-protected web link to watch, and optionally control, an app running in Stim'
---

import StimTabs from '@site/src/components/StimTabs';

Open **Share…** from a running device's menu in Stim Desktop, or run the CLI from its workspace. A share gives anyone with the link and access code a browser view of one device. The default is view-only and expires after 60 minutes.

<StimTabs
code={`stim share ios
stim share android --control
stim share list
stim share stop`}
/>

Send the link and access code separately. With `--control`, viewers can also tap, type and use hardware buttons. If Stim is not installed globally, use `npx stim`.

[Check the requirements](#requirements) or [see all options](#options).

### A readable link

Use `--slug pokedex` for a link ending in `/s/pokedex/`. Slugs use 3–32 lowercase letters, digits or hyphens and start and end with a letter or digit. `assets` is reserved. Anyone can guess a slug, so it requires an access code.

### A view password next to the control one

Use `--control --view-password` to generate a second access code for watching. The first code grants control. The second grants view only.

## The viewer

Open the link and enter the access code. The viewer shows who is watching and marks touches from the host, agents and other viewers. A viewer with control can click or tap, type and use the hardware buttons. Rotation is available on owned simulators and emulators. A physical iPhone is view-only.

### Video and JPEG

Browsers with compatible H.264 decoding get video. Other browsers fall back to JPEG. Add `#jpeg` to the link to force JPEG.

### Stats panel

Add `?stats` to the link to show a panel over the page with the video's round trip, frames per second, bitrate, delay and keyframe requests.

## Start a stopped share again

<StimTabs
code={`stim share android --reuse
stim share android --reuse --expires 60
stim share stop --forget`}
/>

`--reuse` restores the same link, access codes and permissions before the original expiry. Set `--expires` to change how long it lasts. `stim share stop` saves the link for later. Add `--forget` to delete it. A full stim-server restarts saved, unexpired shares that were running before it stopped.

## When the device goes away

A share waits during a rebuild or a temporary disconnect. The viewer resumes when the same slot has a running device again. The original expiry still applies. To end it early, use `stim share stop` or stop the workspace or slot.

## Requirements

- **macOS or Linux.** Use a compatible stim-server for the workspace's Stim home. The CLI starts a share-only server if needed and prints the install command if it cannot find one.
- **A running device.** Start an owned or hosted simulator or emulator first. Use `--device` to share a leased physical device.
- **A public route.** With Tailscale, your tailnet policy must allow Funnel on the host and one of its HTTPS ports must be free. You can also set up a [reverse proxy](#custom-domain).

## A live or waiting share keeps its workspace up

Stim keeps the workspace and device available until the share ends, even when nobody is watching. Stop the share to let idle shutdown and cleanup resume.

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

A viewer with control on a local iOS simulator also gets a **Device keyboard** switch in the viewer's Options menu. It is off by default, so the simulator draws no on-screen keyboard while a viewer types. On, the simulator draws its own keyboard for every viewer of that share, until someone turns it off or the share ends; stopping and restarting stim-server resets it to off. Android emulators, physical devices, macOS apps and hosted sessions have no switch.

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

- A separate public listener exposes the chosen device's screen and, with `--control`, its input. The stim-server API stays private.
- A share admits up to five viewers. Ten wrong codes in ten minutes lock new logins for the rest of that window. `--no-password` lets anyone with the link use the share, including control if you enabled it.
- Saved links and access codes live in the workspace's Stim state in `share-links.json` with owner-only file permissions. Stop with `--forget` to remove them.
- The share itself does not record video. A live screen, touches and clipboard can expose data from the app or device.

<StimTabs code="stim guide share" />

## Try it with an agent

```text
Share the app running in this workspace's iOS simulator with a public link I can
send to a client, watch only, for 30 minutes. Print the link and the password,
then stop the share when I tell you the demo is over.
```
