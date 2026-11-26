---
title: Programmatic API
description: 'Drive Stim from your own scripts and tools, and write or test plugins'
---

import StimTabs from '@site/src/components/StimTabs';
import PromptBox from '@site/src/components/PromptBox';

The `stim` package exports a typed API for scripts, test runners and tools that
want Stim's build, run, logs and cleanup without shelling out to the CLI. It
runs the same operations, with the same safety checks, as the commands.

<PromptBox
title="Script a run"
response={`Added scripts/run-ios.ts: it builds and launches the app with createStim, prints errors from diagnostics, and always calls stop().`}

>

{`Write a Node script that uses createStim from the stim package to run this app on iOS, print the app errors, and always stop the workspace at the end. Read stim guide api first.`}
</PromptBox>

## Install

```bash
npm install --save-dev stim
```

Node 22.12 or later is required. The package also installs the `stim`
executable. Command examples use `stim`; replace it with `npx stim` when it is
not installed globally.

## Example

```ts
import { createStim } from 'stim';

const stim = createStim({
  projectRoot: process.cwd(),
  onProgress: ({ message }) => process.stderr.write(message),
});

try {
  const result = await stim.run({ platform: 'ios' });
  console.log(result.facts.udid);
} finally {
  try {
    const diagnostics = await stim.diagnostics({ errorsOnly: true });
    console.log(diagnostics.directory, diagnostics.records);
  } finally {
    const cleanup = await stim.stop();
    if (!cleanup.ok) throw new Error(cleanup.summary);
  }
}
```

Always call `stop()` in cleanup, even when `run()` failed partway, and check
`ok`: a refused teardown is not a successful cleanup. Failures reject with
`StimError`, which carries `code`, `message`, `remedy` and `details`.

## What it covers

The client has `build`, `run`, `start`, `reload`, `stop`, `plan`,
`addWorktree`, `warmWorktree`, `removeWorktree`, `diagnostics`, `doctor`, `previewGarbage`,
`collectGarbage`, settings, stats and logs. Every method accepts an
`AbortSignal`.

- `build()` only compiles, or restores from the cache. It never boots a device.
- `addWorktree({ path, branch, commitish })` creates a linked worktree with
  the arguments of `git worktree add` and warms it, like `stim worktree add`.
  It returns the new worktree's `path`.
- `removeWorktree({ force: true })` discards uncommitted work, like
  `stim worktree remove --force`.
- `collectGarbage()` deletes what `stim gc` deletes. Call `previewGarbage()`
  first to see the list.

The public entry points are `stim`, `stim/plugin`, `stim/ci`,
`stim/ci/artifacts` and `stim/cache-manifest`. `stim/internal/*` and members
marked `@internal` serve Stim Desktop and stim-server and can change in any
release. Until 2026-12-12, the option names used in the 2.0 prereleases
(`buildCache`, `wait`, `errors`, `gc()`) refuse with `STIM_BAD_ARG` and name
their replacement.

The TypeScript declarations in the package are the full reference, and
`stim guide api` gives your agent the version-matched contract. For CI, use
`buildCI` and `runCI` from `stim/ci` (see [Continuous integration](./ci.md)).

## Plugins

A plugin is a package that implements a plugin kind: `cache-provider`,
`transport` or `agent-driver`. A project selects a cache provider with the
`cache.provider` setting. Stim bundles the `local` and `tailscale` transports
and the `agent-device` agent driver; other transports and drivers are not
loaded yet. Only the `cache-provider` contract is stable in 2.x.

A plugin declares its kinds in `package.json` and imports only types from
`stim/plugin`:

```json
{
  "name": "my-transport",
  "type": "module",
  "main": "index.mjs",
  "stimPlugin": { "kinds": { "transport": 1 } }
}
```

List what Stim loads, and why it rejects one:

<StimTabs code="stim plugin list" />

Run a plugin's contract kit:

<StimTabs code="stim plugin test ." />

:::warning[Test only a plugin you trust]

`stim plugin test` runs the plugin's code as your user, with access to your
files, the network and other processes. It is not a sandbox.

:::

A cache provider is tested in its own test suite with
`runCacheProviderContract` from `stim/plugin`. The exports each kind needs are
in `stim guide api`.

<PromptBox
title="Test a plugin"
response={`stim plugin test . passed 12 of 12 checks for the transport kind.`}

>

{`Run stim plugin test . in this plugin package and fix every failing check. Import only types from stim/plugin.`}
</PromptBox>
