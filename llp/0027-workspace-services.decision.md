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
`orphanTeardown`, `ready`, `ports`, `idEnv`, `env`, `envFile`, `cwd` and
`dependsOn`. A command is an argv array, or a string Stim splits on spaces that refuses quotes
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

## A service start shares the build slots

Every service start, including a restart from `stim revive`, takes a build
slot before running its start command. It shares native builds' queue and
`concurrency.maxBuilds` cap, with the workspace and service name in the claim.
Queue progress goes to stderr, including in JSON mode. Cancellation and claim
recovery follow LLP 0007; unresolved child cleanup retains its claim.

The slot covers the start command and readiness wait only: an explicit `ready`
command, otherwise all declared ports listening, otherwise the process alive
one second after the start.
It releases at readiness, start failure, the 60-second readiness deadline or
cancellation. A running service, stop and teardown hold no slot. Services start
only through `services start` and `revive`, before any native build takes a slot.

Reason: starting a database stack competes with native builds for disk I/O.
Sharing their admission limit bounds that load without another setting or cap.

Maintainer decision: "ok lets use slot then", 2026-11-24
([#6282](https://github.com/appandflow/stim/issues/6282)), for startup only.

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

## A port only counts as the service it recorded

A commands service runs when its record says so and one of its ports listens. A
record that is `running` (also one that only partly came up) runs its
idempotent `start` again on the next start. With no record, or a stopped one, a
held port refuses the start; so does a held port for a supervised process
without a live recorded identity. Stim never adopts a listener it did not start,
not even when the service's `ready` passes. Reason: a foreign listener must not
pass for the service, and an adopted process has no identity Stim could stop.
Chosen by the independent design review and the coordinating session.

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
ports, env, the absolute `envFile` path, dependencies and the caller's `PATH`.
The idle pass, `stim revive` and removal read only that record, never the
settings of the moment, and act only on services Stim started; they run its
commands with the recorded `PATH`, since stimd's may lack the tools the start
found (other variables belong in `env`), and in dependency order.
Reason: unattended runs execute only what the user's own `stim services
start` resolved, not what a branch checked out later declares, and the record
survives the folder, which an orphan teardown needs. Chosen by the
implementing agent with the coordinating session.

The `envFile` contents are the exception: Stim reads the file at each launch,
below `env`, ports and `idEnv`, and the orphan teardown runs without it, since
the file went with the folder. Reason: the file holds secrets, and the recorded
env is written to Stim state, printed in failure remedies and returned by
`stim services env`. Chosen by the implementing agent with the coordinating
session (#6208).

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
resumed. The idle mark clears only on a successful start or an explicit stop;
a restart that fails keeps it, also when the stack partly came up and stays
`running` for the idle pass, so the next revive tries again. A failure refuses with `STIM_SERVICE_FAILED`, naming the service.

Maintainer decision: "Can we also have a resume command for when revive is
called", 2026-11-23 (#6202). The resume is the service's `start`.

## One transition per service change

Every start, stop, teardown and forget of a service goes through one transition
under the workspace's services lock: it runs the command, checks the result
(the ports closed or the process group gone, or the service ready), writes the
record, then syncs the device reverses. A stop runs only while the record is
not already stopped, so a stop command that fails when nothing runs (`pg_ctl
stop`) never runs twice. A teardown runs `teardown` alone, and `stop` only
while the service still runs. Reason: the earlier design carried records
through the reclaim and spread these steps over several helpers, where most
review findings sat. Proposed by an independent design review and the
coordinating session.

## Removal tears services down

Services are settled before a reclaim touches anything else, and a reclaim
never runs a service command after that:

- A linked-worktree removal (`stim worktree remove`, and gc and maintenance
  removing a finished worktree) tears the services down right after its
  blocker and dirty-archive checks, before the reclaim and before ignored
  folders such as `node_modules` move to the trash, so a teardown can still use
  them. A teardown that fails refuses the removal with nothing else touched:
  the worktree, the record (with `teardownFailure`, naming the command, folder
  and env to run by hand, shown by `stim status` and `stim services`) and its
  ports stay. `stim worktree remove --force` drops them. A later refusal of
  the removal leaves the folder with the services' data already deleted;
  `stim services start` recreates it.
- A reclaim that keeps the folder (a source checkout, a project in a
  subfolder) stops each service, keeping its data, then forgets its record and
  ports. The service id is stable for the path, so the next start finds the same
  containers and volumes. A stop that fails refuses the reclaim before anything
  else changes.
- When the folder is gone (gc, or `stim worktree remove` on a missing path),
  each service gets one `orphanTeardown` from the home folder. When recording
  a service with no explicit `orphanTeardown`, Stim uses its `teardown` if the
  definition names the `{id}` placeholder. An explicit `orphanTeardown` wins;
  existing records are unchanged. A failure, or a service with no usable orphan teardown,
  is printed and logged with the command to run by hand, the service is
  forgotten, and the reclaim goes on. Retrying it is #6224.
- Just before the reclaim deletes the workspace state, a service record still
  there (one started during the reclaim) keeps the workspace instead.

Reason: a removal must not leave a stack or its data behind (the 153 volumes
above), and must never delete the data of a checkout that stays.

Maintainer decision: "Yes lets simplify teardown command", 2026-11-24 (#6243).
A teardown naming `{id}` can target the service after its folder is gone,
without declaring the same command twice.

Maintainer decision: "Yes to all 3", 2026-11-24 (#6202): unattended maintenance
and gc delete a service's data only when they delete the worktree itself, just
before; a failed teardown keeps the worktree, the record and its ports until a
teardown succeeds or `--force`, and every report names the command, folder and
env.

Maintainer decision: "Use ur recs for what to do next", 2026-11-24 (#6202). He
delegated the next three choices and approved the recommendations that way: an
orphan teardown gets one attempt and a printed command, with the retry as
follow-up #6224; a linked removal tears down before anything else and accepts
that a later refusal leaves the folder without the services' data; and a reclaim
that keeps the folder forgets the records and ports after stopping. These
replace the earlier retry of a failed orphan teardown on each pass and the
kept record and ports on every reclaim.

## Commands get the services env

`stim test` passes the env of the services Stim started in the workspace to the
test command, over the caller's environment, so tests reach this workspace's
services and not a stack an outer shell pointed at. `stim services env` prints
the values the current settings resolve to, for commands an agent runs itself;
they match the records unless the settings changed since the start.

## Follow-ups

Maintainer decision: "Lets keep it simple for now", 2026-11-24 (#6202). Left
out, each with its own issue: an HTTP readiness check (#6207),
`stim logs --service` (#6209), rendering a config file with the ports (#6210),
and capturing a value from a service's output, such as a tunnel URL (#6211).

## Links

- Issue: #6202.
- Code: `packages/stim-cli/src/services.ts`, `packages/stim-cli/src/commands/services.ts`,
  `packages/stim-cli/src/daemon/service-stops.ts`, `packages/stim-cli/src/commands/revive.ts`,
  `packages/stim-cli/src/devices/reclaim.ts`, `packages/core/state/workspace-state.ts` (`ServiceRecord`),
  `packages/core/state/settings-registry.ts` (`services`).
