# Pluggable hosted agent drivers

Date: 2026-10-13. Status: implemented for agent-device; Argent researched and
not shipped. Issue: #3682.

## Summary

stim-server starts the tool a client's coding agent drives hosted apps with
through a driver contract, `@stim-cli/agent-driver`, instead of a hard-coded
agent-device adapter. agent-device moves into its own package,
`@stim-cli/agent-driver-agent-device`, with no behavior change.
`hosting.agentDriver` names a registered driver or `none`. The grant and access
payloads carry any driver name, so a client that knows a driver can use it and
an older client degrades to `none` with a notice.

The design mirrors the cache provider contract in `@stim-cli/cache` and
`@stim-cli/cache-s3`: a versioned module shape, a loader that never throws,
and a contract test kit.

## Motivation

agent-device is one of several tools that drive simulators and emulators for
agents. The hosted path named it in the server's driver construction, the
grant union, the client's remote config writer and the archived action reader,
so adding a second tool meant editing all of them.

## Scope

In: the contract package, moving agent-device behind it, a registry in
stim-server and in the CLI, the open grant and access payloads, and an action
reader capability.

Out: optional installs of driver packages, third-party driver packages,
project-scoped drivers, and the CLI's own reader of a workspace's local
agent-device actions (`stim logs --source agent`), which reads the
workspace's own `AGENT_DEVICE_STATE_DIR` rather than a hosted driver.

## Contract

A driver package exports `apiVersion: 1`, `id`, and
`createAgentDriver({ env, stateDir, claimRoot, device })`, which returns the
`HostedAgentDriver` that `HostedAgentHost` already reference-counts: `start`,
`stop`, `issue`, `revoke`, `forward` and `onExit`, named `id`. The host keeps
every policy decision: which client and session may use a grant, the tailnet
node pin, restarts and teardown order. The driver confines each forwarded
request to the one app or device it issued the grant for.

Two capabilities are optional:

- `client`, run by the CLI on the Mac that placed the app. It names the file it
  writes beside the placement and turns a grant into that file's contents,
  written with mode 0600, and a command that names the file. The command never
  carries the token. agent-device's client writes the same
  `agent-device-remote.json` as before.
- `actions`, which reads the driver's recorded agent actions from a workspace or
  archive directory. agent-device's reader reads `agent-device/sessions` as
  stim-server's archived timeline did, so existing archives read the same.

`loadAgentDriverModule` and `loadAgentDriver` import a module under a
10-second deadline and resolve to `{ unavailable: reason }` for a failed or
slow import, another `apiVersion` or `id`, a throwing factory, or a driver
under another name. `runAgentDriverContract` loads a module the same way and
checks the host-independent behavior every driver needs: idempotent `stop` and
`revoke`, a refused `issue` before `start`, an error status from `forward`
without a grant, `AgentDriverUnavailable` from `start` when the tool is
missing, and a client file that keeps the token out of the command.

The grant and lease types stay in `@stim-cli/core/state`, which owns the wire
payloads and their parsers; the contract package imports them as types only.

## Resolution

Drivers are machine scope. stim-server is a machine daemon bundled in Stim
Desktop, so it resolves drivers from its own dependencies, never from a
project. stim-server and the CLI each keep a registry of the first-party driver
packages they depend on and import a package only when its driver is needed.
`HOSTED_AGENT_DRIVERS` in core lists the same names for the setting's choices.

The driver for a hosted macOS app keeps its state and claim under the server
home, at `server/<driver>` and `server/<driver>.claims`. A hosted device
session's driver keeps them under the session area, at
`device-host/sessions/<id>/<driver>` and `<driver>.claims`. For agent-device
these are the paths it used before. When a device session stops, stim-server
tears down the driver whose claim root exists in that session's area, or the
configured driver when none does, so a setting changed while a session ran
still releases the old driver's daemon. A claim root stays after its claim is
released, so this matches the earlier unconditional agent-device teardown for
any session agent-device ran in. A session no registered driver ran in stops
without a driver even when the setting names an unknown one.

A driver that is named but fails to load leaves the app with
`{ "driver": "none" }` and a notice naming the reason. A setting naming no
registered driver gets the same.

## Payloads

`HostedAgentGrant` is `{ driver: "none" }` or a grant whose `driver` is any
lowercase name, with `path`, `token`, `scope` and an optional `lease`. A lease,
when present, is validated as before. `HostedAgentAccess` is
`{ driver: "none", setting }` or `{ driver, remoteConfig, command }` for any
driver name. A client that has no driver for a grant's name reports that the
host offered agent control it does not support and records `none`, as it did
for an unknown name before.

## Argent

Argent (`@swmansion/argent`, software-mansion/argent, version 0.28.0 at the
time of writing) fits the transport half of the contract: its tool-server is
an HTTP daemon with bearer-token authentication, `ARGENT_PORT=0` picks a free
port and prints it, and its clients reach a remote tool-server through
`ARGENT_TOOLS_URL` and `ARGENT_AUTH_TOKEN`, keeping a path prefix. It does not
fit the confinement half, and it is not shipped:

- The tool-server has no daemon-side policy: no lease, device allowlist or
  command allowlist. `list-devices`, `boot-device`, `stop-all-simulator-servers`,
  `update-argent`, `stop-metro`, `/upload` and the debugger tools, which take a
  loopback Metro port, reach the whole hosting Mac. Confinement would rest
  entirely on Stim rewriting per-tool bodies.
- On start and every 10 seconds after, the tool-server enumerates every booted
  simulator in the default device set and sets `DYLD_INSERT_LIBRARIES` in each
  simulator's launchd to its native devtools libraries
  (`tool-server/src/utils/simulator-watcher.ts`, `utils/ios-host.ts`). Stim keeps
  its simulators in the default set, so starting Argent for one hosted session
  would modify every other booted simulator on the Mac, including other
  clients' hosted simulators and the person's own. No setting turns the watcher
  off, and it runs for an Android-only session too. The one exception is a
  simulator that a device provider descriptor in `~/.argent/providers/` claims
  without granting `native-devtools`; Argent may still inject before it reads a
  new descriptor, and a descriptor cannot cover simulators Stim does not know
  about.
- It has no backend for native macOS apps.

An Argent driver needs a tool-server mode that serves one device and leaves
other simulators untouched, and preferably a daemon policy like
agent-device's. With that, the driver is a package beside agent-device's, plus
its name in the two registries and in `HOSTED_AGENT_DRIVERS`.

## Decisions

- `hosting.agentDriver` stays a choice of first-party names, so validation,
  `stim settings` and the JSON Schema keep rejecting typos.
- The contract package has no runtime dependencies; it depends on
  `@stim-cli/core` for the payload types only.
- stim-server and the CLI depend on every first-party driver package for now.
  The dynamic import keeps the door open for optional installs.
- A first publish of each new package needs npm to accept it from the release
  workflow before the first release that includes it.
