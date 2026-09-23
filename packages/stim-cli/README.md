# Stim

The `stim` npm package installs the `stim` command.

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
stim ios                  # or: stim android
stim logs --errors
stim stop
```

Stim builds or restores the app, installs it, launches it, and checks launch
readiness. Plain output streams progress and reports the complete result. Use
`--json` when a script needs structured data.

## Documentation

The [documentation website](https://stim.appandflow.com/) is the full
reference:

- [Getting started](https://stim.appandflow.com/docs/getting-started): terms,
  the first run, parallel worktrees, and what to do when a run fails.
- [Worktrees](https://stim.appandflow.com/docs/worktrees): `worktree warm`,
  `--refresh`, and `worktree remove`.
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
