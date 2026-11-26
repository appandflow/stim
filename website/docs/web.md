---
title: 'Web in an owned Chrome'
sidebar_position: 5
description: 'Run the web target in a Stim-owned headless Chrome with page logs in stim logs'
---

import StimTabs from '@site/src/components/StimTabs';
import PromptBox from '@site/src/components/PromptBox';

:::note[Command examples]

Commands use `stim`. If it is not installed globally, replace `stim` with
`npx stim`.

:::

`stim web` opens your web app in a headless Chrome that Stim owns, one per
workspace. The page's console, uncaught errors and failed requests land in
`stim logs`, and the run reports whether the page loaded, like `stim ios` does
for a native app.

<PromptBox
title="Run the web app"
response={`Page loaded at http://localhost:8083/ in the owned Chrome. errors clean`}

>

{`Start this app's dev server (stim start for Expo web), open its web target with stim web, then run stim logs --errors and tell me whether the page loaded and which errors it logged. If launched is not true, follow the printed remedy.`}
</PromptBox>

## How it works

`stim web` never starts a web server. You start the dev server, then run
`stim web`:

<StimTabs
code={`stim web
stim logs --errors
stim reload web
stim stop`}
/>

Stim uses the Google Chrome or Chromium already installed, with its own
profile under `STIM_HOME`. It never installs a browser and never touches your
default profile. `--headed` shows the window.

**Expo web** uses the same Metro as iOS and Android, so `stim start` is the dev
server and `stim web` opens `http://localhost:<metroPort>/`.

**Vite, Next and other servers** run with their own command on a port Stim
reserves, and `web.url` points at it:

<StimTabs
code={`pnpm exec vite --port "$(stim ports get web)" --strictPort
stim settings set web.url 'http://localhost:{port:web}/' --scope workspace
stim web`}
/>

In a monorepo, run these from the web package. A package that depends on
neither `react-native` nor `expo` uses the one Stim app registered in the same
worktree, so register the app first with `stim ports get web` from its
directory.

## Settings worth knowing

| Setting                       | Effect                                                                   |
| ----------------------------- | ------------------------------------------------------------------------ |
| `web.url`                     | The page to open; unset opens the Metro URL for Expo                     |
| `web.ignoreCertificateErrors` | Accept a dev server's self-signed certificate, in the owned profile only |
| `web.viewport`                | `desktop` (1280×800, the default) or `phone` (390×844 at 3× with touch)  |

## Browser tools

Playwright MCP and agent-browser can attach to the owned Chrome through the
loopback DevTools endpoint in `stim status --json`
(`environments[].web.cdpEndpoint`) instead of starting their own browser.
Their clicks, key presses and scrolls show up in `stim logs --source agent`.
Typed text is never recorded, only its length.

## Cleanup

- `stim stop` closes Chrome and keeps the profile, so cookies and storage
  survive. It also stops the workspace's Metro and devices.
- `stim stop --slot web` closes only Chrome; Metro and devices keep running.
- `stim worktree remove` closes Chrome and deletes the profile.
- A dev server you started yourself, such as Vite, keeps running. Use
  `stim ports stop web` to stop it.

Stim Desktop and the phone app show the page as a **Web** tile you can watch
and, with **Control**, click and type into. Chrome and Chromium are the only
engines.

For the `launched` states, log records and HTTPS remedies, run
`stim guide web`.
