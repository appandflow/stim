<img width="1200" height="630" alt="OG_Image" src="https://github.com/user-attachments/assets/c3642b3f-3974-448c-89f6-3d87cbfbc5b0" />

# Stim

Orchestrate fast builds and devices for coding agents.

Stim builds, launches and cleans up React Native, Expo and native apps for every
agent, locally or across your machines, and shows you what each one
is running.

- **Worktree-based workflow.** One git worktree per task. `stim worktree warm`
  copies in its dependencies, and Stim gives it its own Metro port and device,
  so parallel agents never collide.
- **Builds you only pay for once.** React Native and Expo builds are cached and
  shared across worktrees, so a new one rarely compiles from scratch. Xcode and
  Gradle share their compiler caches too.
- **Every device, every machine.** Simulators, emulators, connected phones,
  other Macs, EAS and CI. Send builds to another machine when this one is busy.
- **See what every agent sees.** [Stim Desktop](https://stim.appandflow.com/docs/desktop)
  shows every workspace, device, build and log. Take control of a device, or
  [share a link](https://stim.appandflow.com/docs/share) to it.
- **Watches the whole machine.** Concurrency limits make builds, devices and
  test runs wait their turn instead of overloading the machine. When disk or
  memory runs low, Stim reclaims it.

Stim supports Expo, React Native Community CLI and Re.Pack projects, native
Xcode and Gradle apps, Exact apps, and web pages in an owned Chrome.

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

- [`stim`](./packages/stim-cli) provides the CLI, server, CI runner and public APIs.
- [`@stim-cli/cache-s3`](./packages/cache-s3) provides optional S3-compatible artifact storage.

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
