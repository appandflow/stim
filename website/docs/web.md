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

`stim web` never starts a web server, for any framework. It opens, reuses or
reloads the owned Chrome at the page URL. Every web project follows the same
two steps: start your dev server, then run `stim web`.

<StimTabs
code={`stim web
stim logs --errors
stim reload web
stim stop`}
/>

Chrome runs headless by default. `--headed` shows its window.

## Expo web

An Expo app renders on the web through the same Metro server as iOS and
Android. With no `web.url` set, `stim web` opens `http://localhost:<metroPort>/`.
Its dev server is `stim start`. Install the web dependencies once, then start
Metro before `stim web`:

<StimTabs
code={`npx expo install react-dom react-native-web @expo/metro-runtime
stim start
stim web`}
/>

## Vite, Next, and other web servers

Start the server with its own command on a named port and point `web.url` at
it. In `web.url`, `{port:<label>}` becomes the workspace's named port and
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
| `web.url`                     | The page to open; unset opens the Metro URL for Expo                     |
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

### Monorepo recipe: a Vite package with a base path and HTTPS

In this layout, `apps/web` runs Vite through its `dev` script, serves the app
under `/apps/groups/`, and uses `@vitejs/plugin-basic-ssl`. `apps/mobile` is
the Stim app. The flow is the same as for any web project: start the dev
server, then run `stim web`. Set the page once per repository. The `repo`
layer is shared by every worktree, so a new worktree only registers the app and
starts the server:

<StimTabs
code={`cd apps/mobile
stim ports get web
cd ../web
stim settings set web.url 'https://localhost:{port:web}/apps/groups/' --scope repo
stim settings set web.ignoreCertificateErrors true --scope repo
pnpm dev --port "$(stim ports get web)" --strictPort`}
/>

Keep the dev server running in its own terminal, then work from `apps/web`:

<StimTabs
code={`stim web
stim logs --errors
stim reload web
stim stop`}
/>

- `stim ports get web` from the app directory registers the app without
  starting Metro. Run it before any `ports` or `web` command in the web package.
  A reservation made there first keeps the web package as its own workspace
  until you release it and run `stim stop`.
- Pass `--port` and `--strictPort` through the dev script. Otherwise Vite binds
  its configured port and moves to the next free one when that is taken.
- Put the base path in `web.url`. A path outside it can reach the dev server's
  proxy instead of the app.
- The certificate and scheme remedies print `--scope workspace`, which
  overrides the `repo` value for one worktree only.
- API calls that the dev server proxies to a backend that is not running show
  up as device errors in `stim logs --errors`. The page still loads.
- `stim stop` closes Chrome but leaves the dev server running. Use
  `stim ports stop web` to stop it. In a linked worktree, `stim worktree remove`
  stops both and deletes the profile.

Try it with an agent:

```text
Read stim guide web. Our web app is apps/web (Vite, served under
/apps/groups/, HTTPS with a self-signed certificate) and our Stim app is
apps/mobile. Run stim ports get web in apps/mobile. From apps/web, set web.url
to https://localhost:{port:web}/apps/groups/ and web.ignoreCertificateErrors
to true at --scope repo if stim settings shows them unset. Start
pnpm dev --port "$(stim ports get web)" --strictPort in the background, then
run stim web and stim logs --errors. Tell me whether the page loaded and which
errors it logged, and follow any printed remedy.
```

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
  than Metro answered. The remedy line names the fix. When nothing serves the
  page, it names this workspace's dev server step: `stim start` for Expo web,
  the `stim ports get web` recipe for any other server. A Metro port held by
  another process is also `"unverified"`; `stim start` then reserves a free
  port for this workspace. When this workspace's supervisor is still recorded,
  run `stim stop` first.

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

Each load of the page's top-level document starts a new error window: `stim
web`, `stim reload`, and a reload or navigation the page makes itself.
`stim logs --errors` and the `status` error count report the page's errors from
the latest load only, the way Chrome DevTools clears its console when the page
navigates. A page load does not hide the native app's errors, and a `stim ios`
or `stim android` launch does not hide the page's.

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
Read stim guide web. Start this app's dev server (stim start for Expo web),
open its web target with stim web, then run
stim logs --errors and tell me whether the page loaded and which errors it
logged. If launched is not true, follow the printed remedy.
```
