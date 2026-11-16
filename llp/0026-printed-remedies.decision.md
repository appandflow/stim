# LLP 0026: Guidance for a refusal is its printed remedy

**Type:** Decision
**Status:** Active
**Systems:** Repo
**Author:** Claude
**Date:** 2026-11-15

Maintainer decision: "Also I think we should move as much of it as possible to output from the commands, an easy one is i think we have guide for each error, but we should just show the message when the error actually happens. Like instead of having the guidd explain when thid happens do that, it should just be when the thing happen if logs what the agent should do.", 2026-11-15.
[Issue #5773](https://github.com/appandflow/stim/issues/5773).

## A refusal prints what the agent does next

The remedy a command prints with a refusal carries the action: the command to
run, the setting to change, the thing to wait for. An agent that hits a refusal
follows that remedy. The agent guide sends it to the printed remedy, and to
`stim guide errors <CODE>` only when the remedy names that command.

A guide section about a refusal that repeats what the remedy says is a second
copy to keep in step, and a pointer from output to a guide costs the agent a
read it did not need.

Planned: #5773

## `stim guide errors` keeps only what a remedy cannot hold

A section stays in `stim guide errors` when its procedure is too long for a few
lines of remedy, such as the teardown and ownership-claim recovery. A remedy
that needs such a section names the exact `stim guide errors <CODE>` command.
A guide, another remedy or a page that names a section names one that renders.

## A code with no section prints one line

The implementing agent chose this behavior while working on
[#5773](https://github.com/appandflow/stim/issues/5773); the maintainer has not
stated it. `stim guide errors <CODE>` for a name shaped like a code (`STIM_` and
capitals) that has no section prints one line, on standard output with exit code
0, that says the printed remedy is the guidance. It cannot tell a deleted code
from a mistyped one, so both get the line. Any other name is an unknown section,
with the index on standard error and exit code 1.

## Code

- [The errors topic and its absent-section line](../packages/stim-cli/src/guide/errors.ts) and [how the guide command prints it](../packages/stim-cli/src/commands/guide.ts).
- [The agent router](../packages/stim-cli/src/guide/agent.ts).
