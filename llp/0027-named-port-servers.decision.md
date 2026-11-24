# LLP 0027: Servers on named ports and the commands that stop them

**Type:** Decision
**Status:** Active
**Systems:** Cleanup, Metro
**Author:** Claude
**Date:** 2026-11-23
**Related:** LLP 0001, LLP 0002, LLP 0007

## A label can carry its own commands

A named port (`stim ports get <label>`) can carry up to three commands for
the server on it, each an argv array run without a shell, from the workspace
root, with its output in the workspace log (`port_stop`, `port_teardown`,
`port_resume` events):

- `stop` stops the server and keeps its data. `stim ports stop` and the idle
  pass run it.
- `teardown` removes the server and its data. Workspace removal runs it:
  `stim worktree remove`, `stim gc`, maintenance removing a worktree, and gc
  pruning a workspace whose folder is gone. Without one, removal runs `stop`.
- `resume` starts the server again. `stim revive` runs it for the labels the
  idle pass stopped.

`--stop`, `--teardown` and `--resume` on `ports get` set them, split on spaces,
and refuse quotes and shell syntax; the `ports.commands` project setting
declares them per label for a repository to commit once. `ports get` records
them with the allocation in the machine registry, and every later run reads
only that record, never `.stim.json`. Several labels that share a command run
it once. A label without a stop command keeps the listener stop of
`stim ports stop`, and removal still never signals a listener (#3256).

Reason: a container stack such as a local Supabase publishes its ports
through a root-owned `docker-proxy` or Docker Desktop's backend. Signalling
the listener needs root, breaks the forwarding and leaves the containers and
their memory in place; only the tool's own command stops it. Agent machines
with one worktree per task accumulated one stack per worktree, seven at once,
about 5 GB of resident memory, and the stopped stacks left 153 volumes
(6.6 GB) behind after their worktrees were removed, which is why removal has
its own command. Commands come from the registry so that unattended runs
execute only what the user's own `stim ports get` recorded, not what a
checked-out branch's `.stim.json` says later.

Maintainer decision: "Lets build the stop command support, configurable or
passed via flag when reserving", 2026-11-23 (#6202).

Maintainer decision: "Can we also have a resume command for when revive is
called", 2026-11-23 (#6202).

The separate teardown command, the argv-only form and recording at `ports get`
were chosen by the implementing agent and the coordinating session, not by
the maintainer.

## Stop keeps data, teardown runs at removal

A stop command runs only while one of its ports has a listener, and so does a
stop command that stands in for a missing teardown at removal: stopping
nothing is pointless, and a stop that fails because the tool's runtime is down
would otherwise block the removal. A teardown command runs at removal whether
or not anything listens, because a stopped stack still holds its data. After
a stop or teardown, the ports must have no listener before the allocation is
released; a failed command, a timeout (2 minutes) or a port that still listens
keeps the allocation, so removal keeps the workspace's registry entry and
reports it.

## A workspace folder that is gone

When the workspace folder no longer exists (gc pruning a worktree deleted
outside Stim), removal runs the teardown once from the home folder, since a
command that names its target by id (`--project-id`) needs no folder. If it
fails, the allocation goes anyway and the log line names the command to run
by hand: nothing can run it from the folder later, and a registry entry kept
for it would fail every gc.

## Stop commands run outside the ports lock

The commands run before `ports stop` and removal take the machine-wide ports
lock, which they take only to release. A slow stop would otherwise block every
`stim ports get` and `stim web` in every workspace.

## The idle pass stops labelled servers

Each stimd tick, after the idle stage, the idle pass runs the stop commands of
a registered workspace whose labelled ports have a listener, when the
workspace has had no activity for `idle.minutes` by the full evidence: Stim
commands, source and git writes and commits, and no process or agent session
working in its checkout. `maintenance.keep`, `idle.minutes` 0, a workspace in
use (native-run claim) and `daemon.mode report` keep it. The allocations stay,
so the server comes back on the same ports, and the state records the labels
it stopped. A failed run waits another `idle.minutes` before the next.

Reason for the idle stage rather than the dormant stage: the stack costs
memory, not disk, as LLP 0001 (The 2-minute idle stop is for memory) argues
for Metro and devices, and a day of dormancy is exactly the 7-hour, 5 GB case
above. Reason for the full evidence: Stim cannot see the server's clients, as
it cannot for `metro.command` (which the idle stage keeps whatever its
activity); the source, git, process and agent-session evidence of the dormant
reduction (LLP 0001, One idle day reduces a workspace) stands in for them, so
a backend session that edits and tests without a Stim command keeps its
stack. Chosen by the implementing agent and the coordinating session.

## Revive resumes what the idle pass stopped

`stim revive` runs the resume command of each label the idle pass recorded as
stopped, still allocated and with a resume command, whose ports have no
listener, once per distinct command, before it starts Metro, and checks the
ports listen afterwards (timeout 5 minutes, for a first image pull). A failure
refuses with `STIM_PORT_RESUME_FAILED`, naming the label and command. A label
`stim ports stop` stopped, or a server the user stopped, is never resumed;
removal deletes the record with the workspace. Only revive resumes: `stim
start` and `stim ios` do not.

## Links

- Issue: #6202.
- Code: `packages/stim-cli/src/named-ports.ts`, `packages/stim-cli/src/daemon/port-stops.ts`,
  `packages/stim-cli/src/commands/ports.ts`, `packages/stim-cli/src/commands/revive.ts`,
  `packages/stim-cli/src/devices/reclaim.ts`, `packages/core/state/settings-registry.ts` (`ports.commands`).
