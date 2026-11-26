---
title: 'Dev server and logs'
sidebar_position: 4
description: 'A supervised Metro server per workspace and one queryable log timeline'
---

import StimTabs from '@site/src/components/StimTabs';
import PromptBox from '@site/src/components/PromptBox';

:::note[Command examples]

Commands use `stim`. If it is not installed globally, replace `stim` with
`npx stim`.

:::

Each workspace gets its own dev server on its own port, and every log from
Metro, the app, the device and the build lands in one timeline your agent can
query. You rarely start either by hand: a Debug `stim ios` or `stim android`
starts the dev server when it is not running.

<PromptBox
title="Check the app for errors"
response={`No app errors since the last launch. Metro on port 8083 is running.`}

>

{`Show me this workspace's app errors since the last launch, then tell me which dev server Stim is running and on which port.`}
</PromptBox>

## The dev server

`stim start` reserves a port, starts the dev server and returns once it answers
as this project's. Stim picks the server from the project's files, never from a
`package.json` script:

1. `metro.command` when set.
2. Re.Pack, when `rock.config.*` or `react-native.config.*` loads it.
3. The Expo CLI for an Expo app.
4. Otherwise plain Metro.

`stim start` names the file that decided. The dev server runs on the Node the
project pins (`.nvmrc`, `.node-version`, `.tool-versions` or `volta.node`) when
that Node is installed.

If your app only starts Metro through its own command, set `metro.command` in
the app's `.stim.json`, with `{port}` where the port goes:

```json
{
  "metro": {
    "command": ["node", "../react-native/cli.js", "start", "--port", "{port}"]
  }
}
```

Launches through a custom command are reported as unverified, because Stim
cannot see its bundle requests. Windows does not support `metro.command`.

## Choose the port

Stim picks a free port from 8082 up. When your own tools expect a fixed port,
pin it per worktree:

<StimTabs code={`stim settings set metro.port 25062 --scope workspace`} />

A pinned port that another workspace or process holds is refused.

## Idle stop

After 15 idle minutes, Stim stops the dev server (keeping its port), shuts down
the workspace's owned devices and deletes regenerable build output. Builds,
live shares and pinned workspaces are never stopped. Change or disable it:

<StimTabs code={`stim settings set idle.minutes 60 --scope workspace   # 0 turns it off`} />

An app relaunched after an idle stop shows "could not connect". `stim revive`
restarts the dev server, boots the same devices and relaunches the installed
app from the build cache. It never builds. In-app state is lost.

<PromptBox
title="Resume after a pause"
response={`Revived: Metro on 8083, stim-trailhead booted, app relaunched. errors clean`}

>

{`The app shows "could not connect" after a pause. Run stim revive, then check the app's UI and stim logs --errors.`}
</PromptBox>

A workspace with a device hosted on another Mac is stopped after six idle
hours instead, which ends the hosted session. Set
`maintenance.idleStopHours` to change it, or `0` to turn it off. When a dev
server stops, `stim status` says why.

## Launch checks

`stim ios` and `stim android` open the app and wait for evidence that it
loaded: a bundle request to this workspace's Metro, or a live process for a
Release or native app. The summary can say the bundle is still building, or
that the launch is unverified; the agent follows the printed remedy before
claiming success. When Android killed the app for not responding (an ANR),
the run says so with the reason and, on an emulator, the host load. A device
hosted on another Mac gets no ANR report. Bundle errors, red screens, native
crashes and Android ANR kills of the launched app show up in
`stim logs --errors`. None of this proves the screen looks right.

You can make the check stricter by having the app log when it is really ready.
No package is needed: the app logs `[stim:readiness] pending` at startup and
`[stim:readiness] ready` once its first usable screen shows.

<PromptBox
title="Add readiness logs"
response={`Added pending and ready logs to the root layout. Verified a normal launch, a slow launch and a startup error on iOS and Android.`}

>

{`Add the recommended Stim app-readiness logs to this app. Follow stim guide lifecycle readiness. Use the app's existing splash-screen lifecycle without adding a package, cover login, onboarding and deep links, and never report ready after a failure. Verify a normal launch, a slow launch, a missing ready signal and a startup error, then remove temporary test code.`}
</PromptBox>

## Query the logs

<StimTabs
code={`stim logs --errors
stim logs --source client --since 5m
stim logs --follow --level warn
stim logs --source agent --follow
stim logs --source placement`}
/>

The timeline holds Metro, app, device and build records, plus the actions an
agent takes with [agent-device](https://github.com/callstack/agent-device)
through `stim agent-device`. `--source placement` shows where a run built and
why each remote machine was skipped. Logs live under `$STIM_HOME/workspaces`,
not in your checkout, capped at about 8 MiB per file.

A clean `stim logs --errors` means exit code 0 and no records printed.

<PromptBox
title="Why did it build here"
response={`Two remote machines were checked: one was busy, one runs another Stim version. remote.build came from the machine setting.`}

>

{`My last stim ios run built on this machine. Read stim logs --source placement --json and tell me which remote machines were checked, why each was skipped, and which setting decided it.`}
</PromptBox>

### Report a stimd problem

Before restarting anything, save `stim status --json`, `stim doctor --json`,
`stim engine status --json` and the lines of the daemon log around the
incident (`stim doctor` prints its path, normally
`~/.stim/daemon/daemon.ndjson`) to a private folder outside the checkout.
Before sharing, remove tokens, keys, pairing links and credentials in URLs,
and replace usernames, private paths, hostnames and IP addresses with
consistent placeholders.

## Ports for your other servers

Stim can hand out a port per worktree for a web or API server it does not run:

<StimTabs
code={`pnpm exec vite --port "$(stim ports get web)" --strictPort
stim ports            # list this workspace's ports
stim ports stop web   # kill the listener on that port`}
/>

A reservation does not hold the socket, so use your server's strict-port
option. `ports stop` kills whatever listens on the port, so reserve only ports
this workspace may stop.

<PromptBox
title="Give the web server its own port"
response={`Vite serves this checkout on port 8901. Stopped it with stim ports stop web.`}

>

{`Read stim guide ports. Allocate a web port for this workspace, start the web server on that exact port, and verify it serves this checkout. When finished, stop it with stim ports stop web.`}
</PromptBox>

To let the app on the device reach a server on this machine at
`localhost:<port>`, run `stim ports reverse <label or port>`. It works for
simulators, emulators and Android phones, not for an iPhone over USB.

## Workspace services {/* #workspace-services */}

Declare your databases, API servers and workers once in the committed
`.stim.json`, and every worktree runs its own copy on its own ports:

```json
{
  "services": {
    "web": { "ports": ["web"], "start": "python3 -m http.server {web}" },
    "deps": {
      "ports": { "pg": { "env": "PG_PORT", "reverse": false } },
      "idEnv": "COMPOSE_PROJECT_NAME",
      "start": "docker compose up -d --wait",
      "stop": "docker compose stop",
      "teardown": "docker compose -p {id} down -v"
    }
  }
}
```

<StimTabs
code={`stim services start
stim services
eval "$(stim services env)"
stim services stop`}
/>

`stim start` does not start services. The idle stop stops them and
`stim revive` restarts them. `stim worktree remove` runs each service's
`teardown`, and keeps the worktree when that fails. Keep secrets in a dotenv
file named by `envFile`, not in `.stim.json`.

<PromptBox
title="Run the backend per worktree"
response={`Declared the API and database as services. Both started on this worktree's ports and the integration tests passed.`}

>

{`Read stim guide services. Declare this project's local backend as a service in .stim.json with its ports passed by environment, start it with stim services start, and run the integration tests with stim test.`}
</PromptBox>

## Remote devices and network exposure

A device on another network reaches Metro through a tunnel that
`stim start --remote` opens. `metro.tunnel` picks it: `auto` (the default)
tries ngrok, then cloudflared, and gives Metro a public URL. `tailscale` keeps
it on your tailnet and is never picked automatically. `stim stop` ends the
tunnel.

`stim ios --remote <machine>` and `stim android --remote <machine>` need no
tunnel: Metro stays on this machine, and the host never connects back to it.

For every flag, setting and log source, run `stim guide metro`,
`stim guide logs`, `stim guide ports` and `stim guide services`.
