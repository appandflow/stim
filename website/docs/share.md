---
title: 'Share a running app'
description: 'Give anyone a public, password-protected web link to watch, and optionally control, an app running in Stim'
---

import StimTabs from '@site/src/components/StimTabs';
import PromptBox from '@site/src/components/PromptBox';

A share gives anyone with the link and its password a browser view of one of
your workspace's devices. It is watch-only and ends after 60 minutes unless you
say otherwise. Open **Share…** from a running device's menu in Stim Desktop, or
ask your agent.

<PromptBox
title="Share with a client"
response={`Watch-only link for the iOS simulator, valid 30 minutes:
https://<your-machine>.ts.net/s/k3v9.../ and its password, to send separately.`}

>

{`Share the app running in this workspace's iOS simulator with a public link I can send to a client, watch only, for 30 minutes. Print the link and the password, then stop the share when I tell you the demo is over.`}
</PromptBox>

<StimTabs
code={`stim share ios
stim share android --control
stim share list
stim share stop`}
/>

If Stim is not installed globally, use `npx stim`. Send the link and the
password through different channels.

## Options worth knowing

| Option                | Meaning                                                                         |
| --------------------- | ------------------------------------------------------------------------------- |
| `--control`           | Viewers can also tap, type, rotate and press hardware buttons.                  |
| `--expires <minutes>` | 1 to 480 (default 60). There is no "never".                                     |
| `--password <value>`  | Your own password, 8 to 128 characters, instead of a generated one.             |
| `--no-password`       | No login: anyone with the link gets in, with control if you enabled it.         |
| `--view-password`     | With `--control`, a second password that only watches.                          |
| `--slug <name>`       | A readable link, `/s/<name>/`. Anyone can guess it, so it needs a password.     |
| `--reuse`             | Start a stopped share again with the same link and passwords, until it expires. |
| `--device`, `--slot`  | Share the leased phone, or another slot's device.                               |

`stim share stop` ends the workspace's shares and keeps their links for
`--reuse`. `stim share stop --forget` deletes them.

## What viewers get

Viewers see the device live, as video or JPEG, and see who else is watching.
With control they can click, type and use hardware buttons. A physical iPhone
is always view-only.

While a share runs, Stim keeps its workspace and device up, even when nobody
watches, so idle stop and cleanup wait until you stop it. If the device goes
away during a rebuild, the page says the share is stopped and resumes when the
device is back, within the original expiry.

## Requirements

- macOS or Linux, with a running simulator, emulator or leased device.
- A public route: Tailscale with Funnel allowed on this machine by your
  tailnet policy, or your own reverse proxy (below).

## Security

- A share opens a separate public listener for that one device's screen and,
  with `--control`, its input. The stim-server API stays private.
- Up to five viewers. Ten wrong passwords in ten minutes lock new logins for
  the rest of that window.
- Saved links and passwords stay in the workspace's Stim state with owner-only
  permissions. `--forget` removes them.
- Stim does not record a share, but the live screen, touches and clipboard can
  expose whatever the app or device shows.

## Your own domain

Without Tailscale, for example on a cloud VM running Caddy, serve shares
through your own reverse proxy:

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

`share.exposure` defaults to `auto`, which uses Funnel when Tailscale is
signed in and the proxy otherwise. The listener binds `127.0.0.1` only, so the
proxy runs on the same machine. It must end TLS and forward WebSocket
upgrades.

For the proxy's not-running page, reuse, restart behavior and the viewer's
options, run `stim guide share`.
