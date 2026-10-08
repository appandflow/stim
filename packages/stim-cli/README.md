# Stim

The `stim` npm package installs the `stim` command and exports a typed lifecycle API.

Stim gives coding agents fast, isolated React Native and Expo environments. Each
project or git worktree gets its own Metro port and owned device. Shared caches
keep native and JavaScript builds warm across worktrees.

## Install

Node 22.12.0 or later is required. If you previously installed `stim-cli`
globally, follow the [migration instructions](#migrating-from-stim-cli) first.

```bash
npm install --global stim
npx skills add appandflow/stim
```

Run without a global install when needed:

```bash
npx stim <command>
```

## Normal workflow

```bash
stim doctor
stim start
stim ios                  # or: stim android, or: stim web
stim logs --errors
stim stop
```

Stim builds or restores the app, installs it, launches it, and checks launch
readiness. Plain output streams progress and reports the complete result. Use
`--json` when a script needs structured data.

## Programmatic API

Install `stim` as a dependency with `npm install --save-dev stim`, then import
from the main package:

```ts
import { createStim } from 'stim';

const stim = createStim({ projectRoot: process.cwd() });
try {
  const result = await stim.run({ platform: 'ios' });
  console.log(result.facts);
} finally {
  try {
    console.log(await stim.diagnostics({ errors: true }));
  } finally {
    const cleanup = await stim.stop();
    if (!cleanup.ok) throw new Error(cleanup.summary);
  }
}
```

`run` supports iOS and Android React Native/Expo apps, SwiftPM macOS apps, and
web pages with the same requirements as their CLI commands. Web runs require an
already running server. `run` builds, installs and launches; there is no
build-only API yet. It preserves the CLI's launch evidence, including
`'bundling'` and `'unverified'` results.

Each operation uses a separate bundled worker so its home, cancellation and
process state cannot change the importing process. The CLI and workers call
the same native lifecycle operations. Progress is silent unless `onProgress`
is provided; its `message` is an output chunk. Operations accept `signal`.
Cancellation waits for the worker to exit, and does not replace `stop()`.
Call cleanup with a fresh signal after cancellation or partial failure.

`home` and `buildCache` accept absolute paths. Omit them to use normal Stim
settings. A cache used by concurrent writers needs the same coordinating Stim
home; do not point independent homes at a concurrently writable artifact cache.
Ownership checks and cache locks remain active. `stop()` acts on this workspace,
including resources from earlier runs, so use a dedicated workspace in CI.

Stim failures are `StimError` instances with `code`, `message`, `remedy`, and
`details`. An exception thrown by `onProgress` cancels the worker and is
propagated unchanged.
`diagnostics()` returns the workspace log directory and up to 200 local records,
even if no run has succeeded. It does not fetch remote logs or capture new crashes.
See [the API reference](https://stim.appandflow.com/docs/programmatic-api) or
`stim guide api` for options and result types.

## Documentation

The [documentation website](https://stim.appandflow.com/) is the full
reference:

- [Getting started](https://stim.appandflow.com/docs/getting-started): terms,
  the first run, parallel worktrees, and what to do when a run fails.
- [Native macOS prototype](https://stim.appandflow.com/docs/macos): Swift Package
  Debug apps, workspace logs and local window viewing in Stim Desktop.
- [Web in an owned Chrome](https://stim.appandflow.com/docs/web): `stim web`
  for Expo web and other web servers, page logs, and attaching browser tools.
- [Worktrees](https://stim.appandflow.com/docs/worktrees): `worktree warm`,
  `--refresh`, `worktree remove`, and `gc --worktrees` to remove finished
  worktrees in bulk.
- [Build caches](https://stim.appandflow.com/docs/build-caches): what `gc`
  reports and trims, including the build outputs of idle workspaces.
- [Devices](https://stim.appandflow.com/docs/owned-devices): owned simulators
  and emulators, physical devices, slots, and remote devices.
- [EAS development builds](https://stim.appandflow.com/docs/eas-builds).
- [Commands](https://stim.appandflow.com/docs/commands) and
  [settings](https://stim.appandflow.com/docs/settings).
- [Troubleshooting](https://stim.appandflow.com/docs/troubleshooting): every
  refusal code and its remedy.

The installed CLI contains version-matched operational guidance:

```bash
stim guide agent
stim --help
stim <command> --help
stim guide
```

## Migrating from stim-cli

Remove the old global package before installing `stim`, since both provide the
same command:

```bash
npm uninstall --global stim-cli
npm install --global stim
```

Update programmatic imports from `stim-cli/cache-manifest` to
`stim/cache-manifest`. The `@stim-cli/*` packages keep their names.

## License

MIT
