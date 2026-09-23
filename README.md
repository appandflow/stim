<img width="1200" height="630" alt="OG_Image" src="https://github.com/user-attachments/assets/c3642b3f-3974-448c-89f6-3d87cbfbc5b0" />

# Stim

Fast, isolated local React Native environments for coding agents.

Stim gives each project or git worktree its own Metro port and owned simulator
or emulator. It shares native artifacts, Xcode compilation data, Gradle output,
and Metro transforms across worktrees. Agents can work in parallel without
sharing live resources, then clean up every resource Stim created.

Stim supports React Native Community CLI and Expo projects. Builds run locally
by default; `--eas-profile` uses completed EAS development builds.
Apps can launch on owned simulators and emulators, connected physical devices,
or configured remote devices.

## Install

The `stim` npm package installs the `stim` command. It needs Node 22.12 or
later and runs on macOS, Linux and Windows: Android everywhere, iOS locally on
macOS or through EAS from any host. See
[requirements](https://stim.appandflow.com/docs/requirements). If you
previously installed `stim-cli` globally, run `npm uninstall --global stim-cli`
first.

```bash
npm install --global stim
npx skills add appandflow/stim
```

Run without a global install when needed:

```bash
npx stim <command>
```

Then ask your coding agent to build and run the app. The normal loop is:

```bash
stim doctor
stim start
stim ios                  # or: stim android
stim logs --errors
stim stop
```

Stim needs no project initialization. Runtime state stays under `~/.stim` by
default. [Getting started](https://stim.appandflow.com/docs/getting-started)
covers terms, parallel worktrees, and what to do when a run fails.

## Documentation

Read the [Stim documentation](https://stim.appandflow.com/) for the
motivation, setup, concepts, command reference, and settings reference.

The installed version also includes its own reference:

```bash
stim guide agent
stim guide
stim guide lifecycle
stim guide settings
```

## Packages

- [`stim`](./packages/stim-cli) provides the `stim` command.
- [`@stim-cli/metro`](./packages/metro) shares Metro transforms and records logs.
- [`@stim-cli/expo-build-cache`](./packages/expo-build-cache) lets direct Expo
  builds share native artifacts with Stim.
- [`@stim-cli/cache`](./packages/cache) holds the cache provider contract and
  the local-first tier coordination behind both caches.
- [`@stim-cli/core`](./packages/core) contains shared internal cache contracts.

## Development

```bash
pnpm install
pnpm build
pnpm test
pnpm typecheck
pnpm lint
```

Stim is licensed under the MIT License.

## About

App&Flow is a Montreal-based React Native engineering and consulting studio. We partner with the world’s top companies and are recommended by [Expo](https://expo.dev/consultants). Need a hand? Let’s build together. team@appandflow.com
