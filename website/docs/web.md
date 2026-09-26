---
title: 'Web in an owned Chrome'
sidebar_position: 5
description: 'Run the web target in a Stim-owned headless Chrome with page logs in stim logs'
---

import StimTabs from '@site/src/components/StimTabs';

:::note[Command examples]

Commands use `stim`. If it is not installed globally, replace `stim` with
`npx stim`.

:::

`stim web` opens the workspace's page in a Chrome that Stim owns. It captures
the page's console calls, uncaught errors and failed requests in `stim logs`,
and reports whether the page loaded, the same way `stim ios` and
`stim android` do for native apps.

Stim uses the Google Chrome or Chromium already installed on the machine, with
a profile it creates under `STIM_HOME`. It never installs a browser, and
`stim doctor` reports a missing Chrome for a project that renders on the web.
Stim also never runs your web dev server; it only opens the page.

<StimTabs
code={`stim web
stim logs --errors
stim reload web
stim stop`}
/>

Chrome runs headless by default. `--headed` shows its window.

## Expo web

An Expo app renders on the web through the same Metro server as iOS and
Android. With no `web.url` set, `stim web` starts the workspace's Metro when it
is not running and opens `http://localhost:<metroPort>/`. Install the web
dependencies first:

<StimTabs
code={`npx expo install react-dom react-native-web @expo/metro-runtime
stim web`}
/>

## Vite, Next, and other web servers

Start the server yourself on a named port and point `web.url` at it. In
`web.url`, `{port:<label>}` becomes the workspace's named port and
`{port:metro}` its Metro port.

<StimTabs
code={`pnpm exec vite --port "$(stim ports get web)" --strictPort
stim settings set web.url 'http://localhost:{port:web}/' --scope workspace
stim web`}
/>

In a monorepo where the web app is its own package, such as `apps/web` beside
`apps/mobile`, run the commands from the web package. When that package depends
on neither `react-native` nor `expo` and holds no named ports of its own,
`stim ports`, `web`, `settings`, `logs`, `reload`, `stop` and `status` resolve
to the one Stim app registered in the same Git worktree. Each names the app on
stderr, and `status` stars it.
The port, the browser, `web.url` and the logs all belong to that app's
workspace. Register the app first by running `stim ports get web`,
`stim start`, `stim ios` or `stim android` from the app directory.

| Setting                       | Effect                                                                   |
| ----------------------------- | ------------------------------------------------------------------------ |
| `web.url`                     | The page to open; unset opens Metro for Expo                             |
| `web.ignoreCertificateErrors` | Accept a dev server's self-signed certificate, in the owned profile only |
| `web.viewport`                | `desktop` (1280×800, the default) or `phone` (390×844 at 3× with touch)  |

### HTTPS dev servers

A dev server with a self-signed certificate, such as Vite with
`@vitejs/plugin-basic-ssl`, fails with `net::ERR_CERT_AUTHORITY_INVALID` until
you accept the certificate in the owned profile:

<StimTabs
code={`stim settings set web.url 'https://localhost:{port:web}/' --scope workspace
stim settings set web.ignoreCertificateErrors true --scope workspace
stim web`}
/>

An `https://` URL on a plain HTTP server fails with `net::ERR_SSL_PROTOCOL_ERROR`,
and an `http://` URL on an HTTPS server with `net::ERR_EMPTY_RESPONSE`. The
remedy line names the scheme to use.

## What `launched` means

`stim web --json` reports `launched` from evidence inside the owned page, not
from a port that any tab can reach:

- `true`: the page's document answered and its load event fired. For Metro,
  the page also fetched a web bundle.
- `"bundling"`: Metro was still building the web bundle when the check ended.
- `"unverified"`: the document failed, for example with
  `net::ERR_CONNECTION_REFUSED` when nothing listens on the URL or
  `net::ERR_CERT_AUTHORITY_INVALID` for a self-signed certificate, or the page
  did not finish loading: 20 seconds with no answer, 60 once a server other
  than Metro answered. The remedy line names the fix.

A page that loads and then throws still reports `true`. Its errors are in
`stim logs --errors`.

## Logs

Page records carry `platform: "web"`:

- `client`: console calls at their level, and uncaught errors with stack
  frames.
- `device`: failed requests, browser messages such as CSP violations, and the
  browser's own lifecycle. A failed page document is an error, whatever its
  status. For other requests, a network failure or an HTTP 5xx is an error, a
  4xx a warning, and a canceled request debug. `stim logs --errors` includes
  these device errors.

Expo also prints web console calls on Metro, so they can appear twice: once
from the page and once from Metro.

`stim web` writes no launch marker, so `stim logs --errors` still lists page
errors from earlier runs. Add `--since 1m` to see only the latest load.

## Attach Playwright MCP or agent-browser

`stim status --json` reports `environments[].web.cdpEndpoint`, a reserved
loopback DevTools endpoint. Attach browser tools to it instead of letting them
start their own browser: Playwright MCP takes `--cdp-endpoint`, and
agent-browser takes `--cdp <port>`. The endpoint only reaches the Stim profile.
Chrome refuses remote debugging on your default profile, and Stim never
attaches to a browser it did not start.

## Cleanup

- `stim stop` closes Chrome and keeps the profile, so cookies and storage
  survive the next `stim web`.
- `stim worktree remove` closes Chrome and deletes the profile.
- `stim gc --delete` does the same for a workspace whose path is gone.

Stim signals Chrome only after it verifies the process identity it recorded,
and deletes a profile only when its ledger lists it.

Chrome and Chromium are the only engines. Stim Desktop and the phone app do
not show the browser yet.

Try it with an agent:

```text
Read stim guide web. Open this app's web target with stim web, then run
stim logs --errors and tell me whether the page loaded and which errors it
logged. If launched is not true, follow the printed remedy.
```
