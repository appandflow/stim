# LLP 0027: Workspace services

**Type:** Decision
**Status:** Active
**Systems:** Cleanup, Metro
**Author:** Claude
**Date:** 2026-11-23
**Related:** LLP 0001, LLP 0002, LLP 0007, LLP 0018

## A project declares its services

The `services` project setting, usually committed in `.stim.json`, declares the
databases, API servers and workers a workspace runs besides Metro, keyed by
name. `stim services start [name]` starts them, `stim services stop [name]`
stops them, `stim services env [name]` prints their variables, and
`stim services` lists them. Nothing starts one implicitly: `stim start` does
not, because a container stack takes tens of seconds and needs its runtime,
which would slow and break the Metro command an agent runs most.

A service has a `start` command and optionally `stop`, `teardown`,
`orphanTeardown`, `ready`, `ports`, `idEnv`, `env`, `cwd` and `dependsOn`. A
command is an argv array, or a string Stim splits on spaces that refuses quotes
and shell syntax; nothing runs through a shell. `stim ports` stays the
reservation primitive for a server Stim does not manage.

Reason: lifecycle belongs to a service, not a port; one stack owns several
ports and some services own none; and per-label flags on `stim ports get`
would be API to deprecate after 2.0. Agent machines that create a worktree per
task accumulated one local database stack per worktree, seven at once, about
5 GB of resident memory, and the stopped stacks left 153 volumes (6.6 GB) after
their worktrees were removed. That reasoning is the coordinating session's.

Maintainer decision: "Lets build services and stop port changes", 2026-11-23
(#6202). It supersedes the per-port stop flags of "Lets build the stop command
support, configurable or passed via flag when reserving", 2026-11-23 (#6202).

Maintainer decision: "if it works for supabase it should work for anything",
2026-11-23 (#6202). Stim has no code or name for a particular tool; the guide's
examples cover a web server, a mock API, a docker compose stack, a local
Supabase stack and an API with dependent services.

## A service without a stop command is a process

A service without `stop` is a long-running process Stim supervises: `start`
runs detached, in its own process group, with the service env, its output in
`logs/service-<name>.log` of the workspace. Stim records its captured process
identity and stops it by that identity, SIGTERM to the group, then SIGKILL after
5 seconds, and waits until the whole group is gone; a process whose identity
cannot be read counts as possibly running. A start never spawns over a
recorded process that still runs; it waits for it to be ready. With `stop`,
`start` must return once the service runs in the
background, and Stim runs the service's own commands instead of signalling.
`teardown` and `orphanTeardown` need `stop`.

Maintainer decision: "Simplest case can also be something like that and if no
stop command it just kills process", 2026-11-23 (#6202).

On the side of LLP 0018: the process has no Stim parent. It writes its output
to its file itself, so no restart of a command or of stimd loses any, and Stim
never learns its exit code; `stim services` shows it stopped. A helper parent
like `metro-run` would keep the exit code for one Node process per service;
the implementing agent chose not to add one until an exit code is needed.

## Ports, ids and placeholders

`ports` names the service's named port labels, as a list or as an object of
label to the environment variable that receives the number. They come from the
`stim ports get` pool, so an existing reservation keeps its number and
`stim ports get <label>` prints it. `idEnv` receives the service id,
`<name>-<workspace id>`, stable for the workspace path after its folder is
gone, so each worktree names its own containers and volumes. `env` sets more
variables.

Commands and `env` values take placeholders, substituted per argv element
after splitting: `{<label>}` an own port, `{<service>.<label>}` another
service's port, `{id}` the service id, `{dir}` the service's absolute folder.
`{{` and `}}` are literal braces; any other name refuses when the setting is
read. A reference to another service, or `dependsOn`, orders the start:
dependencies first, stop and teardown in reverse; a cycle refuses. Port
placeholders in commands were added for servers that take their port only as
an argument (`python3 -m http.server {web}`), at the maintainer's request
relayed by the coordinating session; the placeholder names follow the
relayed examples rather than `web.url`'s `{port:<label>}`, chosen by the
implementing agent.

## A running service is reachable from the devices

While a service runs, Stim reverses its ports to the workspace's devices
through the records `stim ports reverse` keeps, so `http://localhost:<port>`
works from the app on a local Android emulator (`adb reverse`), a hosted
simulator or emulator (the hosting Mac's bridge, which needs `stim start`
running), and is already reachable from a local simulator. A device that
starts later gets the recorded ports when `stim android` launches the app.
Stopping or tearing down a service drops its reverses. Every port is reversed
unless its `ports` entry says `{ "env": ..., "reverse": false }`, for a port only
host tools use, such as a database. Reason for the default: the app reaching
the service is why it runs in a workspace, and the cost is one recorded port
of the 16 a workspace may reverse. A reverse that fails is reported with the
start and does not fail it.

Maintainer decision: "Reachability should prob be fixed tho", 2026-11-24
(#6202).

## Stim runs only what it recorded

`stim services start` records each service as it resolved it: argv with
placeholders substituted, absolute folder (refused outside the checkout),
ports and env. The idle pass, `stim revive` and removal read only that record,
never the settings of the moment, and act only on services Stim started.
Reason: unattended runs execute only what the user's own `stim services
start` resolved, not what a branch checked out later declares, and the record
survives the folder, which an orphan teardown needs. Chosen by the
implementing agent with the coordinating session.

## The idle pass stops services

Each stimd tick, after the idle stage, the idle pass stops a workspace's
running services once it has had no activity for `idle.minutes` by the full
evidence: Stim commands, source and git writes and commits, and no process or
agent session working in its checkout. `maintenance.keep`, `idle.minutes` 0, a
workspace in use and `daemon.mode report` keep them. The ports stay. A failed
stop is retried after another `idle.minutes`. A recorded service that no longer
runs is recorded stopped, with no idle mark. The services' own processes (each
supervised process group, and the listeners `lsof` shows on a commands
service's ports) do not count as processes working in the checkout. A service
that writes into its checkout counts as a file edit and never idles. stimd stays alive while a recorded service runs, and
`stim services start` starts stimd.

Reason for the idle stage rather than dormancy: a stack costs memory, not disk,
as LLP 0001 (The 2-minute idle stop is for memory) argues for Metro and
devices, and a day of dormancy is the 7-hour, 5 GB case above. Reason for the
full evidence: Stim cannot see a service's clients, as it cannot for
`metro.command`; the source, git, process and agent-session evidence of the
dormant reduction (LLP 0001, One idle day reduces a workspace) stands in, so a
backend session that edits and tests without a Stim command keeps its stack.
Chosen by the implementing agent with the coordinating session.

## Revive resumes what the idle pass stopped

`stim revive` starts again, from their records and before Metro, the services
the idle pass stopped, and waits for each to be ready. A service
`stim services stop` stopped, one that exited, or one Stim never started is not
resumed; a start clears the idle mark, and a failed restart keeps it, so the
next revive tries again. A failure refuses with `STIM_SERVICE_FAILED`, naming the service.

Maintainer decision: "Can we also have a resume command for when revive is
called", 2026-11-23 (#6202). The resume is the service's `start`.

## Removal tears services down

Before it releases the ports, workspace removal (`stim worktree remove`, `stim
gc`, automatic maintenance) tears down each recorded service in reverse start
order: a process by identity; a commands service through `teardown`, else
`stop` while it runs. When the workspace folder is gone, `orphanTeardown` runs
from the home folder; without one, removal names the command to run by hand.
A teardown that fails while the service may still run (its process lives or
cannot be verified, or its ports listen) throws, so removal keeps the
workspace and names the command; once the user stops it by hand, removal goes
on, and a failure that leaves nothing running is only reported. Reason: a
removal must not leave a stack or its data behind (the 153 volumes above), and
must not be blocked forever by a broken teardown. Chosen by the implementing
agent with the coordinating session.

## Commands get the services env

`stim test` passes the env of the services Stim started in the workspace to the
test command, over the caller's environment, so tests reach this workspace's
services and not a stack an outer shell pointed at. `stim services env` prints
the values the current settings resolve to, for commands an agent runs itself;
they match the records unless the settings changed since the start.

## Follow-ups

Maintainer decision: "Lets keep it simple for now", 2026-11-24 (#6202). Left
out, each with its own issue: an HTTP readiness check (#6207), a per-service
env file (#6208), `stim logs --service` (#6209), rendering a config file with
the ports (#6210), and capturing a value from a service's output, such as a
tunnel URL (#6211).

## Links

- Issue: #6202.
- Code: `packages/stim-cli/src/services.ts`, `packages/stim-cli/src/commands/services.ts`,
  `packages/stim-cli/src/daemon/service-stops.ts`, `packages/stim-cli/src/commands/revive.ts`,
  `packages/stim-cli/src/devices/reclaim.ts`, `packages/core/state/workspace-state.ts` (`ServiceRecord`),
  `packages/core/state/settings-registry.ts` (`services`).
