# Stim

The `stim` npm package installs the `stim` command and exports a typed lifecycle API.

Stim runs React Native, Expo and native apps for coding agents. Each project or
git worktree gets its own Metro port and owned device, shared caches keep native
and JavaScript builds warm across worktrees, and builds and devices can run on
other machines you approve.

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

Then ask your coding agent to run the app, for example "Run the app on iOS."
The skill tells it to run `stim guide agent`, which prints instructions for the
installed version.

## Normal workflow

```bash
stim doctor
stim start
stim ios                  # or: stim android, or: stim web
stim logs --errors
stim stop
```

Stim builds or restores the app, installs it, launches it, and checks launch
readiness. Plain output streams progress and ends with a summary. Use `--json`
when a script needs structured data. `worktree warm`, `start`, `ios` and
`android` run project code; `stim doctor` does not load
`fingerprint.config.js` or run an `eas` from the project tree.

## Programmatic API

Install `stim` as a dependency with `npm install --save-dev stim`, then import
from the main package:

```ts
import { createStim } from 'stim';

const stim = createStim({ projectRoot: process.cwd() });
try {
  const result = await stim.run({ platform: 'ios' });
  console.log(result.facts.udid);
} finally {
  try {
    console.log(await stim.diagnostics({ errorsOnly: true }));
  } finally {
    const cleanup = await stim.stop();
    if (!cleanup.ok) throw new Error(cleanup.summary);
  }
}
```

The API runs the same native lifecycle operations as the CLI, in the importing
process. `stop()` acts on the whole workspace, including resources from earlier
runs, so use a dedicated workspace in CI. Failures are `StimError` instances
with `code`, `message`, `remedy` and `details`. See
[the API reference](https://stim.appandflow.com/docs/programmatic-api) or
`stim guide api` for every operation, option and result type.

## Documentation

- [Getting started](https://stim.appandflow.com/docs/getting-started): install,
  the first run, and the prompts to give your agent.
- [Worktrees](https://stim.appandflow.com/docs/worktrees),
  [build caches](https://stim.appandflow.com/docs/build-caches) and
  [devices](https://stim.appandflow.com/docs/owned-devices).
- [Web in an owned Chrome](https://stim.appandflow.com/docs/web),
  [native macOS apps](https://stim.appandflow.com/docs/macos) and
  [EAS development builds](https://stim.appandflow.com/docs/eas-builds).
- [Commands](https://stim.appandflow.com/docs/commands),
  [settings](https://stim.appandflow.com/docs/settings) and
  [troubleshooting](https://stim.appandflow.com/docs/troubleshooting).

The installed CLI carries the version-matched reference:

```bash
stim guide
stim <command> --help
```

## Migrating from stim-cli

Remove the old global package before installing `stim`, since both provide the
same command:

```bash
npm uninstall --global stim-cli
npm install --global stim
```

Update programmatic imports from `stim-cli/cache-manifest` to
`stim/cache-manifest`. The server and CI runner ship in `stim`; use `stim serve` and `stim ci`.

## License

MIT
