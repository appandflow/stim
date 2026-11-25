---
title: 'Why Stim'
sidebar_position: 1
description: 'Run React Native, Expo and native apps for coding agents, in parallel, on every device and machine you have'
---

:::note[Command examples]

Commands use `stim`. If it is not installed globally, replace `stim` with
`npx stim`.

:::

Stim is where coding agents build and run your app. Each project or git
worktree gets a reserved Metro port and an owned simulator or emulator.
The agent can build, install, launch, inspect errors, and clean up through one
small command surface.

Stim supports Expo, React Native Community CLI and Re.Pack projects, native
Xcode and Gradle apps, Exact apps, and web pages in an owned Chrome. Builds run on this
machine or on an approved [remote machine](./remote-machines.md). Apps can run
on owned simulators and emulators, connected physical devices, or configured
remote devices.

[Report an issue](https://github.com/appandflow/stim/issues) when a workflow
does not behave as documented.

## Fast builds across worktrees

Stim fingerprints native inputs. A matching app installs from a shared artifact
cache instead of compiling again. Xcode compilation data, Gradle output, and
Metro transforms also use shared cache locations.

The cache works across different worktree paths. If two workspaces miss the
same artifact at the same time, Stim runs one native build. The other workspace
waits for that result.

## Parallel work without collisions

Normal React Native tools assume one developer controls one port and one device.
That assumption fails when several coding agents share a machine.

Stim gives every workspace a separate port and device. An agent can create a
worktree, run the app, and verify a change without using another agent's Metro
server or simulator. Parallel tasks remain independent while they share the
expensive caches.

## An interface designed for agents

Stim never prompts. Plain output streams the current phase and ends with the
device, app, Metro, cache, launch, and log facts. Build failures show the useful
compiler diagnostic and a log path. They do not place a full build transcript
in the agent context.

Every command also supports structured output where it is useful. The agent can
query `stim logs --errors` after a change instead of scraping a terminal. Less
noise means less waiting and fewer tokens.

## Owned resources and cleanup

Stim records the ports, processes, build output, devices, and remote sessions it
creates. It does not create, boot, or delete a user-created simulator or
emulator. A physical device reached with `ios --device` or `android --device`
is leased for the run and never added to the owned-device registry.

`stim stop` releases an active environment without deleting its local device.
`stim worktree remove` reclaims the worktree environment. `stim gc`
removes orphaned resources. This ownership model makes cleanup safe after an
agent exits early. [Getting started](./getting-started.md#terms) defines these
terms.

Beyond its own resources, Stim watches CPU, memory and disk for the whole
machine. It sets concurrency limits so builds, devices and test runs wait their
turn instead of overloading it. When disk or memory runs low, Stim reclaims it.
With `maintenance.autoDiscover` on, or folders named in
`maintenance.discoverRoots`, it also reaches checkouts no `stim` command ran in.
[Automatic maintenance](./build-caches.md#automatic-maintenance) lists what it frees.

## Why run locally

A local Mac already has Xcode, Android tools, simulator runtimes, credentials,
and access to private development services. Stim lets coding agents use that
existing setup with worktree isolation.

Local CPU, memory, and disk are finite. `stim doctor`, `stim status`, and
`stim gc --dry-run` make those limits visible. Remote devices remain available when a
local simulator is not the right target.

## When you probably don't need Stim

Stim helps with repeated setup, builds, and device management across worktrees.
If those aren't slowing you down, it may add little.

- **One long-lived checkout, one running app.** Your existing tooling already
  keeps builds warm. If you aren't juggling worktrees or agents, there's less to
  isolate and less duplicated work to avoid.
- **An installed Expo development build and mostly JavaScript changes.** You
  can keep using the same native app while Metro serves your changes. If native
  dependencies and configuration rarely change, there may be little build time
  to save.
- **Agents that don't run the app.** If your agents only edit code and run unit
  tests, they don't need isolated simulators or a native build workflow.
- **Your existing setup already handles this.** If your scripts or development
  platform provide isolated environments and reliable build reuse, Stim may
  duplicate what you have.
- **You want cloud builds or app distribution.** Stim builds on your own
  machines; it doesn't replace hosted build services, signing workflows, or
  store submission.

You don't need to replace a workflow that already works.
