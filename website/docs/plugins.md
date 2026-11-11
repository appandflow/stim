---
title: 'Plugins'
sidebar_position: 6
description: 'List the plugins Stim loads and test a plugin against its contract'
---

import StimTabs from '@site/src/components/StimTabs';

:::note[Command examples]

Commands use `stim`. If it is not installed globally, replace `stim` with
`npx stim`.

:::

A Stim plugin is a package that implements one or more plugin kinds:
`cache-provider`, `transport` or `agent-driver`. Stim bundles the `local` and
`tailscale` transports and the `agent-device` agent driver. A project selects a
cache provider with the `cache.provider` setting; transports and agent drivers
are built-in only for now.

## Write a plugin

Declare each kind and the integer its contract speaks in `package.json`, and
import only types from `stim/plugin`:

```json
{
  "name": "my-transport",
  "type": "module",
  "main": "index.mjs",
  "stimPlugin": { "kinds": { "transport": 1 } }
}
```

```ts
import type { Transport, TransportInput } from 'stim/plugin';
```

A runtime `import 'stim'` fails `stim plugin test`: a plugin runs without the
engine on its import path. Add `stim` as a development dependency for the
types and the kits.

## List plugins

<StimTabs code="stim plugin list" />

Lists the bundled plugins and the plugin `cache.provider` names, with the kind
integers each declares, and says when Stim cannot load one: the module does not
resolve from the settings file's directory, or it declares another integer.
It reads `package.json` manifests only and runs no plugin code. `stim doctor`
reports the same problem, and `stim settings set cache.provider` warns about it
and still writes the value.

`--json` prints:

```json
{
  "api": { "cache-provider": 1, "transport": 1, "agent-driver": 1 },
  "plugins": [
    {
      "name": "builtin:agent-device",
      "source": "builtin",
      "kinds": { "agent-driver": 1 },
      "selectedBy": ["hosting.agentDriver"],
      "accepted": true
    },
    {
      "name": "@stim-cli/cache-s3",
      "source": "project",
      "kinds": { "cache-provider": 1 },
      "selectedBy": ["cache.provider"],
      "accepted": true,
      "baseDir": "/path/to/app"
    }
  ]
}
```

A plugin Stim cannot load has `"accepted": false` and a `reason`.

## Test a plugin

<StimTabs code="stim plugin test ." />

Runs the contract kit of each `transport` and `agent-driver` kind the plugin
declares. Name a plugin directory or module path, a package installed in the
current directory, or `builtin:local` or `builtin:agent-device`.

:::warning[Test only a plugin you trust]

`stim plugin test` runs the plugin's code as your user, with access to your
files, the network and other processes. It is not a sandbox: only test a plugin
you would run anyway.

:::

What the command does isolate:

- The module loads in a worker thread, never in the CLI process, as Stim runs it.
- Its environment holds only `HOME`, `PATH`, `STIM_HOME` and
  `STIM_AGENT_DEVICE_BIN`, all pointing into a temporary directory that holds no
  tools; none of your own environment variables reach it. Stim deletes the
  directory afterwards, also when you interrupt the command.
- Its own output goes to stderr, so `--json` stdout holds only the payload.
- A transport gets empty options. The kit calls its `bindAddresses`, `watch`,
  `identify`, `resolve` and `close`; it never calls `expose` or `unexpose`,
  which change what the machine exposes.
- An agent driver gets a state directory and claim root in the temporary
  directory, with no driving tool on `PATH`, so `start` must refuse with
  `agent-driver-unavailable`.

`builtin:tailscale` is not tested, because it reads and watches this Mac's
Tailscale. A cache provider is not tested either, because it runs in the
calling process: run `runCacheProviderContract` from `stim/plugin` in the
provider's own tests. Both refuse with `STIM_BAD_ARG`.

`--json` prints `{ reference, kinds, skipped, checks, passed }`, where each
check is `{ kind, name, passed, error? }` and `skipped` lists declared kinds the
command does not run, with the reason. The command exits with code 1 when a
check fails.

`stim plugin` runs from the `stim` you invoke, such as a project's development
dependency, instead of the machine's engine, so a plugin is tested with the
kit of the Stim version it builds against.

Try it with an agent:

```text
Run `stim plugin test .` in this plugin package and fix every failing check.
Import only types from stim/plugin.
```
